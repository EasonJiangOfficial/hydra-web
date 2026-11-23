// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const planning = vi.hoisted(() => ({
  deleteTask: vi.fn(async () => ({ ok: true, value: null })),
  loadPlanning: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/planning/actions", () => ({ deleteTask: planning.deleteTask, loadPlanning: planning.loadPlanning }));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const { runCron, runRoutineJob, scheduleRoutines } = await import("./cron");
const { memoryStore } = await import("./testing");
const { scriptedModel, toolUse } = await import("./fixtures");
const { nextRun } = await import("./schedule");
import type { PlanningSnapshot } from "@/lib/planning/types";

const NOW = new Date("2026-11-21T13:00:30Z"); // 08:00:30 in Toronto
const TZ = "America/Toronto";
const status = { id: "00000000-0000-4000-8000-0000000000a1", label: "To do", color: "#1d1d1f", position: 1, isDone: false };
const reminder = {
  id: "00000000-0000-4000-8000-0000000000c1",
  title: "Send the W-9",
  notes: "",
  statusId: status.id,
  goalId: null,
  category: null,
  dueDate: "2026-11-21",
  position: 1,
  alertAt: "2026-11-21T12:59:00.000Z",
  repeatRule: null,
  repeatSeriesId: null,
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  completedAt: null,
  values: {},
};
const snapshot = async () => ({ statuses: [status], tasks: [reminder], goals: [], events: [], properties: [], timeZone: TZ }) as unknown as PlanningSnapshot;

let mem: ReturnType<typeof memoryStore>;
beforeEach(async () => {
  vi.clearAllMocks();
  mem = memoryStore({ now: () => NOW, timeZone: TZ });
  await mem.store.createRoutine({
    name: "Brand mail",
    instruction: "Check Gmail for brand payments and add them to my deals",
    schedule: { kind: "weekdays", time: "08:00" },
    tools: ["hydra", "gmail"],
    delivery: ["notification", "spoken"],
    when_mac_off: "wait",
    paused: false,
    next_run_at: "2026-11-21T13:00:00.000Z",
  });
});

describe("the agent cron", () => {
  it("fires each due routine occurrence and each reminder once under two concurrent runs", async () => {
    const started: string[] = [];
    const deps = { store: mem.store, db: {} as never, now: NOW, snapshot, runRoutine: async (runId: string) => void started.push(runId) };
    const [a, b] = await Promise.all([runCron(deps), runCron(deps)]);

    expect(a.routines.length + b.routines.length).toBe(1);
    expect(started).toHaveLength(1);
    expect(mem.runs).toHaveLength(1);
    expect(mem.runs[0]).toMatchObject({ occurrence_at: "2026-11-21T13:00:00.000Z", status: "queued" });
    expect(a.reminders + b.reminders).toBe(1);
    expect(mem.notifications.filter((n) => n.kind === "reminder")).toHaveLength(1);
    expect(mem.notifications[0]).toMatchObject({
      title: "Send the W-9",
      href: `/planning?task=${reminder.id}`,
      dedupe_key: `reminder:task:${reminder.id}:2026-11-21`,
      channels: ["spoken", "notification", "push"],
      delivered: { spoken: "stored", notification: "stored", push: "not_configured" },
    });
    // Rescheduled to the next weekday occurrence (Saturday and Sunday skipped).
    expect(mem.routines[0].next_run_at).toBe("2026-11-23T13:00:00.000Z");
    expect(mem.routines[0].last_fired_at).toBe("2026-11-21T13:00:00.000Z");

    // The next tick fires nothing again.
    const again = await runCron(deps);
    expect(again.routines).toHaveLength(0);
    expect(again.reminders).toBe(0);
  });

  it("delivers push through the channel hook when one is wired", async () => {
    const push = vi.fn(async () => {});
    await runCron({ store: mem.store, db: {} as never, now: NOW, snapshot, runRoutine: async () => {}, channels: { push } });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Send the W-9" }));
    expect(mem.notifications[0].delivered.push).toBe("sent");
  });

  it("never fires a paused routine and schedules a resumed one from now", async () => {
    await mem.store.updateRoutine(mem.routines[0].id, { paused: true });
    const started: string[] = [];
    await runCron({ store: mem.store, db: {} as never, now: NOW, snapshot, runRoutine: async (id) => void started.push(id) });
    expect(started).toHaveLength(0);
    await mem.store.updateRoutine(mem.routines[0].id, { paused: false, next_run_at: null });
    expect(await scheduleRoutines(mem.store, NOW, TZ)).toBe(1);
    expect(mem.routines[0].next_run_at).toBe(nextRun({ kind: "weekdays", time: "08:00" }, NOW, TZ).toISOString());
  });
});

