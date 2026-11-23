import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Surface, UiAction } from "./events";
import type { AgentStore, GateReason, Inverse } from "./store";

/**
 * The tool contract. Every tool: a short description, a zod input (the JSON schema the model sees
 * and the validation that runs before the tool does), and how it is gated. Writes return the
 * inverse that undoes them (null when nothing can). Hydra tools call the engines' typed actions
 * and queries, the same ones the pages call; never SQL.
 */

/** Tool families. A routine names the ones it may use (hydra, mac, gmail, calendar). */
export type ToolGroup = "hydra" | "routines" | "memory" | "ui" | "mac" | "gmail" | "calendar";
export type Risk = "delete" | "send" | "pay" | "mac";

export interface Gate {
  reason: GateReason;
  summary: string;
  danger: boolean;
}

export interface ToolCtx {
  store: AgentStore;
  /** The owner's session client (RLS applies). Engine queries take it. */
  db: SupabaseClient;
  surface: Surface;
  threadId: string | null;
  runId: string | null;
  deviceId: string | null;
  /** A routine run: nobody is there to say yes. */
  unattended: boolean;
  /** Tool groups this caller may use. */
  allowed: ReadonlySet<ToolGroup>;
  now(): Date;
  timeZone(): Promise<string>;
  ui(action: UiAction): void;
  /** Set only on a call the owner approved: the agent_approvals id (Gmail send and trash need it). */
  approvalId?: string | null;
  /** 0200: approve all let this call through (no owner yes). A Mac step then binds to a desktop that tags deletions. */
  autoApproved?: boolean;
}

export interface Outcome {
  data: unknown;
  /** One short line for the activity list and the tool event. */
  summary: string;
  inverse?: Inverse | null;
  ui?: UiAction;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  group: ToolGroup;
  kind: "read" | "write";
  input: S;
  /** Deletion, sending or paying: the owner must say yes first. */
  risk?: Risk | ((input: z.output<S>) => Risk | null);
  /** Rows the call changes; "unknown" when it cannot be told before it runs (treated as bulk). */
  bulk?: (input: z.output<S>) => number | "unknown";
  /** Replaces risk and bulk when the gate needs the database (undo). */
  gate?: (ctx: ToolCtx, input: z.output<S>) => Promise<Gate | null>;
  /** What the confirm card says. */
  describe?: (input: z.output<S>) => string;
  run: (ctx: ToolCtx, input: z.output<S>) => Promise<Outcome>;
}

/** Keeps the input type for `run` while the registry holds plain ToolDefs. */
export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

/** A failure the model should hear about (bad id, not found, refused by an engine). */
export class ToolError extends Error {}

type EngineResult<T> =
  | { ok: true; data: T }
  | { ok: true; value: T }
  | { ok: false; error: string | { code?: string; message: string } }
  | { ok: false; reason: string };

/** The data of an engine ActionResult / PlanningResult, or a ToolError with its message. */
export function unwrap<T>(result: EngineResult<T>): T {
  if (result.ok) return "data" in result ? result.data : result.value;
  if ("reason" in result) throw new ToolError(`Refused: ${result.reason}`);
  throw new ToolError(typeof result.error === "string" ? result.error : result.error.message);
}

export const BULK_LIMIT = 10;
const LIVE_REASON_DANGER: Record<GateReason, boolean> = { delete: true, send: true, pay: true, bulk: false, mac: true };

/** The confirm gate (DESIGN.md 6.9): every deletion, bulk over 10 rows, anything that sends or pays. */
export async function gateFor(def: ToolDef, ctx: ToolCtx, input: unknown): Promise<Gate | null> {
  if (def.gate) return def.gate(ctx, input);
  const describe = () => def.describe?.(input) ?? def.description.split(".")[0];
  const risk = typeof def.risk === "function" ? def.risk(input) : (def.risk ?? null);
  if (risk) return { reason: risk, summary: describe(), danger: LIVE_REASON_DANGER[risk] };
  const rows = def.bulk?.(input);
  if (rows === "unknown" || (typeof rows === "number" && rows > BULK_LIMIT)) {
    return { reason: "bulk", summary: `${describe()} (${rows === "unknown" ? "many rows" : `${rows} rows`})`, danger: false };
  }
  return null;
}

