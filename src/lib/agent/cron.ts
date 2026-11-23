import type { SupabaseClient } from "@supabase/supabase-js";
import { dueAlerts } from "@/lib/planning/alerts";
import { loadSnapshot } from "@/lib/planning/repository";
import type { PlanningSnapshot } from "@/lib/planning/types";
import { routineGroups } from "./config";
import { deliver, type Channels } from "./deliver";
import { runTurn, type ModelClient } from "./loop";
import type { ToolCtx } from "./registry";
import { nextRun, type Schedule } from "./schedule";
import { needsMac, RELAY_ONLINE_MS, type RelayStore, type RelayTurnRow } from "./relay";
import type { AgentStore, RoutineRow, RunStatus } from "./store";

/**
 * The minute cron (/api/cron/agent). Claims due routine occurrences (FOR UPDATE SKIP LOCKED plus a
 * last_fired_at compare-and-set, unique per occurrence) and due reminders (planning_claim_alert,
 * unique per occurrence), so two overlapping runs or a retry never fire anything twice. Claimed
 * routine runs are started through `runRoutine` (the owner-session bridge in production).
 *
 * Nothing is left hanging: a queued run whose start failed is started again after
 * RETRY_AFTER_S, at most MAX_ATTEMPTS times, then marked failed and the owner is told; a run still
 * "running" past the run function's life is failed the same way; a run waiting on approvals is
 * settled once none is left (approved, declined or expired).
 */

/** A start that has not moved the run out of "queued" by then is tried again. */
export const RETRY_AFTER_S = 120;
export const MAX_ATTEMPTS = 3;
/** /api/agent/routines/run lives 300 s; past this a "running" run died. */
export const RUNNING_TIMEOUT_MS = 360_000;

export interface CronDeps {
  /** Service role store. */
  store: AgentStore;
  /** Service role client (reads Planning for reminders). */
  db: SupabaseClient;
  now: Date;
  runRoutine: (runId: string) => Promise<void>;
  channels?: Channels;
  snapshot?: (db: SupabaseClient) => Promise<PlanningSnapshot>;
  /** Service role relay: a running run whose Mac still holds its turn is not stuck. */
  relay?: RelayStore;
}

export interface CronResult {
  routines: string[];
  reminders: number;
  scheduled: number;
  failed: number;
}

export async function runCron(d: CronDeps): Promise<CronResult> {
  const tz = await d.store.timeZone();
  await d.store.claimDueRoutines(d.now, 20);
  const scheduled = await scheduleRoutines(d.store, d.now, tz);
  // New runs and runs whose start failed earlier, each with its attempt count.
  const dispatched = await d.store.dispatchRuns(d.now, RETRY_AFTER_S, 20);
  const toStart = dispatched.filter((r) => r.attempts <= MAX_ATTEMPTS);
  // Started first, so nothing below (sweeps, reminders) can keep a claimed run from starting. A
  // start that throws leaves the run queued: the next tick after RETRY_AFTER_S tries again.
  const starting = Promise.allSettled(toStart.map((c) => d.runRoutine(c.run_id)));
  let failed = 0;
  try {
    for (const r of dispatched.filter((x) => x.attempts > MAX_ATTEMPTS)) {
      if (await failRun(d, r.run_id, ["queued"], "It could not start. Hydra tried 3 times.")) failed++;
    }
    if (d.relay) await d.relay.sweep();
    for (const run of await d.store.runsWithStatus("running", 50)) {
      if (!run.started_at || d.now.getTime() - new Date(run.started_at).getTime() <= RUNNING_TIMEOUT_MS) continue;
      const turn = d.relay ? await d.relay.turnForRun(run.id) : null;
      // The Mac holds its turn (heartbeats renew the lease): a routine turn may wait on approvals for a day.
      if (turn?.status === "claimed" && turn.lease_until && turn.lease_until > d.now.toISOString()) continue;
      // No Mac took it: the routine's own choice when the Mac is off.
      if (turn?.status === "queued") {
        await macWentOff(d, run.id, run.routine_id, turn.id);
        continue;
      }
      if (await failRun(d, run.id, ["running"], "It stopped before it finished.")) failed++;
    }
    for (const run of await d.store.runsWithStatus("waiting_approval", 50)) await settleRun(d.store, run.id, d.channels, d.now);
  } catch (error) {
    console.error(`[agent] run sweep: ${(error as Error).message}`);
  }

  // Reminders must never block routine runs: a failure here is logged and the runs still start.
  let reminders = 0;
  try {
    reminders = await deliverReminders(d, tz);
  } catch (error) {
    console.error(`[agent] reminders: ${(error as Error).message}`);
  }

  const settled = await starting;
  const rejected = settled.filter((s) => s.status === "rejected");
  for (const f of rejected) console.error(`[agent] routine run: ${((f as PromiseRejectedResult).reason as Error)?.message}`);
  return { routines: toStart.map((c) => c.run_id), reminders, scheduled, failed: rejected.length + failed };
}

