import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { SURFACES, type AgentEvent, type Emit, type Scope, type Usage } from "./events";
import { localTurnSchema, relayEventSchema, slotSchema } from "./relay-schema";
import { avatarStyle } from "./prompt";
import type { AddedInput, AgentStore, ApprovalRow, Avatar } from "./store";

/**
 * The Mac is the brain (W3 contract and its fixes). The web and the phone queue a turn here; Hydra
 * Desktop claims it (GET /api/agent/relay/next?slot=live|routine), runs it on the owner's Claude
 * login and posts its events back under the claim's id (POST /api/agent/relay/events); the turn route
 * streams them to the browser in order. Asks the Mac would show locally become relay approvals
 * (POST /api/agent/relay/approval). Tables and the claim, append and sweep functions are in migration
 * 0120; `memoryRelay` in testing.ts is the same contract in memory.
 */

/** A Mac whose relay loop (claim or event post) ran this recently is online (it long-polls every 25 s). */
export const RELAY_ONLINE_MS = 45_000;
/** A claim holds the turn this long; every event post renews it (the Mac sends an empty batch every 20 s). */
export const RELAY_LEASE_S = 60;
/** The web side waits this long for the Mac, inside the turn route's 300 s life. Routine turns have no cap. */
export const RELAY_TURN_MS = 280_000;
export const RELAY_POLL_MS = 250;
/** A relay approval in a live turn lasts as long as an MCP one; a routine's waits a day. */
export const RELAY_APPROVAL_LIVE_MS = 15 * 60_000;
export const RELAY_APPROVAL_ROUTINE_MS = 24 * 60 * 60_000;
/** Messages of the thread the Mac gets with a turn (newest last). */
export const RELAY_HISTORY = 20;
/** The waiting turn route re-queues or fails lapsed leases this often (the Mac may be gone). */
const SWEEP_EVERY_MS = 5_000;

export type RelayInput = { text: string } | { audioTranscript: string };
export type RelaySurface = "web" | "phone" | "desktop" | "routine";
/** agent_devices.role (0121): mac is Hydra Desktop, brain is Hydra's server. */
export type RelayRole = "mac" | "brain";
export type RelayStatus = "queued" | "claimed" | "done" | "error" | "expired";
export type AppendResult = "claimed" | "done" | "error" | "not_found" | "stale_claim" | "not_yours" | "seq_gap";
export interface RelayContext {
  path: string;
  search: string;
  scope: Scope;
}

export interface RelayTurnRow {
  id: string;
  thread_id: string;
  input: RelayInput;
  surface: RelaySurface;
  context: RelayContext;
  routine_run_id: string | null;
  allowed_tools: string[] | null;
  status: RelayStatus;
  claimed_by: string | null;
  claim_id: string | null;
  claim_seq: number;
  lease_until: string | null;
  attempts: number;
  created_at: string;
  /** A sub-turn (0160): the brain's turn it was made in. Only a Mac claims it; nothing of it goes into the thread. */
  parent_turn_id?: string | null;
}
export type NewRelayTurn = Pick<RelayTurnRow, "thread_id" | "input" | "surface" | "context"> &
  Partial<Pick<RelayTurnRow, "routine_run_id" | "allowed_tools">>;
/** agent_relay_subturn's outcome (0160): queued, mac_offline (closed at once), or a refusal with no sub-turn. */
export type SubturnOutcome = "queued" | "mac_offline" | "not_found" | "stale_claim" | "not_yours" | "not_brain" | "not_live";

/** What the Mac receives for one claimed turn. */
export interface RelayTurnOut {
  id: string;
  /** Names this claim on every event post; a new one per claim. */
  claimId: string;
  threadId: string;
  input: RelayInput;
  surface: RelaySurface;
  context: RelayContext;
  /** The thread so far (text only, oldest first), so a follow-up has its context. Outside text: data. */
  history: { role: "user" | "assistant"; text: string }[];
  routineId?: string;
  routineRunId?: string;
  allowedTools?: string[];
  /** A sub-turn: the brain's turn that asked the Mac (its input is the brain's instruction, not the owner's words). */
  parentTurnId?: string;
  /** 0220: the active avatar, and its style as instructions for the brain to put after its system prompt (absent: none). */
  avatar?: Avatar;
  style?: string;
}

