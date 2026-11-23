// @vitest-environment node
// W2 repairs (R1b): one turn per thread, history bound, confirm deadline, Gmail/Calendar tools,
// reminder removal gate, MCP approval checks, routine retries, failures and settling.
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./events";

const planning = vi.hoisted(() => {
  const task = {
    id: "00000000-0000-4000-8000-0000000000b1",
    title: "Send the W-9",
    notes: "",
    statusId: "s",
    goalId: null,
    category: null,
    dueDate: null,
    position: 1,
    alertAt: "2026-11-21T23:00:00.000Z",
    repeatRule: null,
    repeatSeriesId: null,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    completedAt: null,
    values: {},
  };
  return {
    task,
    loadPlanning: vi.fn(async () => ({ ok: true, value: { statuses: [], tasks: [task], goals: [], events: [], properties: [], timeZone: "America/Toronto" } })),
    deleteTask: vi.fn(async () => ({ ok: true, value: null })),
    updateTask: vi.fn(async (_id: string, patch: object) => ({ ok: true, value: { ...task, ...patch } })),
  };
});
const google = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ ok: true, data: { messageId: "m1", threadId: "t1" } })),
  trashThread: vi.fn(async () => ({ ok: true, data: { threadId: "t1", trashed: true } })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/planning/actions", () => ({ loadPlanning: planning.loadPlanning, deleteTask: planning.deleteTask, updateTask: planning.updateTask }));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));
vi.mock("@/lib/google/gmail", async (orig) => ({ ...(await orig<object>()), sendEmail: google.sendEmail, trashThread: google.trashThread }));

const { runTurn, boundHistory, BUSY_MESSAGE } = await import("./loop");
const { executeTool, anthropicTools } = await import("./tools");
const { callMcpTool } = await import("./mcp");
const { runCron, settleRun, MAX_ATTEMPTS } = await import("./cron");
const { routineGroups, MCP_GROUPS } = await import("./config");
const { memoryStore } = await import("./testing");
const { scriptedModel, toolUse, textBlock, toolCtx, ALL } = await import("./fixtures");
const { DEFAULT_SETTINGS } = await import("./store");
import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { PlanningSnapshot } from "@/lib/planning/types";

type Mem = ReturnType<typeof memoryStore>;
const NOW = new Date("2026-11-21T15:00:00Z");
let mem: Mem;
beforeEach(() => {
  vi.clearAllMocks();
  mem = memoryStore({ now: () => NOW });
});

function turn(client: ReturnType<typeof scriptedModel>["client"], over: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const events: AgentEvent[] = [];
  const done = runTurn({
    client,
    store: mem.store,
    ctx: { db: {} as never, surface: "web", runId: null, deviceId: null, unattended: false, allowed: ALL, now: () => NOW, timeZone: async () => "America/Toronto" },
    text: "Hi Hydra",
    emit: (e) => events.push(e),
    mode: "live",
    settings: DEFAULT_SETTINGS,
    confirmWaitMs: 2_000,
    pollMs: 5,
    ...over,
  });
  return { events, done };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error("timed out");
};

const blocks = (m: BetaMessageParam | undefined) => (!m || typeof m.content === "string" ? [] : (m.content ?? []));

/** What the Messages API demands: user first, and each tool_use answered in the very next message, nothing else. */
function expectValidHistory(messages: BetaMessageParam[]) {
  expect(messages[0].role).toBe("user");
  for (let i = 0; i < messages.length; i++) {
    const uses = blocks(messages[i]).flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    const results = blocks(messages[i]).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));
    const before = i > 0 && messages[i - 1].role === "assistant" ? blocks(messages[i - 1]).flatMap((b) => (b.type === "tool_use" ? [b.id] : [])) : [];
    expect(results.sort(), `message ${i} answers only the call right before it`).toEqual(results.length ? before.sort() : []);
    if (uses.length) {
      const next = messages[i + 1];
      expect(next?.role, `message ${i + 1} answers the calls`).toBe("user");
      expect(blocks(next).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])).sort()).toEqual(uses.sort());
    }
  }
}
const stored = (threadId: string) => mem.messages.filter((m) => m.thread_id === threadId).map((m) => m.message);

