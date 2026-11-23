import { expect, test } from "vitest";

import type { ActionRow, ApprovalRow, RoutineRow, RunRow } from "@/lib/agent/store";

import { buildRoutinesData } from "./build";

const routine = { id: "r1", name: "Payments", instruction: "x", schedule: { kind: "weekdays", time: "08:00" }, tools: ["hydra"], delivery: ["notification"], when_mac_off: "wait", paused: false, next_run_at: "2026-11-23T13:00:00Z" } as unknown as RoutineRow;
const run = (id: string, actionIds: string[]) => ({ id, routine_id: "r1", occurrence_at: "2026-11-20T13:00:00Z", status: "ok", output: "done", error: null, action_ids: actionIds }) as unknown as RunRow;
const action = (id: string, inverse: unknown, undone: string | null) => ({ id, summary: `did ${id}`, inverse, undone_at: undone }) as unknown as ActionRow;
const approval = (over: Partial<ApprovalRow>) => ({ id: "a1", source: "routine", run_id: "run1", summary: "Send it", reason: "send", danger: false, created_at: "2026-11-21T00:00:00Z", ...over }) as ApprovalRow;

test("plain words, undoable actions, and only routine approvals", () => {
  const data = buildRoutinesData({
    now: new Date("2026-11-21T15:00:00Z"),
    timeZone: "America/Toronto",
    routines: [routine, { ...routine, id: "r2", paused: true } as RoutineRow],
    runs: [run("run1", ["x", "y", "gone"])],
    actions: [action("x", { tool: "t", input: {} }, null), action("y", { tool: "t", input: {} }, "2026-11-21T01:00:00Z")],
    approvals: [approval({}), approval({ id: "a2", source: "live" }), approval({ id: "a3", run_id: "unknown" })],
  });
  expect(data.routines[0].scheduleText).toBe("Weekdays at 08:00");
  expect(data.routines[0].runs[0].actions).toEqual([
    { id: "x", summary: "did x", undoable: true, undone: false },
    { id: "y", summary: "did y", undoable: false, undone: true },
  ]);
  expect(data.routines[1].nextRunAt).toBeNull();
  expect(data.approvals.map((a) => [a.id, a.routineName])).toEqual([["a1", "Payments"]]);
});
