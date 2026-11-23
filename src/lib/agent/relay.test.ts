// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/planning/actions", () => ({}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const { relayBatchSchema, relayTurn, approvalStatus, threadHistory, RELAY_LEASE_S, RELAY_TURN_MS } = await import("./relay");
const { runCron, runRoutineJob, finishRelayRun, settleRun, RUNNING_TIMEOUT_MS } = await import("./cron");
const { memoryStore, memoryRelay } = await import("./testing");
import type { AgentEvent } from "./events";
import type { RelayEvent, RelayTurnRow } from "./relay";

const MAC_A = "00000000-0000-4000-8000-00000000000a";
const MAC_B = "00000000-0000-4000-8000-00000000000b";
const CONTEXT = { path: "/", search: "", scope: "all" as const };

let clock: number;
let mem: ReturnType<typeof memoryStore>;
let r: ReturnType<typeof memoryRelay>;
beforeEach(() => {
  clock = Date.parse("2026-11-22T15:00:00Z");
  mem = memoryStore({ now: () => new Date(clock), brain: "mac" });
  r = memoryRelay(mem, { now: () => new Date(clock) });
});

async function queue(text = "What did I spend today?") {
  const threadId = await mem.store.createThread("web", text);
  return { threadId, turnId: await r.relay.createTurn({ thread_id: threadId, input: { text }, surface: "web", context: CONTEXT }) };
}
/** The Mac posts under its claim (seq: the claim's number of the batch's first event, optional). */
const append = (t: RelayTurnRow, events: RelayEvent[], o: { device?: string; seq?: number | null } = {}) =>
  r.relay.append(t.id, o.device ?? t.claimed_by!, t.claim_id!, o.seq ?? null, events, RELAY_LEASE_S);
const said = async (threadId: string) =>
  (await mem.store.loadMessages(threadId)).map((m) => [m.role, (m.content as { text: string }[])[0].text]);
const mcpApproval = (o: { expires?: number; summary?: string } = {}) =>
  mem.store.createApproval({
    source: "mcp",
    thread_id: null,
    run_id: null,
    device_id: MAC_A,
    tool: "delete_task",
    input: { id: "t1" },
    summary: o.summary ?? "Delete the task Send W-9",
    reason: "delete",
    danger: true,
    expires_at: new Date(clock + (o.expires ?? 15 * 60_000)).toISOString(),
  });