/**
 * Approve all (0200, owner: "there should be a mode that approves all actions"): with it on, a gated step runs
 * without asking, except a deletion (reason "delete"), which always asks (owner rule: every deletion of anything).
 * A Mac step (reason "mac") runs without asking only when every Hydra Desktop that can take it declared
 * approveAllDeletionTags (relay-schema.ts): that Mac asks locally for any deletion-class action. An older Mac gets
 * the ask exactly as with approve all off. The caller still writes the approval row, already approved, and passes
 * its id (Gmail send needs it).
 */
export async function autoApproves(approveAll: boolean, gate: Pick<Gate, "reason">, store: Pick<AgentStore, "desktopsTagDeletions">) {
  if (!approveAll || gate.reason === "delete") return false;
  return gate.reason !== "mac" || (await store.desktopsTagDeletions());
}

/**
 * Words of a Mac step that can delete or lose something (files, a drive, a table, a process, unsaved work). A fail
 * closed extra layer: a match can only add an ask (it makes a step a deletion), never remove one. The structured
 * tags decide first (mac_do's deletes flag; a relay ask's `deletion` from the Mac's own per-action tag). ponytail:
 * a word list, not intent; it over-asks ("clear the search field", "git checkout main") by design.
 */
const MAC_DELETES = new RegExp(
  [
    String.raw`\b(delet\w*|trash\w*|remov\w*|eras\w*|wip\w*|empt\w*|rm|rmdir|srm|mv|cp|dd|shred\w*|purg\w*|uninstall\w*|bin|clear\w*|discard\w*|throw\w*|rid|nuk\w*)\b`,
    String.raw`\b((re)?format\w*|clean\w*|destroy\w*|overwrit\w*|replac\w*|reset\w*|unlink\w*|revert\w*|lose\w*|losing|loss\w*|lost|unsaved)\b`,
    String.raw`\b((p|x)?kill\w*|force\w*|terminat\w*|drop\w*|truncat\w*|backspace|prun\w*|rimraf|diskutil|zerodisk|tee)\b`,
    // Unsaved work: "Don't Save", "without saving", "do not keep changes", "saving no", No or Cmd+D on a save prompt.
    String.raw`\b(without sav\w*|don'?t (sav|keep)\w*|do not (sav|keep)\w*|saving no|(click|press|choose|select|answer|say|hit) "?no\b)`,
    String.raw`\b(cmd|command)( ?[+-] ?| )d\b|\u2318 ?d\b`,
    // git: a branch delete (-d, -D, -fd), a checkout or restore that drops edits, an update ... set in SQL.
    String.raw`\bbranch (-\w*d\b|--delete)|\bgit (checkout|restore)\b|\bupdate \S+ set\b`,
    // Shell: a redirect onto a path or a file with an extension ("> notes.txt", ":>log.txt", "> /dev/disk2"), any device file.
    String.raw`(?<![-=>])>(?![>=]) ?([~/.]|[\w-]+\.\w)|\/dev\/|[\u232b\u2326]`,
  ].join("|"),
  "u",
);
/** The words as matched: NFKC, no invisible format characters (\p{Cf}), plain quotes and dashes, one space, lowercase. */
export const foldWords = (words: string) =>
  words
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2018\u2019\u201b\u02bc\u0060\u00b4\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
export const macDeletes = (words: string) => MAC_DELETES.test(foldWords(words));

/** The JSON schema the API sees: strict-mode compatible (the SDK's own transform). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return tuplesToArrays(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as Record<string, unknown>;
}

/** Structured outputs have no tuples: a [min, max] pair becomes an array (zod still checks the length). */
function tuplesToArrays(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tuplesToArrays);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = tuplesToArrays(v);
  if (Array.isArray(out.prefixItems)) {
    const n = out.prefixItems.length;
    out.items = out.prefixItems[0] ?? {};
    delete out.prefixItems;
    out.description = `${out.description ? `${out.description} ` : ""}Exactly ${n} items.`;
  } else if (out.items === false) delete out.items;
  return out;
}

// Shared input pieces.
export const uuid = z.uuid();
export const day = z.iso.date();
export const instant = z.iso.datetime({ offset: true });
export { scopeSchema } from "./relay-schema";