export interface RelayStore {
  /** A live device with the relay scope ran its relay loop since `since`: of `role` when given, else the server brain or a Mac. */
  macOnline(since: Date, role?: RelayRole): Promise<boolean>;
  /** A device's role (0121), or null when it is unknown. */
  deviceRole(deviceId: string): Promise<RelayRole | null>;
  createTurn(turn: NewRelayTurn): Promise<string>;
  getTurn(id: string): Promise<RelayTurnRow | null>;
  /** The newest relay turn of a routine run, or null. */
  turnForRun(runId: string): Promise<RelayTurnRow | null>;
  /** The routine a run belongs to (for the Mac's turn payload). */
  routineOfRun(runId: string): Promise<string | null>;
  eventsAfter(turnId: string, seq: number): Promise<{ seq: number; event: AgentEvent }[]>;
  /** Compare-and-set to expired while the turn is in one of `from`. */
  expire(turnId: string, from: RelayStatus[]): Promise<boolean>;
  /** Lapsed leases: re-queue once, then fail with an error event. */
  sweep(): Promise<number>;
  /** Service role: the oldest queued turn of the slot (null: either) for this device (one device wins), or null. */
  claim(deviceId: string, leaseSeconds: number, slot?: RelaySlot | null): Promise<RelayTurnRow | null>;
  /** Service role: store events in order under the claim (seq dedupes a retry), renew the lease, close on done/error. */
  append(turnId: string, deviceId: string, claimId: string, seq: number | null, events: RelayEvent[], leaseSeconds: number): Promise<AppendResult>;
  /**
   * Service role: a relay approval of the turn, made in one locked step only while this device's claim
   * holds it open (a closing turn ends it with the rest). Null when the turn is not open under that claim.
   */
  createApproval(turnId: string, deviceId: string, claimId: string, ask: { summary: string; danger: boolean; expiresAt: string }): Promise<ApprovalRow | null>;
  /** Service role: the brain makes a sub-turn of the turn it holds under that claim (agent_relay_subturn, 0160). */
  createSubturn(parentId: string, deviceId: string, claimId: string, instruction: string): Promise<{ id: string | null; outcome: SubturnOutcome }>;
  /**
   * Service role (0191): the device holding this claim acknowledges the owner's additions up to `seen` and
   * gets the rest, oldest first. Nothing for another device, a stale claim or a turn no longer claimed.
   */
  inputsAck(turnId: string, deviceId: string, claimId: string, seen: number | null): Promise<AddedInput[]>;
}

// ---------------------------------------------------------------------------
// The events a Mac may post: the shapes and limits live in relay-schema.ts (zod only, plain JS
// syntax), the one source Hydra Desktop copies verbatim. Exported from here too.
// ---------------------------------------------------------------------------

export {
  internalHref,
  LIMITS,
  localTurnSchema,
  relayApprovalSchema,
  relayBatchSchema,
  relayEventSchema,
  relaySubturnSchema,
  slotSchema,
  subturnResultSchema,
  uiActionSchema,
  usageSchema,
} from "./relay-schema";
export type RelayEvent = z.infer<typeof relayEventSchema>;
export type RelaySlot = z.infer<typeof slotSchema>;

const isEnd = (e: { type: string }) => e.type === "done" || e.type === "error";

/** A stored event as the browser gets it (done always carries all four counts; missing ones are 0). */
function toClient(event: AgentEvent | RelayEvent): AgentEvent {
  if (event.type !== "done") return event as AgentEvent;
  const given = (event as { usage?: Record<string, unknown> }).usage ?? {};
  const n = (k: keyof Usage) => (typeof given[k] === "number" ? (given[k] as number) : 0);
  return {
    type: "done",
    usage: {
      input_tokens: n("input_tokens"),
      output_tokens: n("output_tokens"),
      cache_read_input_tokens: n("cache_read_input_tokens"),
      cache_creation_input_tokens: n("cache_creation_input_tokens"),
    },
  };
}

/** The thread so far as plain text, oldest first (tool calls, results and the server loop's page context left out). */
export async function threadHistory(store: AgentStore, threadId: string, limit = RELAY_HISTORY): Promise<RelayTurnOut["history"]> {
  const rows = await store.threadMessages(threadId, limit);
  return rows
    .slice()
    .reverse()
    .map((m) => ({
      role: m.role,
      text: (typeof m.content === "string" ? m.content : (m.content ?? []).flatMap((b) => (b.type === "text" && !b.text.startsWith("<context>") ? [b.text] : [])).join("\n")).trim(),
    }))
    .filter((m) => m.text.length > 0);
}

