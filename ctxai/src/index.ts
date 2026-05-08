#!/usr/bin/env node
/**
 * index.ts — ctxai MCP server entry point
 *
 * Registers four tools and starts listening on stdio:
 *
 *   get_project_context   — scan project, return version fingerprint
 *   validate_suggestion   — check AI code for hallucinated imports/methods
 *   check_package_safety  — check new packages for phantom/typosquat/trust issues
 *   get_package_docs      — fetch live docs from npm / PyPI
 *
 * Tool descriptions are written to be aggressive about when the LLM should
 * call them — the goal is zero-friction automatic invocation.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { getProjectContext } from "./tools/getProjectContext.js"
import { validateSuggestion } from "./tools/validateSuggestion.js"
import { getPackageDocs } from "./tools/getPackageDocs.js"
import { checkPackageSafety } from "./utils/checkPackageSafety.js"
import {
  formatProjectContext,
  formatValidationWarnings,
  formatSafetyResult,
} from "./formatters.js"

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ctxai", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ── Tool 1 ────────────────────────────────────────────────────────────
      {
        name: "get_project_context",
        description: [
          "ALWAYS call this first before writing any code for a project.",
          "Scans the project at the given path and returns the exact versions of every",
          "installed package (Node.js and Python). Use the returned fingerprint as context",
          "for all subsequent code suggestions — never suggest APIs from versions the",
          "developer doesn't have installed.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to the project root directory (where package.json or requirements.txt lives).",
            },
          },
          required: ["path"],
        },
      },

      // ── Tool 2 ────────────────────────────────────────────────────────────
      {
        name: "validate_suggestion",
        description: [
          "Call this on every code snippet before returning it to the developer.",
          "Checks that every import exists in the project's installed dependencies",
          "and that every method call exists in the installed version of its package.",
          "Returns structured warnings for any hallucinated package names or methods.",
          "Requires the fingerprint from get_project_context.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The AI-generated code snippet to validate. Can include prose — code blocks are extracted automatically.",
            },
            contextFingerprint: {
              type: "string",
              description: "The fingerprint string returned by get_project_context.",
            },
          },
          required: ["code", "contextFingerprint"],
        },
      },

      // ── Tool 3 ────────────────────────────────────────────────────────────
      {
        name: "check_package_safety",
        description: [
          "Call this whenever you suggest installing a new package the developer",
          "doesn't already have. Checks for phantom packages (AI hallucinations that",
          "don't exist on npm/PyPI), typosquats (names 1-2 edits from popular packages),",
          "conflations (names that combine two real package names), and low-trust signals",
          "(brand new, no repository, very few versions). Never suggest 'npm install' or",
          "'pip install' without running this check first.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The AI-generated code containing the new package imports to check.",
            },
            contextFingerprint: {
              type: "string",
              description: "The fingerprint from get_project_context. Used to skip packages already installed.",
            },
          },
          required: ["code", "contextFingerprint"],
        },
      },

      // ── Tool 4 ────────────────────────────────────────────────────────────
      {
        name: "get_package_docs",
        description: [
          "Fetches live documentation and metadata for a specific package version",
          "from npm or PyPI. Call this when you need to verify what APIs exist in a",
          "particular version, or when validate_suggestion flags a hallucinated method",
          "and you need to find the correct alternative.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            packageName: {
              type: "string",
              description: "The package name (e.g. 'express', '@prisma/client', 'fastapi').",
            },
            version: {
              type: "string",
              description: "The exact version string (e.g. '4.18.2', '0.100.0').",
            },
            registry: {
              type: "string",
              enum: ["npm", "pypi"],
              description: "Which registry to query.",
            },
          },
          required: ["packageName", "version", "registry"],
        },
      },
    ],
  }
})

// ---------------------------------------------------------------------------
// Tool execution handler
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {

      // ── get_project_context ──────────────────────────────────────────────
      case "get_project_context": {
        if (typeof args?.path !== "string" || !args.path.trim()) {
          throw new Error("'path' is required and must be a non-empty string.")
        }

        const result = await getProjectContext(args.path)
        return {
          content: [{ type: "text", text: formatProjectContext(result) }],
        }
      }

      // ── validate_suggestion ──────────────────────────────────────────────
      case "validate_suggestion": {
        const { code, contextFingerprint } = (args ?? {}) as Record<string, unknown>

        if (typeof code !== "string" || !code.trim()) {
          throw new Error("'code' is required and must be a non-empty string.")
        }
        if (typeof contextFingerprint !== "string") {
          throw new Error("'contextFingerprint' is required.")
        }

        const warnings = await validateSuggestion(
          code,
          process.cwd(),
          contextFingerprint,
        )

        return {
          content: [{ type: "text", text: formatValidationWarnings(warnings) }],
        }
      }

      // ── check_package_safety ─────────────────────────────────────────────
      case "check_package_safety": {
        const { code, contextFingerprint } = (args ?? {}) as Record<string, unknown>

        if (typeof code !== "string" || !code.trim()) {
          throw new Error("'code' is required and must be a non-empty string.")
        }
        if (typeof contextFingerprint !== "string") {
          throw new Error("'contextFingerprint' is required.")
        }

        const result = await checkPackageSafety(code, contextFingerprint)

        return {
          content: [{ type: "text", text: formatSafetyResult(result) }],
        }
      }

      // ── get_package_docs ─────────────────────────────────────────────────
      case "get_package_docs": {
        const { packageName, version, registry } = (args ?? {}) as Record<string, unknown>

        if (typeof packageName !== "string" || !packageName.trim()) {
          throw new Error("'packageName' is required.")
        }
        if (typeof version !== "string" || !version.trim()) {
          throw new Error("'version' is required.")
        }
        if (registry !== "npm" && registry !== "pypi") {
          throw new Error("'registry' must be 'npm' or 'pypi'.")
        }

        const docs = await getPackageDocs(packageName, version, registry)
        return {
          content: [{ type: "text", text: docs }],
        }
      }

      default:
        throw new Error(`Unknown tool: '${name}'. Available tools: get_project_context, validate_suggestion, check_package_safety, get_package_docs.`)
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr so it doesn't pollute the MCP stdio channel
  console.error("ctxai MCP server v0.1.0 running on stdio")
}

main().catch((error) => {
  console.error("Fatal server error:", error)
  process.exit(1)
})