describe("one turn at a time per thread (AGT-2)", () => {
  it("two concurrent turns on one thread leave a valid history and run the delete once", async () => {
    const first = scriptedModel([{ text: "Hi.", content: [], stop_reason: "end_turn" }]);
    const { threadId } = await turn(first.client).done;

    const { client, requests } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: planning.task.id })], stop_reason: "tool_use" },
      { text: "Deleted.", content: [], stop_reason: "end_turn" },
      { text: "Something else.", content: [], stop_reason: "end_turn" },
    ]);
    const a = turn(client, { threadId, text: "Delete the W-9 task" });
    await until(() => a.events.some((e) => e.type === "confirm"));
    const b = turn(client, { threadId, text: "Also, what's due today?" });
    await new Promise((r) => setTimeout(r, 30)); // B waits for the thread instead of interleaving
    expect(requests).toHaveLength(1);
    const confirm = a.events.find((e) => e.type === "confirm") as Extract<AgentEvent, { type: "confirm" }>;
    await mem.store.moveApproval(confirm.id, ["pending"], "approved");
    const [ra, rb] = await Promise.all([a.done, b.done]);

    expect([ra.stop, rb.stop]).toEqual(["end_turn", "end_turn"]);
    expect(planning.deleteTask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(stored(threadId))).not.toContain("Interrupted");
    expectValidHistory(stored(threadId));
    for (const r of requests) expectValidHistory(r.messages);
  });

  it("a second turn that cannot get the thread in time says so and writes nothing", async () => {
    const first = scriptedModel([{ text: "Hi.", content: [], stop_reason: "end_turn" }]);
    const { threadId } = await turn(first.client).done;
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: planning.task.id })], stop_reason: "tool_use" },
      { text: "Deleted.", content: [], stop_reason: "end_turn" },
    ]);
    const a = turn(client, { threadId });
    await until(() => a.events.some((e) => e.type === "confirm"));
    const count = stored(threadId).length;
    const b = turn(client, { threadId, lockWaitMs: 20 });
    expect((await b.done).stop).toBe("busy");
    expect(b.events).toContainEqual({ type: "error", message: BUSY_MESSAGE });
    expect(stored(threadId)).toHaveLength(count);
    const confirm = a.events.find((e) => e.type === "confirm") as Extract<AgentEvent, { type: "confirm" }>;
    await mem.store.moveApproval(confirm.id, ["pending"], "approved");
    await a.done;
    expectValidHistory(stored(threadId));
  });

  it("after a turn died mid-confirm, the next turn expires its approval before answering the call as interrupted", async () => {
    const threadId = await mem.store.createThread("web", "t");
    await mem.store.appendMessage(threadId, { role: "user", content: [{ type: "text", text: "delete it" }] }, "web");
    await mem.store.appendMessage(threadId, { role: "assistant", content: [toolUse("tu_9", "delete_task", { id: planning.task.id })] as never }, "web");
    const dead = await mem.store.createApproval({
      source: "live", thread_id: threadId, run_id: null, device_id: null, tool: "delete_task", input: { id: planning.task.id },
      summary: "Delete this task", reason: "delete", danger: true, expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const { client, requests } = scriptedModel([{ text: "OK.", content: [], stop_reason: "end_turn" }]);
    await turn(client, { threadId }).done;
    expect(mem.approvals.find((x) => x.id === dead.id)!.status).toBe("expired");
    expect(await mem.store.moveApproval(dead.id, ["pending"], "approved")).toBeNull(); // a late yes runs nothing
    expectValidHistory(requests[0].messages);
    expect(planning.deleteTask).not.toHaveBeenCalled();
  });
});

