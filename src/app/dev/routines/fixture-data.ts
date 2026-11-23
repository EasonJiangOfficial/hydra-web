import type { ApprovalView, RoutinesData, RoutineView } from "@/components/routines/types";

/** A fixed clock: Saturday, November 21, 2026, 10:00 in Toronto (EST, UTC-5). The fixture's times never drift. */
export const NOW = "2026-11-21T15:00:00.000Z";
export const TZ = "America/Toronto";

const routines: RoutineView[] = [
  {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "Brand payment emails",
    instruction: "Check Gmail for brand payment emails and mark the matching UGC deal payments as received.",
    schedule: { kind: "weekdays", time: "08:00" },
    scheduleText: "Weekdays at 08:00",
    tools: ["hydra", "gmail"],
    delivery: ["notification", "push"],
    whenMacOff: "wait",
    paused: false,
    nextRunAt: "2026-11-23T13:00:00.000Z",
    runs: [
      {
        id: "run-a1-2",
        occurrenceAt: "2026-11-20T13:00:00.000Z",
        status: "ok",
        output: "Found 2 payment emails: Wordwise ($1,200.00) and Brandly ($850.00). Matched both to open deals and marked them paid.",
        error: null,
        actions: [
          { id: "act-a1-1", summary: "Marked the Wordwise payment as received", undoable: true, undone: false },
          { id: "act-a1-2", summary: "Marked the Brandly payment as received", undoable: true, undone: false },
        ],
      },
      { id: "run-a1-1", occurrenceAt: "2026-11-19T13:00:00.000Z", status: "ok", output: "No new payment emails.", error: null, actions: [] },
    ],
  },
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "Tidy the desktop",
    instruction: "Move loose files on the desktop into Documents/Desktop archive and quit apps I left open.",
    schedule: { kind: "daily", time: "22:00" },
    scheduleText: "Every day at 22:00",
    tools: ["mac"],
    delivery: ["spoken"],
    whenMacOff: "wait",
    paused: false,
    nextRunAt: "2026-11-22T03:00:00.000Z",
    runs: [
      {
        id: "run-a2-1",
        occurrenceAt: "2026-11-21T03:00:00.000Z",
        status: "waiting_approval",
        output: "Moved 14 files into the archive. Preview has unsaved changes, so I left it open and asked first.",
        error: null,
        actions: [{ id: "act-a2-1", summary: "Moved 14 files to Documents/Desktop archive", undoable: true, undone: false }],
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-0000000000a3",
    name: "Brand follow-ups",
    instruction: "Find invoices more than 14 days unpaid and draft a polite reminder to the brand contact.",
    schedule: { kind: "weekdays", time: "09:00" },
    scheduleText: "Weekdays at 09:00",
    tools: ["hydra", "gmail"],
    delivery: ["notification", "email"],
    whenMacOff: "wait",
    paused: false,
    nextRunAt: "2026-11-23T14:00:00.000Z",
    runs: [
      {
        id: "run-a3-1",
        occurrenceAt: "2026-11-20T14:00:00.000Z",
        status: "waiting_approval",
        output: "Invoice 114 to Brandly is 19 days unpaid. Reminder drafted, waiting for your yes to send.",
        error: null,
        actions: [],
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-0000000000a4",
    name: "Weekly tax set-aside check",
    instruction: "Compare what I set aside for taxes with what I owe so far this year and tell me the gap.",
    schedule: { kind: "weekly", time: "09:00", days: [1] },
    scheduleText: "Every Monday at 09:00",
    tools: ["hydra"],
    delivery: ["notification"],
    whenMacOff: "skip",
    paused: true,
    nextRunAt: null,
    runs: [
      {
        id: "run-a4-1",
        occurrenceAt: "2026-11-16T14:00:00.000Z",
        status: "failed",
        output: "",
        error: "Could not read the tax figures. The bank feed was out of date.",
        actions: [],
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-0000000000a5",
    name: "Close the day",
    instruction: "At 18:00 put tomorrow's events on the screen and quit the editing apps.",
    schedule: { kind: "daily", time: "18:00" },
    scheduleText: "Every day at 18:00",
    tools: ["mac", "calendar"],
    delivery: ["push"],
    whenMacOff: "skip",
    paused: false,
    nextRunAt: "2026-11-21T23:00:00.000Z",
    runs: [{ id: "run-a5-1", occurrenceAt: "2026-11-20T23:00:00.000Z", status: "skipped", output: "", error: null, actions: [] }],
  },
];

const approvals: ApprovalView[] = [
  {
    id: "approval-1",
    routineId: routines[1].id,
    routineName: routines[1].name,
    runId: "run-a2-1",
    summary: "Quit Preview, it has unsaved changes",
    reason: "mac",
    danger: true,
    createdAt: "2026-11-21T03:00:30.000Z",
  },
  {
    id: "approval-2",
    routineId: routines[2].id,
    routineName: routines[2].name,
    runId: "run-a3-1",
    summary: "Send a payment reminder to Jordan Lee at Brandly",
    reason: "send",
    danger: false,
    createdAt: "2026-11-20T14:00:30.000Z",
  },
];

export function fixtureData(): RoutinesData {
  return { now: NOW, timeZone: TZ, routines, approvals };
}