export function turnOut(row: RelayTurnRow, routineId: string | null, history: RelayTurnOut["history"] = [], avatar: Avatar | null = null): RelayTurnOut {
  const style = avatarStyle(avatar);
  return {
    id: row.id,
    claimId: row.claim_id ?? "",
    threadId: row.thread_id,
    input: row.input,
    surface: row.surface,
    context: row.context,
    history,
    ...(routineId ? { routineId } : {}),
    ...(row.routine_run_id ? { routineRunId: row.routine_run_id } : {}),
    ...(row.allowed_tools ? { allowedTools: row.allowed_tools } : {}),
    ...(row.parent_turn_id ? { parentTurnId: row.parent_turn_id } : {}),
    ...(avatar && style ? { avatar, style } : {}),
  };
}

/**
 * What the brain gets for a sub-turn (GET /relay/subturn): the Mac's words; on error or expiry its
 * words so far, then the reason (an expired one: the Mac took too long, or went offline before it took it).
 */
export function subturnResult(status: RelayStatus, events: { event: AgentEvent }[], expiredText: string = MAC_TIMEOUT.message): { status: RelayStatus; text: string } {
  const said = events.flatMap(({ event }) => (event.type === "text" ? [event.delta] : [])).join("").trim();
  const err = events.findLast(({ event }) => event.type === "error")?.event;
  const reason = status === "error" ? (err?.type === "error" ? err.message : "") : status === "expired" ? expiredText : "";
  return { status, text: [said, reason].filter(Boolean).join("\n") };
}

/**
 * What the Mac sees of an approval. approved: go on (done: a relay ask already handed over).
 * failed or expired: never call it (an MCP step that already ran and failed is not run again).
 */
export function approvalStatus(a: Pick<ApprovalRow, "status" | "expires_at">, now = new Date()): "pending" | "approved" | "declined" | "expired" {
  if (a.status === "pending") return a.expires_at > now.toISOString() ? "pending" : "expired";
  if (a.status === "approved" || a.status === "done") return "approved";
  if (a.status === "declined") return "declined";
  return "expired";
}

// ---------------------------------------------------------------------------
// The web side of a turn when the Mac is the brain.
// ---------------------------------------------------------------------------

/** Neither Hydra's server (a brain device) nor the owner's Mac is online. Older clients also know mac_offline. */
export const BRAIN_OFFLINE = { type: "error", code: "brain_offline", message: "Hydra is offline." } as const;
export const MAC_TIMEOUT = { type: "error", code: "mac_timeout", message: "Your Mac took too long." } as const;
/** A turn typed in Hydra Desktop needs the Mac, and no Mac is online. */
export const MAC_OFFLINE = { type: "error", code: "mac_offline", message: "Your Mac is offline." } as const;
/** The brain held the turn (or should have): Hydra's words, not the Mac's (0121's sweep says brain_failed too). */
export const BRAIN_TIMEOUT = { type: "error", code: "brain_timeout", message: "Hydra took too long." } as const;
export const BRAIN_FAILED = { type: "error", code: "brain_failed", message: "Hydra stopped answering." } as const;

/** A turn only a Mac can run (0121's agent_relay_needs_mac): typed in Hydra Desktop, or a routine with Mac tools. */
export const needsMac = (t: Pick<RelayTurnRow, "surface" | "allowed_tools">) => t.surface === "desktop" || (t.allowed_tools ?? []).includes("mac");

