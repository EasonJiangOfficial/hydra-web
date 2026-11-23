import { randomUUID } from "node:crypto";
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentEvent } from "./events";
import { BRAIN_FAILED, needsMac, type RelayEvent, type RelayStore, type RelayTurnRow } from "./relay";
import { ADDED_PREFIX } from "./relay-schema";
import {
  DEFAULT_SETTINGS,
  type ActionRow,
  type AgentSettings,
  type AgentStore,
  type Avatar,
  type ApprovalRow,
  type Capabilities,
  type DesktopJobRow,
  type ModelKeyRow,
  type NewApproval,
  type NotificationRow,
  type RoutineRow,
  type RunRow,
  type StoredMessage,
  type ThreadRow,
} from "./store";

/**
 * The AgentStore contract in memory, for tests. Compare-and-set steps (claim a routine, an alert,
 * an undo, an approval, a run start) are checked and written synchronously, so two callers racing
 * through `Promise.all` see the same exclusivity the SQL gives (row locks, unique keys).
 */
export function memoryStore(init: { timeZone?: string; now?: () => Date; brain?: AgentSettings["brain"] } = {}) {
  const now = init.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const threads: ThreadRow[] = [];
  const messages: { id: string; thread_id: string; message: BetaMessageParam; created_at: string }[] = [];
  // The server brain unless asked: the scripted-model tests run the server loop. The database default is
  // 'mac' (0120); relay tests pass brain: "mac".
  const settingsPatch: Partial<AgentSettings> = { brain: init.brain ?? "server" };
  const memory = new Map<string, string>();
  const actions: ActionRow[] = [];
  const approvals: ApprovalRow[] = [];
  const addApproval = (a: NewApproval & { dedupe_key?: string }) => {
    const status = a.status ?? "pending";
    const row: ApprovalRow = { ...a, id: randomUUID(), status, result: null, action_id: null, decided_at: status === "approved" ? iso() : null, created_at: iso() };
    approvals.push(row);
    return row;
  };
  /** Relay turns that closed (memoryRelay adds them): their approvals no longer wait. */
  const closedTurns = new Set<string>();
  const routines: RoutineRow[] = [];
  const runs: RunRow[] = [];
  const notifications: NotificationRow[] = [];
  const jobs: DesktopJobRow[] = [];
  const alertFires = new Set<string>();
  const dispatched = new Map<string, number>();
  const devicesSeen: { at: Date }[] = [];
  /** 0200: each live desktop's declared capabilities (agent_devices.capabilities); none known = no tags. */
  const capabilities = new Map<string, Capabilities>();
  /** When each device last declared them (its relay poll), for macSignedIn's freshness. Brains: `brainDevices`. */
  const capabilitiesAt = new Map<string, Date>();
  const brainDevices = new Set<string>();
  /** 0225: agent_model_keys by provider. */
  const modelKeys = new Map<string, ModelKeyRow & { sealed: string }>();
  const tick = () => Promise.resolve();
  const leases = new Map<string, { token: string; until: number }>();
  /** 0191: words added to turns in flight. A relay turn is open while memoryRelay says so. */
  const inputs: { turn_id: string; seq: number; text: string; written: boolean; thread_id: string | null }[] = [];
  const hooks: { relayOpen: (turnId: string) => boolean } = { relayOpen: () => false };

  /** 0220: the avatars and agent_settings.active_avatar_id (a foreign key: an unknown id throws, a delete clears it). */
  const avatars: Avatar[] = [];
  let activeAvatarId: string | null = null;
  const current = (): AgentSettings => ({ ...DEFAULT_SETTINGS, ...settingsPatch, activeAvatar: avatars.find((a) => a.id === activeAvatarId) ?? null });

  const store: AgentStore = {
    settings: async () => current(),
    async setSleepWord(word) {
      settingsPatch.sleepWord = word;
    },
    async updateSettings({ activeAvatarId: avatar, ...patch }) {
      if (avatar !== undefined) {
        if (avatar !== null && !avatars.some((a) => a.id === avatar)) throw new Error("settings: agent_settings_active_avatar_id_fkey");
        activeAvatarId = avatar;
      }
      Object.assign(settingsPatch, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return current();
    },
    listAvatars: async () => avatars.map((a) => ({ ...a })),
    async createAvatar(fields) {
      const a = { id: randomUUID(), ...fields };
      avatars.push(a);
      return { ...a };
    },
    async updateAvatar(id, patch) {
      const a = avatars.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return { ...a };
    },
    async deleteAvatar(id) {
      const i = avatars.findIndex((x) => x.id === id);
      if (i < 0) return null;
      if (activeAvatarId === id) activeAvatarId = null;
      return avatars.splice(i, 1)[0]!;
    },
    modelKeys: async () => [...modelKeys.values()].sort((a, b) => a.provider.localeCompare(b.provider)).map(({ provider, hint, updatedAt }) => ({ provider, hint, updatedAt })),
    async putModelKey(provider, sealed, hint) {
      if (!sealed.startsWith("v1.")) throw new Error("put model key: agent_model_keys_sealed_check");
      modelKeys.set(provider, { provider, sealed, hint, updatedAt: iso() });
      return { provider, hint, updatedAt: iso() };
    },
    deleteModelKey: async (provider) => modelKeys.delete(provider),
    sealedModelKey: async (provider) => modelKeys.get(provider)?.sealed ?? null,
    // Checked and written synchronously, like agent_turn_append's locked check-and-insert.
    async appendInput(turnId, text) {
      const relay = hooks.relayOpen(turnId);
      const leased = relay ? undefined : [...leases].find(([, l]) => l.token === turnId && l.until > now().getTime());
      if (!relay && !leased) return null;
      const seq = Math.max(0, ...inputs.filter((i) => i.turn_id === turnId).map((i) => i.seq)) + 1;
      inputs.push({ turn_id: turnId, seq, text: text.trim(), written: false, thread_id: leased?.[0] ?? null });
      return seq;
    },
    inputsAfter: async (turnId, seq) => inputs.filter((i) => i.turn_id === turnId && !i.written && i.seq > seq).map(({ seq, text }) => ({ seq, text })),
    // agent_take_inputs: one synchronous mark-and-return, so racing takers get disjoint sets.
    async takeInputs(turnId) {
      await tick();
      const taken = inputs.filter((i) => i.turn_id === turnId && !i.written).sort((a, b) => a.seq - b.seq);
      for (const i of taken) i.written = true;
      return taken.map(({ seq, text }) => ({ seq, text }));
    },
    // agent_write_inputs: the lease check, the take and the message in one synchronous step, like its locked transaction.
    async writeInputs(threadId, turnId, surface, { own, before = [], after = [] }) {
      await tick();
      const t = threads.find((x) => x.id === threadId);
      if (!t) return null;
      const lease = leases.get(threadId);
      if (own && lease && lease.until > now().getTime() && lease.token !== turnId) return null;
      const taken = inputs.filter((i) => i.thread_id === threadId && !i.written && (own ? i.turn_id === turnId : i.turn_id !== turnId));
      for (const i of taken) i.written = true;
      const content: BetaContentBlockParam[] = [...before, ...taken.map((i) => ({ type: "text" as const, text: ADDED_PREFIX + i.text })), ...after];
      if (!content.length) return null;
      messages.push({ id: randomUUID(), thread_id: threadId, message: { role: "user", content: structuredClone(content) }, created_at: iso() });
      Object.assign(t, { surface, updated_at: iso() });
      return content;
    },
    threadMessages: async (id, limit) =>
      messages
        .map((m, i) => ({ ...m, i }))
        .filter((m) => m.thread_id === id)
        .reverse()
        .slice(0, limit)
        .map((m) => ({ id: m.id, role: m.message.role, content: structuredClone(m.message.content), created_at: m.created_at }) as StoredMessage),
    timeZone: async () => init.timeZone ?? "America/Toronto",

    async createThread(surface, title) {
      const row = { id: randomUUID(), title, surface, created_at: iso(), updated_at: iso() };
      threads.push(row);
      return row.id;
    },
    threadExists: async (id) => threads.some((t) => t.id === id),
    loadMessages: async (id, limit) =>
      messages
        .filter((m) => m.thread_id === id)
        .slice(limit === undefined ? 0 : -limit)
        .map((m) => structuredClone(m.message)),
    async claimThread(id, token, seconds) {
      await tick();
      const t = threads.find((x) => x.id === id);
      const lease = leases.get(id);
      if (!t || (lease && lease.until > now().getTime() && lease.token !== token)) return false;
      leases.set(id, { token, until: now().getTime() + seconds * 1000 });
      return true;
    },
    // Like the SQL: only the lease ends, the token stays.
    async releaseThread(id, token) {
      const lease = leases.get(id);
      if (lease?.token === token) lease.until = 0;
    },
    async appendMessage(threadId, message, surface) {
      messages.push({ id: randomUUID(), thread_id: threadId, message: structuredClone(message), created_at: iso() });
      // Like the SQL: the thread takes the surface and its touch trigger moves updated_at.
      const t = threads.find((x) => x.id === threadId);
      if (t) Object.assign(t, { surface, updated_at: iso() });
    },
    // Newest updated_at first; a tie keeps the newer thread first (a stable sort of the reversed list).
    recentThreads: async (limit, surfaces) =>
      [...threads]
        .reverse()
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .filter((t) => !surfaces || surfaces.includes(t.surface))
        .slice(0, limit),

    listMemory: async () => [...memory].map(([key, value]) => ({ key, value })),
    async remember(key, value) {
      const before = memory.get(key) ?? null;
      memory.set(key, value);
      return before;
    },
    async forget(key) {
      const before = memory.get(key) ?? null;
      memory.delete(key);
      return before;
    },

    async logAction(a) {
      const row: ActionRow = { ...a, id: randomUUID(), undone_at: null, undo_action_id: null, created_at: iso() };
      actions.push(row);
      return row.id;
    },
    getAction: async (id) => actions.find((a) => a.id === id) ?? null,
    async claimUndo(id) {
      await tick();
      const a = actions.find((x) => x.id === id);
      if (!a || a.undone_at || !a.inverse) return null;
      a.undone_at = iso();
      return a;
    },
    async finishUndo(id, undoActionId, ok) {
      const a = actions.find((x) => x.id === id)!;
      if (ok) a.undo_action_id = undoActionId;
      else a.undone_at = null;
    },
    recentActions: async (limit) => [...actions].reverse().slice(0, limit),

    async createApproval(a) {
      return addApproval(a);
    },
    async createApprovalOnce(a, freeBefore) {
      const held = approvals.find((x) => x.dedupe_key === a.dedupe_key);
      if (held && held.created_at >= freeBefore) return null;
      if (held) held.dedupe_key = `${a.dedupe_key}:${held.id}`;
      return addApproval(a);
    },
    getApproval: async (id) => {
      const row = approvals.find((a) => a.id === id);
      return row ? { ...row } : null;
    },
    async moveApproval(id, from, to, patch = {}) {
      const a = approvals.find((x) => x.id === id);
      if (!a || !from.includes(a.status)) return null;
      if (from.includes("pending") && to !== "expired" && a.expires_at <= iso()) return null;
      Object.assign(a, { status: to, ...patch }, from.includes("pending") ? { decided_at: iso() } : {});
      return { ...a };
    },
    pendingApprovals: async () =>
      approvals.filter((a) => a.status === "pending" && a.expires_at > iso() && !(a.relay_turn_id && closedTurns.has(a.relay_turn_id))),
    async expireLiveApprovals(threadId) {
      const hit = approvals.filter((a) => a.thread_id === threadId && a.source === "live" && a.status === "pending");
      for (const a of hit) Object.assign(a, { status: "expired", decided_at: iso() });
      return hit.length;
    },
    approvalsForRun: async (runId) => approvals.filter((a) => a.run_id === runId).map((a) => ({ ...a })),

    listRoutines: async () => [...routines],
    getRoutine: async (id) => routines.find((r) => r.id === id) ?? null,
    async createRoutine(fields) {
      const row: RoutineRow = { ...fields, id: randomUUID(), last_fired_at: null, created_at: iso(), updated_at: iso() };
      routines.push(row);
      return { ...row };
    },
    async updateRoutine(id, patch) {
      const r = routines.find((x) => x.id === id);
      if (!r) return null;
      const before = { ...r };
      Object.assign(r, patch, { updated_at: iso() });
      return { before, after: { ...r } };
    },
    async deleteRoutine(id) {
      const i = routines.findIndex((r) => r.id === id);
      if (i < 0) return null;
      const [row] = routines.splice(i, 1);
      for (let j = runs.length - 1; j >= 0; j--) if (runs[j].routine_id === id) runs.splice(j, 1);
      return row;
    },
    getRun: async (id) => runs.find((r) => r.id === id) ?? null,
    async startRun(id) {
      await tick();
      const r = runs.find((x) => x.id === id);
      if (!r || r.status !== "queued") return false;
      r.status = "running";
      r.started_at = iso();
      return true;
    },
    async updateRun(id, patch) {
      Object.assign(runs.find((r) => r.id === id)!, patch);
    },
    async moveRun(id, from, patch) {
      await tick();
      const r = runs.find((x) => x.id === id);
      if (!r || !from.includes(r.status)) return false;
      Object.assign(r, patch);
      return true;
    },
    runsWithStatus: async (status, limit) => runs.filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r })),
    async addRunAction(runId, actionId) {
      runs.find((r) => r.id === runId)?.action_ids.push(actionId);
    },
    recentRuns: async (routineId, limit) => runs.filter((r) => !routineId || r.routine_id === routineId).slice(-limit).reverse(),

    async queueDesktopJob(job, status = "queued") {
      const row: DesktopJobRow = { ...job, id: randomUUID(), status, device_id: null, result: null, claimed_at: null, finished_at: null, created_at: iso() };
      jobs.push(row);
      return row.id;
    },
    desktopOnline: async (since) => devicesSeen.some((d) => d.at >= since),
    async setCapabilities(deviceId, caps) {
      capabilities.set(deviceId, caps);
      capabilitiesAt.set(deviceId, now());
    },
    macSignedIn: async (service, since) =>
      [...capabilities].some(([id, c]) => !brainDevices.has(id) && (capabilitiesAt.get(id) ?? new Date(0)) >= since && !!c.signedIn?.includes(service)),
    desktopsTagDeletions: async () => capabilities.size > 0 && [...capabilities.values()].every((c) => c.approveAllDeletionTags === 1),
    async claimDesktopJobs(deviceId, limit, tags = false) {
      const picked = jobs.filter((j) => j.status === "queued" && (!j.needs_tags || tags)).slice(0, limit);
      for (const j of picked) Object.assign(j, { status: "claimed", device_id: deviceId, claimed_at: iso() });
      return picked.map((j) => ({ ...j }));
    },
    async finishDesktopJob(id, status, result) {
      const j = jobs.find((x) => x.id === id && x.status === "claimed");
      if (!j) return null;
      Object.assign(j, { status, result, finished_at: iso() });
      return { ...j };
    },

    async notify(n) {
      await tick();
      if (n.dedupe_key && notifications.some((x) => x.dedupe_key === n.dedupe_key)) return null;
      const row: NotificationRow = {
        id: randomUUID(),
        kind: n.kind,
        title: n.title,
        body: n.body ?? "",
        href: n.href ?? null,
        dedupe_key: n.dedupe_key ?? null,
        channels: n.channels ?? ["notification"],
        delivered: {},
        desktop_at: null,
        read_at: null,
        created_at: iso(),
      };
      notifications.push(row);
      return row.id;
    },
    async markDelivered(id, channel, status) {
      const n = notifications.find((x) => x.id === id)!;
      n.delivered = { ...n.delivered, [channel]: status };
    },
    recentNotifications: async (limit) => [...notifications].reverse().slice(0, limit),
    async pullDesktopNotifications(limit) {
      const rows = notifications.filter((n) => !n.desktop_at).slice(0, limit);
      for (const n of rows) n.desktop_at = iso();
      return rows.map((n) => ({ ...n }));
    },

    async claimDueRoutines(at, limit) {
      await tick();
      const due = routines
        .filter((r) => !r.paused && r.next_run_at && r.next_run_at <= at.toISOString() && r.last_fired_at !== r.next_run_at)
        .sort((a, b) => a.next_run_at!.localeCompare(b.next_run_at!))
        .slice(0, limit);
      const claimed = [];
      for (const r of due) {
        const occurrence = r.next_run_at!;
        r.last_fired_at = occurrence;
        r.next_run_at = null;
        if (runs.some((x) => x.routine_id === r.id && x.occurrence_at === occurrence)) continue;
        const run: RunRow = {
          id: randomUUID(),
          routine_id: r.id,
          occurrence_at: occurrence,
          status: "queued",
          output: "",
          action_ids: [],
          error: null,
          thread_id: null,
          started_at: null,
          finished_at: null,
          created_at: iso(),
        };
        runs.push(run);
        claimed.push({ run_id: run.id, routine_id: r.id, occurrence_at: occurrence });
      }
      return claimed;
    },
    async dispatchRuns(at, staleSeconds, limit) {
      await tick();
      const out = [];
      for (const r of runs.filter((x) => x.status === "queued").slice(0, limit)) {
        const last = dispatched.get(r.id);
        if (last !== undefined && last >= at.getTime() - staleSeconds * 1000) continue;
        dispatched.set(r.id, at.getTime());
        r.attempts = (r.attempts ?? 0) + 1;
        out.push({ run_id: r.id, routine_id: r.routine_id, attempts: r.attempts });
      }
      return out;
    },
    routinesToSchedule: async () => routines.filter((r) => !r.paused && r.next_run_at === null).map((r) => ({ ...r })),
    async setNextRun(id, next) {
      await tick();
      const r = routines.find((x) => x.id === id);
      if (!r || r.paused || r.next_run_at !== null) return false;
      r.next_run_at = next;
      return true;
    },
    async claimAlert(kind, itemId, occurrenceOn) {
      await tick();
      const key = `${kind}:${itemId}:${occurrenceOn}`;
      if (alertFires.has(key)) return false;
      alertFires.add(key);
      return true;
    },
  };

  return {
    store,
    threads,
    messages,
    memory,
    actions,
    approvals,
    closedTurns,
    routines,
    runs,
    notifications,
    jobs,
    inputs,
    hooks,
    /** Hydra Desktop checked in at `at`. */
    seeDesktop: (at: Date) => devicesSeen.push({ at }),
    /** The live desktops and what each declared (0200), as agent_devices.capabilities holds them. */
    capabilities,
    capabilitiesAt,
    /** Devices that are the server brain (agent_devices.role = 'brain'). */
    brainDevices,
    /** 0225: the stored provider keys, sealed. */
    modelKeys,
    /** Change the shared agent settings (the brain, the sleep word). */
    setSettings: (patch: Partial<AgentSettings>) => Object.assign(settingsPatch, patch),
  };
}

