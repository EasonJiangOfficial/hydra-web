import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asData } from "./prompt";
import { autoApproves, jsonSchemaOf, type ToolCtx } from "./registry";
import { executeTool, TOOLS, type ExecResult } from "./tools";

/**
 * The Hydra Agent's tools over MCP (streamable HTTP, stateless, JSON responses) for a paired device
 * (Hydra Desktop, Claude Code). Same registry, same gate: a gated tool is not run; it returns an
 * approval id, the owner says yes in Hydra (his own session: /api/agent/state lists it under
 * pendingApprovals; no device may approve it), and the same device calls the same tool again with
 * `approvalId` and the same arguments before it expires.
 */

const MCP_APPROVAL_MS = 15 * 60_000;

/** Stable JSON: the approved input and the retried input must be the same call. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], isError });

/** A ran step's row: its result and action, or the error (the audit trail, as the loop's settleApproval keeps it). */
const settled = (res: ExecResult) =>
  res.status === "ok"
    ? { result: res.data ?? null, action_id: res.actionId }
    : { result: { error: res.status === "confirm" ? res.gate.summary : res.message }, action_id: null };

/** Approve all: one auto-approved run per device, tool and input within DEDUPE_MS of the last one (a sliding window). */
const DEDUPE_MS = 2 * 60_000;
const dedupeKey = (ctx: ToolCtx, name: string, input: unknown) =>
  `mcp:${ctx.deviceId ?? "owner"}:${name}:${createHash("sha256").update(stable(input)).digest("hex").slice(0, 32)}`;

export function listMcpTools(ctx: Pick<ToolCtx, "allowed">) {
  return TOOLS.filter((t) => ctx.allowed.has(t.group)).map((t) => {
    const schema = jsonSchemaOf(t.input) as { type: "object"; properties?: Record<string, unknown>; required?: string[] };
    return {
      name: t.name,
      description: t.description,
      inputSchema: {
        ...schema,
        type: "object" as const,
        properties: {
          ...schema.properties,
          approvalId: { type: "string", format: "uuid", description: "The owner's approval for a call that needs his yes." },
        },
      },
    };
  });
}

export async function callMcpTool(name: string, args: Record<string, unknown> | undefined, ctx: ToolCtx): Promise<CallToolResult> {
  const { approvalId, ...input } = args ?? {};
  if (typeof approvalId === "string") {
    const approval = await ctx.store.getApproval(approvalId);
    if (
      !approval ||
      approval.source !== "mcp" ||
      approval.tool !== name ||
      approval.device_id !== ctx.deviceId ||
      stable(approval.input) !== stable(input)
    ) {
      return text("That approval does not match this call.", true);
    }
    if (approval.expires_at <= ctx.now().toISOString()) {
      // Never left 'approved' for a step that can no longer run: the run it belongs to can settle.
      await ctx.store.moveApproval(approvalId, ["pending", "approved"], "expired");
      return text("That approval has expired. Ask again.", true);
    }
    const claimed = await ctx.store.moveApproval(approvalId, ["approved"], "done");
    if (!claimed) return text(`Not approved (${approval.status}).`, true);
    const res = await executeTool(name, input, ctx, { approved: true, approvalId });
    await ctx.store.moveApproval(approvalId, ["done"], res.status === "ok" ? "done" : "failed", settled(res));
    return res.status === "ok" ? text(asData(res.data)) : text(res.status === "confirm" ? res.gate.summary : res.message, true);
  }
  const res = await executeTool(name, input, ctx);
  // Approve all (0200; the settings are read once per call, only when a gate fires): a non-delete step runs in this
  // same call, with its row written already approved (the audit trail; Gmail send checks it). A deletion still asks.
  // The same call from the same device again within DEDUPE_MS of the last auto-approved one (a retry, or two at once)
  // finds its key taken (a unique column, so it holds across instances) and asks the owner instead: never two sends.
  const approval =
    res.status === "confirm" && (await autoApproves((await ctx.store.settings()).approveAll, res.gate, ctx.store))
      ? await ctx.store.createApprovalOnce({
          source: "mcp",
          thread_id: null,
          run_id: null,
          device_id: ctx.deviceId,
          tool: name,
          input,
          summary: res.gate.summary,
          reason: res.gate.reason,
          danger: res.gate.danger,
          status: "approved",
          expires_at: new Date(ctx.now().getTime() + MCP_APPROVAL_MS).toISOString(),
          dedupe_key: dedupeKey(ctx, name, input),
        }, new Date(ctx.now().getTime() - DEDUPE_MS).toISOString())
      : null;
  if (approval) {
    const ran = await executeTool(name, input, { ...ctx, autoApproved: true }, { approved: true, approvalId: approval.id });
    await ctx.store.moveApproval(approval.id, ["approved"], ran.status === "ok" ? "done" : "failed", settled(ran));
    return ran.status === "ok" ? text(asData(ran.data)) : text(ran.status === "confirm" ? ran.gate.summary : ran.message, true);
  }
  if (res.status === "confirm") {
    const approval = await ctx.store.createApproval({
      source: "mcp",
      thread_id: null,
      run_id: null,
      device_id: ctx.deviceId,
      tool: name,
      input,
      summary: res.gate.summary,
      reason: res.gate.reason,
      danger: res.gate.danger,
      expires_at: new Date(ctx.now().getTime() + MCP_APPROVAL_MS).toISOString(),
    });
    await ctx.store.notify({ kind: "approval", title: "Hydra needs your yes", body: res.gate.summary, href: null, dedupe_key: `approval:${approval.id}` });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ needsApproval: true, approvalId: approval.id, summary: res.gate.summary, danger: res.gate.danger, expiresAt: approval.expires_at }),
        },
      ],
      structuredContent: { needsApproval: true, approvalId: approval.id, summary: res.gate.summary, danger: res.gate.danger },
    };
  }
  if (res.status === "ok") return text(asData(res.data));
  return text(res.message, true);
}

/** Serve one MCP HTTP request. */
export async function handleMcp(request: Request, ctx: ToolCtx): Promise<Response> {
  const server = new Server({ name: "hydra-agent", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listMcpTools(ctx) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callMcpTool(req.params.name, req.params.arguments, ctx));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
