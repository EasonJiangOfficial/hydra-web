import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { z } from "zod";
import { undoActivity } from "@/lib/activity/actions";
import { listActivity } from "@/lib/activity/queries";
import { UNDO_DAYS, type ActivityEntry } from "@/lib/activity/types";
import { defineTool, gateFor, jsonSchemaOf, ToolError, uuid, type Gate, type Outcome, type ToolCtx, type ToolDef, type ToolGroup } from "./registry";
import { AGENT_TOOLS } from "./tools-agent";
import { GOOGLE_TOOLS } from "./tools-google";
import { HYDRA_TOOLS } from "./tools-hydra";
import { NOTE_TOOLS } from "./tools-notes";
import { SETTINGS_TOOLS } from "./tools-settings";
import { TAX_TOOLS } from "./tools-taxes";

/**
 * The tool layer: the registry, the one path every tool call takes (validate, gate, run, log with
 * its inverse), and undo. The live turn, routines, MCP and the routes all go through executeTool.
 */

export type ExecResult =
  | { status: "ok"; data: unknown; summary: string; actionId: string | null }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string }
  | { status: "confirm"; gate: Gate };

export const ALL_GROUPS: ReadonlySet<ToolGroup> = new Set(["hydra", "routines", "memory", "ui", "mac", "gmail", "calendar"]);

/** Tools that act outside Hydra's database (keep in step with activity_list in 0130_activity.sql). */
export const OUTSIDE_TOOL = /^(gmail|calendar|mac)_/;

/**
 * Until agent writes are tagged with their action (DESIGN decision 10), a step outside a routine ran
 * through the owner's session, so its Hydra rows are already an Activity entry with an exact undo.
 * Its tool inverse would undo the same change a second time (a second copy of a restored rule).
 */
export const rowsLogged = (a: { tool: string; surface: string }) => a.surface !== "routine" && !OUTSIDE_TOOL.test(a.tool);

const undoTool = defineTool({
  name: "undo_action",
  description: "Undo one of Hydra's own steps (hydraActions in list_activity), for what undo_activity cannot: an email label, a calendar change.",
  group: "hydra",
  kind: "read", // the inverse it runs is logged, not the undo itself
  input: z.object({ actionId: uuid }),
  gate: async (ctx, { actionId }) => {
    const action = await ctx.store.getAction(actionId);
    const inverse = action?.inverse ? toolByName(action.inverse.tool) : undefined;
    if (!action || !inverse || rowsLogged(action)) return null; // run() reports why
    const gate = await gateFor(inverse, ctx, action.inverse!.input);
    return gate && { ...gate, summary: `Undo: ${action.summary}` };
  },
  run: async (ctx, { actionId }) => {
    const r = await undoAction(actionId, ctx, { approved: true, refuseLogged: true });
    if (r.status !== "ok") throw new ToolError(r.status === "confirm" ? r.gate.summary : r.message);
    return { data: r.data, summary: r.summary };
  },
});

const activityTool = defineTool({
  name: "list_activity",
  description: `Activity: every change by the owner, Hydra or a routine, newest first, with undo state (kept ${UNDO_DAYS} days). before = next of the last page.`,
  group: "hydra",
  kind: "read",
  input: z.object({ limit: z.int().min(1).max(50).optional(), before: z.string().min(1).max(200).optional() }),
  run: async (ctx, { limit, before }) => {
    const page = await listActivity({ before, limit: limit ?? 20 });
    // Hydra's own steps with a tool undo, for undo_action (outside effects); first page only.
    const hydraActions = before
      ? undefined
      : (await ctx.store.recentActions(limit ?? 20))
          .filter((a) => a.inverse && !a.undone_at && !rowsLogged(a))
          .map((a) => ({ id: a.id, summary: a.summary, at: a.created_at }));
    return { data: { ...page, ...(hydraActions ? { hydraActions } : {}) }, summary: "Read activity" };
  },
});

/** `undoDeletes`: true when undoing the entry removes rows it added. The data unit sets it; unknown counts as true (asks). */
type Entry = ActivityEntry & { undoDeletes?: boolean };

/** One activity entry by id. */
async function findEntry(id: string): Promise<Entry | null> {
  let before: string | undefined;
  // ponytail: pages back through at most 1000 entries; a get-by-id read in the data unit if that is slow.
  for (let page = 0; page < 20; page++) {
    const { entries, next } = await listActivity({ before, limit: 50 });
    const hit: Entry | undefined = entries.find((e) => e.id === id);
    if (hit || !next) return hit ?? null;
    before = next;
  }
  return null;
}