/**
 * The relay contract (0120) in memory, sharing a memoryStore's threads, messages, runs and
 * approvals. A claim picks and marks its turn with no await in between, so two Macs racing through
 * `Promise.all` see the exclusivity FOR UPDATE SKIP LOCKED gives. `close` is the 0120 close trigger:
 * the owner's words and the reply go into the thread, and the turn's open approvals end.
 */
export function memoryRelay(mem: ReturnType<typeof memoryStore>, init: { now?: () => Date } = {}) {
  const now = init.now ?? (() => new Date());
  const turns: RelayTurnRow[] = [];
  const events: { turn_id: string; seq: number; event: AgentEvent | RelayEvent }[] = [];
  const macs: { id: string; at: Date }[] = [];
  const lastSeq = (id: string) => Math.max(0, ...events.filter((e) => e.turn_id === id).map((e) => e.seq));
  const open = (t?: RelayTurnRow) => t?.status === "queued" || t?.status === "claimed";
  const push = (id: string, event: AgentEvent | RelayEvent) => {
    events.push({ turn_id: id, seq: lastSeq(id) + 1, event: structuredClone(event) });
    // 0160: a sub-turn's confirm also goes into its open parent's stream; nothing else of it does.
    const parent = turns.find((x) => x.id === turns.find((s) => s.id === id)?.parent_turn_id);
    if (event.type === "confirm" && parent?.status === "claimed") push(parent.id, event);
  };
  const leaseUntil = (seconds: number) => new Date(now().getTime() + seconds * 1000).toISOString();
  const runOf = (t: RelayTurnRow) => mem.runs.find((r) => r.id === t.routine_run_id);
  const seen = (id: string) => macs.push({ id, at: now() });
  /** Devices paired with a Server code (agent_devices.role = 'brain', 0121); every other one is a Mac. */
  const brains = new Set<string>();
  const brainOnline = (except: string) => macs.some((m) => brains.has(m.id) && m.id !== except && m.at.getTime() >= now().getTime() - 45_000);

  const close = (t: RelayTurnRow, status: "done" | "error" | "expired") => {
    if (t.status !== "queued" && t.status !== "claimed") return;
    Object.assign(t, { status, lease_until: null });
    mem.closedTurns.add(t.id);
    // 0160: a sub-turn writes nothing into the thread (the brain says the outcome); a closing parent ends its open sub-turns.
    // 0191: what he added while it worked joins his words.
    if (!t.parent_turn_id) {
      const added = mem.inputs.filter((i) => i.turn_id === t.id).map((i) => i.text);
      const said = [("text" in t.input ? t.input.text : t.input.audioTranscript).trim(), ...added].filter(Boolean).join("\n");
      const reply = events
        .filter((e) => e.turn_id === t.id && e.event.type === "text")
        .map((e) => (e.event as { delta: string }).delta)
        .join("");
      // Synchronous, like the trigger inside the closing statement.
      if (said) void mem.store.appendMessage(t.thread_id, { role: "user", content: [{ type: "text", text: said }] }, t.surface);
      if (reply.trim()) void mem.store.appendMessage(t.thread_id, { role: "assistant", content: [{ type: "text", text: reply }] }, t.surface);
      for (const s of turns.filter((x) => x.parent_turn_id === t.id && open(x))) close(s, "expired");
    }
    for (const a of mem.approvals.filter((x) => x.relay_turn_id === t.id && (x.status === "pending" || x.status === "approved"))) {
      Object.assign(a, { status: a.source === "relay" && a.status === "approved" ? "done" : "expired", decided_at: a.decided_at ?? now().toISOString() });
    }
  };

  /** 0191: what each turn's current claim acknowledged. */
  const acks = new Map<string, { claim: string; seen: number }>();
  // Like agent_turn_append: only a turn whose current claim acknowledged (its device reads additions).
  mem.hooks.relayOpen = (id) => turns.some((x) => x.id === id && x.status === "claimed" && !!x.claim_id && acks.get(id)?.claim === x.claim_id);

  const relay: RelayStore = {
    async inputsAck(id, deviceId, claimId, seen) {
      const t = turns.find((x) => x.id === id);
      if (!t || t.status !== "claimed" || t.claim_id !== claimId || t.claimed_by !== deviceId) return [];
      const ack = acks.get(id);
      const upTo = Math.max(ack?.claim === claimId ? ack.seen : 0, seen ?? 0, 0);
      acks.set(id, { claim: claimId, seen: upTo });
      return mem.store.inputsAfter(id, upTo);
    },
    macOnline: async (since, role) => macs.some((m) => m.at >= since && (!role || brains.has(m.id) === (role === "brain"))),
    deviceRole: async (id) => (brains.has(id) ? "brain" : "mac"),
    async createTurn(t) {
      const row: RelayTurnRow = {
        routine_run_id: null,
        allowed_tools: null,
        ...structuredClone(t),
        id: randomUUID(),
        status: "queued",
        claimed_by: null,
        claim_id: null,
        claim_seq: 0,
        lease_until: null,
        attempts: 0,
        created_at: now().toISOString(),
      };
      turns.push(row);
      return row.id;
    },
    getTurn: async (id) => {
      const t = turns.find((x) => x.id === id);
      return t ? { ...t } : null;
    },
    turnForRun: async (runId) => {
      const t = turns.findLast((x) => x.routine_run_id === runId);
      return t ? { ...t } : null;
    },
    routineOfRun: async (runId) => mem.runs.find((r) => r.id === runId)?.routine_id ?? null,
    eventsAfter: async (id, seq) =>
      events
        .filter((e) => e.turn_id === id && e.seq > seq)
        .slice(0, 500) // the real read's page size
        .map((e) => ({ seq: e.seq, event: structuredClone(e.event) as AgentEvent })),
    async expire(id, from) {
      const t = turns.find((x) => x.id === id);
      if (!t || !from.includes(t.status)) return false;
      close(t, "expired");
      return true;
    },
    async sweep() {
      let n = 0;
      for (const t of turns.filter((x) => x.status === "claimed" && x.lease_until! < now().toISOString())) {
        if (t.attempts < 2) {
          Object.assign(t, { status: "queued", claimed_by: null, claim_id: null, lease_until: null });
          // 0160: the claim ended, so its open sub-turns end (the next claim asks the Mac again).
          for (const s of turns.filter((x) => x.parent_turn_id === t.id && open(x))) close(s, "expired");
        }
        else {
          push(t.id, brains.has(t.claimed_by ?? "") ? BRAIN_FAILED : { type: "error", code: "mac_failed", message: "Your Mac stopped answering." });
          close(t, "error");
        }
        n++;
      }
      return n;
    },
    async claim(deviceId, leaseSeconds, slot = null) {
      seen(deviceId);
      await relay.sweep();
      for (const t of turns.filter((x) => x.status === "queued" && x.routine_run_id && !["running", "waiting_mac"].includes(runOf(x)?.status ?? ""))) {
        close(t, "expired");
      }
      // 0121: a turn that needs the Mac goes only to a Mac; while a brain is online, a Mac gets only
      // those (it stays seen: the fallback).
      const brain = brains.has(deviceId);
      const fits = (x: RelayTurnRow) => (brain ? !needsMac(x) : brainOnline(deviceId) ? needsMac(x) : true);
      const t = turns.find((x) => x.status === "queued" && (slot === null || (slot === "routine") === (x.surface === "routine")) && fits(x));
      if (!t) return null;
      Object.assign(t, {
        status: "claimed",
        claimed_by: deviceId,
        claim_id: randomUUID(),
        claim_seq: 0,
        attempts: t.attempts + 1,
        lease_until: leaseUntil(leaseSeconds),
      });
      const run = runOf(t);
      if (run?.status === "waiting_mac") Object.assign(run, { status: "running", started_at: now().toISOString() });
      return { ...t };
    },
    async append(id, deviceId, claimId, seq, batch, leaseSeconds) {
      const t = turns.find((x) => x.id === id);
      if (!t) return "not_found";
      if (t.claim_id !== claimId) return "stale_claim";
      if (t.claimed_by !== deviceId) return "not_yours";
      seen(deviceId);
      let skip = 0;
      if (seq !== null) {
        if (seq > t.claim_seq + 1) return "seq_gap";
        skip = t.claim_seq - (seq - 1);
      }
      if (t.status !== "claimed") {
        return (t.status === "done" || t.status === "error") && seq !== null && batch.length > 0 && skip >= batch.length ? t.status : "stale_claim";
      }
      const fresh = batch.slice(skip);
      // 0191: a done is held (counted, not stored) while additions past what this claim acknowledged wait.
      const ack = acks.get(id);
      const held =
        fresh.at(-1)?.type === "done" && ack?.claim === claimId && mem.inputs.some((i) => i.turn_id === id && i.seq > ack.seen);
      for (const e of fresh) {
        if (held && e.type === "done") continue;
        push(id, e);
        const approval = e.type === "confirm" ? mem.approvals.find((a) => a.id === e.id && a.device_id === deviceId) : undefined;
        if (approval) {
          approval.relay_turn_id ??= id;
          approval.run_id ??= t.routine_run_id;
          if (t.routine_run_id) {
            const day = new Date(new Date(approval.created_at).getTime() + 24 * 60 * 60_000).toISOString();
            if (day > approval.expires_at) approval.expires_at = day;
          }
        }
      }
      t.claim_seq += fresh.length;
      const last = fresh.at(-1)?.type;
      if (held || (last !== "done" && last !== "error")) {
        t.lease_until = leaseUntil(leaseSeconds);
        return "claimed";
      }
      close(t, last);
      return last;
    },
    // Checked and written synchronously, like the locked check-and-insert of agent_relay_approval.
    async createApproval(id, deviceId, claimId, ask) {
      const t = turns.find((x) => x.id === id);
      if (!t || t.status !== "claimed" || t.claim_id !== claimId || t.claimed_by !== deviceId) return null;
      return mem.store.createApproval({
        source: "relay",
        thread_id: t.thread_id,
        run_id: t.routine_run_id,
        device_id: deviceId,
        relay_turn_id: t.id,
        tool: "relay",
        input: {},
        summary: ask.summary,
        reason: "mac",
        danger: ask.danger,
        expires_at: ask.expiresAt,
      });
    },
    // agent_relay_subturn (0160), checked and written synchronously under the parent's lock.
    async createSubturn(parentId, deviceId, claimId, instruction) {
      const p = turns.find((x) => x.id === parentId);
      if (!p) return { id: null, outcome: "not_found" };
      if (p.claim_id !== claimId || p.status !== "claimed" || !(p.lease_until && p.lease_until > now().toISOString())) return { id: null, outcome: "stale_claim" };
      if (p.claimed_by !== deviceId) return { id: null, outcome: "not_yours" };
      if (!brains.has(deviceId)) return { id: null, outcome: "not_brain" };
      if (p.parent_turn_id || (p.surface !== "web" && p.surface !== "phone")) return { id: null, outcome: "not_live" };
      const online = macs.some((m) => !brains.has(m.id) && m.at.getTime() >= now().getTime() - 45_000);
      const row: RelayTurnRow = {
        id: randomUUID(),
        thread_id: p.thread_id,
        input: { text: instruction.trim() },
        surface: p.surface,
        context: structuredClone(p.context),
        routine_run_id: null,
        allowed_tools: ["mac"],
        parent_turn_id: p.id,
        status: online ? "queued" : "error",
        claimed_by: null,
        claim_id: null,
        claim_seq: 0,
        lease_until: null,
        attempts: 0,
        created_at: now().toISOString(),
      };
      turns.push(row);
      if (!online) push(row.id, { type: "error", code: "mac_offline", message: "Your Mac is offline." });
      return { id: row.id, outcome: online ? "queued" : "mac_offline" };
    },
  };

  return {
    relay,
    turns,
    events,
    /** A Mac's relay loop ran at `at`. */
    seeMac: (id: string, at: Date) => macs.push({ id, at }),
    /** This device was paired with a Server code (role 'brain'). */
    makeBrain: (id: string) => brains.add(id),
  };
}