describe("claiming a relay turn", () => {
  it("two Macs ask at once: one wins with a fresh claim id, the other gets nothing", async () => {
    const { turnId } = await queue();
    const [a, b] = await Promise.all([r.relay.claim(MAC_A, RELAY_LEASE_S), r.relay.claim(MAC_B, RELAY_LEASE_S)]);
    expect([a?.id, b?.id].filter(Boolean)).toEqual([turnId]);
    expect(r.turns[0]).toMatchObject({ status: "claimed", attempts: 1, claim_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("a lapsed lease goes back to the queue once, then the turn fails with an error event", async () => {
    const { turnId } = await queue();
    await r.relay.claim(MAC_A, RELAY_LEASE_S);
    clock += 61_000;
    const again = await r.relay.claim(MAC_B, RELAY_LEASE_S);
    expect(again).toMatchObject({ id: turnId, claimed_by: MAC_B, attempts: 2 });
    clock += 61_000;
    expect(await r.relay.claim(MAC_A, RELAY_LEASE_S)).toBeNull();
    expect(r.turns[0].status).toBe("error");
    expect((await r.relay.eventsAfter(turnId, 0)).map((e) => e.event)).toEqual([{ type: "error", code: "mac_failed", message: "Your Mac stopped answering." }]);
  });

  it("F1: the same Mac re-claims a re-queued turn; the old run's posts get stale_claim and never mix in", async () => {
    const { threadId, turnId } = await queue();
    const first = (await r.relay.claim(MAC_A, RELAY_LEASE_S))!;
    expect(await append(first, [{ type: "text", delta: "FIRST RUN partial." }])).toBe("claimed");
    clock += 61_000; // the lid was shut: the lease lapsed
    const second = (await r.relay.claim(MAC_A, RELAY_LEASE_S))!;
    expect(second.claim_id).not.toBe(first.claim_id);
    expect(await append(first, [{ type: "text", delta: "OLD resumes." }])).toBe("stale_claim");
    expect(await append(first, [])).toBe("stale_claim"); // its heartbeat too
    expect(await append(second, [{ type: "text", delta: "NEW answer." }, { type: "done" }])).toBe("done");
    expect((await r.relay.eventsAfter(turnId, 0)).map((e) => e.event)).toEqual([
      { type: "text", delta: "FIRST RUN partial." },
      { type: "text", delta: "NEW answer." },
      { type: "done" },
    ]);
    expect(await said(threadId)).toEqual([
      ["user", "What did I spend today?"],
      ["assistant", "FIRST RUN partial.NEW answer."],
    ]);
  });

  it("an empty post (the 20 s heartbeat) renews the lease", async () => {
    await queue();
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S))!;
    clock += 50_000;
    expect(await append(t, [])).toBe("claimed");
    clock += 50_000;
    expect(await r.relay.sweep()).toBe(0);
  });

  it("slots: a live slot never takes a routine turn and a routine slot never takes a live one", async () => {
    const routineThread = await mem.store.createThread("routine", "Brand mail");
    const routineTurn = await r.relay.createTurn({ thread_id: routineThread, input: { text: "Run it" }, surface: "routine", context: CONTEXT });
    const { turnId: liveTurn } = await queue();
    expect((await r.relay.claim(MAC_A, RELAY_LEASE_S, "live"))?.id).toBe(liveTurn);
    expect(await r.relay.claim(MAC_A, RELAY_LEASE_S, "live")).toBeNull();
    expect((await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine"))?.id).toBe(routineTurn);
  });

  it("claims and posts are what make the Mac online; the claim's thread history rides along", async () => {
    expect(await r.relay.macOnline(new Date(clock - 45_000))).toBe(false);
    const { threadId } = await queue("And yesterday?");
    await mem.store.appendMessage(threadId, { role: "user", content: [{ type: "text", text: "<context>page</context>" }, { type: "text", text: "Show my last transaction" }] }, "web");
    await mem.store.appendMessage(threadId, { role: "assistant", content: [{ type: "text", text: "Coffee, $4." }] }, "web");
    await r.relay.claim(MAC_A, RELAY_LEASE_S);
    expect(await r.relay.macOnline(new Date(clock - 45_000))).toBe(true);
    expect(await threadHistory(mem.store, threadId)).toEqual([
      { role: "user", text: "Show my last transaction" },
      { role: "assistant", text: "Coffee, $4." },
    ]);
  });
});

describe("relay events", () => {
  const ids = { turnId: "00000000-0000-4000-8000-000000000001", claimId: "00000000-0000-4000-8000-000000000002" };
  const batch = (events: unknown[], extra: object = {}) => relayBatchSchema.safeParse({ ...ids, ...extra, events });

  it("accepts the SSE contract", () => {
    const ok = batch([
      { type: "text", delta: "You spent " },
      { type: "tool", name: "list_transactions", status: "done", summary: "3 rows" },
      { type: "ui", action: { kind: "navigate", href: "/transactions?tx=abc" } },
      { type: "ui", action: { kind: "openPanel", param: "taxline", value: "abc-1" } },
      { type: "ui", action: { kind: "setScope", scope: "ugc" } },
      { type: "ui", action: { kind: "highlight", selector: "[data-row='abc']" } },
      { type: "confirm", id: "00000000-0000-4000-8000-0000000000f1", summary: "Delete the task", danger: true },
      { type: "done" },
    ]);
    expect(ok.success).toBe(true);
    expect(batch([{ type: "error", message: "No network", code: "mac_network" }]).success).toBe(true);
    expect(batch([]).success).toBe(true);
    expect(batch([], { seq: 4 }).success).toBe(true);
    expect(batch([{ type: "text", delta: "x".repeat(8000) }]).success).toBe(true);
  });

  it("usage in done is optional and lenient: the Mac's snake_case counts are kept, anything else is dropped", () => {
    const usage = (u: unknown) => {
      const b = batch([{ type: "done", usage: u }]);
      return b.success ? b.data.events[0] : "refused";
    };
    expect(usage({ input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9 })).toEqual({
      type: "done",
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9 },
    });
    expect(usage({ inputTokens: 1200, outputTokens: 80, output_tokens: 3, cost: "x" })).toEqual({ type: "done", usage: { output_tokens: 3 } });
    expect(usage({ input_tokens: "12" })).toEqual({ type: "done", usage: {} });
    expect(usage(null)).toEqual({ type: "done" });
  });

  it.each([
    ["no claim id", [{ type: "text", delta: "hi" }], { claimId: undefined }],
    ["a thread event (the server owns threads)", [{ type: "thread", threadId: "00000000-0000-4000-8000-000000000001" }], {}],
    ["an off-site navigate", [{ type: "ui", action: { kind: "navigate", href: "//evil.example/x" } }], {}],
    ["a scheme in navigate", [{ type: "ui", action: { kind: "navigate", href: "javascript:alert(1)" } }], {}],
    ["whitespace in navigate", [{ type: "ui", action: { kind: "navigate", href: "/planning x" } }], {}],
    ["a backslash in navigate", [{ type: "ui", action: { kind: "navigate", href: "/\\evil.example" } }], {}],
    ["a control character in navigate", [{ type: "ui", action: { kind: "navigate", href: "/planning\u0000" } }], {}],
    ["an unknown panel", [{ type: "ui", action: { kind: "openPanel", param: "admin", value: "1" } }], {}],
    ["a panel value with a space", [{ type: "ui", action: { kind: "openPanel", param: "tx", value: "abc def" } }], {}],
    ["a selector over 200", [{ type: "ui", action: { kind: "highlight", selector: "x".repeat(201) } }], {}],
    ["a confirm summary over 500", [{ type: "confirm", id: "00000000-0000-4000-8000-0000000000f1", summary: "x".repeat(501), danger: true }], {}],
    ["a text delta over 8000", [{ type: "text", delta: "x".repeat(8001) }], {}],
    ["a confirm without an approval id", [{ type: "confirm", id: "x", summary: "Pay", danger: true }], {}],
    ["an unknown field", [{ type: "text", delta: "hi", html: "<b>" }], {}],
    ["an event after done", [{ type: "done" }, { type: "text", delta: "late" }], {}],
    ["a tool with a made-up status", [{ type: "tool", name: "x", status: "maybe", summary: "" }], {}],
    ["seq 0", [], { seq: 0 }],
  ])("refuses %s", (_name, events, extra) => expect(batch(events, extra).success).toBe(false));

  it("keeps order across posts, closes the turn into the thread, and refuses posts after the close", async () => {
    const { threadId, turnId } = await queue();
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S))!;
    expect(await append(t, [{ type: "text", delta: "x" }], { device: MAC_B })).toBe("not_yours");
    expect(await append(t, [{ type: "text", delta: "You spent " }, { type: "tool", name: "list_transactions", status: "done", summary: "3" }])).toBe("claimed");
    expect(await append(t, [{ type: "text", delta: "$42." }, { type: "done" }])).toBe("done");
    expect((await r.relay.eventsAfter(turnId, 0)).map((e) => `${e.seq}:${e.event.type}`)).toEqual(["1:text", "2:tool", "3:text", "4:done"]);
    expect((await r.relay.eventsAfter(turnId, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect(await said(threadId)).toEqual([
      ["user", "What did I spend today?"],
      ["assistant", "You spent $42."],
    ]);
    expect(await append(t, [{ type: "text", delta: "late" }])).toBe("stale_claim");
  });

  it("F8: a retried post with the same seq is stored once; a gap is refused; a replayed closing post answers its status", async () => {
    const { turnId } = await queue();
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S))!;
    const first: RelayEvent[] = [{ type: "text", delta: "You spent " }, { type: "text", delta: "$42" }];
    expect(await append(t, first, { seq: 1 })).toBe("claimed");
    expect(await append(t, first, { seq: 1 })).toBe("claimed"); // the response was lost; the Mac retries
    expect(await append(t, [{ type: "text", delta: "$42" }, { type: "text", delta: "." }], { seq: 2 })).toBe("claimed"); // overlaps by one
    expect(await append(t, [{ type: "text", delta: "?" }], { seq: 9 })).toBe("seq_gap");
    expect(await append(t, [], { seq: 4 })).toBe("claimed"); // heartbeat
    expect(await append(t, [{ type: "done" }], { seq: 4 })).toBe("done");
    expect(await append(t, [{ type: "done" }], { seq: 4 })).toBe("done"); // its answer was lost too
    expect(await append(t, [], { seq: 5 })).toBe("stale_claim"); // but nothing new after the close
    expect((await r.relay.eventsAfter(turnId, 0)).map((e) => (e.event.type === "text" ? e.event.delta : e.event.type))).toEqual([
      "You spent ",
      "$42",
      ".",
      "done",
    ]);
  });

  it("an approval reads as the Mac needs it", () => {
    const at = new Date("2026-11-22T15:00:00Z");
    const future = "2026-11-22T15:10:00.000Z";
    expect(approvalStatus({ status: "pending", expires_at: future }, at)).toBe("pending");
    expect(approvalStatus({ status: "pending", expires_at: "2026-11-22T14:59:00.000Z" }, at)).toBe("expired");
    for (const s of ["approved", "done"] as const) expect(approvalStatus({ status: s, expires_at: future }, at)).toBe("approved");
    expect(approvalStatus({ status: "declined", expires_at: future }, at)).toBe("declined");
    // F15: a step that already ran and failed is never called again.
    for (const s of ["expired", "failed"] as const) expect(approvalStatus({ status: s, expires_at: future }, at)).toBe("expired");
  });
});

describe("the web side of a Mac turn", () => {
  // The route's poll sleeps are released one at a time by the test, each moving the clock.
  const until = async (cond: () => boolean) => {
    for (let i = 0; !cond(); i++) {
      if (i > 1000) throw new Error("stuck");
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const run = (over: Partial<Parameters<typeof relayTurn>[0]> = {}) => {
    const out: AgentEvent[] = [];
    const sleepers: (() => void)[] = [];
    let finished = false;
    const done = relayTurn({
      relay: r.relay,
      store: mem.store,
      surface: "web",
      input: { text: "Hi" },
      context: CONTEXT,
      emit: (e) => out.push(e),
      startedAt: clock,
      now: () => clock,
      sleep: (ms) => new Promise<void>((resolve) => sleepers.push(() => ((clock += ms), resolve()))),
      ...over,
    }).then(() => void (finished = true));
    /** Let `n` polls pass (or until the turn ends). */
    const polls = async (n: number) => {
      for (let i = 0; i < n && !finished; i++) {
        await until(() => sleepers.length > 0 || finished);
        sleepers.shift()?.();
      }
      await until(() => sleepers.length > 0 || finished);
    };
    const toEnd = async () => {
      while (!finished) await polls(1);
      await done;
    };
    return { out, done, polls, toEnd };
  };

  it("no brain or Mac online: thread, then brain_offline at once, nothing is queued, and the owner's words are kept", async () => {
    r.seeMac(MAC_A, new Date(clock - 46_000)); // last seen 46 s ago
    const { out, done } = run();
    await done;
    expect(out).toEqual([
      { type: "thread", threadId: expect.any(String) },
      { type: "error", code: "brain_offline", message: "Hydra is offline." },
    ]);
    expect(r.turns).toHaveLength(0);
    expect(await said((out[0] as { threadId: string }).threadId)).toEqual([["user", "Hi"]]);
  });

  it("offline with no thread named: the newest conversation is kept, no empty thread is made", async () => {
    const threadId = await mem.store.createThread("phone", "earlier");
    const { out, done } = run();
    await done;
    expect(out[0]).toEqual({ type: "thread", threadId });
    expect(mem.threads).toHaveLength(1);
  });

  it("forwards the Mac's events in order; done carries usage (snake_case kept, the rest 0); the thread continues", async () => {
    r.seeMac(MAC_A, new Date(clock));
    const threadId = await mem.store.createThread("phone", "earlier");
    const { out, polls, toEnd } = run({ threadId });
    await polls(0);
    const turn = (await r.relay.claim(MAC_A, RELAY_LEASE_S))!;
    expect(turn).toMatchObject({ thread_id: threadId, input: { text: "Hi" }, surface: "web", context: CONTEXT });
    await append(turn, [{ type: "text", delta: "Hello" }]);
    await polls(2);
    expect(out.at(-1)).toEqual({ type: "text", delta: "Hello" });
    const done = relayBatchSchema.parse({
      turnId: turn.id,
      claimId: turn.claim_id,
      events: [{ type: "ui", action: { kind: "navigate", href: "/planning" } }, { type: "done", usage: { input_tokens: 7, output_tokens: 5, inputTokens: 7 } }],
    });
    await append(turn, done.events);
    await toEnd();
    expect(out).toEqual([
      { type: "thread", threadId },
      { type: "turn", turnId: turn.id },
      { type: "text", delta: "Hello" },
      { type: "ui", action: { kind: "navigate", href: "/planning" } },
      { type: "done", usage: { input_tokens: 7, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);
  });

  it("no end after 280 s: mac_timeout, the turn is expired, its open ask ends, the late Mac gets stale_claim, the words are kept", async () => {
    r.seeMac(MAC_A, new Date(clock));
    const started = clock;
    const { out, polls, toEnd } = run();
    await polls(0);
    const turn = (await r.relay.claim(MAC_A, 600))!;
    const gate = await mcpApproval();
    await append(turn, [{ type: "text", delta: "Deleting " }, { type: "confirm", id: gate.id, summary: gate.summary, danger: true }]);
    await toEnd();
    expect(out.at(-1)).toEqual({ type: "error", code: "mac_timeout", message: "Your Mac took too long." });
    expect(clock - started).toBe(RELAY_TURN_MS);
    expect(r.turns[0].status).toBe("expired");
    expect(await append(turn, [{ type: "done" }])).toBe("stale_claim");
    // F7: the owner cannot say yes to a step no turn will run any more.
    expect(mem.approvals[0]).toMatchObject({ status: "expired", relay_turn_id: turn.id });
    expect(await said(turn.thread_id)).toEqual([
      ["user", "Hi"],
      ["assistant", "Deleting "],
    ]);
  });

  it("F9: the brain held the turn and never ended it: brain_timeout in Hydra's words, not the Mac's", async () => {
    r.makeBrain(MAC_B);
    r.seeMac(MAC_A, new Date(clock)); // the Mac is idle and fine
    const { out, polls, toEnd } = run();
    await polls(0);
    const turn = (await r.relay.claim(MAC_B, 600))!;
    expect(turn.claimed_by).toBe(MAC_B);
    await toEnd();
    expect(out.at(-1)).toEqual({ type: "error", code: "brain_timeout", message: "Hydra took too long." });
  });

  it("F9: the brain went quiet twice: brain_failed in Hydra's words", async () => {
    r.makeBrain(MAC_B);
    r.seeMac(MAC_B, new Date(clock));
    const { out, polls, toEnd } = run();
    await polls(0);
    await r.relay.claim(MAC_B, RELAY_LEASE_S);
    await polls(61_000 / 250 + 20);
    await r.relay.claim(MAC_B, RELAY_LEASE_S);
    await toEnd();
    expect(out.at(-1)).toEqual({ type: "error", code: "brain_failed", message: "Hydra stopped answering." });
  });

  it("a Mac that dies mid-turn: re-queued once, then the error reaches the browser and the words are kept", async () => {
    r.seeMac(MAC_A, new Date(clock));
    const { out, polls, toEnd } = run();
    await polls(0);
    await r.relay.claim(MAC_A, RELAY_LEASE_S);
    await polls(61_000 / 250 + 20); // the lease lapses; the waiting route sweeps every 5 s
    expect(r.turns[0]).toMatchObject({ status: "queued", claimed_by: null, claim_id: null });
    await r.relay.claim(MAC_B, RELAY_LEASE_S);
    await toEnd();
    expect(out.at(-1)).toEqual({ type: "error", code: "mac_failed", message: "Your Mac stopped answering." });
    expect(r.turns[0].status).toBe("error");
    expect(await said(r.turns[0].thread_id)).toEqual([["user", "Hi"]]);
  });

  it("the browser leaves before a Mac took the turn: it is expired, never run", async () => {
    r.seeMac(MAC_A, new Date(clock));
    const abort = new AbortController();
    const { polls, toEnd } = run({ signal: abort.signal });
    await polls(0);
    abort.abort();
    await toEnd();
    expect(r.turns[0].status).toBe("expired");
    expect(await r.relay.claim(MAC_A, RELAY_LEASE_S)).toBeNull();
  });
});

describe("routines when the Mac is the brain", () => {
  let runId: string;
  const routine = (over: object = {}) =>
    mem.store.createRoutine({
      name: "Brand mail",
      instruction: "Check Gmail for brand payments",
      schedule: { kind: "daily", time: "10:00" },
      tools: ["hydra", "gmail"],
      delivery: ["notification"],
      when_mac_off: "wait",
      paused: false,
      next_run_at: new Date(clock - 1000).toISOString(),
      ...over,
    });
  beforeEach(async () => {
    await routine();
    [{ run_id: runId }] = await mem.store.claimDueRoutines(new Date(clock), 10);
  });
  const deps = () => ({ client: null, store: mem.store, db: {} as never, now: () => new Date(clock), relay: r.relay });
  const finish = async (t: RelayTurnRow) => finishRelayRun(mem.store, r.relay, (await r.relay.getTurn(t.id))!, undefined, new Date(clock));
  const post = async (t: RelayTurnRow, events: RelayEvent[]) => [await append(t, events), await finish(t)];
  const cron = () => runCron({ store: mem.store, db: {} as never, now: new Date(clock), runRoutine: async () => {}, relay: r.relay, snapshot: async () => ({ statuses: [], tasks: [], goals: [], events: [], properties: [], timeZone: "America/Toronto" }) as never });

  it("Mac on: the run becomes a relay turn with the routine's tools; done ends the run ok and tells the owner", async () => {
    r.seeMac(MAC_A, new Date(clock));
    expect(await runRoutineJob(runId, deps())).toBe("running");
    const claimed = (await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine"))!;
    expect(claimed).toMatchObject({ surface: "routine", routine_run_id: runId, allowed_tools: ["hydra", "gmail"] });
    expect("text" in claimed.input && claimed.input.text).toContain("Check Gmail for brand payments");
    expect(await post(claimed, [{ type: "text", delta: "Two payments added." }, { type: "done" }])).toEqual(["done", "ok"]);
    expect(mem.runs[0]).toMatchObject({ status: "ok", output: "Two payments added.", thread_id: claimed.thread_id });
    expect(mem.notifications.at(-1)).toMatchObject({ title: "Brand mail: Done", body: "Two payments added.", dedupe_key: `routine-relay:${runId}` });
  });

  it("Mac off and the routine waits: the turn waits in the queue; the Mac takes it later", async () => {
    expect(await runRoutineJob(runId, deps())).toBe("waiting_mac");
    expect(mem.runs[0].status).toBe("waiting_mac");
    expect(r.turns).toHaveLength(1);
    expect(mem.notifications.at(-1)).toMatchObject({ title: "Brand mail: Waiting for the Mac" });
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine"))!;
    expect(mem.runs[0].status).toBe("running");
    expect(await post(t, [{ type: "error", message: "Gmail is not connected." }])).toEqual(["error", "failed"]);
    expect(mem.runs[0]).toMatchObject({ status: "failed", error: "Gmail is not connected." });
  });

  it("Mac off and the routine skips: skipped, nothing queued", async () => {
    await mem.store.updateRoutine(mem.routines[0].id, { when_mac_off: "skip" });
    expect(await runRoutineJob(runId, deps())).toBe("skipped");
    expect(r.turns).toHaveLength(0);
    expect(mem.notifications.at(-1)).toMatchObject({ title: "Brand mail: Skipped: the Mac was off" });
  });

  it("F2/point 8: the Mac keeps the turn open while it waits; the owner's yes an hour later runs the step in the same turn", async () => {
    r.seeMac(MAC_A, new Date(clock));
    await runRoutineJob(runId, deps());
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine"))!;
    const gate = await mcpApproval({ summary: "Reply to the brand" });
    expect(await append(t, [{ type: "confirm", id: gate.id, summary: gate.summary, danger: true }])).toBe("claimed");
    expect(mem.approvals[0]).toMatchObject({ run_id: runId, relay_turn_id: t.id });
    expect(mem.approvals[0].expires_at > new Date(clock + 23 * 3600_000).toISOString()).toBe(true); // a routine's ask waits a day
    // F3: an hour of heartbeats; the minute cron never fails the held run.
    for (let i = 0; i < 180; i++) {
      clock += 20_000;
      expect(await append(t, [])).toBe("claimed");
      if (i % 3 === 0) await cron();
    }
    expect(mem.runs[0].status).toBe("running");
    await mem.store.moveApproval(gate.id, ["pending"], "approved");
    expect(approvalStatus((await mem.store.getApproval(gate.id))!, new Date(clock))).toBe("approved");
    await mem.store.moveApproval(gate.id, ["approved"], "done"); // the Mac called the tool again with the id
    expect(await post(t, [{ type: "text", delta: "Replied." }, { type: "done" }])).toEqual(["done", "ok"]);
    expect(mem.runs[0]).toMatchObject({ status: "ok", output: "Replied." });
  });

  it("F2: done with an ask still open ends that ask (no one is left to run it) and the run says so", async () => {
    r.seeMac(MAC_A, new Date(clock));
    await runRoutineJob(runId, deps());
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine"))!;
    const gate = await mcpApproval({ summary: "Reply to the brand" });
    expect(await post(t, [{ type: "confirm", id: gate.id, summary: gate.summary, danger: true }, { type: "done" }])).toEqual(["done", "ok"]);
    expect(mem.approvals[0].status).toBe("expired");
    expect(mem.runs[0].output).toBe("No answer: Reply to the brand");
  });

  it("F2: an MCP yes that came too late is expired, so a waiting run settles instead of hanging", async () => {
    const gate = await mcpApproval({ expires: 60_000 });
    Object.assign(mem.approvals[0], { run_id: runId, status: "approved" });
    Object.assign(mem.runs[0], { status: "waiting_approval" });
    expect(await settleRun(mem.store, runId, undefined, new Date(clock))).toBeNull(); // still in time
    clock += 61_000;
    expect(await settleRun(mem.store, runId, undefined, new Date(clock))).toBe("skipped");
    expect(gate.id).toBe(mem.approvals[0].id);
  });

  it("F11: online at enqueue but no Mac took it: after the running timeout the routine's own choice applies", async () => {
    r.seeMac(MAC_A, new Date(clock));
    expect(await runRoutineJob(runId, deps())).toBe("running");
    clock += RUNNING_TIMEOUT_MS + 1000;
    await cron();
    expect(mem.runs[0].status).toBe("waiting_mac"); // wait: the turn stays queued for the Mac
    expect(r.turns[0].status).toBe("queued");
  });

  it("F11: the same with skip: the run is skipped and its turn expired", async () => {
    await mem.store.updateRoutine(mem.routines[0].id, { when_mac_off: "skip" });
    r.seeMac(MAC_A, new Date(clock));
    expect(await runRoutineJob(runId, deps())).toBe("running");
    clock += RUNNING_TIMEOUT_MS + 1000;
    await cron();
    expect(mem.runs[0].status).toBe("skipped");
    expect(r.turns[0].status).toBe("expired");
    expect(mem.notifications.at(-1)).toMatchObject({ title: "Brand mail: Not done", body: "The Mac was off." });
  });

  it("F10: a newer run replaces an older one waiting for the Mac; the older turn is expired, not run", async () => {
    expect(await runRoutineJob(runId, deps())).toBe("waiting_mac");
    clock += 24 * 3600_000;
    expect(await mem.store.setNextRun(mem.routines[0].id, new Date(clock - 1000).toISOString())).toBe(true);
    const [{ run_id: newer }] = await mem.store.claimDueRoutines(new Date(clock), 10);
    expect(await runRoutineJob(newer, deps())).toBe("waiting_mac");
    expect(mem.runs.find((x) => x.id === runId)).toMatchObject({ status: "skipped", error: "A newer run took its place." });
    const t = (await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine"))!;
    expect(t.routine_run_id).toBe(newer);
    expect(r.turns[0].status).toBe("expired");
    expect(await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine")).toBeNull();
  });

  it("a Mac that dies on a routine turn: the run fails at the running timeout", async () => {
    r.seeMac(MAC_A, new Date(clock));
    await runRoutineJob(runId, deps());
    await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine");
    clock += 61_000;
    await r.relay.claim(MAC_A, RELAY_LEASE_S, "routine");
    clock += RUNNING_TIMEOUT_MS;
    await cron();
    expect(r.turns[0].status).toBe("error");
    expect(mem.runs[0]).toMatchObject({ status: "failed", error: "It stopped before it finished." });
  });

  it("the server brain without a key still fails closed", async () => {
    mem.setSettings({ brain: "server" });
    expect(await runRoutineJob(runId, deps())).toBe("failed");
    expect(r.turns).toHaveLength(0);
  });
});
