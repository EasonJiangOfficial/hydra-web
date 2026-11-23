// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Mac relay end to end through the real route handlers: the browser posts /api/agent/turn
 * (owner session), a scripted Mac (device key, scope relay) long-polls /relay/next, posts its
 * events to /relay/events under its claim id, asks the owner through /relay/approval; the
 * browser's stream carries them in order. The database is the in-memory store and relay
 * (testing.ts); the SQL is proven by pgTAP 0120. Every event the scripted Mac posts goes through the
 * server's real zod schemas (relay-schema.ts), the shapes Hydra Desktop copies.
 */
const m = vi.hoisted(() => ({
  isOwner: false,
  devices: new Map<string, { id: string; scopes: string[] }>(),
  rateHits: [] as string[],
  mem: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryStore>,
  relay: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryRelay>,
  state: null as null | typeof import("../state/route"),
  confirm: null as null | typeof import("../confirm/route"),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ rpc: async (name: string) => ({ data: name === "is_owner" ? m.isOwner : null, error: null }) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      // agent_device_auth moves last_seen_at only: "online" is the relay loop (claim, post), not any call.
      if (name === "agent_device_auth") {
        const d = m.devices.get(args.p_key_hash);
        return { data: d ? [d] : [], error: null };
      }
      if (name === "agent_rate_hit") m.rateHits.push(args.p_bucket);
      return { data: 0, error: null };
    },
  }),
}));
// The owner-session bridge, as production does it: the same route, now with the owner's session.
vi.mock("@/lib/agent/bridge", () => ({
  forwardAsOwner: async (request: Request, deviceId: string) => {
    const body = request.method === "GET" ? undefined : await request.text();
    const forwarded = new Request(request.url, { method: request.method, headers: { "content-type": "application/json", "x-hydra-device": deviceId }, body });
    m.isOwner = true;
    try {
      return await (new URL(request.url).pathname.endsWith("/confirm") ? m.confirm!.POST(forwarded) : m.state!.GET(forwarded));
    } finally {
      m.isOwner = false;
    }
  },
  fetchAsOwner: vi.fn(),
}));
vi.mock("@/lib/agent/store", async (orig) => ({ ...(await orig<object>()), supabaseStore: () => m.mem!.store }));
vi.mock("@/lib/agent/relay", async (orig) => ({ ...(await orig<object>()), supabaseRelay: () => m.relay!.relay }));
vi.mock("@/lib/agent/channels", () => ({ liveChannels: () => ({}) }));
vi.mock("@/lib/planning/actions", () => ({}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const turn = await import("../turn/route");
const confirm = await import("../confirm/route");
m.confirm = confirm;
const next = await import("./next/route");
const events = await import("./events/route");
const approval = await import("./approval/route");
const localRoute = await import("./local/route");
const subturn = await import("./subturn/route");
const { subturnResultSchema, CAPABILITIES_HEADER } = await import("@/lib/agent/relay-schema");
m.state = await import("../state/route");
const { sha256, KEY_PREFIX } = await import("@/lib/agent/devices");
const { memoryStore, memoryRelay } = await import("@/lib/agent/testing");
const { runRoutineJob } = await import("@/lib/agent/cron");
/** The shared agent settings GET /api/agent/state answers (W6 contract), at their defaults. */
const SETTINGS = { sleepWord: "Hydra, sleep", wakePhrase: "Hey Hydra", clapSensitivity: "medium", model: "claude-opus-5-5", effortLive: "low", effortRoutine: "medium", brain: "mac", approveAll: false, activeAvatarId: null };

const MAC_KEY = `${KEY_PREFIX}mac`;
const MAC_ID = "00000000-0000-4000-8000-0000000000d1";
const OTHER_KEY = `${KEY_PREFIX}other`;
const OTHER_ID = "00000000-0000-4000-8000-0000000000d2";
const URL_BASE = "https://hydra.example";
const TURN = { input: { text: "What did I spend today?" }, surface: "web", context: { path: "/reports", search: "", scope: "all" as const } };

const mac = (key = MAC_KEY) => ({ authorization: `Bearer ${key}` });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${URL_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${URL_BASE}${path}`, { headers });

/** Read an SSE body to its end: one JSON event per `data:` line. */
async function readEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

interface Claimed {
  id: string;
  claimId: string;
  threadId: string;
  [k: string]: unknown;
}

/** Hydra Desktop build 4's declaration (0200): it tags every action that can delete. */
const TAGS = { [CAPABILITIES_HEADER]: JSON.stringify({ approveAllDeletionTags: 1 }) };

/** A scripted Hydra Desktop speaking only HTTP to the real routes. `build4`: it declares TAGS on every relay request. */
function scriptedMac(key = MAC_KEY, build4 = false) {
  const h = () => ({ ...mac(key), ...(build4 ? TAGS : {}) });
  return {
    async next(slot?: "live" | "routine"): Promise<Claimed | null> {
      const res = await next.GET(get(`/api/agent/relay/next?wait=0${slot ? `&slot=${slot}` : ""}`, h()));
      return res.status === 204 ? null : (await res.json()).turn;
    },
    send: (t: Claimed, evs: unknown[], seq?: number) =>
      events.POST(post("/api/agent/relay/events", { turnId: t.id, claimId: t.claimId, ...(seq ? { seq } : {}), events: evs }, mac(key))),
    ask: (t: Claimed, summary: string, danger = true, deletion?: boolean) =>
      approval.POST(post("/api/agent/relay/approval", { turnId: t.id, claimId: t.claimId, summary, danger, ...(deletion === undefined ? {} : { deletion }) }, h())),
    status: async (id: string) => (await approval.GET(get(`/api/agent/relay/approval?id=${id}`, mac(key)))).json(),
  };
}

/** The owner answers in the app (his own session, the real confirm route). */
async function ownerSays(id: string, approve: boolean) {
  m.isOwner = true;
  try {
    return await confirm.POST(post("/api/agent/confirm", { id, approve }));
  } finally {
    m.isOwner = false;
  }
}

/** The browser starts a live turn as the owner (the session is read before the stream starts); `events` is its whole stream. */
async function browserTurn(body: object = TURN) {
  m.isOwner = true;
  let res: Response;
  try {
    res = await turn.POST(post("/api/agent/turn", body));
  } finally {
    m.isOwner = false;
  }
  return { events: readEvents(res) };
}

beforeEach(() => {
  m.isOwner = false;
  m.devices.clear();
  m.rateHits.length = 0;
  m.mem = memoryStore({ brain: "mac" });
  m.relay = memoryRelay(m.mem);
  m.devices.set(sha256(MAC_KEY), { id: MAC_ID, scopes: ["agent", "mcp", "relay"] });
  m.devices.set(sha256(OTHER_KEY), { id: OTHER_ID, scopes: ["agent", "mcp"] });
});

describe("who may call the relay", () => {
  it("needs a device key with the relay scope", async () => {
    const ids = { turnId: MAC_ID, claimId: MAC_ID };
    const calls = (headers: Record<string, string>) => [
      () => next.GET(get("/api/agent/relay/next?wait=0", headers)),
      () => events.POST(post("/api/agent/relay/events", { ...ids, events: [] }, headers)),
      () => approval.GET(get(`/api/agent/relay/approval?id=${MAC_ID}`, headers)),
      () => approval.POST(post("/api/agent/relay/approval", { ...ids, summary: "Send it", danger: true }, headers)),
    ];
    for (const call of calls({})) expect((await call()).status).toBe(401);
    m.isOwner = true; // an owner session is not a Mac
    for (const call of calls({})) expect((await call()).status).toBe(401);
    for (const call of calls(mac(`${KEY_PREFIX}unknown`))) expect((await call()).status).toBe(401);
    for (const call of calls(mac(OTHER_KEY))) expect((await call()).status).toBe(403);
  });

  it("answers 204 when nothing is queued; a bad slot is 400", async () => {
    expect((await next.GET(get("/api/agent/relay/next?wait=0", mac()))).status).toBe(204);
    expect((await next.GET(get("/api/agent/relay/next?wait=0&slot=both", mac()))).status).toBe(400);
    expect(m.rateHits).toEqual([`device:${MAC_ID}:relay`, `device:${MAC_ID}:relay`]);
  });

  it("F6: any other call with the Mac's key does not make it online; only the relay loop does", async () => {
    expect((await m.state!.GET(get("/api/agent/state", mac()))).status).toBe(200);
    expect(await (await browserTurn()).events).toEqual([
      { type: "thread", threadId: expect.any(String) },
      { type: "error", code: "brain_offline", message: "Hydra is offline." },
    ]);
  });
});

describe("a turn through the Mac", () => {
  it("no brain or Mac online: the browser gets thread, then brain_offline, and the owner's words are in the thread", async () => {
    const out = await (await browserTurn()).events;
    expect(out).toEqual([
      { type: "thread", threadId: expect.any(String) },
      { type: "error", code: "brain_offline", message: "Hydra is offline." },
    ]);
    expect((await m.mem!.store.loadMessages(out[0].threadId)).map((x) => x.role)).toEqual(["user"]);
  });

  it("a scripted Mac answers with snake_case usage; the browser streams its events in order and the thread keeps both sides", async () => {
    const desk = scriptedMac();
    expect(await desk.next("live")).toBeNull(); // the Mac checks in (it long-polls), so it is online
    const browser = (await browserTurn()).events;

    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    expect(claimed).toMatchObject({
      claimId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      threadId: expect.any(String),
      input: { text: "What did I spend today?" },
      surface: "web",
      context: TURN.context,
      history: [],
    });
    expect(await desk.next("live")).toBeNull(); // taken once

    const gate = await m.mem!.store.createApproval({
      source: "mcp",
      thread_id: null,
      run_id: null,
      device_id: MAC_ID,
      tool: "delete_task",
      input: { id: "t1" },
      summary: "Delete the task Send W-9",
      reason: "delete",
      danger: true,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    expect(await (await desk.send(claimed, [{ type: "text", delta: "You spent " }, { type: "tool", name: "list_transactions", status: "done", summary: "3 rows" }], 1)).json()).toEqual({
      ok: true,
      status: "claimed",
      inputs: [],
    });
    // The response was lost and the Mac retries the same post: stored once.
    expect((await desk.send(claimed, [{ type: "text", delta: "You spent " }, { type: "tool", name: "list_transactions", status: "done", summary: "3 rows" }], 1)).status).toBe(200);
    expect((await desk.send(claimed, [{ type: "confirm", id: gate.id, summary: "Delete the task Send W-9", danger: true }], 3)).status).toBe(200);

    // The owner says yes in the browser; the Mac sees it and goes on.
    expect(await desk.status(gate.id)).toEqual({ status: "pending" });
    expect((await ownerSays(gate.id, true)).status).toBe(200);
    expect(await desk.status(gate.id)).toEqual({ status: "approved" });

    expect((await desk.send(claimed, [{ type: "ui", action: { kind: "navigate", href: "//evil.example" } }])).status).toBe(400);
    expect((await desk.send(claimed, [{ type: "thread", threadId: claimed.threadId }])).status).toBe(400);
    expect((await desk.send(claimed, [{ type: "confirm", id: "00000000-0000-4000-8000-00000000ffff", summary: "Pay", danger: true }])).status).toBe(400);
    expect((await desk.send({ ...claimed, claimId: OTHER_ID }, [{ type: "text", delta: "x" }])).status).toBe(409);
    const done = [{ type: "text", delta: "$42." }, { type: "done", usage: { input_tokens: 1200, output_tokens: 9, cache_read_input_tokens: 40, service_tier: "x" } }];
    expect(await (await desk.send(claimed, done, 4)).json()).toEqual({ ok: true, status: "done", inputs: [] });
    expect(await (await desk.send(claimed, done, 4)).json()).toEqual({ ok: true, status: "done", inputs: [] }); // a replayed close
    const late = await desk.send(claimed, [{ type: "text", delta: "late" }]);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "stale_claim" });

    expect(await browser).toEqual([
      { type: "thread", threadId: claimed.threadId },
      { type: "turn", turnId: expect.any(String) },
      { type: "text", delta: "You spent " },
      { type: "tool", name: "list_transactions", status: "done", summary: "3 rows" },
      { type: "confirm", id: gate.id, summary: "Delete the task Send W-9", danger: true },
      { type: "text", delta: "$42." },
      { type: "done", usage: { input_tokens: 1200, output_tokens: 9, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } },
    ]);
    expect((await m.mem!.store.loadMessages(claimed.threadId)).map((msg) => [msg.role, (msg.content as { text: string }[])[0].text])).toEqual([
      ["user", "What did I spend today?"],
      ["assistant", "You spent $42."],
    ]);
  });

  it("a stale claim gets 409: after a lapse the same Mac re-claims, and the old run's posts are refused", async () => {
    const desk = scriptedMac();
    const threadId = await m.mem!.store.createThread("web", "x");
    await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "x" }, surface: "web", context: TURN.context });
    const first = (await desk.next("live"))!;
    expect((await desk.send(first, [{ type: "text", delta: "FIRST " }])).status).toBe(200);
    m.relay!.turns[0].lease_until = new Date(Date.now() - 1000).toISOString(); // the lease lapsed
    const second = (await desk.next("live"))!;
    expect(second.claimId).not.toBe(first.claimId);
    const stale = await desk.send(first, [{ type: "text", delta: "OLD " }]);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_claim" });
    expect((await desk.ask(first, "Send the email")).status).toBe(409);
    expect((await desk.send(second, [{ type: "text", delta: "NEW" }, { type: "done" }])).status).toBe(200);
    expect((await m.relay!.relay.eventsAfter(second.id, 0)).map((e) => e.event)).toEqual([{ type: "text", delta: "FIRST " }, { type: "text", delta: "NEW" }, { type: "done" }]);
  });

  it("only the Mac that claimed a turn posts to it, and only approvals its own gate or turn made", async () => {
    m.devices.set(sha256(OTHER_KEY), { id: OTHER_ID, scopes: ["relay"] });
    const threadId = await m.mem!.store.createThread("web", "x");
    const turnId = await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "x" }, surface: "web", context: TURN.context });
    const t = (await scriptedMac().next())!;
    expect((await scriptedMac(OTHER_KEY).send(t, [{ type: "text", delta: "hi" }])).status).toBe(403);
    const foreign = await m.mem!.store.createApproval({
      source: "mcp",
      thread_id: null,
      run_id: null,
      device_id: OTHER_ID,
      tool: "x",
      input: {},
      summary: "x",
      reason: "delete",
      danger: true,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await scriptedMac().send(t, [{ type: "confirm", id: foreign.id, summary: "x", danger: true }])).status).toBe(400);
    expect((await approval.GET(get(`/api/agent/relay/approval?id=${foreign.id}`, mac()))).status).toBe(404);
    expect((await approval.GET(get("/api/agent/relay/approval?id=nope", mac()))).status).toBe(400);
    expect((await events.POST(post("/api/agent/relay/events", { turnId: OTHER_ID, claimId: OTHER_ID, events: [] }, mac()))).status).toBe(404);
    expect(t.id).toBe(turnId);
  });

  it("point 6: a Mac-local ask in a phone turn becomes the owner's approval; he answers on the phone; the Mac acts", async () => {
    const desk = scriptedMac();
    await desk.next("live");
    const browser = (await browserTurn({ ...TURN, surface: "phone", input: { text: "Email Nike the invoice" } })).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    const asked = await desk.ask(claimed, "Send the invoice to Nike");
    expect(asked.status).toBe(201);
    const { id } = await asked.json();
    expect(m.mem!.approvals[0]).toMatchObject({ id, source: "relay", device_id: MAC_ID, relay_turn_id: claimed.id, thread_id: claimed.threadId, reason: "mac" });
    expect((await desk.send(claimed, [{ type: "confirm", id, summary: "Send the invoice to Nike", danger: true }])).status).toBe(200);
    // A device never approves its own ask.
    expect((await confirm.POST(post("/api/agent/confirm", { id, approve: true }, mac()))).status).toBe(403);
    expect(await desk.status(id)).toEqual({ status: "pending" });
    expect((await ownerSays(id, true)).status).toBe(200);
    expect(await desk.status(id)).toEqual({ status: "approved" });
    expect((await desk.send(claimed, [{ type: "text", delta: "Sent." }, { type: "done" }])).status).toBe(200);
    expect(m.mem!.approvals[0].status).toBe("done"); // handed to the Mac
    expect((await browser).map((e) => e.type)).toEqual(["thread", "turn", "confirm", "text", "done"]);
  });

  it("0200 approve all: a build 4 Mac's ask tagged deletion false is approved at once (row kept, no notice); every other ask waits", async () => {
    const desk = scriptedMac(MAC_KEY, true);
    await desk.next("live");
    const browser = (await browserTurn({ ...TURN, input: { text: "Arrange my windows" } })).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    m.mem!.setSettings({ approveAll: true });
    const calm = await desk.ask(claimed, "Arrange Safari and Notes side by side", false, false);
    expect(calm.status).toBe(201);
    const { id, status } = await calm.json();
    expect(status).toBe("approved");
    expect(await desk.status(id)).toEqual({ status: "approved" });
    expect(m.mem!.approvals.find((a) => a.id === id)).toMatchObject({ source: "relay", relay_turn_id: claimed.id, danger: false, status: "approved" });
    expect(m.mem!.notifications.some((n) => n.dedupe_key === `approval:${id}`)).toBe(false);
    expect((await m.mem!.store.pendingApprovals()).map((a) => a.id)).not.toContain(id);

    const waits = async (ask: Response, what: string) => {
      const out = await ask.json();
      expect(out.status, what).toBeUndefined();
      expect(await desk.status(out.id), what).toEqual({ status: "pending" });
    };
    // The Mac's own tag says it deletes, or the tag is missing: the owner answers.
    await waits(await desk.ask(claimed, "Arrange Safari and Notes side by side", false, true), "deletion true");
    await waits(await desk.ask(claimed, "Arrange Safari and Notes side by side", false), "deletion missing");
    // The same Mac without its declaration (an older build): asks exactly as before, even with deletion false.
    await waits(await scriptedMac().ask(claimed, "Arrange Safari and Notes side by side", false, false), "no capability");
    // The words can only add an ask: a deletion word with deletion false still waits.
    for (const words of ["Move the old screenshots to the Bin", "Click \u201cDon\u2019t Save\u201d in the TextEdit dialog", "Run pkill TextEdit", "Click No when Pages asks to save"]) {
      await waits(await desk.ask(claimed, words, false, false), words);
    }

    const risky = await desk.ask(claimed, "Delete the Drafts folder", true, true);
    await waits(risky, "danger");
    expect(m.mem!.notifications.at(-1)).toMatchObject({ kind: "approval", body: "Delete the Drafts folder" });

    expect((await desk.send(claimed, [{ type: "text", delta: "Done." }, { type: "done" }])).status).toBe(200);
    expect(m.mem!.approvals.find((a) => a.id === id)!.status).toBe("done"); // the turn closed: handed to the Mac
    await browser;
  });

  it("0200 /relay/next records the Mac's declaration; an older build's poll clears it", async () => {
    await scriptedMac(MAC_KEY, true).next("live");
    expect(m.mem!.capabilities.get(MAC_ID)).toEqual({ approveAllDeletionTags: 1 });
    expect(await m.mem!.store.desktopsTagDeletions()).toBe(true);
    await next.GET(get("/api/agent/relay/next?wait=0", { ...mac(), [CAPABILITIES_HEADER]: "{not json" }));
    expect(await m.mem!.store.desktopsTagDeletions()).toBe(false);
    await scriptedMac(MAC_KEY, true).next("live");
    await scriptedMac().next("live");
    expect(m.mem!.capabilities.get(MAC_ID)).toEqual({});
    expect(await m.mem!.store.desktopsTagDeletions()).toBe(false);
  });

  it("models: /relay/next records the Mac's ChatGPT sign-in (signedIn); unknown services are dropped; a poll without it clears it", async () => {
    const since = new Date(Date.now() - 60_000);
    await next.GET(get("/api/agent/relay/next?wait=0", { ...mac(), [CAPABILITIES_HEADER]: JSON.stringify({ approveAllDeletionTags: 1, signedIn: ["chatgpt"] }) }));
    expect(m.mem!.capabilities.get(MAC_ID)).toEqual({ approveAllDeletionTags: 1, signedIn: ["chatgpt"] });
    expect(await m.mem!.store.macSignedIn("chatgpt", since)).toBe(true);
    await next.GET(get("/api/agent/relay/next?wait=0", { ...mac(), [CAPABILITIES_HEADER]: JSON.stringify({ approveAllDeletionTags: 1, signedIn: ["gemini"] }) }));
    expect(m.mem!.capabilities.get(MAC_ID)).toEqual({ approveAllDeletionTags: 1 });
    // An unknown name beside "chatgpt" is dropped alone: ChatGPT stays pickable.
    await next.GET(get("/api/agent/relay/next?wait=0", { ...mac(), [CAPABILITIES_HEADER]: JSON.stringify({ signedIn: ["claude", "chatgpt", "grok"] }) }));
    expect(m.mem!.capabilities.get(MAC_ID)).toEqual({ signedIn: ["chatgpt"] });
    // A non-string entry, or more than 8 entries, beside "chatgpt" drops only the others.
    for (const signedIn of [[5, "chatgpt", null, { a: 1 }], ["a", "b", "c", "d", "e", "f", "g", "h", "i", "chatgpt"]]) {
      await next.GET(get("/api/agent/relay/next?wait=0", { ...mac(), [CAPABILITIES_HEADER]: JSON.stringify({ signedIn }) }));
      expect(m.mem!.capabilities.get(MAC_ID), JSON.stringify(signedIn)).toEqual({ signedIn: ["chatgpt"] });
    }
    expect(await m.mem!.store.macSignedIn("chatgpt", since)).toBe(true);
    await scriptedMac().next("live");
    expect(await m.mem!.store.macSignedIn("chatgpt", since)).toBe(false);
  });

  it("0200 approve all off: a Mac ask that is not dangerous still waits", async () => {
    const desk = scriptedMac();
    await desk.next("live");
    void browserTurn();
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const asked = await (await desk.ask(t as unknown as Claimed, "Arrange my windows", false)).json();
    expect(await desk.status(asked.id)).toEqual({ status: "pending" });
  });

  it("the server brain keeps today's loop and fails closed without a key", async () => {
    m.mem!.setSettings({ brain: "server" });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    m.isOwner = true;
    const res = await turn.POST(post("/api/agent/turn", TURN));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "agent_not_configured" });
    vi.unstubAllEnvs();
  });
});

describe("the server brain takes turns first; the Mac is the fallback (0121)", () => {
  const BRAIN_KEY = `${KEY_PREFIX}brain`;
  const BRAIN_ID = "00000000-0000-4000-8000-0000000000b1";
  beforeEach(() => {
    m.devices.set(sha256(BRAIN_KEY), { id: BRAIN_ID, scopes: ["agent", "mcp", "relay"] });
    m.relay!.makeBrain(BRAIN_ID); // paired with a Server code
  });

  it("a brain online gets the live turn and a Mac does not", async () => {
    const desk = scriptedMac();
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("live")).toBeNull(); // the brain checks in: online
    const browser = (await browserTurn()).events;
    expect(await desk.next("live")).toBeNull();
    expect(await desk.next()).toBeNull();
    const t = (await brain.next("live"))!;
    expect(t).toMatchObject({ input: { text: "What did I spend today?" }, surface: "web" });
    expect(m.relay!.turns[0].claimed_by).toBe(BRAIN_ID);
    expect((await desk.send(t, [{ type: "text", delta: "x" }])).status).toBe(403); // not the Mac's turn
    expect((await brain.send(t, [{ type: "text", delta: "You spent $42." }, { type: "done" }])).status).toBe(200);
    expect((await browser).map((e) => e.type)).toEqual(["thread", "turn", "text", "done"]);
  });

  it("models: the brain says who answered (the model event, fallback included); the browser gets it, a bad one is refused", async () => {
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("live")).toBeNull();
    const browser = (await browserTurn()).events;
    const t = (await brain.next("live"))!;
    expect((await brain.send(t, [{ type: "model", model: "grok-4.7", effort: "turbo" }])).status).toBe(400); // an effort outside low..max
    expect((await brain.send(t, [{ type: "model", model: "grok-4.7", effort: "high", fallback: "maybe" }])).status).toBe(400);
    const model = { type: "model", model: "claude-opus-5-5", effort: "high", fallback: "not_connected" };
    expect((await brain.send(t, [model, { type: "text", delta: "You spent $42." }, { type: "done" }])).status).toBe(200);
    const evs = await browser;
    expect(evs.map((e) => e.type)).toEqual(["thread", "turn", "model", "text", "done"]);
    expect(evs[2]).toEqual(model);
  });

  it("a brain online gets routine turns too; the Mac's routine slot stays empty", async () => {
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("live")).toBeNull();
    const threadId = await m.mem!.store.createThread("routine", "Brand mail");
    const turnId = await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "Run it" }, surface: "routine", context: TURN.context });
    expect(await scriptedMac().next("routine")).toBeNull();
    expect((await brain.next("routine"))?.id).toBe(turnId);
  });

  it("the brain offline (last contact 46 s ago): the Mac gets the turn", async () => {
    m.relay!.seeMac(BRAIN_ID, new Date(Date.now() - 46_000));
    const desk = scriptedMac();
    expect(await desk.next("live")).toBeNull();
    const browser = (await browserTurn()).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    expect(m.relay!.turns[0].claimed_by).toBe(MAC_ID);
    expect((await desk.send(claimed, [{ type: "text", delta: "From the Mac." }, { type: "done" }])).status).toBe(200);
    expect((await browser).map((e) => e.type)).toEqual(["thread", "turn", "text", "done"]);
  });

  it("F3: a turn typed in Hydra Desktop goes to the Mac, never the brain, while the brain is online", async () => {
    const desk = scriptedMac();
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("live")).toBeNull();
    expect(await desk.next("live")).toBeNull(); // both online
    const browser = (await browserTurn({ ...TURN, surface: "desktop", input: { text: "Open Safari and screenshot this page" } })).events;
    await vi.waitFor(() => expect(m.relay!.turns).toHaveLength(1));
    expect(await brain.next("live")).toBeNull(); // the brain has no Mac tools
    const t = (await desk.next("live"))!;
    expect(t).toMatchObject({ surface: "desktop", input: { text: "Open Safari and screenshot this page" } });
    expect((await desk.send(t, [{ type: "text", delta: "Done." }, { type: "done" }])).status).toBe(200);
    expect((await browser).map((e) => e.type)).toEqual(["thread", "turn", "text", "done"]);
  });

  it("F3: a turn typed in Hydra Desktop with no Mac online ends at once with mac_offline, even with the brain online", async () => {
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("live")).toBeNull();
    const out = await (await browserTurn({ ...TURN, surface: "desktop" })).events;
    expect(out).toEqual([
      { type: "thread", threadId: expect.any(String) },
      { type: "error", code: "mac_offline", message: "Your Mac is offline." },
    ]);
    expect(m.relay!.turns).toHaveLength(0);
  });

  it("F4: a routine with Mac tools and when_mac_off skip is skipped while only the brain is online", async () => {
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("routine")).toBeNull();
    await m.mem!.store.createRoutine({
      name: "Dock shot",
      instruction: "Every morning screenshot my dock",
      schedule: { kind: "daily", time: "08:00" },
      tools: ["mac"],
      delivery: ["notification"],
      when_mac_off: "skip",
      paused: false,
      next_run_at: new Date(Date.now() - 1000).toISOString(),
    });
    const [{ run_id }] = await m.mem!.store.claimDueRoutines(new Date(), 10);
    expect(await runRoutineJob(run_id, { client: null, store: m.mem!.store, db: {} as never, now: () => new Date(), relay: m.relay!.relay })).toBe("skipped");
    expect(m.relay!.turns).toHaveLength(0);
    expect(await brain.next("routine")).toBeNull();
  });

  it("F4: a routine with Mac tools goes to the Mac, not the brain, while both are online", async () => {
    const desk = scriptedMac();
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("routine")).toBeNull();
    expect(await desk.next("routine")).toBeNull();
    const threadId = await m.mem!.store.createThread("routine", "Dock shot");
    const turnId = await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "Run it" }, surface: "routine", context: TURN.context, allowed_tools: ["mac"] });
    expect(await brain.next("routine")).toBeNull();
    expect((await desk.next("routine"))?.id).toBe(turnId);
  });

  it("F9: a brain that posts the relay client's mac_failed ends the turn in Hydra's words", async () => {
    const brain = scriptedMac(BRAIN_KEY);
    expect(await brain.next("live")).toBeNull();
    const browser = (await browserTurn()).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await brain.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    expect((await brain.send(claimed, [{ type: "error", code: "mac_failed", message: "The Mac could not finish." }])).status).toBe(200);
    expect((await browser).at(-1)).toEqual({ type: "error", code: "brain_failed", message: "Hydra stopped answering." });
  });

  it("neither online: brain_offline at once, and the owner's words are kept", async () => {
    m.relay!.seeMac(BRAIN_ID, new Date(Date.now() - 46_000));
    m.relay!.seeMac(MAC_ID, new Date(Date.now() - 46_000));
    const out = await (await browserTurn({ ...TURN, input: { text: "Remind me to call Nike" } })).events;
    expect(out).toEqual([
      { type: "thread", threadId: expect.any(String) },
      { type: "error", code: "brain_offline", message: "Hydra is offline." },
    ]);
    expect(m.relay!.turns).toHaveLength(0);
    expect((await m.mem!.store.loadMessages(out[0].threadId)).map((x) => [x.role, (x.content as { text: string }[])[0].text])).toEqual([
      ["user", "Remind me to call Nike"],
    ]);
  });
});

describe("a routine's turn through the Mac", () => {
  const routine = async () => {
    await m.mem!.store.createRoutine({
      name: "Brand mail",
      instruction: "Check Gmail",
      schedule: { kind: "daily", time: "10:00" },
      tools: ["hydra", "gmail"],
      delivery: ["notification"],
      when_mac_off: "wait",
      paused: false,
      next_run_at: new Date(Date.now() - 1000).toISOString(),
    });
    const [{ run_id }] = await m.mem!.store.claimDueRoutines(new Date(), 10);
    return run_id;
  };
  const job = (runId: string) => runRoutineJob(runId, { client: null, store: m.mem!.store, db: {} as never, now: () => new Date(), relay: m.relay!.relay });

  it("the Mac's done ends the run and the owner hears about it", async () => {
    const desk = scriptedMac();
    const runId = await routine();
    expect(await desk.next("routine")).toBeNull(); // online
    expect(await job(runId)).toBe("running");
    expect(await desk.next("live")).toBeNull(); // a routine never lands on the live slot
    const t = (await desk.next("routine"))!;
    expect(t).toMatchObject({ surface: "routine", routineRunId: runId, routineId: m.mem!.routines[0].id, allowedTools: ["hydra", "gmail"] });
    await desk.send(t, [{ type: "text", delta: "Nothing new." }, { type: "done" }]);
    expect(m.mem!.runs[0]).toMatchObject({ status: "ok", output: "Nothing new." });
    expect(m.mem!.notifications.at(-1)).toMatchObject({ title: "Brand mail: Done" });
  });

  it("point 7: a routine waits on a relay approval while a live turn runs on the other slot", async () => {
    const desk = scriptedMac();
    const runId = await routine();
    await desk.next("routine");
    await job(runId);
    const rt = (await desk.next("routine"))!;
    const asked = await desk.ask(rt, "Reply to the brand");
    const { id } = await asked.json();
    expect(m.mem!.approvals[0]).toMatchObject({ source: "relay", run_id: runId, relay_turn_id: rt.id });
    expect(Date.parse(m.mem!.approvals[0].expires_at) - Date.now()).toBeGreaterThan(23 * 3600_000); // a routine's ask waits a day
    expect((await desk.send(rt, [{ type: "confirm", id, summary: "Reply to the brand", danger: true }])).status).toBe(200);

    // The owner asks something on the phone meanwhile: the live slot serves it at once.
    const browser = (await browserTurn({ ...TURN, surface: "phone" })).events;
    let live: Claimed | null = null;
    await vi.waitFor(async () => {
      live = await desk.next("live");
      expect(live).not.toBeNull();
    });
    expect((await desk.send(rt, [])).status).toBe(200); // the routine's heartbeat goes on
    expect((await desk.send(live!, [{ type: "text", delta: "$12 today." }, { type: "done" }])).status).toBe(200);
    expect((await browser).slice(2)).toEqual([
      { type: "text", delta: "$12 today." },
      { type: "done", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);
    expect(m.mem!.runs[0].status).toBe("running");

    // Then the owner approves the routine's ask on the Routines page; the Mac goes on in the same turn.
    expect((await ownerSays(id, true)).status).toBe(200);
    expect(await desk.status(id)).toEqual({ status: "approved" });
    expect((await desk.send(rt, [{ type: "text", delta: "Replied." }, { type: "done" }])).status).toBe(200);
    expect(m.mem!.runs[0]).toMatchObject({ status: "ok", output: "Replied." });
    expect(m.mem!.approvals[0].status).toBe("done");
  });
});

describe("the Mac's own turns join the shared thread (POST /relay/local)", () => {
  const local = (body: unknown, key = MAC_KEY) => localRoute.POST(post("/api/agent/relay/local", body, mac(key)));
  const said = async (threadId: string) =>
    (await m.mem!.store.loadMessages(threadId)).map((msg) => [msg.role, (msg.content as { text: string }[])[0].text]);
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("appends the owner's words and the reply to his thread, and the next relay turn's history has them", async () => {
    const threadId = await m.mem!.store.createThread("web", "Groceries");
    const res = await local({ user: "Add milk to my list", assistant: "Added milk.", threadId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadId });
    expect(await said(threadId)).toEqual([
      ["user", "Add milk to my list"],
      ["assistant", "Added milk."],
    ]);
    await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "And eggs" }, surface: "phone", context: TURN.context });
    const t = (await scriptedMac().next("live"))!;
    expect(t.history).toEqual([
      { role: "user", text: "Add milk to my list" },
      { role: "assistant", text: "Added milk." },
    ]);
    expect(m.rateHits).toContain(`device:${MAC_ID}:relay`);
  });

  it("without a thread: the newest one moved in the last 30 minutes, else a new desktop thread", async () => {
    const old = await m.mem!.store.createThread("web", "old");
    const recent = await m.mem!.store.createThread("phone", "recent");
    m.mem!.threads.find((t) => t.id === recent)!.updated_at = ago(29 * 60_000);
    m.mem!.threads.find((t) => t.id === old)!.updated_at = ago(60 * 60_000);
    const reuse = await (await local({ user: "What's next?", assistant: "Your 3 pm call." })).json();
    expect(reuse).toEqual({ threadId: recent });

    m.mem!.threads.find((t) => t.id === recent)!.updated_at = ago(31 * 60_000);
    const fresh = await (await local({ user: "Hello", assistant: "Hi." })).json();
    expect([old, recent]).not.toContain(fresh.threadId);
    expect(m.mem!.threads.find((t) => t.id === fresh.threadId)).toMatchObject({ surface: "desktop", title: "Hello" });
    expect(await said(fresh.threadId)).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi."],
    ]);
    expect(await (await local({ user: "Thanks", assistant: "" })).json()).toEqual(fresh);
    expect(await said(fresh.threadId)).toHaveLength(3); // an empty reply is not stored
    // `at` (when he said it, posted late): the 30 minutes count back from then, never from the future.
    for (const t of m.mem!.threads) t.updated_at = ago(3 * 3600_000);
    const row = m.mem!.threads.find((t) => t.id === fresh.threadId)!;
    row.updated_at = ago(40 * 60_000);
    expect(await (await local({ user: "Said 20 min ago", assistant: "Ok.", at: ago(20 * 60_000) })).json()).toEqual(fresh);
    row.updated_at = ago(40 * 60_000);
    const future = await (await local({ user: "From the future", assistant: "Ok.", at: new Date(Date.now() + 3600_000).toISOString() })).json();
    expect(future.threadId).not.toBe(fresh.threadId);
  });

  it("refuses a thread that is not his, bad bodies, and keys without the relay scope", async () => {
    const before = m.mem!.messages.length;
    const foreign = await local({ user: "x", assistant: "y", threadId: "00000000-0000-4000-8000-00000000beef" });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "not_found" });
    for (const body of [
      { user: "", assistant: "" },
      { user: "x".repeat(8001), assistant: "" },
      { user: "x", assistant: "y".repeat(32001) },
      { user: "x", assistant: "y", threadId: "nope" },
      { user: "x", assistant: "y", at: "yesterday" },
      { assistant: "y" },
      null,
    ]) {
      expect((await local(body)).status).toBe(400);
    }
    expect((await local({ user: "x".repeat(8000), assistant: "y".repeat(32000) })).status).toBe(200);
    expect(m.mem!.messages.length).toBe(before + 2);
    expect((await local({ user: "x", assistant: "y" }, OTHER_KEY)).status).toBe(403);
    expect((await localRoute.POST(post("/api/agent/relay/local", { user: "x", assistant: "y" }))).status).toBe(401);
  });
});

describe("minor 6: no relay approval outlives its turn", () => {
  it("the locked check makes none once the turn closed, and a closed turn's approval leaves the waiting list", async () => {
    const desk = scriptedMac();
    const threadId = await m.mem!.store.createThread("web", "x");
    await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "x" }, surface: "web", context: TURN.context });
    const t = (await desk.next("live"))!;
    const { id } = await (await desk.ask(t, "Send the invoice")).json();
    m.isOwner = true;
    const listed = async () => ((await (await m.state!.GET(get("/api/agent/state"))).json()).pendingApprovals as { id: string }[]).map((a) => a.id);
    expect(await listed()).toEqual([id]);
    m.isOwner = false;
    expect((await desk.send(t, [{ type: "done" }])).status).toBe(200);
    // The route's first look raced the close: the locked insert still refuses.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await m.relay!.relay.createApproval(t.id, MAC_ID, t.claimId, { summary: "Late", danger: true, expiresAt })).toBeNull();
    // A row that somehow stayed pending is not listed once its turn closed.
    m.mem!.approvals.find((a) => a.id === id)!.status = "pending";
    m.isOwner = true;
    expect(await listed()).toEqual([]);
    m.isOwner = false;
  });
});

describe("the phone controls the Mac: the brain's sub-turns (0160, W5 section 7)", () => {
  const BRAIN_KEY = `${KEY_PREFIX}brain`;
  const BRAIN_ID = "00000000-0000-4000-8000-0000000000b1";
  const PHONE = { ...TURN, surface: "phone", input: { text: "Close Safari on my Mac" } };
  const ASK = "Quit Safari (2 windows, 9 tabs) on Studio Mac";
  beforeEach(() => {
    m.devices.set(sha256(BRAIN_KEY), { id: BRAIN_ID, scopes: ["agent", "mcp", "relay"] });
    m.relay!.makeBrain(BRAIN_ID);
  });

  /** The scripted server brain: the relay loop plus ask_mac over the real sub-turn route. */
  function scriptedBrain() {
    return {
      ...scriptedMac(BRAIN_KEY),
      askMac: (t: Claimed, instruction: string, key = BRAIN_KEY) =>
        subturn.POST(post("/api/agent/relay/subturn", { turnId: t.id, claimId: t.claimId, instruction }, mac(key))),
      result: async (id: string, key = BRAIN_KEY) => {
        const res = await subturn.GET(get(`/api/agent/relay/subturn?id=${id}`, mac(key)));
        return res.status === 200 ? subturnResultSchema.parse(await res.json()) : res.status;
      },
    };
  }

  /** Both online, a phone turn the brain holds. */
  async function phoneTurnOnBrain() {
    const desk = scriptedMac();
    const brain = scriptedBrain();
    expect(await brain.next("live")).toBeNull();
    expect(await desk.next("live")).toBeNull();
    const browser = (await browserTurn(PHONE)).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await brain.next("live");
      expect(t).not.toBeNull();
    });
    return { desk, brain, browser, parent: t as unknown as Claimed };
  }

  it("the brain asks the Mac; only the Mac claims it; its ask shows on the phone with the real target; the brain gets the Mac's words", async () => {
    const { desk, brain, browser, parent } = await phoneTurnOnBrain();
    const made = await brain.askMac(parent, "Quit Safari");
    expect(made.status).toBe(201);
    const { subTurnId } = await made.json();
    expect(await brain.result(subTurnId)).toEqual({ status: "queued", text: "" });

    expect(await brain.next("live")).toBeNull(); // the brain never claims a sub-turn
    const sub = (await desk.next("live"))!;
    expect(sub).toMatchObject({ id: subTurnId, parentTurnId: parent.id, allowedTools: ["mac"], surface: "phone", input: { text: "Quit Safari" }, threadId: parent.threadId });

    // The Mac asks first: a relay approval with its own words, listed for the owner on every surface.
    const asked = await desk.ask(sub, ASK);
    expect(asked.status).toBe(201);
    const { id } = await asked.json();
    expect(m.mem!.notifications.at(-1)).toMatchObject({ kind: "approval", body: ASK });
    m.isOwner = true;
    const listed = ((await (await m.state!.GET(get("/api/agent/state"))).json()).pendingApprovals as { id: string; summary: string; thread_id: string }[]).map(
      (a) => [a.id, a.summary, a.thread_id],
    );
    m.isOwner = false;
    expect(listed).toEqual([[id, ASK, parent.threadId]]);
    expect((await desk.send(sub, [{ type: "text", delta: "Quitting Safari. " }, { type: "confirm", id, summary: ASK, danger: true }], 1)).status).toBe(200);

    expect((await ownerSays(id, true)).status).toBe(200); // the owner's yes on the phone
    expect(await desk.status(id)).toEqual({ status: "approved" });
    expect(await brain.result(subTurnId)).toEqual({ status: "claimed", text: "Quitting Safari." });
    expect((await desk.send(sub, [{ type: "text", delta: "Safari is closed." }, { type: "done" }], 3)).status).toBe(200);
    expect(await brain.result(subTurnId)).toEqual({ status: "done", text: "Quitting Safari. Safari is closed." });

    expect((await brain.send(parent, [{ type: "text", delta: "Done. Safari is closed on your Mac." }, { type: "done" }])).status).toBe(200);
    // The browser saw the Mac's ask (confirm) and the brain's words; none of the sub-turn's own text.
    expect(await browser).toEqual([
      { type: "thread", threadId: parent.threadId },
      { type: "turn", turnId: parent.id },
      { type: "confirm", id, summary: ASK, danger: true },
      { type: "text", delta: "Done. Safari is closed on your Mac." },
      { type: "done", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);
    expect((await m.mem!.store.loadMessages(parent.threadId)).map((msg) => [msg.role, (msg.content as { text: string }[])[0].text])).toEqual([
      ["user", "Close Safari on my Mac"],
      ["assistant", "Done. Safari is closed on your Mac."],
    ]);
  });

  it("no Mac online: the result is 'Your Mac is offline.' at once", async () => {
    const brain = scriptedBrain();
    expect(await brain.next("live")).toBeNull();
    const browser = (await browserTurn(PHONE)).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await brain.next("live");
      expect(t).not.toBeNull();
    });
    const parent = t as unknown as Claimed;
    const made = await brain.askMac(parent, "Quit Safari");
    expect(made.status).toBe(201);
    expect(await brain.result((await made.json()).subTurnId)).toEqual({ status: "error", text: "Your Mac is offline." });
    expect((await brain.send(parent, [{ type: "text", delta: "Your Mac is offline." }, { type: "done" }])).status).toBe(200);
    expect((await browser).map((e) => e.type)).toEqual(["thread", "turn", "text", "done"]);
  });

  it("the Mac goes offline before it takes the sub-turn: the next look ends it with 'Your Mac is offline.'", async () => {
    const { brain, parent } = await phoneTurnOnBrain();
    const { subTurnId } = await (await brain.askMac(parent, "Quit Safari")).json();
    // 46 s on, the Mac's relay loop has not run since: it is offline.
    const realNow = Date.now;
    Date.now = () => realNow() + 46_000;
    try {
      expect(await brain.result(subTurnId)).toEqual({ status: "expired", text: "Your Mac is offline." });
    } finally {
      Date.now = realNow;
    }
    expect(m.relay!.turns.find((x) => x.id === subTurnId)?.status).toBe("expired");
    expect(await scriptedMac().next("live")).toBeNull();
  });

  it("the parent closing ends an open sub-turn and its ask; the Mac's next post is refused", async () => {
    const { desk, brain, parent } = await phoneTurnOnBrain();
    const { subTurnId } = await (await brain.askMac(parent, "Empty the Trash")).json();
    const sub = (await desk.next("live"))!;
    const { id } = await (await desk.ask(sub, "Empty the Trash (41 items)")).json();
    expect((await brain.send(parent, [{ type: "text", delta: "Stopped." }, { type: "done" }])).status).toBe(200);
    expect(await brain.result(subTurnId)).toEqual({ status: "expired", text: "The turn ended before your Mac finished." });
    expect(await desk.status(id)).toEqual({ status: "expired" });
    expect((await desk.send(sub, [{ type: "text", delta: "x" }])).status).toBe(409);
  });

  it("the sweep puts the parent back in the queue: its open sub-turn ends, the Mac never runs it, and its ask no longer reaches the browser", async () => {
    const { desk, brain, parent } = await phoneTurnOnBrain();
    const { subTurnId } = await (await brain.askMac(parent, "Read ~/Documents/notes.txt")).json();
    const row = m.relay!.turns.find((x) => x.id === parent.id)!;
    row.lease_until = new Date(Date.now() - 1000).toISOString();
    expect(await brain.askMac(parent, "again").then((r) => r.json())).toEqual({ error: "stale_claim" }); // a lapsed lease makes no sub-turn
    expect(await m.relay!.relay.sweep()).toBe(1);
    expect(row.status).toBe("queued");
    expect(m.relay!.turns.find((x) => x.id === subTurnId)?.status).toBe("expired");
    expect(await desk.next("live")).toBeNull(); // the brain is online: the Mac gets neither the old sub-turn nor the parent
  });

  it("a long Mac answer comes back whole (past one 500-event page), its closing reason too", async () => {
    const { desk, brain, parent } = await phoneTurnOnBrain();
    const { subTurnId } = await (await brain.askMac(parent, "List my Downloads")).json();
    const sub = (await desk.next("live"))!;
    const deltas = Array.from({ length: 620 }, (_, i) => ({ type: "text" as const, delta: `${i} ` }));
    expect((await desk.send(sub, deltas.slice(0, 400), 1)).status).toBe(200);
    expect((await desk.send(sub, [...deltas.slice(400), { type: "error", code: "mac_failed", message: "Finder stopped." }], 401)).status).toBe(200);
    expect(await brain.result(subTurnId)).toEqual({ status: "error", text: `${deltas.map((d) => d.delta).join("").trim()}\nFinder stopped.` });
  });

  it("refusals: only the brain that holds the turn, a live web or phone turn, no nesting; results only to that brain", async () => {
    const { desk, brain, parent } = await phoneTurnOnBrain();
    expect((await subturn.POST(post("/api/agent/relay/subturn", { turnId: parent.id, claimId: parent.claimId, instruction: "x" }))).status).toBe(401);
    expect((await brain.askMac(parent, "x", OTHER_KEY)).status).toBe(403); // no relay scope
    expect((await brain.askMac(parent, "   ")).status).toBe(400);
    expect(await (await brain.askMac({ ...parent, claimId: OTHER_ID }, "x")).json()).toEqual({ error: "stale_claim" });
    expect(await (await brain.askMac({ ...parent, id: OTHER_ID }, "x")).json()).toEqual({ error: "not_found" });
    const notYours = await brain.askMac(parent, "x", MAC_KEY);
    expect([notYours.status, await notYours.json()]).toEqual([403, { error: "not_yours" }]);

    const { subTurnId } = await (await brain.askMac(parent, "Quit Safari")).json();
    const sub = (await desk.next("live"))!;
    const notBrain = await brain.askMac(sub, "x", MAC_KEY); // the Mac holds the sub-turn, but is no brain
    expect([notBrain.status, await notBrain.json()]).toEqual([403, { error: "not_brain" }]);
    m.relay!.makeBrain(MAC_ID); // even a brain cannot nest a sub-turn in a sub-turn
    const nested = await brain.askMac(sub, "x", MAC_KEY);
    expect([nested.status, await nested.json()]).toEqual([400, { error: "not_live" }]);

    expect(await brain.result(subTurnId, MAC_KEY)).toBe(404); // not the parent's holder
    expect(await brain.result(parent.id)).toBe(404); // not a sub-turn
    expect(await brain.result("nope")).toBe(400);
  });

  it("a routine turn on the brain cannot ask the Mac", async () => {
    const brain = scriptedBrain();
    expect(await brain.next("routine")).toBeNull();
    const threadId = await m.mem!.store.createThread("routine", "Brand mail");
    await m.relay!.relay.createTurn({ thread_id: threadId, input: { text: "Run it" }, surface: "routine", context: TURN.context });
    const t = (await brain.next("routine"))!;
    expect(await (await brain.askMac(t, "Open Mail")).json()).toEqual({ error: "not_live" });
  });
});

describe("Hydra Desktop reads the shared settings", () => {
  it("a device key with the agent scope gets the sleep word from /api/agent/state", async () => {
    await m.mem!.store.setSleepWord("Goodnight Hydra");
    const res = await m.state!.GET(get("/api/agent/state", mac()));
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({ ...SETTINGS, sleepWord: "Goodnight Hydra", brain: "mac" });
    const relayOnly = `${KEY_PREFIX}relayonly`;
    m.devices.set(sha256(relayOnly), { id: OTHER_ID, scopes: ["relay"] });
    expect((await m.state!.GET(get("/api/agent/state", mac(relayOnly)))).status).toBe(403);
  });
});

describe("0191: words added while the brain thinks", () => {
  it("the owner adds words to the turn in flight; the Mac gets each until it acknowledges it, and the thread keeps them", async () => {
    const appendRoute = await import("../turn/append/route");
    const desk = scriptedMac();
    expect(await desk.next("live")).toBeNull(); // the Mac checks in
    const browser = (await browserTurn()).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    const add = async (text: string) => {
      m.isOwner = true;
      try {
        return await appendRoute.POST(post("/api/agent/turn/append", { turnId: claimed.id, text }));
      } finally {
        m.isOwner = false;
      }
    };
    const heartbeat = async (inputsSeen?: number, key = MAC_KEY) =>
      events.POST(post("/api/agent/relay/events", { turnId: claimed.id, claimId: claimed.claimId, events: [], ...(inputsSeen === undefined ? {} : { inputsSeen }) }, mac(key)));

    // An older Mac (no inputsSeen) never reads additions: the turn takes none, so the client asks them next.
    expect(await (await heartbeat()).json()).toEqual({ ok: true, status: "claimed", inputs: [] });
    expect((await add("and on food")).status).toBe(409);
    // This Mac reads them: inputsSeen 0 says so.
    expect(await (await heartbeat(0)).json()).toEqual({ ok: true, status: "claimed", inputs: [] });
    const first = await add("  and on food ");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, seq: 1 });
    expect(await (await heartbeat(0)).json()).toEqual({ ok: true, status: "claimed", inputs: [{ seq: 1, text: "and on food" }] });
    expect(await (await heartbeat(0)).json()).toEqual({ ok: true, status: "claimed", inputs: [{ seq: 1, text: "and on food" }] }); // not acknowledged yet
    expect(await (await heartbeat()).json()).toEqual({ ok: true, status: "claimed", inputs: [] }); // a post without inputsSeen gets none
    expect((await add("and gas")).status).toBe(202);
    expect(await (await heartbeat(1)).json()).toEqual({ ok: true, status: "claimed", inputs: [{ seq: 2, text: "and gas" }] });
    expect(await (await heartbeat(2)).json()).toEqual({ ok: true, status: "claimed", inputs: [] });
    expect(await (await heartbeat(0)).json()).toEqual({ ok: true, status: "claimed", inputs: [] }); // never goes back
    expect((await add("   ")).status).toBe(400);
    expect((await heartbeat(undefined, OTHER_KEY)).status).toBe(403); // no relay scope

    expect(await (await desk.send(claimed, [{ type: "text", delta: "$42: $18 food, $20 gas." }, { type: "done" }])).json()).toEqual({ ok: true, status: "done", inputs: [] });
    const out = await browser;
    expect(out.map((e: { type: string }) => e.type)).toEqual(["thread", "turn", "text", "done"]);
    expect(out[1]).toEqual({ type: "turn", turnId: claimed.id });
    // Over: a late addition is refused (409), so the client starts a new turn with it.
    const late = await add("too late");
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "turn_over" });
    expect((await m.mem!.store.loadMessages(claimed.threadId)).map((msg) => [msg.role, (msg.content as { text: string }[])[0].text])).toEqual([
      ["user", "What did I spend today?\nand on food\nand gas"],
      ["assistant", "$42: $18 food, $20 gas."],
    ]);
  });

  it("a done that arrives while an addition waits unread is held: the Mac gets it, answers it, then closes", async () => {
    const appendRoute = await import("../turn/append/route");
    const desk = scriptedMac();
    expect(await desk.next("live")).toBeNull();
    const browser = (await browserTurn()).events;
    let t: Claimed | null = null;
    await vi.waitFor(async () => {
      t = await desk.next("live");
      expect(t).not.toBeNull();
    });
    const claimed = t as unknown as Claimed;
    const add = async (text: string) => {
      m.isOwner = true;
      try {
        return await appendRoute.POST(post("/api/agent/turn/append", { turnId: claimed.id, text }));
      } finally {
        m.isOwner = false;
      }
    };
    const postEvents = async (evs: unknown[], seq: number, inputsSeen: number) =>
      (await events.POST(post("/api/agent/relay/events", { turnId: claimed.id, claimId: claimed.claimId, seq, events: evs, inputsSeen }, mac(MAC_KEY)))).json();

    expect(await postEvents([], 1, 0)).toEqual({ ok: true, status: "claimed", inputs: [] });
    expect((await add("and on food")).status).toBe(202); // just before the Mac's done: it never saw it
    expect(await postEvents([{ type: "text", delta: "$42 today." }, { type: "done" }], 1, 0)).toEqual({
      ok: true,
      status: "claimed",
      inputs: [{ seq: 1, text: "and on food" }],
    });
    // A replay of the held post changes nothing; the Mac answers the addition and closes.
    expect(await postEvents([{ type: "text", delta: "$42 today." }, { type: "done" }], 1, 0)).toEqual({ ok: true, status: "claimed", inputs: [{ seq: 1, text: "and on food" }] });
    expect(await postEvents([{ type: "text", delta: " $18 on food." }, { type: "done" }], 3, 1)).toEqual({ ok: true, status: "done", inputs: [] });
    const out = await browser;
    expect(out.map((e: { type: string }) => e.type)).toEqual(["thread", "turn", "text", "text", "done"]);
    expect((await m.mem!.store.loadMessages(claimed.threadId)).map((msg) => [msg.role, (msg.content as { text: string }[])[0].text])).toEqual([
      ["user", "What did I spend today?\nand on food"],
      ["assistant", "$42 today. $18 on food."],
    ]);
  });
});