async function deliverReminders(d: CronDeps, tz: string): Promise<number> {
  let reminders = 0;
  const snap = await (d.snapshot ?? loadSnapshot)(d.db);
  for (const alert of dueAlerts(snap, d.now, tz)) {
    if (!(await d.store.claimAlert(alert.kind, alert.itemId, alert.occurrenceOn))) continue;
    const delivered = await deliver(
      d.store,
      {
        kind: "reminder",
        title: alert.title,
        href: alert.kind === "task" ? `/planning?task=${alert.itemId}` : `/planning?day=${alert.occurrenceOn}`,
        dedupe_key: `reminder:${alert.kind}:${alert.itemId}:${alert.occurrenceOn}`,
        channels: ["spoken", "notification", "push"],
      },
      d.channels,
    );
    if (delivered) reminders++;
  }
  return reminders;
}

const WORD: Partial<Record<RunStatus, string>> = { ok: "Done", failed: "Failed", skipped: "Not done" };

async function tell(store: AgentStore, runId: string, status: RunStatus, body: string, channels: Channels | undefined, key: string) {
  const run = await store.getRun(runId);
  const routine = run ? await store.getRoutine(run.routine_id) : null;
  if (!routine) return;
  await deliver(
    store,
    {
      kind: "routine",
      title: `${routine.name}: ${WORD[status] ?? status}`,
      body: body.slice(0, 4000),
      href: `/routines?routine=${routine.id}`,
      dedupe_key: `${key}:${runId}`,
      channels: routine.delivery.length ? routine.delivery : ["notification"],
    },
    channels,
  );
}

/** Mark a stuck run failed (compare-and-set on its status) and tell the owner. */
async function failRun(d: CronDeps, runId: string, from: RunStatus[], error: string): Promise<boolean> {
  const moved = await d.store.moveRun(runId, from, { status: "failed", error, finished_at: d.now.toISOString() });
  if (moved) await tell(d.store, runId, "failed", error, d.channels, "routine-run");
  return moved;
}

/** A routine run went to the Mac but no Mac took its turn: skip it or wait, as the routine says. */
async function macWentOff(d: CronDeps, runId: string, routineId: string, turnId: string) {
  const routine = await d.store.getRoutine(routineId);
  if (routine?.when_mac_off !== "skip") {
    await d.store.moveRun(runId, ["running"], { status: "waiting_mac" });
    return;
  }
  await d.relay!.expire(turnId, ["queued"]);
  if (await d.store.moveRun(runId, ["running"], { status: "skipped", finished_at: d.now.toISOString() })) {
    await tell(d.store, runId, "skipped", "The Mac was off.", d.channels, "routine-run");
  }
}

/**
 * An approval still open: pending and not expired, or approved and about to run. An approved MCP or
 * relay step past its time never runs (no one calls it any more), so it does not hold a run open.
 */
function isOpen(a: { status: string; source: string; expires_at: string }, at: string): boolean {
  if (a.status === "pending") return a.expires_at > at;
  if (a.status === "approved") return a.source === "routine" || a.expires_at > at;
  return false;
}

/** The declined or unanswered steps of a run, one line each. */
const notDoneLines = (approvals: { status: string; summary: string }[]) =>
  approvals
    .filter((a) => a.status === "declined" || a.status === "expired" || a.status === "pending")
    .map((a) => `${a.status === "declined" ? "You declined" : "No answer"}: ${a.summary}`);

