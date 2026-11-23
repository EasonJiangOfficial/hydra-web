import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorize, runTool, TOOLS, type ToolName } from "../../ugc/v1/tools";

/**
 * The Grokbot connector as an MCP server (streamable HTTP, stateless, JSON responses). Same key
 * check and the same four tools as /api/ugc/v1. Every request carries the bearer key.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authorize(request);
  if (auth instanceof Response) return auth;

  const server = new McpServer({ name: "hydra-ugc", version: "1.0.0" });
  for (const name of Object.keys(TOOLS) as ToolName[]) {
    const t = TOOLS[name];
    server.registerTool(
      name,
      { description: t.description, inputSchema: t.input, annotations: { readOnlyHint: t.readOnly } },
      async (args: unknown) => {
        const result = await runTool(name, auth.db, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
      },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
