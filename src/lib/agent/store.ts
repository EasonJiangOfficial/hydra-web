import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stripEmotes } from "./emotes";
import type { Surface } from "./events";
import { DEFAULT_MODEL, MAC_SIGN_IN, PROVIDERS, type Effort, type KeyedProvider, type Provider } from "./models";
import { ADDED_PREFIX } from "./relay-schema";

/**
 * Database access for the agent tables (0070). Takes a client: the owner's session (RLS) for the
 * turn, the routes and the tools; the service role for the cron. `memoryStore` in testing.ts is
 * the same contract in memory, so the loop, the gate, undo and the cron are tested without a DB.
 */

// The models and efforts the owner may pick: models.ts (one catalog for every surface).
export type { Effort };
export const CLAP_LEVELS = ["low", "medium", "high"] as const;
export type ClapSensitivity = (typeof CLAP_LEVELS)[number];
export interface AgentSettings {
  model: string;
  effortLive: Effort;
  effortRoutine: Effort;
  /** Puts Hydra Desktop to sleep; shared by every device. */
  sleepWord: string;
  /** Wakes Hydra Desktop (0190); the web shows it. */
  wakePhrase: string;
  /** Hydra Desktop's double clap (0190). */
  clapSensitivity: ClapSensitivity;
  /** Where the model runs: Hydra Desktop on the owner's Claude login (relay), or the server loop. */
  brain: "mac" | "server";
  /** 0200: every gated step runs without asking, except a deletion (reason "delete"), which always asks. */
  approveAll: boolean;
  /** 0220: the avatar every surface speaks and talks as; null is Hydra's own voice and no style. */
  activeAvatar: Avatar | null;
}
/** 0220: a persona Hydra speaks as: a Fish Audio voice and how it talks. */
export interface Avatar {
  id: string;
  name: string;
  /** Fish Audio's model id (32 lower-case hex), the TTS reference_id. */
  voiceId: string;
  curse: boolean;
  slang: boolean;
  styleNotes: string;
}
export type AvatarFields = Omit<Avatar, "id">;
export const DEFAULT_SETTINGS: AgentSettings = {
  model: DEFAULT_MODEL,
  effortLive: "low",
  effortRoutine: "medium",
  sleepWord: "Hydra, sleep",
  wakePhrase: "Hey Hydra",
  clapSensitivity: "medium",
  brain: "mac",
  approveAll: false,
  activeAvatar: null,
};
/** What PATCH /api/agent/state may change (not the brain); the avatar by its id (null: Hydra's own voice). */
export type SettingsPatch = Partial<Omit<AgentSettings, "brain" | "activeAvatar"> & { activeAvatarId: string | null }>;
const SETTING_COLUMNS: Record<keyof SettingsPatch, string> = {
  model: "model",
  effortLive: "effort_live",
  effortRoutine: "effort_routine",
  sleepWord: "sleep_word",
  wakePhrase: "wake_phrase",
  clapSensitivity: "clap_sensitivity",
  approveAll: "approve_all",
  activeAvatarId: "active_avatar_id",
};
/** Words the owner added to a turn in flight (0191), oldest first. */
export interface AddedInput {
  seq: number;
  text: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: BetaMessageParam["content"];
  created_at: string;
}

export interface Inverse {
  tool: string;
  input: Record<string, unknown>;
}

export interface ThreadRow {
  id: string;
  title: string;
  surface: Surface;
  created_at: string;
  updated_at: string;
}

export interface ActionRow {
  id: string;
  thread_id: string | null;
  run_id: string | null;
  device_id: string | null;
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
  summary: string;
  inverse: Inverse | null;
  surface: Surface;
  undone_at: string | null;
  undo_action_id: string | null;
  created_at: string;
}
export type NewAction = Pick<ActionRow, "thread_id" | "run_id" | "device_id" | "tool" | "input" | "result" | "summary" | "inverse" | "surface">;

/** relay: an ask the Mac would show locally in a relay turn (0120); the Mac polls it and acts. */
export type ApprovalSource = "live" | "routine" | "mcp" | "relay";
export type ApprovalStatus = "pending" | "approved" | "declined" | "expired" | "done" | "failed";
/** What a Hydra Desktop declares on its relay requests (relay-schema.ts capabilitiesSchema). */
export type Capabilities = { approveAllDeletionTags?: 1; signedIn?: string[] };
/** 0225: a connected provider key as the owner sees it: never the key, only its last four characters. */
export interface ModelKeyRow {
  provider: KeyedProvider;
  hint: string;
  updatedAt: string;
}

export type GateReason = "delete" | "bulk" | "send" | "pay" | "mac";
export interface ApprovalRow {
  id: string;
  source: ApprovalSource;
  thread_id: string | null;
  run_id: string | null;
  device_id: string | null;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  reason: GateReason;
  danger: boolean;
  status: ApprovalStatus;
  result: unknown;
  action_id: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
  /** The relay turn it belongs to (0120): a relay approval, or an mcp one the turn's confirm named. */
  relay_turn_id?: string | null;
  /** Approve all (0200): one auto-approved MCP run per device, tool, input and window. Null otherwise. */
  dedupe_key?: string | null;
}
export type NewApproval = Pick<
  ApprovalRow,
  "source" | "thread_id" | "run_id" | "device_id" | "tool" | "input" | "summary" | "reason" | "danger" | "expires_at"