/**
 * A run waiting on approvals ends once none is open: failed if a step failed, ok if any step was
 * done, else skipped. Each declined or unanswered step is named in its output. Null while open.
 */
export async function settleRun(store: AgentStore, runId: string, channels?: Channels, now = new Date()): Promise<RunStatus | null> {
  const run = await store.getRun(runId);
  if (!run || run.status !== "waiting_approval") return null;
  const approvals = await store.approvalsForRun(runId);
  const at = now.toISOString();
  if (approvals.some((a) => isOpen(a, at))) return null;
  const status: RunStatus = approvals.some((a) => a.status === "failed") ? "failed" : approvals.some((a) => a.status === "done") ? "ok" : "skipped";
  const notDone = notDoneLines(approvals);
  const output = [run.output, ...notDone].filter(Boolean).join("\n").slice(0, 20_000);
  if (!(await store.moveRun(runId, ["waiting_approval"], { status, output, finished_at: at }))) return null;
  await tell(store, runId, status, notDone.join("\n") || output, channels, "routine-run-settled");
  return status;
}

/** Fill next_run_at for every active routine that needs one (new, resumed, or just claimed). */
export async function scheduleRoutines(store: AgentStore, now: Date, tz: string): Promise<number> {
  let n = 0;
  for (const r of await store.routinesToSchedule()) {
    const after = r.last_fired_at && new Date(r.last_fired_at) > now ? new Date(r.last_fired_at) : now;
    if (await store.setNextRun(r.id, nextRun(r.schedule as Schedule, after, tz).toISOString())) n++;
  }
  return n;
}

export interface RoutineRunDeps {
  client: ModelClient | null;
  store: AgentStore;
  /** The owner's session client. */
  db: ToolCtx["db"];
  now: () => Date;
  channels?: Channels;
  /** The relay, for when the Mac is the brain (agent_settings.brain = 'mac'). */
  relay?: RelayStore;
}

const RUN_WORD: Partial<Record<RunStatus, string>> = {
  ok: "Done",
  running: "Sent to the Mac",
  waiting_approval: "Waiting for your yes",
  waiting_mac: "Waiting for the Mac",
  skipped: "Skipped: the Mac was off",
  failed: "Failed",
};

const routinePrompt = (routine: RoutineRow) =>
  `Run the routine "${routine.name}" now. Its instruction: ${routine.instruction}\nWhen done, say in one or two sentences what you did.`;

