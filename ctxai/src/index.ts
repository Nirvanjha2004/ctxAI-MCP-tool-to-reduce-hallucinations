#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import tool logic (to be implemented next)
// import { getProjectContext } from "./tools/getProjectContext.js";
// import { validateSuggestion } from "./tools/validateSuggestion.js";
// import { getPackageDocs } from "./tools/getPackageDocs.js";

const server = new Server(
  {
    name: "ctxai",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
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
        description: "Retrieves the local project's tech stack, installed packages, and versions.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to project root" }
          },
          required: ["path"]
        },
      },
      {
        name: "validate_suggestion",
        description: "Checks AI-generated code for hallucinated imports or method calls against local project constraints.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "The code snippet to validate" },
            contextFingerprint: { type: "string", description: "The fingerprint returned by get_project_context" }
          },
          required: ["code", "contextFingerprint"]
        },
      },
      {
        name: "get_package_docs",
        description: "Fetches the real API surface/documentation for a specific package and version from npm/PyPI.",
        inputSchema: {
          type: "object",
          properties: {
            packageName: { type: "string" },
            version: { type: "string" },
            registry: { type: "string", enum: ["npm", "pypi"] }
          },
          required: ["packageName", "version", "registry"]
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
      case "get_project_context":
        // TODO: Call implementation from ./tools/getProjectContext.ts
        return { content: [{ type: "text", text: "Project context logic pending..." }] };

      case "validate_suggestion":
        // TODO: Call implementation from ./tools/validateSuggestion.ts
        return { content: [{ type: "text", text: "Validation logic pending..." }] };

      case "get_package_docs":
        // TODO: Call implementation from ./tools/getPackageDocs.ts
        return { content: [{ type: "text", text: "Documentation retrieval pending..." }] };

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