const CANNOT: Record<NonNullable<ActivityEntry["cannotUndo"]>, string> = {
  expired: `That is older than ${UNDO_DAYS} days: it cannot be undone.`,
  undone: "That is already undone. Undo the undo to redo it.",
  outside: "That acted outside Hydra (an email, a payment). undo_action may undo Hydra's step, if it is in hydraActions.",
};
const UNDO_FAILED: Record<"expired" | "already_undone" | "not_found" | "failed", string> = {
  expired: CANNOT.expired,
  already_undone: CANNOT.undone,
  not_found: "That activity is gone.",
  failed: "The undo did not work. Nothing was changed.",
};

const undoActivityTool = defineTool({
  name: "undo_activity",
  description: "Undo one activity entry by its id from list_activity (\"undo that\": the newest entry's id). Undoing an undo redoes it. force undoes even when the rows changed since.",
  group: "hydra",
  kind: "write",
  // The id is required: the owner approves one named entry, and the approved call undoes that entry,
  // not whatever is newest when the yes arrives.
  input: z.object({ id: uuid, force: z.boolean().optional() }),
  // Asks only when the undo deletes what the owner made (undoing a create), or overwrites later changes (force).
  gate: async (_ctx, { id, force }) => {
    const e = await findEntry(id);
    if (!e?.canUndo) return null; // run() says why
    if (force) return { reason: "delete", summary: `Undo anyway, over later changes: ${e.summary}`, danger: true };
    return e.undoDeletes === false ? null : { reason: "delete", summary: `Undo: ${e.summary}`, danger: true };
  },
  run: async (_ctx, { id, force }) => {
    const e = await findEntry(id);
    if (!e) throw new ToolError(UNDO_FAILED.not_found);
    if (!e.canUndo) throw new ToolError(CANNOT[e.cannotUndo ?? "undone"]);
    const r = await undoActivity(e.id, { force });
    if (!r.ok) {
      if (r.error === "changed_since" && r.blocked) throw new ToolError(`It cannot be undone: ${r.changed.join("; ")}. Undoing anyway would not help.`);
      if (r.error === "changed_since") throw new ToolError(`Changed since: ${r.changed.join("; ")}. Ask the owner before undoing anyway (force).`);
      throw new ToolError(UNDO_FAILED[r.error]);
    }
    return { data: { undoId: r.undoId, undid: e.summary }, summary: `Undid: ${e.summary}`, inverse: { tool: "undo_activity", input: { id: r.undoId } } };
  },
});

/** Every tool, in a fixed order (the order is part of the cached prompt prefix). */
export const TOOLS: readonly ToolDef[] = [...HYDRA_TOOLS, ...TAX_TOOLS, ...SETTINGS_TOOLS, activityTool, undoActivityTool, undoTool, ...AGENT_TOOLS, ...NOTE_TOOLS, ...GOOGLE_TOOLS];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export function toolByName(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/**
 * The API's strict-mode budget per request, across every strict schema (structured outputs docs,
 * "Schema complexity limits"): 20 strict tools, 24 optional parameters, 16 union-typed parameters.
 * Going over is a 400 on every request, so strict goes to the tools that delete first, then to the
 * rest in registry order while the budget lasts. Every tool, strict or not, is validated with zod
 * before it runs.
 */
export const STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 } as const;

type Schema = { [k: string]: unknown };

/** Optional and union-typed parameters in a schema, nested ones included. */
export function schemaCost(node: unknown): { optional: number; unions: number } {
  const cost = { optional: 0, unions: 0 };
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const s = n as Schema;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const required = new Set((s.required as string[] | undefined) ?? []);
    for (const [key, prop] of Object.entries(props)) {
      if (!required.has(key)) cost.optional++;
      if (Array.isArray(prop.anyOf) || Array.isArray(prop.type)) cost.unions++;
      walk(prop);
    }
    walk(s.items);
    for (const k of ["anyOf", "allOf"]) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach(walk);
  };
  walk(node);
  return cost;
}