describe("the history sent to the model is bounded (AGT-12)", () => {
  const big = "x".repeat(1_000);
  const turnOf = (n: number): BetaMessageParam[] => [
    { role: "user", content: [{ type: "text", text: `ask ${n} ${big}` }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, toolUse(`tu_${n}`, "list_tasks", {})] as never },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${n}`, content: big }] },
    { role: "assistant", content: [textBlock(`answer ${n}`)] as never },
  ];

  it("keeps whole newest turns, never a result without its call, and drops thinking once cut", () => {
    const all = Array.from({ length: 20 }, (_, n) => turnOf(n)).flat();
    const { messages, trimmed } = boundHistory(all, { chars: 9_000 });
    expect(trimmed).toBe(true);
    expect(messages.length).toBeLessThan(all.length);
    expect(messages.length % 4).toBe(0);
    expect(JSON.stringify(messages[0])).toContain("ask ");
    expect(JSON.stringify(messages.at(-1))).toContain("answer 19");
    expect(JSON.stringify(messages)).not.toContain('"thinking"');
    expectValidHistory(messages);
  });

  it("sends a short thread whole, thinking included", () => {
    const all = turnOf(1);
    expect(boundHistory(all)).toEqual({ messages: all, trimmed: false });
  });

  it("loads the newest messages, not the oldest", async () => {
    const id = await mem.store.createThread("web", "t");
    for (let i = 0; i < 5; i++) await mem.store.appendMessage(id, { role: "user", content: [{ type: "text", text: `m${i}` }] }, "web");
    expect(JSON.stringify(await mem.store.loadMessages(id, 2))).toBe(JSON.stringify([{ role: "user", content: [{ type: "text", text: "m3" }] }, { role: "user", content: [{ type: "text", text: "m4" }] }]));
  });
});

describe("a confirm never outlives the turn (AGT-9)", () => {
  it("caps the wait at the turn's budget", async () => {
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: planning.task.id })], stop_reason: "tool_use" },
      { text: "No answer.", content: [], stop_reason: "end_turn" },
    ]);
    const { done } = turn(client, { confirmWaitMs: 240_000, budgetMs: 5_200, pollMs: 50 });
    await until(() => mem.approvals.length > 0);
    expect(new Date(mem.approvals[0].expires_at).getTime() - NOW.getTime()).toBeLessThanOrEqual(5_200);
    await mem.store.moveApproval(mem.approvals[0].id, ["pending"], "declined");
    await done;
  });

  it("counts the budget from the turn's start, thread-lock wait included (RA-4)", async () => {
    const threadId = await mem.store.createThread("web", "t");
    const other = "00000000-0000-4000-8000-00000000bbbb";
    await mem.store.claimThread(threadId, other, 300); // another device's turn holds the thread
    setTimeout(() => void mem.store.releaseThread(threadId, other), 1_500);
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: planning.task.id })], stop_reason: "tool_use" },
      { text: "No answer.", content: [], stop_reason: "end_turn" },
    ]);
    const { done } = turn(client, { threadId, lockWaitMs: 5_000, confirmWaitMs: 240_000, budgetMs: 8_000, pollMs: 20 });
    await vi.waitFor(() => expect(mem.approvals.length).toBeGreaterThan(0), { timeout: 5_000 });
    // The confirm wait ends 8 s after the turn began, not 8 s after the lock came free.
    expect(new Date(mem.approvals[0].expires_at).getTime() - NOW.getTime()).toBeLessThanOrEqual(8_000 - 1_400);
    await mem.store.moveApproval(mem.approvals[0].id, ["pending"], "declined");
    await done;
  });

  it("counts the budget from the request start the route passes (RA-4)", async () => {
    const { client } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: planning.task.id })], stop_reason: "tool_use" },
      { text: "Out of time.", content: [], stop_reason: "end_turn" },
    ]);
    // The request came in 276 s ago: under 5 s of the 280 s budget is left, so it does not ask.
    const { events, done } = turn(client, { startedAt: Date.now() - 276_000 });
    await done;
    expect(events.some((e) => e.type === "confirm")).toBe(false);
    expect(mem.approvals).toHaveLength(0);
  });

  it("does not ask when no time is left, and says so", async () => {
    const { client, requests } = scriptedModel([
      { content: [toolUse("tu_1", "delete_task", { id: planning.task.id })], stop_reason: "tool_use" },
      { text: "Out of time.", content: [], stop_reason: "end_turn" },
    ]);
    const { events, done } = turn(client, { budgetMs: 3_000 });
    await done;
    expect(mem.approvals).toHaveLength(0);
    expect(events.some((e) => e.type === "confirm")).toBe(false);
    expect(JSON.stringify(requests[1].messages.at(-1))).toContain("no time left");
    expect(planning.deleteTask).not.toHaveBeenCalled();
  });
});

describe("Gmail and Calendar tools (AGT-4)", () => {
  const mail = { to: ["brand@example.com"], subject: "Invoice", body: "Hi" };
  const approval = (tool: string, status: "pending" | "approved") =>
    mem.store
      .createApproval({ source: "live", thread_id: null, run_id: null, device_id: null, tool, input: mail, summary: "Send", reason: "send", danger: true, expires_at: new Date(NOW.getTime() + 60_000).toISOString() })
      .then(async (a) => (status === "approved" ? (await mem.store.moveApproval(a.id, ["pending"], "approved"))! : a));

  it("a gmail or calendar routine gets those tools", () => {
    const names = (tools: string[]) => anthropicTools(routineGroups(tools)).map((t) => t.name);
    expect(names(["hydra", "gmail"])).toEqual(expect.arrayContaining(["gmail_search", "gmail_read_thread", "gmail_send", "gmail_trash", "list_deals"]));
    expect(names(["calendar"])).toEqual(["calendar_sync", "calendar_pending_deletes", "calendar_confirm_delete", "calendar_keep"]);
  });

  it("send asks first, and refuses without a real approval in the store", async () => {
    const ctx = toolCtx(mem.store);
    expect((await executeTool("gmail_send", mail, ctx)).status).toBe("confirm");
    expect(await executeTool("gmail_send", mail, ctx, { approved: true })).toMatchObject({ status: "error", message: "This needs the owner's yes first." });
    const pending = await approval("gmail_send", "pending");
    expect((await executeTool("gmail_send", mail, ctx, { approved: true, approvalId: pending.id })).status).toBe("error");
    const other = await approval("gmail_trash", "approved");
    expect((await executeTool("gmail_send", mail, ctx, { approved: true, approvalId: other.id })).status).toBe("error");
    expect(google.sendEmail).not.toHaveBeenCalled();

    const yes = await approval("gmail_send", "approved");
    expect((await executeTool("gmail_send", mail, ctx, { approved: true, approvalId: yes.id })).status).toBe("ok");
    expect(google.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ["brand@example.com"] }), yes.id);
  });

  it("trash asks first and refuses without an approval", async () => {
    const ctx = toolCtx(mem.store);
    expect(await executeTool("gmail_trash", { threadId: "t1" }, ctx)).toMatchObject({ status: "confirm", gate: { reason: "delete", danger: true } });
    expect((await executeTool("gmail_trash", { threadId: "t1" }, ctx, { approved: true })).status).toBe("error");
    expect(google.trashThread).not.toHaveBeenCalled();
  });
});

describe("removing a reminder by update asks first (AGT-7)", () => {
  it("update_task and update_event with alertAt null are gated; other changes are not", async () => {
    const ctx = toolCtx(mem.store);
    const id = planning.task.id;
    expect(await executeTool("update_task", { id, patch: { alertAt: null } }, ctx)).toMatchObject({ status: "confirm", gate: { reason: "delete" } });
    expect(await executeTool("update_event", { id, patch: { alertAt: null } }, ctx)).toMatchObject({ status: "confirm", gate: { reason: "delete" } });
    expect(planning.updateTask).not.toHaveBeenCalled();
    expect((await executeTool("update_task", { id, patch: { title: "Send the W-9 now" } }, ctx)).status).toBe("ok");
  });
});

describe("MCP approvals (AGT-3)", () => {
  const DEVICE = "00000000-0000-4000-8000-0000000000d1";
  const OTHER = "00000000-0000-4000-8000-0000000000d2";
  const ctx = (deviceId: string) => toolCtx(mem.store, { surface: "mcp", allowed: MCP_GROUPS, deviceId });
  const input = { id: planning.task.id };
  const approvalIdOf = (r: Awaited<ReturnType<typeof callMcpTool>>) => (r.structuredContent as { approvalId: string }).approvalId;

  it("only the device that asked may use the approval, and only before it expires", async () => {
    const id = approvalIdOf(await callMcpTool("delete_task", input, ctx(DEVICE)));
    await mem.store.moveApproval(id, ["pending"], "approved");
    expect((await callMcpTool("delete_task", { ...input, approvalId: id }, ctx(OTHER))).isError).toBe(true);
    expect(planning.deleteTask).not.toHaveBeenCalled();
    expect((await callMcpTool("delete_task", { ...input, approvalId: id }, ctx(DEVICE))).isError).toBe(false);
    expect(planning.deleteTask).toHaveBeenCalledTimes(1);

    const late = approvalIdOf(await callMcpTool("delete_task", input, ctx(DEVICE)));
    await mem.store.moveApproval(late, ["pending"], "approved");
    const after = toolCtx(mem.store, { surface: "mcp", allowed: MCP_GROUPS, deviceId: DEVICE, now: () => new Date(NOW.getTime() + 16 * 60_000) });
    expect((await callMcpTool("delete_task", { ...input, approvalId: late }, after)).isError).toBe(true);
    expect(planning.deleteTask).toHaveBeenCalledTimes(1);
  });
});

describe("routine runs never hang (AGT-5, AGT-6)", () => {
  const snapshot = async () => ({ statuses: [], tasks: [], goals: [], events: [], properties: [], timeZone: "America/Toronto" }) as unknown as PlanningSnapshot;
  async function routineRun() {
    await mem.store.createRoutine({
      name: "Brand mail", instruction: "Check Gmail", schedule: { kind: "daily", time: "08:00" }, tools: ["hydra", "gmail"],
      delivery: ["notification"], when_mac_off: "wait", paused: false, next_run_at: "2026-11-21T13:00:00.000Z",
    });
  }
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

  it("retries a start that failed, at most 3 times, then fails the run and tells the owner", async () => {
    await routineRun();
    const runRoutine = vi.fn(async () => {
      throw new Error("routine run: 503");
    });
    const tick = (min: number) => runCron({ store: mem.store, db: {} as never, now: at(min), snapshot, runRoutine });
    await tick(0);
    expect(runRoutine).toHaveBeenCalledTimes(1);
    await tick(1); // too soon to try again
    expect(runRoutine).toHaveBeenCalledTimes(1);
    await tick(3);
    await tick(6);
    expect(runRoutine).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(mem.runs[0].status).toBe("queued");
    const last = await tick(9);
    expect(runRoutine).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(last.failed).toBe(1);
    expect(mem.runs[0]).toMatchObject({ status: "failed", error: "It could not start. Hydra tried 3 times." });
    expect(mem.notifications.find((n) => n.kind === "routine")).toMatchObject({ title: "Brand mail: Failed" });
  });

  it("a reminder step that throws never keeps a claimed run from starting", async () => {
    await routineRun();
    const runRoutine = vi.fn(async () => {});
    const broken = async () => {
      throw new Error("planning down");
    };
    const r = await runCron({ store: mem.store, db: {} as never, now: at(0), snapshot: broken, runRoutine });
    expect(runRoutine).toHaveBeenCalledWith(mem.runs[0].id);
    expect(r.routines).toEqual([mem.runs[0].id]);
  });

  it("a retry that works starts the run", async () => {
    await routineRun();
    const runRoutine = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue(undefined);
    await runCron({ store: mem.store, db: {} as never, now: at(0), snapshot, runRoutine });
    const second = await runCron({ store: mem.store, db: {} as never, now: at(3), snapshot, runRoutine });
    expect(second.routines).toEqual([mem.runs[0].id]);
    expect(runRoutine).toHaveBeenCalledTimes(2);
  });

  it("fails a run still 'running' after its function died, once, and tells the owner", async () => {
    await routineRun();
    await runCron({ store: mem.store, db: {} as never, now: at(0), snapshot, runRoutine: async () => {} });
    await mem.store.startRun(mem.runs[0].id);
    await mem.store.updateRun(mem.runs[0].id, { started_at: at(0).toISOString() });
    await runCron({ store: mem.store, db: {} as never, now: at(5), snapshot, runRoutine: async () => {} });
    expect(mem.runs[0].status).toBe("running");
    const r = await runCron({ store: mem.store, db: {} as never, now: at(7), snapshot, runRoutine: async () => {} });
    expect(r.failed).toBe(1);
    expect(mem.runs[0]).toMatchObject({ status: "failed", error: "It stopped before it finished." });
    expect(mem.notifications.filter((n) => n.kind === "routine")).toHaveLength(1);
  });

  async function waitingRun() {
    await routineRun();
    const [c] = await mem.store.claimDueRoutines(NOW, 5);
    await mem.store.updateRun(c.run_id, { status: "waiting_approval", output: "Found 3 newsletters." });
    const a = await mem.store.createApproval({
      source: "routine", thread_id: null, run_id: c.run_id, device_id: null, tool: "gmail_trash", input: { threadId: "t1" },
      summary: "Move this email thread to the trash", reason: "delete", danger: true, expires_at: at(60).toISOString(),
    });
    return { runId: c.run_id, approvalId: a.id };
  }

  it("declining the last open step finishes the run and tells the owner", async () => {
    const { runId, approvalId } = await waitingRun();
    await mem.store.moveApproval(approvalId, ["pending"], "declined");
    expect(await settleRun(mem.store, runId)).toBe("skipped");
    expect(mem.runs[0]).toMatchObject({ status: "skipped", output: "Found 3 newsletters.\nYou declined: Move this email thread to the trash" });
    expect(mem.notifications.find((n) => n.kind === "routine")).toMatchObject({ title: "Brand mail: Not done" });
    expect(await settleRun(mem.store, runId)).toBeNull(); // once
  });

  it("an approval that expired unanswered is settled by the cron", async () => {
    const { runId } = await waitingRun();
    await runCron({ store: mem.store, db: {} as never, now: at(30), snapshot, runRoutine: async () => {} });
    expect(mem.runs.find((r) => r.id === runId)!.status).toBe("waiting_approval");
    await runCron({ store: mem.store, db: {} as never, now: at(61), snapshot, runRoutine: async () => {} });
    expect(mem.runs.find((r) => r.id === runId)).toMatchObject({ status: "skipped", output: expect.stringContaining("No answer: Move this email thread") });
  });
});

// Keep the type import used.
export type _B = BetaContentBlock;