describe("a routine run", () => {
  async function claimOne() {
    const [claimed] = await mem.store.claimDueRoutines(NOW, 10);
    return claimed.run_id;
  }

  it("runs once even when started twice, and delivers its result", async () => {
    const runId = await claimOne();
    const { client, requests } = scriptedModel([{ text: "No brand payments today.", content: [], stop_reason: "end_turn" }]);
    const deps = { client, store: mem.store, db: {} as never, now: () => NOW };
    const [a, b] = await Promise.all([runRoutineJob(runId, deps), runRoutineJob(runId, deps)]);
    expect([a, b].filter(Boolean)).toEqual(["ok"]);
    expect(requests).toHaveLength(1);
    expect(requests[0].output_config).toEqual({ effort: "medium" });
    const toolNames = requests[0].tools!.map((t) => (t as { name: string }).name);
    expect(toolNames).toContain("list_deals");
    expect(toolNames).not.toContain("navigate"); // no screen in a routine
    expect(toolNames).not.toContain("mac_do"); // the routine did not allow the Mac
    expect(mem.runs[0]).toMatchObject({ status: "ok", output: "No brand payments today." });
    expect(mem.notifications.find((n) => n.kind === "routine")).toMatchObject({
      title: "Brand mail: Done",
      channels: ["notification", "spoken"],
      dedupe_key: `routine-run:${runId}`,
    });
  });

  it("leaves a risky step for the owner and waits", async () => {
    const runId = await claimOne();
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: reminder.id })], stop_reason: "tool_use" },
      { text: "Asked first.", content: [], stop_reason: "end_turn" },
    ]);
    expect(await runRoutineJob(runId, { client, store: mem.store, db: {} as never, now: () => NOW })).toBe("waiting_approval");
    expect(planning.deleteTask).not.toHaveBeenCalled();
    expect(mem.approvals[0]).toMatchObject({ source: "routine", run_id: runId, status: "pending" });
  });

  it("fails closed without an API key", async () => {
    const runId = await claimOne();
    expect(await runRoutineJob(runId, { client: null, store: mem.store, db: {} as never, now: () => NOW })).toBe("failed");
    expect(mem.runs[0]).toMatchObject({ status: "failed", error: "agent_not_configured" });
  });

  it("skips a Mac step when the Mac is off and the routine says skip", async () => {
    await mem.store.updateRoutine(mem.routines[0].id, { tools: ["hydra", "mac"], when_mac_off: "skip" });
    const runId = await claimOne();
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "mac_do", { instruction: "Open Notes", risky: false })], stop_reason: "tool_use" },
      { text: "The Mac was off.", content: [], stop_reason: "end_turn" },
    ]);
    expect(await runRoutineJob(runId, { client, store: mem.store, db: {} as never, now: () => NOW })).toBe("skipped");
    expect(mem.jobs[0]).toMatchObject({ status: "skipped", run_id: runId });
  });

  it("queues a Mac step for Hydra Desktop when the routine waits for the Mac", async () => {
    await mem.store.updateRoutine(mem.routines[0].id, { tools: ["mac"] });
    const runId = await claimOne();
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "mac_do", { instruction: "Open Notes", risky: false })], stop_reason: "tool_use" },
      { text: "Queued.", content: [], stop_reason: "end_turn" },
    ]);
    expect(await runRoutineJob(runId, { client, store: mem.store, db: {} as never, now: () => NOW })).toBe("waiting_mac");
    expect(mem.jobs[0]).toMatchObject({ status: "queued" });
    // Desktop is on: the step goes straight to it and the run is ok.
    mem.seeDesktop(NOW);
    expect((await mem.store.claimDesktopJobs("00000000-0000-4000-8000-0000000000d1", 10))[0].instruction).toBe("Open Notes");
  });
});