/** Run one claimed occurrence as an agent job, once. Unattended: risky steps leave approvals. */
export async function runRoutineJob(runId: string, d: RoutineRunDeps): Promise<RunStatus | null> {
  const run = await d.store.getRun(runId);
  if (!run || !(await d.store.startRun(runId))) return null;
  const routine = await d.store.getRoutine(run.routine_id);
  if (!routine) return null;
  const finish = async (status: RunStatus, output: string, error: string | null, threadId: string | null) => {
    await d.store.updateRun(runId, { status, output: output.slice(0, 20_000), error, thread_id: threadId, finished_at: d.now().toISOString() });
    await deliver(
      d.store,
      {
        kind: "routine",
        title: `${routine.name}: ${RUN_WORD[status] ?? status}`,
        body: (error ?? output).slice(0, 4000),
        href: `/routines?routine=${routine.id}`,
        dedupe_key: `routine-run:${runId}`,
        channels: routine.delivery.length ? routine.delivery : ["notification"],
      },
      d.channels,
    );
    return status;
  };
  const settings = await d.store.settings();
  if (settings.brain === "mac") {
    // The Mac runs it (its Claude login, the routine's tools). Mac off: the routine's own choice.
    if (!d.relay) return finish("failed", "", "relay_not_configured", null);
    // A routine with Mac tools runs only on a Mac (0121): the server brain being online does not count.
    const macOnly = needsMac({ surface: "routine", allowed_tools: routine.tools });
    const online = await d.relay.macOnline(new Date(d.now().getTime() - RELAY_ONLINE_MS), macOnly ? "mac" : undefined);
    if (!online && routine.when_mac_off === "skip") return finish("skipped", "", null, null);
    // One waiting run per routine: a Mac back after days off runs the newest, not the whole backlog
    // (the claim expires the older run's turn).
    for (const old of await d.store.recentRuns(routine.id, 20)) {
      if (old.id !== runId && old.status === "waiting_mac") {
        await d.store.moveRun(old.id, ["waiting_mac"], { status: "skipped", error: "A newer run took its place.", finished_at: d.now().toISOString() });
      }
    }
    const threadId = await d.store.createThread("routine", routine.name);
    await d.relay.createTurn({
      thread_id: threadId,
      input: { text: routinePrompt(routine) },
      surface: "routine",
      context: { path: "/routines", search: `?routine=${routine.id}`, scope: "all" },
      routine_run_id: runId,
      allowed_tools: routine.tools,
    });
    if (!online) return finish("waiting_mac", "", null, threadId);
    await d.store.updateRun(runId, { thread_id: threadId });
    return "running";
  }
  if (!d.client) return finish("failed", "", "agent_not_configured", null);
  try {
    const result = await runTurn({
      client: d.client,
      store: d.store,
      ctx: {
        db: d.db,
        surface: "routine",
        runId,
        deviceId: null,
        unattended: true,
        allowed: routineGroups(routine.tools),
        now: d.now,
        timeZone: () => d.store.timeZone(),
      },
      text: routinePrompt(routine),
      emit: () => {},
      mode: "routine",
      settings,
    });
    const status: RunStatus = result.approvals.length
      ? "waiting_approval"
      : result.mac.skipped
        ? "skipped"
        : result.mac.queuedOffline
          ? "waiting_mac"
          : "ok";
    return finish(status, result.text, null, result.threadId);
  } catch (error) {
    console.error(`[agent] routine ${routine.id}: ${(error as Error).message}`);
    return finish("failed", "", "The run failed. Nothing after the failure was done.", null);
  }
}

/**
 * A routine's relay turn ended (the Mac posted done or error): its run gets the Mac's words and
 * ends ok or failed (error), or waits on approvals still open (settled by settleRun as usual). The
 * Mac keeps a routine turn open while it waits on an approval (heartbeats, up to the approval's
 * 24 h), so an approved step always runs inside the turn; closing the turn ends the asks it left
 * unanswered (0120 close trigger), and the output names them. The owner hears about it through the
 * routine's delivery. Service role.
 */
export async function finishRelayRun(store: AgentStore, relay: RelayStore, turn: RelayTurnRow, channels?: Channels, now = new Date()): Promise<RunStatus | null> {
  if (!turn.routine_run_id || (turn.status !== "done" && turn.status !== "error")) return null;
  const run = await store.getRun(turn.routine_run_id);
  const routine = run ? await store.getRoutine(run.routine_id) : null;
  if (!run || !routine) return null;
  const events = (await relay.eventsAfter(turn.id, 0)).map((r) => r.event);
  const said = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("").trim();
  const failed = events.findLast((e) => e.type === "error");
  const approvals = await store.approvalsForRun(run.id);
  const open = approvals.some((a) => isOpen(a, now.toISOString()));
  const status: RunStatus = turn.status === "error" ? "failed" : open ? "waiting_approval" : "ok";
  const error = failed?.type === "error" ? failed.message : null;
  const output = [said, ...(open ? [] : notDoneLines(approvals))].filter(Boolean).join("\n");
  const moved = await store.moveRun(run.id, ["running", "waiting_mac"], {
    status,
    output: output.slice(0, 20_000),
    error,
    thread_id: turn.thread_id,
    finished_at: now.toISOString(),
  });
  if (!moved) return null;
  await deliver(
    store,
    {
      kind: "routine",
      title: `${routine.name}: ${RUN_WORD[status] ?? status}`,
      body: (error ?? output).slice(0, 4000),
      href: `/routines?routine=${routine.id}`,
      dedupe_key: `routine-relay:${run.id}`,
      channels: routine.delivery.length ? routine.delivery : ["notification"],
    },
    channels,
  );
  return status;
}
