// @vitest-environment node
/*
 * The agent client against the REAL route handlers (turn, confirm, state, undo) and the real loop, tools, gate and
 * event stream. Only the model (a scripted Messages API) and the database (the in-memory AgentStore) are stand-ins.
 * The client's fetch goes straight to the handlers, so a drift on either side of the wire fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Listener, ListenerHandlers } from "./listener";
import type { SpeakerLike } from "./speaker";
import type { UiEvent } from "./types";

const m = vi.hoisted(() => ({
  mem: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryStore>,
  model: null as null | ReturnType<typeof import("@/lib/agent/fixtures").scriptedModel>,
  relay: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryRelay>,
  /** sha256 of the scripted Mac's device key (scopes agent, mcp, relay). */
  macHash: "",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ rpc: async (name: string) => ({ data: name === "is_owner", error: null }) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) =>
      name === "agent_device_auth"
        ? { data: args.p_key_hash === m.macHash ? [{ id: "00000000-0000-4000-8000-0000000000d1", scopes: ["agent", "mcp", "relay"] }] : [], error: null }
        : { data: null, error: null },
  }),
}));
vi.mock("@/lib/agent/store", async (orig) => ({ ...(await orig<object>()), supabaseStore: () => m.mem!.store }));
vi.mock("@/lib/agent/relay", async (orig) => ({ ...(await orig<object>()), supabaseRelay: () => m.relay!.relay }));
vi.mock("@/lib/agent/config", async (orig) => ({ ...(await orig<object>()), createModelClient: () => m.model?.client ?? null }));
vi.mock("@/lib/planning/actions", () => ({}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const turn = await import("@/app/api/agent/turn/route");
const confirm = await import("@/app/api/agent/confirm/route");
const state = await import("@/app/api/agent/state/route");
const undo = await import("@/app/api/agent/undo/route");
const relayNext = await import("@/app/api/agent/relay/next/route");
const relayEvents = await import("@/app/api/agent/relay/events/route");
const relayApproval = await import("@/app/api/agent/relay/approval/route");
const { memoryStore, memoryRelay } = await import("@/lib/agent/testing");
const { sha256, KEY_PREFIX } = await import("@/lib/agent/devices");
const { scriptedModel, toolUse } = await import("@/lib/agent/fixtures");
const { AgentController } = await import("./controller");

/** The browser's fetch, routed to the Next route handlers. */
const routes: Record<string, (req: Request) => Promise<Response>> = {
  "POST /api/agent/turn": turn.POST,
  "POST /api/agent/confirm": confirm.POST,
  "GET /api/agent/state": state.GET,
  "PATCH /api/agent/state": state.PATCH,
  "POST /api/agent/undo": undo.POST,
};
const calls: { route: string; status: number }[] = [];
const appFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const route = `${init?.method ?? "GET"} ${url}`;
  const handler = routes[route];
  if (!handler) return new Response("not found", { status: 404 });
  const res = await handler(new Request(`https://hydra.example${url}`, init));
  calls.push({ route, status: res.status });
  return res;
};

function client(storage: Pick<Storage, "getItem" | "removeItem"> = { getItem: () => null, removeItem: () => {} }) {
  const listeners: { h: ListenerHandlers; listener: Listener }[] = [];
  let busyCb: (b: boolean) => void = () => {};
  const speaker = {
    say: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    level: () => 0,
    busy: false,
    onBusy: (cb: (b: boolean) => void) => void (busyCb = cb),
    played: vi.fn((): string[] => []),
  } satisfies SpeakerLike;
  const runUi = vi.fn<(e: UiEvent) => void>();
  const ctl = new AgentController({
    fetch: appFetch,
    nav: { push: vi.fn(), replace: vi.fn() },
    speaker,
    createListener: (h) => {
      const listener = { start: vi.fn(), stop: vi.fn() };
      listeners.push({ h, listener });
      return listener;
    },
    openMic: async () => null,
    blip: vi.fn(),
    supported: () => true,
    runUi,
    here: () => ({ path: "/transactions", search: "?scope=personal" }),
    surface: () => "phone",
    storage,
  });
  ctl.init(undefined);
  /** The owner says something to the live recognizer. */
  const say = (t: string) => {
    const live = listeners.at(-1)!;
    expect(live.listener.stop).not.toHaveBeenCalled();
    live.h.onFinal(t);
  };
  return { ctl, runUi, speaker, say, busy: (b: boolean) => busyCb(b) };
}

beforeEach(() => {
  calls.length = 0;
  m.mem = memoryStore();
  m.relay = memoryRelay(m.mem);
});

describe("the agent client on the real routes", () => {
  it("tap, talk, streamed text, ui navigate, a spoken yes on a delete confirm, and one-tap undo", async () => {
    await m.mem!.store.remember("gate code", "4412");
    m.model = scriptedModel([
      { text: "Opening Planning. ", content: [toolUse("t1", "navigate", { href: "/planning" })], stop_reason: "tool_use" },
      { text: "Here is your week.", content: [], stop_reason: "end_turn" },
      { text: "That forgets one fact. ", content: [toolUse("t2", "forget", { key: "gate code" })], stop_reason: "tool_use" },
      { text: "Forgot it.", content: [], stop_reason: "end_turn" },
    ]);
    const { ctl, runUi, speaker, say } = client();

    // Tap the orb, then talk.
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("listening");
    say("Open planning");
    expect(ctl.getSnapshot().status).toBe("thinking");
    await vi.waitFor(() => expect(ctl.getSnapshot().status).toBe("listening"));
    expect(calls[0]).toEqual({ route: "POST /api/agent/turn", status: 200 });
    expect(ctl.getSnapshot().error).toBeNull();
    // The text before the navigate tool is narration: a step, never spoken. Only the answer is text, and spoken.
    expect(ctl.getSnapshot().thread.map((x) => [x.role, x.text])).toEqual([
      ["user", "Open planning"],
      ["hydra", "Here is your week."],
    ]);
    expect(ctl.getSnapshot().thread[1].parts).toEqual([
      { kind: "step", text: "Opening Planning." },
      { kind: "step", text: expect.any(String), tool: "navigate", status: "done" },
      { kind: "text", text: "Here is your week." },
    ]);
    const filler = speaker.say.mock.calls.filter((c) => c[1]?.filler).map((c) => c[0]);
    expect(filler).toHaveLength(1); // "Let me check." or the like, when the tool started
    expect(speaker.say.mock.calls.filter((c) => !c[1]?.filler).map((c) => c[0])).toEqual(["Here is your week."]);
    expect(runUi).toHaveBeenCalledWith({ kind: "navigate", href: "/planning" });
    const threadId = ctl.currentThread;
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    // The page context reached the model.
    expect(JSON.stringify(m.model.requests[0].messages)).toContain("/transactions");

    // A delete: the turn pauses at the confirm, the mic listens, a spoken yes answers it, the same stream goes on.
    say("Forget the gate code");
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm).not.toBeNull());
    expect(ctl.getSnapshot().confirm).toMatchObject({ prompt: 'Forget "gate code"', danger: expect.any(Boolean) });
    expect(ctl.getSnapshot().status).toBe("listening");
    expect((await m.mem!.store.listMemory()).map((x) => x.key)).toEqual(["gate code"]); // nothing deleted yet
    say("Yes.");
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("That forgets one fact. Forgot it."), { timeout: 5000 });
    expect(calls.filter((c) => c.route === "POST /api/agent/confirm")).toEqual([{ route: "POST /api/agent/confirm", status: 200 }]);
    expect(calls.filter((c) => c.route === "POST /api/agent/turn")).toHaveLength(2);
    expect(await m.mem!.store.listMemory()).toEqual([]);
    expect(ctl.currentThread).toBe(threadId); // one shared thread
    expect(await m.mem!.store.recentThreads(10)).toHaveLength(1);
    expect(ctl.getSnapshot().confirm).toBeNull();

    // The activity list came from /state with an undo id; one tap undoes it.
    await vi.waitFor(() => expect(ctl.getSnapshot().activity.some((a) => a.label === "Forgot gate code")).toBe(true));
    const row = ctl.getSnapshot().activity.find((a) => a.label === "Forgot gate code")!;
    expect(row.undoId).toBe(row.id);
    // It belongs to this chat (the panel's "This chat" group), with its time and surface for the hover.
    expect(row).toMatchObject({ threadId, surface: expect.stringMatching(/^(web|phone)$/), createdAt: expect.stringMatching(/^\d{4}-/) });
    expect(ctl.getSnapshot().threadId).toBe(threadId);
    await ctl.undo(row.undoId!);
    expect(calls.find((c) => c.route === "POST /api/agent/undo")).toEqual({ route: "POST /api/agent/undo", status: 200 });
    expect(await m.mem!.store.listMemory()).toEqual([{ key: "gate code", value: "4412" }]);
    await vi.waitFor(() => expect(ctl.getSnapshot().activity.find((a) => a.id === row.id)).toMatchObject({ undone: true, undoId: null }));
    expect(ctl.getSnapshot().error).toBeNull();
  }, 15_000);

  it("a barge-in: the owner talks over Hydra, and the next turn reaches the model knowing where it was cut off", async () => {
    m.model = scriptedModel([
      { text: "You earned four thousand this month. Most of it came from", content: [], stop_reason: "end_turn" },
      { text: "Savings went up two hundred.", content: [], stop_reason: "end_turn" },
    ]);
    const { ctl, speaker, say, busy } = client();
    ctl.tapOrb();
    say("How much did I earn");
    await vi.waitFor(() => expect(speaker.say).toHaveBeenCalledWith("You earned four thousand this month."));
    speaker.played.mockReturnValue(["You earned four thousand this month."]);
    busy(true); // Hydra is saying it
    say("what about savings"); // the recognizer stays on while Hydra speaks: he cuts in
    expect(speaker.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Savings went up two hundred."));
    const second = JSON.stringify(m.model!.requests[1].messages);
    expect(second).toContain("Interrupted: the owner cut in while you were speaking");
    expect(second).toContain("You earned four thousand this month.");
    expect(JSON.stringify(m.model!.requests[0].messages)).not.toContain("Interrupted");
  });

  it("a tap on Decline answers no, and nothing is deleted", async () => {
    await m.mem!.store.remember("gate code", "4412");
    m.model = scriptedModel([
      { content: [toolUse("t1", "forget", { key: "gate code" })], stop_reason: "tool_use" },
      { text: "Okay, I kept it.", content: [], stop_reason: "end_turn" },
    ]);
    const { ctl } = client();
    ctl.heard("Forget the gate code");
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm).not.toBeNull());
    await ctl.decide(ctl.getSnapshot().confirm!.id, false);
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Okay, I kept it."), { timeout: 5000 });
    expect(await m.mem!.store.listMemory()).toEqual([{ key: "gate code", value: "4412" }]);
  }, 15_000);

  it("continues the owner's conversation, not a newer routine thread that is still running, and shows its messages (RA-1, RA-3)", async () => {
    const store = m.mem!.store;
    const web = await store.createThread("web", "Lunch");
    await store.appendMessage(web, { role: "user", content: [{ type: "text", text: "<context>page</context>" }, { type: "text", text: "What did I spend on lunch?" }] }, "web");
    await store.appendMessage(web, { role: "assistant", content: [{ type: "text", text: "$48 this week." }] }, "web");
    // The Morning brief routine runs now: a newer thread, its lease held for the whole run.
    const routine = await store.createThread("routine", "Run the routine Morning brief");
    await store.appendMessage(routine, { role: "user", content: [{ type: "text", text: "Run the routine Morning brief" }] }, "routine");
    expect(await store.claimThread(routine, "00000000-0000-4000-8000-00000000cccc", 300)).toBe(true);

    m.model = scriptedModel([{ text: "Added it.", content: [], stop_reason: "end_turn" }]);
    const { ctl } = client();
    await ctl.refresh();
    expect(ctl.currentThread).toBe(web);
    expect(ctl.getSnapshot().thread.map((x) => [x.role, x.text])).toEqual([
      ["user", "What did I spend on lunch?"],
      ["hydra", "$48 this week."],
    ]);

    ctl.heard("Add a $12 lunch expense");
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Added it."));
    expect(ctl.getSnapshot().error).toBeNull();
    expect(ctl.currentThread).toBe(web);
    expect(JSON.stringify(m.model.requests[0].messages)).toContain("$48 this week.");
    expect(JSON.stringify(m.model.requests[0].messages)).not.toContain("Morning brief");
  });

  it("the sleep word is the server's setting, shared by every device (RA-2)", async () => {
    const { ctl } = client();
    await ctl.refresh();
    expect(ctl.getSnapshot().sleepWord).toBe("Hydra, sleep");
    expect(await ctl.setSleepWord("  Goodnight Hydra ")).toBe(true);
    expect(calls).toContainEqual({ route: "PATCH /api/agent/state", status: 200 });
    expect((await m.mem!.store.settings()).sleepWord).toBe("Goodnight Hydra");
    // Another device loads it from the server.
    const phone = client();
    await phone.ctl.refresh();
    expect(phone.ctl.getSnapshot().sleepWord).toBe("Goodnight Hydra");
    phone.ctl.tapOrb();
    phone.say("goodnight hydra");
    expect(phone.ctl.getSnapshot().status).toBe("asleep");
  });

  it("a sleep word an older client kept on this device moves to the server once, then the local copy is gone (RA-2)", async () => {
    const local = new Map([["hydra:sleep-word", "Hydra, go dark"]]);
    const storage = { getItem: (k: string) => local.get(k) ?? null, removeItem: (k: string) => void local.delete(k) };
    const { ctl } = client(storage);
    await ctl.refresh();
    await vi.waitFor(async () => expect((await m.mem!.store.settings()).sleepWord).toBe("Hydra, go dark"));
    expect(ctl.getSnapshot().sleepWord).toBe("Hydra, go dark");
    expect(calls).toContainEqual({ route: "PATCH /api/agent/state", status: 200 });
    expect(local.size).toBe(0);
    // A local word never overrides a word the server already holds.
    await m.mem!.store.setSleepWord("Night Hydra");
    local.set("hydra:sleep-word", "Old word");
    const other = client(storage);
    await other.ctl.refresh();
    expect(other.ctl.getSnapshot().sleepWord).toBe("Night Hydra");
    expect((await m.mem!.store.settings()).sleepWord).toBe("Night Hydra");
    expect(local.size).toBe(0);
  });

  it("with no model key the owner sees the server's answer, not a silent card", async () => {
    m.model = null; // createModelClient() answers null: the agent is not configured
    const { ctl } = client();
    ctl.heard("hi");
    await vi.waitFor(() => expect(ctl.getSnapshot().error).not.toBeNull());
    expect(calls.find((c) => c.route === "POST /api/agent/turn")).toEqual({ route: "POST /api/agent/turn", status: 503 });
    expect(ctl.getSnapshot().error).toBe("Hydra is not set up yet");
    expect(ctl.getSnapshot().status).toBe("listening");
  });
});