export interface RelayTurnInput {
  relay: RelayStore;
  store: AgentStore;
  surface: "web" | "phone" | "desktop";
  threadId?: string;
  input: RelayInput;
  context: RelayContext;
  emit: Emit;
  signal?: AbortSignal;
  /** When the request arrived: the 280 s budget counts from here. */
  startedAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Queue the turn for the brain (the server when online, else the Mac: the claim routes it, 0121) and
 * stream its events in order until done or error. Neither online: `thread` then `error brain_offline`,
 * at once, and the owner's words still go into the thread. A turn typed in Hydra Desktop runs only on a Mac
 * (none online: `error mac_offline`). No end after 280 s: `error mac_timeout` (`brain_timeout` when the
 * brain held it), and the turn is expired (its open approvals end, the Mac's next
 * post gets 409). The client leaving expires a turn no Mac took yet. Closing a turn any way writes
 * the owner's words and the reply so far into the thread (the 0120 close trigger).
 */
export async function relayTurn(o: RelayTurnInput): Promise<void> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? wait;
  const text = "text" in o.input ? o.input.text : o.input.audioTranscript;
  const given = o.threadId && (await o.store.threadExists(o.threadId)) ? o.threadId : null;
  // A turn typed in Hydra Desktop is about the Mac: only a Mac runs it (the brain has no Mac tools).
  const macOnly = needsMac({ surface: o.surface, allowed_tools: null });
  if (!(await o.relay.macOnline(new Date(now() - RELAY_ONLINE_MS), macOnly ? "mac" : undefined))) {
    // No empty thread for a turn that never ran: it would hide the shared conversation.
    const threadId = given ?? (await o.store.recentThreads(1, SURFACES))[0]?.id ?? (await o.store.createThread(o.surface, text.slice(0, 80)));
    o.emit({ type: "thread", threadId });
    o.emit(macOnly ? MAC_OFFLINE : BRAIN_OFFLINE);
    try {
      await o.store.appendMessage(threadId, { role: "user", content: [{ type: "text", text }] }, o.surface);
    } catch (error) {
      console.error(`[agent] relay offline words: ${(error as Error).message}`);
    }
    return;
  }
  const threadId = given ?? (await o.store.createThread(o.surface, text.slice(0, 80)));
  const turnId = await o.relay.createTurn({ thread_id: threadId, input: o.input, surface: o.surface, context: o.context });
  o.emit({ type: "thread", threadId });
  // What the owner says or types while it works is added to this turn (POST /api/agent/turn/append, 0191).
  o.emit({ type: "turn", turnId });
  let seq = 0;
  let swept = now();
  for (;;) {
    if (o.signal?.aborted) {
      await o.relay.expire(turnId, ["queued"]);
      return;
    }
    for (const row of await o.relay.eventsAfter(turnId, seq)) {
      seq = row.seq;
      o.emit(toClient(row.event));
      if (isEnd(row.event)) return;
    }
    if (now() - o.startedAt >= RELAY_TURN_MS) {
      // A Mac that closed the turn just now wins the race: read its last events next time round.
      const held = (await o.relay.getTurn(turnId))?.claimed_by;
      if (await o.relay.expire(turnId, ["queued", "claimed"])) {
        // The brain held it, or no one did while a brain was online (it should have): Hydra's words.
        const brain = held
          ? (await o.relay.deviceRole(held)) === "brain"
          : !macOnly && (await o.relay.macOnline(new Date(now() - RELAY_ONLINE_MS), "brain"));
        o.emit(brain ? BRAIN_TIMEOUT : MAC_TIMEOUT);
        return;
      }
    } else if (now() - swept >= SWEEP_EVERY_MS) {
      swept = now();
      await o.relay.sweep();
    }
    await sleep(RELAY_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// The Mac's own turns (local voice on Hydra Desktop) join the shared thread.
// ---------------------------------------------------------------------------

/** A Mac turn without a thread joins the owner's newest thread when it moved this recently. */
export const LOCAL_THREAD_MS = 30 * 60_000;
export type LocalTurn = z.infer<typeof localTurnSchema>;

/**
 * Appends the owner's words and Hydra's reply (an empty reply is not stored: an empty text block is not a
 * message) to the given thread, or to his newest thread updated within 30 minutes of `at` (never later
 * than now), or to a new desktop thread. Returns the thread, or null when the given thread is not his.
 */
export async function appendLocalTurn(store: AgentStore, turn: LocalTurn, now = Date.now()): Promise<string | null> {
  let threadId: string;
  if (turn.threadId) {
    if (!(await store.threadExists(turn.threadId))) return null;
    threadId = turn.threadId;
  } else {
    const at = Math.min(turn.at ? Date.parse(turn.at) : now, now);
    const last = (await store.recentThreads(1, SURFACES))[0];
    threadId = last && Date.parse(last.updated_at) >= at - LOCAL_THREAD_MS ? last.id : await store.createThread("desktop", turn.user.slice(0, 80));
  }
  await store.appendMessage(threadId, { role: "user", content: [{ type: "text", text: turn.user }] }, "desktop");
  if (turn.assistant.trim()) await store.appendMessage(threadId, { role: "assistant", content: [{ type: "text", text: turn.assistant }] }, "desktop");
  return threadId;
}

// ---------------------------------------------------------------------------
// Supabase.
// ---------------------------------------------------------------------------

type Reply<T> = { data: T | null; error: { message: string } | null };
function must<T>(what: string, r: Reply<T>): T {
  if (r.error) throw new Error(`relay ${what}: ${r.error.message}`);
  return r.data as T;
}

const TURN_COLUMNS =
  "id, thread_id, input, surface, context, routine_run_id, allowed_tools, status, claimed_by, claim_id, claim_seq, lease_until, attempts, created_at, parent_turn_id";

/** The owner's session (the turn route, the routine run) or the service role (the relay routes, the cron). */
export function supabaseRelay(db: SupabaseClient): RelayStore {
  return {
    async macOnline(since, role) {
      let q = db.from("agent_devices").select("id").is("revoked_at", null).contains("scopes", ["relay"]).gte("relay_seen_at", since.toISOString());
      if (role) q = q.eq("role", role);
      const rows = must("devices", await q.limit(1)) as { id: string }[];
      return rows.length > 0;
    },
    async deviceRole(deviceId) {
      const row = must("device role", await db.from("agent_devices").select("role").eq("id", deviceId).maybeSingle()) as { role: RelayRole } | null;
      return row?.role ?? null;
    },
    async createTurn(turn) {
      return (must("create turn", await db.from("agent_relay_turns").insert(turn).select("id").single()) as { id: string }).id;
    },
    async getTurn(id) {
      return must("turn", await db.from("agent_relay_turns").select(TURN_COLUMNS).eq("id", id).maybeSingle()) as RelayTurnRow | null;
    },
    async turnForRun(runId) {
      return must(
        "run turn",
        await db.from("agent_relay_turns").select(TURN_COLUMNS).eq("routine_run_id", runId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ) as RelayTurnRow | null;
    },
    async routineOfRun(runId) {
      const row = must("run", await db.from("agent_routine_runs").select("routine_id").eq("id", runId).maybeSingle()) as { routine_id: string } | null;
      return row?.routine_id ?? null;
    },
    async eventsAfter(turnId, seq) {
      return must(
        "events",
        await db.from("agent_relay_events").select("seq, event").eq("turn_id", turnId).gt("seq", seq).order("seq").limit(500),
      ) as { seq: number; event: AgentEvent }[];
    },
    async expire(turnId, from) {
      const row = must(
        "expire",
        await db.from("agent_relay_turns").update({ status: "expired", lease_until: null }).eq("id", turnId).in("status", from).select("id").maybeSingle(),
      );
      return row !== null;
    },
    async sweep() {
      return must("sweep", await db.rpc("agent_relay_sweep")) as number;
    },
    async claim(deviceId, leaseSeconds, slot = null) {
      const rows = must("claim", await db.rpc("agent_relay_claim", { p_device: deviceId, p_lease_seconds: leaseSeconds, p_slot: slot })) as RelayTurnRow[] | null;
      return rows?.[0] ?? null;
    },
    async append(turnId, deviceId, claimId, seq, events, leaseSeconds) {
      return must(
        "append",
        await db.rpc("agent_relay_append", {
          p_turn: turnId,
          p_device: deviceId,
          p_claim: claimId,
          p_seq: seq,
          p_events: events,
          p_lease_seconds: leaseSeconds,
        }),
      ) as AppendResult;
    },
    async createApproval(turnId, deviceId, claimId, ask) {
      const rows = must(
        "approval",
        await db.rpc("agent_relay_approval", {
          p_turn: turnId,
          p_device: deviceId,
          p_claim: claimId,
          p_summary: ask.summary,
          p_danger: ask.danger,
          p_expires_at: ask.expiresAt,
        }),
      ) as ApprovalRow[] | null;
      return rows?.[0] ?? null;
    },
    async createSubturn(parentId, deviceId, claimId, instruction) {
      const rows = must(
        "subturn",
        await db.rpc("agent_relay_subturn", { p_parent: parentId, p_device: deviceId, p_claim: claimId, p_instruction: instruction }),
      ) as { id: string | null; outcome: SubturnOutcome }[] | null;
      return rows?.[0] ?? { id: null, outcome: "not_found" };
    },
    async inputsAck(turnId, deviceId, claimId, seen) {
      const rows = must(
        "inputs",
        await db.rpc("agent_relay_inputs_ack", { p_turn: turnId, p_device: deviceId, p_claim: claimId, p_seen: seen }),
      ) as { input_seq: number; input_text: string }[] | null;
      return (rows ?? []).map((r) => ({ seq: r.input_seq, text: r.input_text }));
    },
  };
}