> &
  Pick<Partial<ApprovalRow>, "relay_turn_id"> & {
    /** "approved": approve all said yes (0200). The row is written already decided, in one insert. */
    status?: "pending" | "approved";
  };

export type RoutineTool = "hydra" | "mac" | "gmail" | "calendar";
export type Delivery = "spoken" | "notification" | "push" | "email";
export interface RoutineRow {
  id: string;
  name: string;
  instruction: string;
  schedule: Record<string, unknown>;
  tools: RoutineTool[];
  delivery: Delivery[];
  when_mac_off: "wait" | "skip";
  paused: boolean;
  next_run_at: string | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}
export type RoutineFields = Pick<RoutineRow, "name" | "instruction" | "schedule" | "tools" | "delivery" | "when_mac_off" | "paused" | "next_run_at">;

export type RunStatus = "queued" | "running" | "ok" | "waiting_approval" | "waiting_mac" | "failed" | "skipped";
export interface RunRow {
  id: string;
  routine_id: string;
  occurrence_at: string;
  status: RunStatus;
  output: string;
  action_ids: string[];
  error: string | null;
  thread_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  attempts?: number;
}
export type RunPatch = Partial<Pick<RunRow, "status" | "output" | "error" | "thread_id" | "started_at" | "finished_at">>;