/**
 * The same client when the Mac is the brain (the production default): the turn route relays to a
 * scripted Hydra Desktop that speaks only HTTP to the real relay routes, so every event it posts
 * passes the server's real schemas on the way to the client.
 */
describe("the agent client when the Mac is the brain", () => {
  const MAC_KEY = `${KEY_PREFIX}contract-mac`;
  const auth = { authorization: `Bearer ${MAC_KEY}` };
  const url = (path: string) => `https://hydra.example${path}`;
  const jsonPost = (path: string, body: object) =>
    new Request(url(path), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const mac = {
    next: async () => {
      const res = await relayNext.GET(new Request(url("/api/agent/relay/next?wait=0&slot=live"), { headers: auth }));
      return res.status === 204 ? null : ((await res.json()).turn as { id: string; claimId: string; threadId: string });
    },
    send: (t: { id: string; claimId: string }, events: unknown[]) => relayEvents.POST(jsonPost("/api/agent/relay/events", { turnId: t.id, claimId: t.claimId, events })),
    ask: (t: { id: string; claimId: string }, summary: string) =>
      relayApproval.POST(jsonPost("/api/agent/relay/approval", { turnId: t.id, claimId: t.claimId, summary, danger: true })),
    status: async (id: string) => (await relayApproval.GET(new Request(url(`/api/agent/relay/approval?id=${id}`), { headers: auth }))).json(),
  };

  beforeEach(() => {
    m.mem = memoryStore({ brain: "mac" });
    m.relay = memoryRelay(m.mem);
    m.macHash = sha256(MAC_KEY);
    m.model = null; // no server model: everything comes from the Mac
  });

  it("no server brain or Mac online: the card shows the server's offline message and the owner's words stay in the thread", async () => {
    const { ctl } = client();
    ctl.heard("What did I spend today?");
    await vi.waitFor(() => expect(ctl.getSnapshot().error).toBe("Hydra is offline."));
    expect(ctl.getSnapshot().macIssue).toBe("brain_offline");
    expect(calls.find((c) => c.route === "POST /api/agent/turn")).toEqual({ route: "POST /api/agent/turn", status: 200 });
    expect(ctl.getSnapshot().status).toBe("listening");
    const [thread] = await m.mem!.store.recentThreads(1);
    expect((await m.mem!.store.loadMessages(thread.id)).map((x) => x.role)).toEqual(["user"]);
  });

  it("a barge-in reaches the relay brain too: the claimed turn's context carries interruptedAfter", async () => {
    expect(await mac.next()).toBeNull();
    const { ctl, speaker, say, busy } = client();
    ctl.tapOrb();
    speaker.played.mockReturnValue(["Your rent is due Friday."]);
    busy(true);
    say("which rent is that");
    let claimed: (Awaited<ReturnType<typeof mac.next>> & { context?: Record<string, unknown> }) | null = null;
    await vi.waitFor(async () => {
      claimed = await mac.next();
      expect(claimed).not.toBeNull();
    });
    expect(claimed!.context).toMatchObject({ path: "/transactions", interruptedAfter: "Your rent is due Friday." });
    ctl.stop();
  });

  it("a scripted Mac answers: streamed text, a ui action, a send the owner approves with a tap, snake_case usage", async () => {
    expect(await mac.next()).toBeNull(); // the Mac's relay loop checks in: online
    const { ctl, runUi } = client();
    ctl.heard("Email Nike the invoice");
    let claimed: Awaited<ReturnType<typeof mac.next>> = null;
    await vi.waitFor(async () => {
      claimed = await mac.next();
      expect(claimed).not.toBeNull();
    });
    const turn = claimed!;
    expect((await mac.send(turn, [{ type: "text", delta: "Opening the deal. " }, { type: "ui", action: { kind: "openPanel", param: "deal", value: "nike-1" } }])).status).toBe(200);
    // Gmail send is a Mac-local ask: it becomes the owner's approval and shows in the card.
    const asked = await mac.ask(turn, "Send the invoice to Nike");
    expect(asked.status).toBe(201);
    const { id } = await asked.json();
    expect((await mac.send(turn, [{ type: "confirm", id, summary: "Send the invoice to Nike", danger: true }])).status).toBe(200);
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm).toMatchObject({ id, prompt: "Send the invoice to Nike", danger: true }));
    await ctl.decide(id, true);
    expect(calls).toContainEqual({ route: "POST /api/agent/confirm", status: 200 });
    expect(await mac.status(id)).toEqual({ status: "approved" });
    const done = [{ type: "text", delta: "Sent." }, { type: "done", usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 300 } }];
    expect((await mac.send(turn, done)).status).toBe(200);
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Opening the deal. Sent."));
    expect(runUi).toHaveBeenCalledWith({ kind: "openPanel", param: "deal", value: "nike-1" });
    expect(ctl.getSnapshot().error).toBeNull();
    expect(ctl.getSnapshot().confirm).toBeNull();
    expect((await m.mem!.store.loadMessages(turn.threadId)).map((x) => x.role)).toEqual(["user", "assistant"]);
  }, 15_000);
});
