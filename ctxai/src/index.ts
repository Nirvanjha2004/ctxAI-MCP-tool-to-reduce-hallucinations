#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Import tool logic (to be implemented next)
import { getProjectContext } from "./tools/getProjectContext.js";
import { validateSuggestion } from "./tools/validateSuggestion.js";
import { getPackageDocs } from "./tools/getPackageDocs.js";

const server = new Server(
  {
    name: "ctxai",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

/**
 * Tool Definitions
 * These tell the LLM exactly how and when to use our server.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_project_context",
        description:
          "Retrieves the local project's tech stack, installed packages, and versions.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to project root",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "validate_suggestion",
        description:
          "Checks AI-generated code for hallucinated imports or method calls against local project constraints.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The code snippet to validate",
            },
            contextFingerprint: {
              type: "string",
              description: "The fingerprint returned by get_project_context",
            },
          },
          required: ["code", "contextFingerprint"],
        },
      },
      {
        name: "get_package_docs",
        description:
          "Fetches the real API surface/documentation for a specific package and version from npm/PyPI.",
        inputSchema: {
          type: "object",
          properties: {
            packageName: { type: "string" },
            version: { type: "string" },
            registry: { type: "string", enum: ["npm", "pypi"] },
          },
          required: ["packageName", "version", "registry"],
        },
      },
    ],
  };
});

/**
 * Tool Execution Handler
 * Dispatches the tool calls to their respective functions.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case "validate_suggestion": {
        const { code, contextFingerprint } = args as {
          code: string;
          contextFingerprint: string;
        };

        if (!code || !contextFingerprint) {
          throw new Error("Missing required arguments for validate_suggestion");
        }

        const warnings = await validateSuggestion(code, process.cwd(), contextFingerprint);
        return {
          content: [
            {
              type: "text",
              text:
                warnings.length > 0
                  ? JSON.stringify(
                      { status: "warnings", issues: warnings },
                      null,
                      2,
                    )
                  : JSON.stringify({
                      status: "ok",
                      message: "No hallucinations detected.",
                    }),
            },
          ],
        };
      };

      case "get_project_context": {
        if (typeof args?.path !== "string") {
          throw new Error(
            "Missing or invalid argument 'path' for get_project_context",
          );
        }
        const contextText = await getProjectContext(args.path);
        return { content: [{ type: "text", text: contextText }] };
      }
      case "get_package_docs": {
        const { packageName, version, registry } = args as {
          packageName: string;
          version: string;
          registry: "npm" | "pypi";
        };

        if (!packageName || !version || !registry) {
          throw new Error("Missing arguments for get_package_docs");
        }

        const docs = await getPackageDocs(packageName, version, registry);
        return {
          content: [{ type: "text", text: docs }],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

/**
 * Start the server using Stdio transport.
 * This allows the LLM client (like Claude Desktop) to communicate with us.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ctxai MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