export interface NewNotification {
  kind: "reminder" | "routine" | "approval" | "info";
  title: string;
  body?: string;
  href?: string | null;
  dedupe_key?: string | null;
  channels?: Delivery[];
}
export interface NotificationRow extends Required<NewNotification> {
  id: string;
  delivered: Record<string, string>;
  desktop_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface DesktopJobRow {
  id: string;
  run_id: string | null;
  thread_id: string | null;
  instruction: string;
  risky: boolean;
  /** 0200: approve all let this risky step through; only a pull that declares approveAllDeletionTags claims it. */
  needs_tags: boolean;
  status: "queued" | "claimed" | "done" | "failed" | "skipped";
  device_id: string | null;
  result: unknown;
  claimed_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface ClaimedRun {
  run_id: string;
  routine_id: string;
  occurrence_at: string;
}

export interface DispatchedRun {
  run_id: string;
  routine_id: string;
  attempts: number;
}

/** What a person said or heard: text blocks only, never tool calls, tool results, thinking or context. */
/**
 * What a reader sees of a stored message: its text, without the <context> block or emote tags. An assistant row that
 * calls a tool is one loop step: its text is narration before the tool ("I need dates; today 2026-11-22."), not an
 * answer, so it shows nothing (the live panel shows it as a step).
 */
export function visibleText(m: Pick<StoredMessage, "role" | "content">): string {
  if (typeof m.content === "string") return m.role === "assistant" ? stripEmotes(m.content, true).trim() : m.content;
  if (m.role === "assistant" && (m.content ?? []).some((b) => b.type === "tool_use")) return "";
  // Words added while a turn worked (0191) carry a prefix for the model only.
  const texts = (m.content ?? []).flatMap((b) => (b.type === "text" && !b.text.startsWith("<context>") ? [b.text.startsWith(ADDED_PREFIX) ? b.text.slice(ADDED_PREFIX.length) : b.text] : []));
  return m.role === "user" ? texts.join("\n").trim() : stripEmotes(texts.join(""), true).trim();
}

export interface AgentStore {
  settings(): Promise<AgentSettings>;
  setSleepWord(word: string): Promise<void>;
  /** Writes the given settings (every device shares them) and returns them all. */
  updateSettings(patch: SettingsPatch): Promise<AgentSettings>;
  /** Adds the owner's words to a turn in flight (an open relay turn or a thread lease): its seq, or null when it is over. */
  appendInput(turnId: string, text: string): Promise<number | null>;
  /** The words added to a turn after `seq` and not yet written into the thread, oldest first. */
  inputsAfter(turnId: string, seq: number): Promise<AddedInput[]>;
  /** Takes the turn's unwritten additions, oldest first: marked written in the same step, so the taker owns them (0191). */
  takeInputs(turnId: string): Promise<AddedInput[]>;
  /**
   * Takes additions and writes them, ADDED_PREFIX first, as one user message between `before` and `after`, in one
   * transaction (agent_write_inputs). `own`: the turn's own (its last write; nothing while another turn holds the
   * thread, whose first message takes them). Else the thread's other turns' (ones that died before they wrote them).
   * Returns the content written, or null when nothing was.
   */
  writeInputs(threadId: string, turnId: string, surface: Surface, opts: { own: boolean; before?: BetaContentBlockParam[]; after?: BetaContentBlockParam[] }): Promise<BetaContentBlockParam[] | null>;
  timeZone(): Promise<string>;

  /** 0220: the owner's avatars, oldest first. */
  listAvatars(): Promise<Avatar[]>;
  createAvatar(fields: AvatarFields): Promise<Avatar>;
  /** The avatar after, or null when there is none with that id. */
  updateAvatar(id: string, patch: Partial<AvatarFields>): Promise<Avatar | null>;
  /** The avatar removed, or null. The active avatar going away puts Hydra's own voice back (on delete set null). */
  deleteAvatar(id: string): Promise<Avatar | null>;

  /** 0225: the connected provider keys (owner session or service role), never the sealed key. */
  modelKeys(): Promise<ModelKeyRow[]>;
  /** 0225, service role only: stores (or replaces) a provider's sealed key. */
  putModelKey(provider: KeyedProvider, sealed: string, hint: string): Promise<ModelKeyRow>;
  /** 0225, service role only: removes it; false when there was none. */
  deleteModelKey(provider: KeyedProvider): Promise<boolean>;
  /** 0225, service role only: the sealed key, or null. */
  sealedModelKey(provider: KeyedProvider): Promise<string | null>;

  createThread(surface: Surface, title: string): Promise<string>;
  threadExists(id: string): Promise<boolean>;
  /** The newest `limit` messages (all when unset), oldest first. */
  loadMessages(threadId: string, limit?: number): Promise<BetaMessageParam[]>;
  /** Take the thread for one turn (a lease of `seconds`); false while another turn holds it. */
  claimThread(id: string, token: string, seconds: number): Promise<boolean>;
  releaseThread(id: string, token: string): Promise<void>;
  appendMessage(threadId: string, message: BetaMessageParam, surface: Surface): Promise<void>;
  /** Newest first (updated_at); only the given surfaces when set. */
  recentThreads(limit: number, surfaces?: readonly Surface[]): Promise<ThreadRow[]>;
  /** The newest `limit` stored messages of a thread, newest first, with ids and times. */
  threadMessages(threadId: string, limit: number): Promise<StoredMessage[]>;

  listMemory(): Promise<{ key: string; value: string }[]>;
  /** Upsert; returns the value it replaced. */
  remember(key: string, value: string): Promise<string | null>;
  /** Returns the value it removed. */
  forget(key: string): Promise<string | null>;

  logAction(action: NewAction): Promise<string>;
  getAction(id: string): Promise<ActionRow | null>;
  /** Compare-and-set: marks an undoable, not yet undone action as undone. Null when another undo won. */
  claimUndo(id: string): Promise<ActionRow | null>;
  /** After the inverse ran: link it, or release the claim when it failed. */
  finishUndo(id: string, undoActionId: string | null, ok: boolean): Promise<void>;
  recentActions(limit: number): Promise<ActionRow[]>;

  createApproval(approval: NewApproval): Promise<ApprovalRow>;
  /**
   * The same, unless a row made at or after `freeBefore` holds `dedupe_key` (unique, 0200): then null and nothing is
   * written. An older holder gives the key up first (renamed `key:id`, kept for the audit), so the window slides.
   */
  createApprovalOnce(approval: NewApproval & { dedupe_key: string }, freeBefore: string): Promise<ApprovalRow | null>;
  getApproval(id: string): Promise<ApprovalRow | null>;
  /** Compare-and-set from `from` to `to`; the row after, or null when it was not in `from`. */
  moveApproval(
    id: string,
    from: ApprovalStatus[],
    to: ApprovalStatus,
    patch?: { result?: unknown; action_id?: string | null },
  ): Promise<ApprovalRow | null>;
  pendingApprovals(): Promise<ApprovalRow[]>;
  /** Live approvals of a thread still pending: expire them (their turn is gone). Returns how many. */
  expireLiveApprovals(threadId: string): Promise<number>;
  approvalsForRun(runId: string): Promise<ApprovalRow[]>;

  listRoutines(): Promise<RoutineRow[]>;
  getRoutine(id: string): Promise<RoutineRow | null>;
  createRoutine(fields: RoutineFields): Promise<RoutineRow>;
  updateRoutine(id: string, patch: Partial<RoutineFields>): Promise<{ before: RoutineRow; after: RoutineRow } | null>;
  deleteRoutine(id: string): Promise<RoutineRow | null>;
  getRun(id: string): Promise<RunRow | null>;
  /** Compare-and-set queued -> running: a run starts once. */
  startRun(id: string): Promise<boolean>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  /** Compare-and-set: writes `patch` only while the run is in one of `from`. */
  moveRun(id: string, from: RunStatus[], patch: RunPatch): Promise<boolean>;
  runsWithStatus(status: RunStatus, limit: number): Promise<RunRow[]>;
  addRunAction(runId: string, actionId: string): Promise<void>;
  recentRuns(routineId: string | null, limit: number): Promise<RunRow[]>;

  queueDesktopJob(job: Pick<DesktopJobRow, "run_id" | "thread_id" | "instruction" | "risky" | "needs_tags">, status?: "queued" | "skipped"): Promise<string>;
  /** Hydra Desktop is running: a device with the agent scope was seen since `since`. */
  desktopOnline(since: Date): Promise<boolean>;
  /** 0200: what a device's relay loop declared on its last /relay/next (relay-schema.ts capabilitiesSchema); {} clears it. */
  setCapabilities(deviceId: string, capabilities: Capabilities): Promise<void>;
  /**
   * 0200: every live Hydra Desktop that can take a Mac step (not revoked, agent scope, not the server brain) declared
   * approveAllDeletionTags, and there is at least one. False otherwise (fail closed: an older Mac, or none, asks).
   */
  desktopsTagDeletions(): Promise<boolean>;
  /** A live Hydra Desktop (not revoked, seen since `since`, not the server brain) reports it is signed in to `service` ("chatgpt"). */
  macSignedIn(service: string, since: Date): Promise<boolean>;
  /**
   * Queued Mac steps for one device (each job goes to one device once). A needs_tags job goes only to a pull with
   * `tags` (this request declared approveAllDeletionTags); others wait queued for one.
   */
  claimDesktopJobs(deviceId: string, limit: number, tags?: boolean): Promise<DesktopJobRow[]>;
  finishDesktopJob(id: string, status: "done" | "failed", result: unknown): Promise<DesktopJobRow | null>;

  /** Insert; null when `dedupe_key` was already delivered. */
  notify(n: NewNotification): Promise<string | null>;
  markDelivered(id: string, channel: string, status: string): Promise<void>;
  recentNotifications(limit: number): Promise<NotificationRow[]>;
  /** Notifications Hydra Desktop has not shown yet; they are marked as pulled. */
  pullDesktopNotifications(limit: number): Promise<NotificationRow[]>;

  // Cron side (service role).
  claimDueRoutines(now: Date, limit: number): Promise<ClaimedRun[]>;
  /** Queued runs never started or whose last start is older than `staleSeconds`: attempts goes up. */
  dispatchRuns(now: Date, staleSeconds: number, limit: number): Promise<DispatchedRun[]>;
  routinesToSchedule(): Promise<RoutineRow[]>;
  /** Compare-and-set: only writes when next_run_at is still null. */
  setNextRun(id: string, next: string): Promise<boolean>;
  claimAlert(kind: "task" | "event", itemId: string, occurrenceOn: string): Promise<boolean>;
}

type Reply<T> = { data: T | null; error: { message: string; code?: string } | null };

class StoreError extends Error {}

/** Rows come back untyped (no generated DB types here): callers cast to the row interfaces above. */
function must(what: string, r: Reply<unknown>): unknown {
  if (r.error) throw new StoreError(`${what}: ${r.error.message}`);
  if (r.data === null) throw new StoreError(`${what}: no row`);
  return r.data;
}
function maybe(what: string, r: Reply<unknown>): unknown {
  if (r.error) throw new StoreError(`${what}: ${r.error.message}`);
  return r.data;
}
const idOf = (row: unknown) => (row as { id: string }).id;

const DESKTOP_FRESH_MS = 2 * 60_000;
export { DESKTOP_FRESH_MS };

/** The shared settings every surface reads (W6 contract), as GET and PATCH /api/agent/state answer them. */
export const settingsOut = (s: AgentSettings) => ({
  sleepWord: s.sleepWord,
  wakePhrase: s.wakePhrase,
  clapSensitivity: s.clapSensitivity,
  model: s.model,
  effortLive: s.effortLive,
  effortRoutine: s.effortRoutine,
  brain: s.brain,
  approveAll: s.approveAll,
  activeAvatarId: s.activeAvatar?.id ?? null,
});

/**
 * The providers the owner can pick now, in catalog order: Claude always; a keyed one (Grok) while its key is stored
 * (0225); a Mac sign-in one (ChatGPT) while a live Hydra Desktop reports it (seen in the last DESKTOP_FRESH_MS).
 */
export async function connectedProviders(store: AgentStore, now: Date = new Date()): Promise<Provider[]> {
  const since = new Date(now.getTime() - DESKTOP_FRESH_MS);
  const [keys, macs] = await Promise.all([
    store.modelKeys(),
    Promise.all(PROVIDERS.map(async (p) => (MAC_SIGN_IN[p] ? store.macSignedIn(MAC_SIGN_IN[p], since) : false))),
  ]);
  return PROVIDERS.filter((p, i) => p === "anthropic" || keys.some((k) => k.provider === p) || macs[i]);
}

const AVATAR_COLUMNS = "id, name, fish_voice_id, curse, slang, style_notes";
type AvatarRow = { id: string; name: string; fish_voice_id: string; curse: boolean; slang: boolean; style_notes: string };
const avatarOf = (r: AvatarRow): Avatar => ({ id: r.id, name: r.name, voiceId: r.fish_voice_id, curse: r.curse, slang: r.slang, styleNotes: r.style_notes });
const avatarRow = (f: Partial<AvatarFields>) => {
  const row: Partial<Omit<AvatarRow, "id">> = {};
  if (f.name !== undefined) row.name = f.name;
  if (f.voiceId !== undefined) row.fish_voice_id = f.voiceId;
  if (f.curse !== undefined) row.curse = f.curse;
  if (f.slang !== undefined) row.slang = f.slang;
  if (f.styleNotes !== undefined) row.style_notes = f.styleNotes;
  return row;
};

// The one source of truth for the agent's model and effort: agent_settings (default claude-opus-5-5).
// settings.chat_model (0001) is not read anywhere; nothing should start reading it.
async function readSettings(db: SupabaseClient): Promise<AgentSettings> {
  const row = maybe(
    "agent settings",
    await db.from("agent_settings").select(`model, effort_live, effort_routine, sleep_word, wake_phrase, clap_sensitivity, brain, approve_all, agent_avatars(${AVATAR_COLUMNS})`).maybeSingle(),
  ) as {
    model: string;
    effort_live: Effort;
    effort_routine: Effort;
    sleep_word: string;
    wake_phrase: string;
    clap_sensitivity: ClapSensitivity;
    brain: AgentSettings["brain"];
    approve_all: boolean;
    agent_avatars: AvatarRow | null;
  } | null;
  if (!row) return DEFAULT_SETTINGS;
  return {
    model: row.model,
    effortLive: row.effort_live,
    effortRoutine: row.effort_routine,
    sleepWord: row.sleep_word,
    wakePhrase: row.wake_phrase,
    clapSensitivity: row.clap_sensitivity,
    brain: row.brain,
    approveAll: row.approve_all === true,
    activeAvatar: row.agent_avatars ? avatarOf(row.agent_avatars) : null,
  };
}

export function supabaseStore(db: SupabaseClient): AgentStore {
  const write = async (what: string, row: Record<string, unknown>) => {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new StoreError(`${what}: no owner session`);
    must(what, await db.from("agent_settings").upsert({ user_id: data.user.id, ...row }, { onConflict: "user_id" }).select("user_id").single());
  };
  return {
    settings: () => readSettings(db),
    async setSleepWord(word) {
      await write("sleep word", { sleep_word: word });
    },
    async updateSettings(patch) {
      const row: Record<string, unknown> = {};
      for (const k of Object.keys(SETTING_COLUMNS) as (keyof SettingsPatch)[]) if (patch[k] !== undefined) row[SETTING_COLUMNS[k]] = patch[k];
      await write("settings", row);
      return readSettings(db);
    },
    async appendInput(turnId, text) {
      return maybe("append input", await db.rpc("agent_turn_append", { p_turn: turnId, p_text: text })) as number | null;
    },
    async inputsAfter(turnId, seq) {
      return (maybe("inputs", await db.from("agent_relay_inputs").select("seq, text").eq("turn_id", turnId).eq("written", false).gt("seq", seq).order("seq")) ?? []) as AddedInput[];
    },
    async takeInputs(turnId) {
      const rows = must("take inputs", await db.rpc("agent_take_inputs", { p_turn: turnId })) as { input_seq: number; input_text: string }[];
      return rows.map((r) => ({ seq: r.input_seq, text: r.input_text }));
    },
    async writeInputs(threadId, turnId, surface, { own, before = [], after = [] }) {
      const args = { p_thread: threadId, p_turn: turnId, p_own: own, p_surface: surface, p_prefix: ADDED_PREFIX, p_before: before, p_after: after };
      return maybe("write inputs", await db.rpc("agent_write_inputs", args)) as BetaContentBlockParam[] | null;
    },
    async timeZone() {
      const row = maybe("settings", await db.from("settings").select("time_zone").maybeSingle()) as { time_zone: string | null } | null;
      return row?.time_zone || "America/Toronto";
    },

    async listAvatars() {
      const rows = must("avatars", await db.from("agent_avatars").select(AVATAR_COLUMNS).order("created_at").order("id")) as AvatarRow[];
      return rows.map(avatarOf);
    },
    async createAvatar(fields) {
      return avatarOf(must("create avatar", await db.from("agent_avatars").insert(avatarRow(fields)).select(AVATAR_COLUMNS).single()) as AvatarRow);
    },
    async updateAvatar(id, patch) {
      const row = maybe("update avatar", await db.from("agent_avatars").update(avatarRow(patch)).eq("id", id).select(AVATAR_COLUMNS).maybeSingle()) as AvatarRow | null;
      return row && avatarOf(row);
    },
    async deleteAvatar(id) {
      const row = maybe("delete avatar", await db.from("agent_avatars").delete().eq("id", id).select(AVATAR_COLUMNS).maybeSingle()) as AvatarRow | null;
      return row && avatarOf(row);
    },

    async modelKeys() {
      const rows = must("model keys", await db.from("agent_model_keys").select("provider, hint, updated_at").order("provider")) as { provider: KeyedProvider; hint: string; updated_at: string }[];
      return rows.map((r) => ({ provider: r.provider, hint: r.hint, updatedAt: r.updated_at }));
    },
    async putModelKey(provider, sealed, hint) {
      const r = must(
        "put model key",
        await db.from("agent_model_keys").upsert({ provider, sealed, hint }, { onConflict: "provider" }).select("provider, hint, updated_at").single(),
      ) as { provider: KeyedProvider; hint: string; updated_at: string };
      return { provider: r.provider, hint: r.hint, updatedAt: r.updated_at };
    },
    async deleteModelKey(provider) {
      return maybe("delete model key", await db.from("agent_model_keys").delete().eq("provider", provider).select("provider").maybeSingle()) !== null;
    },
    async sealedModelKey(provider) {
      const row = maybe("model key", await db.from("agent_model_keys").select("sealed").eq("provider", provider).maybeSingle()) as { sealed: string } | null;
      return row?.sealed ?? null;
    },

    async createThread(surface, title) {
      return idOf(must("create thread", await db.from("agent_threads").insert({ surface, title: title.slice(0, 200) }).select("id").single()));
    },
    async threadExists(id) {
      return maybe("thread", await db.from("agent_threads").select("id").eq("id", id).maybeSingle()) !== null;
    },
    async loadMessages(threadId, limit = 500) {
      // Newest first, then turned around: PostgREST caps a select at max_rows (1000), so an
      // ascending read of a long thread would return its OLDEST rows.
      const rows = must(
        "messages",
        await db
          .from("agent_messages")
          .select("role, content")
          .eq("thread_id", threadId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(Math.min(limit, 1000)),
      ) as { role: "user" | "assistant"; content: BetaMessageParam["content"] }[];
      return rows.reverse().map((r) => ({ role: r.role, content: r.content }) as BetaMessageParam);
    },
    async claimThread(id, token, seconds) {
      return must("claim thread", await db.rpc("agent_claim_thread", { p_thread: id, p_token: token, p_seconds: seconds })) === true;
    },
    async releaseThread(id, token) {
      // Only the lease ends; the token stays (agent_turn_append takes additions only while busy_until is ahead).
      maybe("release thread", await db.from("agent_threads").update({ busy_until: null }).eq("id", id).eq("busy_token", token).select("id"));
    },
    async appendMessage(threadId, message, surface) {
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      must("append message", await db.from("agent_messages").insert({ thread_id: threadId, role: message.role, content, surface }).select("id").single());
      must("touch thread", await db.from("agent_threads").update({ surface: surface }).eq("id", threadId).select("id").single());
    },
    async threadMessages(threadId, limit) {
      return must(
        "thread messages",
        await db
          .from("agent_messages")
          .select("id, role, content, created_at")
          .eq("thread_id", threadId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(limit),
      ) as StoredMessage[];
    },
    async recentThreads(limit, surfaces) {
      // Named columns: the thread lock (busy_token, busy_until) never leaves the server.
      const q = db.from("agent_threads").select("id, title, surface, created_at, updated_at");
      return must("threads", await (surfaces ? q.in("surface", [...surfaces]) : q).order("updated_at", { ascending: false }).limit(limit)) as ThreadRow[];
    },

    async listMemory() {
      return must("memory", await db.from("agent_memory").select("key, value").order("key")) as { key: string; value: string }[];
    },
    async remember(key, value) {
      const before = maybe("memory", await db.from("agent_memory").select("value").eq("key", key).maybeSingle()) as { value: string } | null;
      must("remember", await db.from("agent_memory").upsert({ key, value }, { onConflict: "key" }).select("key").single());
      return before?.value ?? null;
    },
    async forget(key) {
      const rows = must("forget", await db.from("agent_memory").delete().eq("key", key).select("value")) as { value: string }[];
      return rows[0]?.value ?? null;
    },

    async logAction(action) {
      return idOf(must("log action", await db.from("agent_actions").insert(action).select("id").single()));
    },
    async getAction(id) {
      return maybe("action", await db.from("agent_actions").select("*").eq("id", id).maybeSingle()) as ActionRow | null;
    },
    async claimUndo(id) {
      return maybe(
        "claim undo",
        await db
          .from("agent_actions")
          .update({ undone_at: new Date().toISOString() })
          .eq("id", id)
          .is("undone_at", null)
          .not("inverse", "is", null)
          .select("*")
          .maybeSingle(),
      ) as ActionRow | null;
    },
    async finishUndo(id, undoActionId, ok) {
      const patch = ok ? { undo_action_id: undoActionId } : { undone_at: null };
      maybe("finish undo", await db.from("agent_actions").update(patch).eq("id", id).select("id").maybeSingle());
    },
    async recentActions(limit) {
      return must("actions", await db.from("agent_actions").select("*").order("created_at", { ascending: false }).limit(limit)) as ActionRow[];
    },

    async createApproval(approval) {
      const row = approval.status === "approved" ? { ...approval, decided_at: new Date().toISOString() } : approval;
      return must("create approval", await db.from("agent_approvals").insert(row).select("*").single()) as ApprovalRow;
    },
    async createApprovalOnce(approval, freeBefore) {
      // A compare-and-set on the key: two callers past the window both try, one renames, both insert, the unique key
      // lets one in. created_at is the database's clock, freeBefore the server's: skew only stretches the window.
      const key = approval.dedupe_key;
      const old = maybe(
        "approval key",
        await db.from("agent_approvals").select("id").eq("dedupe_key", key).lt("created_at", freeBefore).maybeSingle(),
      ) as { id: string } | null;
      if (old) maybe("free approval key", await db.from("agent_approvals").update({ dedupe_key: `${key}:${old.id}` }).eq("id", old.id).eq("dedupe_key", key));
      const row = approval.status === "approved" ? { ...approval, decided_at: new Date().toISOString() } : approval;
      const r = await db.from("agent_approvals").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must("create approval", r) as ApprovalRow;
    },
    async getApproval(id) {
      return maybe("approval", await db.from("agent_approvals").select("*").eq("id", id).maybeSingle()) as ApprovalRow | null;
    },
    async moveApproval(id, from, to, patch = {}) {
      const decided = from.includes("pending") ? { decided_at: new Date().toISOString() } : {};
      let q = db.from("agent_approvals").update({ status: to, ...decided, ...patch }).eq("id", id).in("status", from);
      if (from.includes("pending") && to !== "expired") q = q.gt("expires_at", new Date().toISOString());
      return maybe("move approval", await q.select("*").maybeSingle()) as ApprovalRow | null;
    },
    async pendingApprovals() {
      // An approval tied to a relay turn waits only while that turn is open (the 0120 close trigger ends
      // them too; this keeps a stale row off every surface even so).
      const rows = must(
        "approvals",
        await db
          .from("agent_approvals")
          .select("*, relay_turn:agent_relay_turns(status)")
          .eq("status", "pending")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(50),
      ) as (ApprovalRow & { relay_turn: { status: string } | null })[];
      return rows
        .filter((r) => !r.relay_turn_id || r.relay_turn?.status === "queued" || r.relay_turn?.status === "claimed")
        .map((r) => {
          const row: Partial<typeof r> = { ...r };
          delete row.relay_turn;
          return row as ApprovalRow;
        });
    },

    async expireLiveApprovals(threadId) {
      const rows = maybe(
        "expire approvals",
        await db.from("agent_approvals").update({ status: "expired", decided_at: new Date().toISOString() }).eq("thread_id", threadId).eq("source", "live").eq("status", "pending").select("id"),
      ) as { id: string }[] | null;
      return rows?.length ?? 0;
    },
    async approvalsForRun(runId) {
      return must("run approvals", await db.from("agent_approvals").select("*").eq("run_id", runId).order("created_at")) as ApprovalRow[];
    },

    async listRoutines() {
      return must("routines", await db.from("agent_routines").select("*").order("created_at")) as RoutineRow[];
    },
    async getRoutine(id) {
      return maybe("routine", await db.from("agent_routines").select("*").eq("id", id).maybeSingle()) as RoutineRow | null;
    },
    async createRoutine(fields) {
      return must("create routine", await db.from("agent_routines").insert(fields).select("*").single()) as RoutineRow;
    },
    async updateRoutine(id, patch) {
      const before = maybe("routine", await db.from("agent_routines").select("*").eq("id", id).maybeSingle()) as RoutineRow | null;
      if (!before) return null;
      const after = must("update routine", await db.from("agent_routines").update(patch).eq("id", id).select("*").single()) as RoutineRow;
      return { before, after };
    },
    async deleteRoutine(id) {
      const rows = must("delete routine", await db.from("agent_routines").delete().eq("id", id).select("*")) as RoutineRow[];
      return rows[0] ?? null;
    },
    async getRun(id) {
      return maybe("run", await db.from("agent_routine_runs").select("*").eq("id", id).maybeSingle()) as RunRow | null;
    },
    async startRun(id) {
      const row = maybe(
        "start run",
        await db
          .from("agent_routine_runs")
          .update({ status: "running", started_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "queued")
          .select("id")
          .maybeSingle(),
      );
      return row !== null;
    },
    async updateRun(id, patch) {
      must("update run", await db.from("agent_routine_runs").update(patch).eq("id", id).select("id").single());
    },
    async moveRun(id, from, patch) {
      return maybe("move run", await db.from("agent_routine_runs").update(patch).eq("id", id).in("status", from).select("id").maybeSingle()) !== null;
    },
    async runsWithStatus(status, limit) {
      return must("runs", await db.from("agent_routine_runs").select("*").eq("status", status).order("created_at").limit(limit)) as RunRow[];
    },
    async addRunAction(runId, actionId) {
      const run = must("run", await db.from("agent_routine_runs").select("action_ids").eq("id", runId).single()) as { action_ids: string[] };
      must(
        "run actions",
        await db.from("agent_routine_runs").update({ action_ids: [...run.action_ids, actionId] }).eq("id", runId).select("id").single(),
      );
    },
    async recentRuns(routineId, limit) {
      let q = db.from("agent_routine_runs").select("*").order("occurrence_at", { ascending: false }).limit(limit);
      if (routineId) q = q.eq("routine_id", routineId);
      return must("runs", await q) as RunRow[];
    },

    async queueDesktopJob(job, status = "queued") {
      return idOf(must("queue desktop job", await db.from("agent_desktop_jobs").insert({ ...job, status }).select("id").single()));
    },
    async desktopOnline(since) {
      const rows = must(
        "devices",
        await db
          .from("agent_devices")
          .select("id")
          .is("revoked_at", null)
          .contains("scopes", ["agent"])
          .gte("last_seen_at", since.toISOString())
          .limit(1),
      ) as { id: string }[];
      return rows.length > 0;
    },

    async setCapabilities(deviceId, capabilities) {
      maybe("capabilities", await db.from("agent_devices").update({ capabilities }).eq("id", deviceId).select("id").maybeSingle());
    },
    async desktopsTagDeletions() {
      const rows = must(
        "device capabilities",
        await db.from("agent_devices").select("capabilities").is("revoked_at", null).contains("scopes", ["agent"]).neq("role", "brain"),
      ) as { capabilities: Capabilities | null }[];
      return rows.length > 0 && rows.every((r) => r.capabilities?.approveAllDeletionTags === 1);
    },
    async macSignedIn(service, since) {
      const rows = must(
        "device sign-ins",
        await db
          .from("agent_devices")
          .select("id")
          .is("revoked_at", null)
          .neq("role", "brain")
          .gte("last_seen_at", since.toISOString())
          .contains("capabilities", { signedIn: [service] })
          .limit(1),
      ) as { id: string }[];
      return rows.length > 0;
    },

    async claimDesktopJobs(deviceId, limit, tags = false) {
      return must("claim desktop jobs", await db.rpc("agent_claim_desktop_jobs", { p_device: deviceId, p_limit: limit, p_tags: tags })) as DesktopJobRow[];
    },
    async finishDesktopJob(id, status, result) {
      return maybe(
        "finish desktop job",
        await db
          .from("agent_desktop_jobs")
          .update({ status, result: result ?? null, finished_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "claimed")
          .select("*")
          .maybeSingle(),
      ) as DesktopJobRow | null;
    },

    async notify(n) {
      const r = await db.from("agent_notifications").insert(n).select("id").single();
      if (r.error?.code === "23505") return null;
      return idOf(must("notify", r));
    },
    async markDelivered(id, channel, status) {
      const row = must("notification", await db.from("agent_notifications").select("delivered").eq("id", id).single()) as {
        delivered: Record<string, string>;
      };
      must(
        "mark delivered",
        await db.from("agent_notifications").update({ delivered: { ...row.delivered, [channel]: status } }).eq("id", id).select("id").single(),
      );
    },

    async recentNotifications(limit) {
      return must("notifications", await db.from("agent_notifications").select("*").order("created_at", { ascending: false }).limit(limit)) as NotificationRow[];
    },
    async pullDesktopNotifications(limit) {
      const rows = must(
        "desktop notifications",
        await db.from("agent_notifications").select("*").is("desktop_at", null).order("created_at").limit(limit),
      ) as NotificationRow[];
      if (!rows.length) return [];
      const pulled = must(
        "mark pulled",
        await db
          .from("agent_notifications")
          .update({ desktop_at: new Date().toISOString() })
          .in("id", rows.map((r) => r.id))
          .is("desktop_at", null)
          .select("*"),
      ) as NotificationRow[];
      return pulled;
    },

    async claimDueRoutines(now, limit) {
      return must("claim routines", await db.rpc("agent_claim_due_routines", { p_now: now.toISOString(), p_limit: limit })) as ClaimedRun[];
    },
    async dispatchRuns(now, staleSeconds, limit) {
      return must(
        "dispatch runs",
        await db.rpc("agent_dispatch_runs", { p_now: now.toISOString(), p_stale_seconds: staleSeconds, p_limit: limit }),
      ) as DispatchedRun[];
    },
    async routinesToSchedule() {
      return must("routines to schedule", await db.from("agent_routines").select("*").eq("paused", false).is("next_run_at", null)) as RoutineRow[];
    },
    async setNextRun(id, next) {
      const row = maybe(
        "set next run",
        await db.from("agent_routines").update({ next_run_at: next }).eq("id", id).is("next_run_at", null).eq("paused", false).select("id").maybeSingle(),
      );
      return row !== null;
    },
    async claimAlert(kind, itemId, occurrenceOn) {
      return must("claim alert", await db.rpc("planning_claim_alert", { p_kind: kind, p_item: itemId, p_occurrence: occurrenceOn })) === true;
    },
  };
}