/** Messages API tool definitions for the groups a caller may use: eager input streaming, strict within the budget. */
export function anthropicTools(allowed: ReadonlySet<ToolGroup>): BetaTool[] {
  const defs = TOOLS.filter((t) => allowed.has(t.group));
  const schemas = new Map(defs.map((t) => [t.name, transformJSONSchema(jsonSchemaOf(t.input)) as BetaTool["input_schema"]]));
  const strict = new Set<string>();
  const used = { optional: 0, unions: 0 };
  const deletesFirst = [...defs.filter((t) => t.risk === "delete"), ...defs.filter((t) => t.risk !== "delete")];
  for (const t of deletesFirst) {
    if (strict.size >= STRICT_LIMITS.tools) break;
    const cost = schemaCost(schemas.get(t.name));
    if (used.optional + cost.optional > STRICT_LIMITS.optional || used.unions + cost.unions > STRICT_LIMITS.unions) continue;
    used.optional += cost.optional;
    used.unions += cost.unions;
    strict.add(t.name);
  }
  const tools: BetaTool[] = defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: schemas.get(t.name)!,
    ...(strict.has(t.name) ? { strict: true } : {}),
    eager_input_streaming: true,
  }));
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  return tools;
}

/**
 * One tool call: validate, gate, run, log. A gated call comes back as `confirm` unless
 * `approved` (the owner said yes, or tapped undo). A write is logged with its inverse.
 */
export async function executeTool(
  name: string,
  raw: unknown,
  ctx: ToolCtx,
  opts: { approved?: boolean; approvalId?: string | null } = {},
): Promise<ExecResult> {
  const def = toolByName(name);
  if (!def) return { status: "error", message: `There is no tool named ${name}.` };
  if (!ctx.allowed.has(def.group)) return { status: "error", message: `${name} is not allowed here.` };
  const parsed = def.input.safeParse(raw);
  if (!parsed.success) return { status: "invalid", message: z.prettifyError(parsed.error) };
  if (!opts.approved) {
    const gate = await gateFor(def, ctx, parsed.data);
    if (gate) return { status: "confirm", gate };
  }
  let out: Outcome;
  try {
    out = await def.run(opts.approvalId ? { ...ctx, approvalId: opts.approvalId } : ctx, parsed.data);
  } catch (error) {
    if (error instanceof ToolError) return { status: "error", message: error.message };
    console.error(`[agent] ${name}: ${(error as Error).message}`);
    return { status: "error", message: "That did not work. Nothing was changed by Hydra after the failure." };
  }
  let actionId: string | null = null;
  if (def.kind === "write") {
    actionId = await ctx.store.logAction({
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      device_id: ctx.deviceId,
      tool: name,
      input: (raw ?? {}) as Record<string, unknown>,
      result: out.data ?? null,
      summary: out.summary.slice(0, 500),
      inverse: out.inverse ?? null,
      surface: ctx.surface,
    });
    if (ctx.runId) await ctx.store.addRunAction(ctx.runId, actionId);
  }
  if (out.ui) ctx.ui(out.ui);
  return { status: "ok", data: out.data, summary: out.summary, actionId };
}

/**
 * Undo one logged action by running its inverse. The claim is a compare-and-set, so a double tap
 * or two devices undo once. A failed inverse releases the claim. Without `approved`, an inverse
 * that is itself gated (undoing a create deletes) comes back as `confirm`. `refuseLogged` (Activity and
 * undo_action): a step whose rows are already an Activity entry is not undone a second way.
 */
export async function undoAction(actionId: string, ctx: ToolCtx, opts: { approved: boolean; refuseLogged?: boolean }): Promise<ExecResult> {
  const action = await ctx.store.getAction(actionId);
  if (!action) return { status: "error", message: "That action is gone." };
  if (!action.inverse) return { status: "error", message: "That action cannot be undone." };
  if (action.undone_at) return { status: "error", message: "That action is already undone." };
  if (opts.refuseLogged && rowsLogged(action)) return { status: "error", message: "Undo this in Activity: its changes are logged there." };
  const everything = { ...ctx, allowed: ALL_GROUPS };
  if (!opts.approved) {
    const inverse = toolByName(action.inverse.tool);
    const gate = inverse ? await gateFor(inverse, everything, action.inverse.input) : null;
    if (gate) return { status: "confirm", gate: { ...gate, summary: `Undo: ${action.summary}` } };
  }
  if (!(await ctx.store.claimUndo(actionId))) return { status: "error", message: "That action is already undone." };
  const result = await executeTool(action.inverse.tool, action.inverse.input, everything, { approved: true });
  await ctx.store.finishUndo(actionId, result.status === "ok" ? result.actionId : null, result.status === "ok");
  return result.status === "ok" ? { ...result, summary: `Undid: ${action.summary}` } : result;
}
