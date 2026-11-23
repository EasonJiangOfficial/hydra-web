// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  isOwner: false,
  devices: new Map<string, { id: string; scopes: string[] }>(),
  insertedCodes: [] as Record<string, unknown>[],
  exchange: vi.fn(),
  /** The role agent_pairing_code_role answers (null: no live code). */
  codeRole: "mac" as string | null,
  forwardAsOwner: vi.fn(async (_req: Request, deviceId: string) => Response.json({ forwarded: deviceId })),
  fetchAsOwner: vi.fn(async () => Response.json({ ok: true })),
  runCron: vi.fn(),
  rateWait: 0,
  rateHits: [] as string[],
  mem: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryStore>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    rpc: async (name: string) => (name === "is_owner" ? { data: m.isOwner, error: null } : { data: null, error: null }),
    from: () => ({ insert: async (row: Record<string, unknown>) => (m.insertedCodes.push(row), { error: null }) }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      if (name === "agent_device_auth") {
        const d = m.devices.get(args.p_key_hash);
        return { data: d ? [d] : [], error: null };
      }
      if (name === "agent_pair_exchange") return { data: m.exchange(args), error: null };
      if (name === "agent_pairing_code_role") return { data: m.codeRole, error: null };
      if (name === "agent_rate_hit") {
        m.rateHits.push(args.p_bucket);
        return { data: m.rateWait, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/agent/bridge", () => ({ forwardAsOwner: m.forwardAsOwner, fetchAsOwner: m.fetchAsOwner }));
vi.mock("@/lib/agent/cron", async (orig) => ({ ...(await orig<object>()), runCron: m.runCron }));
vi.mock("@/lib/agent/store", async (orig) => ({ ...(await orig<object>()), supabaseStore: () => m.mem!.store }));
vi.mock("@/lib/planning/actions", () => ({}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const turn = await import("./turn/route");
const append = await import("./turn/append/route");
const confirm = await import("./confirm/route");
const pair = await import("./devices/pair/route");
const exchange = await import("./devices/exchange/route");
const mcp = await import("../mcp/agent/route");
const cron = await import("../cron/agent/route");
const state = await import("./state/route");
const undo = await import("./undo/route");
const jobs = await import("./jobs/route");
const devices = await import("./devices/route");
const revoke = await import("./devices/revoke/route");
const routineRun = await import("./routines/run/route");
const { sha256, KEY_PREFIX } = await import("@/lib/agent/devices");
const { memoryStore } = await import("@/lib/agent/testing");
/** The shared agent settings GET /api/agent/state answers (W6 contract), at their defaults. */
const SETTINGS = { sleepWord: "Hydra, sleep", wakePhrase: "Hey Hydra", clapSensitivity: "medium", model: "claude-opus-5-5", effortLive: "low", effortRoutine: "medium", brain: "mac", approveAll: false, activeAvatarId: null };

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://hydra.example${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const TURN = { input: { text: "hi" }, surface: "web", context: { path: "/", search: "", scope: "all" } };
const KEY = `${KEY_PREFIX}desktop-key`;
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";

beforeEach(() => {
  vi.clearAllMocks();
  m.isOwner = false;
  m.devices.clear();
  m.insertedCodes.length = 0;
  m.rateWait = 0;
  m.rateHits.length = 0;
  m.codeRole = "mac";
  m.mem = memoryStore();
  vi.unstubAllEnvs();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("CRON_SECRET", "");
});

describe("who may call the agent", () => {
  it("refuses a caller with no session and no key", async () => {
    expect((await turn.POST(post("/api/agent/turn", TURN))).status).toBe(401);
    expect((await turn.POST(post("/api/agent/turn", TURN, { authorization: "Bearer hyd_unknown" }))).status).toBe(401);
    expect(m.forwardAsOwner).not.toHaveBeenCalled();
  });

  // The proxy lets every /api/agent/* and /api/mcp/agent call through (src/lib/auth/gate.ts), so each handler must refuse on its own.
  it("every agent route answers 401 to no session, no key", async () => {
    const ID = "00000000-0000-4000-8000-000000000001";
    const get = (url: string) => new Request(`https://hydra.example${url}`);
    const calls: Array<[string, () => Promise<Response>]> = [
      ["turn", () => turn.POST(post("/api/agent/turn", TURN))],
      ["turn/append", () => append.POST(post("/api/agent/turn/append", { turnId: ID, text: "and gas" }))],
      ["state PATCH", () => state.PATCH(new Request("https://hydra.example/api/agent/state", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }))],
      ["confirm", () => confirm.POST(post("/api/agent/confirm", { id: ID, approve: true }))],
      ["state", () => state.GET(get("/api/agent/state"))],
      ["undo", () => undo.POST(post("/api/agent/undo", { actionId: ID }))],
      ["jobs GET", () => jobs.GET(get("/api/agent/jobs"))],
      ["jobs POST", () => jobs.POST(post("/api/agent/jobs", { jobId: ID, status: "done" }))],
      ["devices", () => devices.GET()],
      ["devices/pair", () => pair.POST(post("/api/agent/devices/pair", {}))],
      ["devices/revoke", () => revoke.POST(post("/api/agent/devices/revoke", { id: ID }))],
      ["routines/run", () => routineRun.POST(post("/api/agent/routines/run", { runId: ID }))],
      ["mcp POST", () => mcp.POST(post("/api/mcp/agent", {}))],
      ["mcp GET", () => mcp.GET(get("/api/mcp/agent"))],
      ["mcp DELETE", () => mcp.DELETE(new Request("https://hydra.example/api/mcp/agent", { method: "DELETE" }))],
    ];
    for (const [name, call] of calls) expect([name, (await call()).status]).toEqual([name, 401]);
    expect(m.forwardAsOwner).not.toHaveBeenCalled();
    // The pairing exchange has no session by design: the one-time code is the proof.
    m.exchange.mockReturnValueOnce(null);
    expect((await exchange.POST(post("/api/agent/devices/exchange", { code: "NOTACODE" }))).status).toBe(400);
  });

  it("forwards a paired device with the right scope as the owner, and refuses the wrong scope", async () => {
    m.devices.set(sha256(KEY), { id: DEVICE_ID, scopes: ["agent"] });
    const res = await turn.POST(post("/api/agent/turn", TURN, { authorization: `Bearer ${KEY}` }));
    expect(await res.json()).toEqual({ forwarded: DEVICE_ID });
    expect((await mcp.POST(post("/api/mcp/agent", {}, { authorization: `Bearer ${KEY}` }))).status).toBe(403);
    m.devices.set(sha256(KEY), { id: DEVICE_ID, scopes: ["mcp"] });
    expect((await turn.POST(post("/api/agent/turn", TURN, { authorization: `Bearer ${KEY}` }))).status).toBe(403);
    expect(await (await mcp.POST(post("/api/mcp/agent", {}, { authorization: `Bearer ${KEY}` }))).json()).toEqual({ forwarded: DEVICE_ID });
  });

  it("fails closed with agent_not_configured when ANTHROPIC_API_KEY is missing", async () => {
    m.isOwner = true;
    const res = await turn.POST(post("/api/agent/turn", TURN));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "agent_not_configured" });
  });

  it("checks the turn body", async () => {
    m.isOwner = true;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect((await turn.POST(post("/api/agent/turn", { ...TURN, surface: "fridge" }))).status).toBe(400);
    expect((await turn.POST(post("/api/agent/turn", { ...TURN, input: { text: "" } }))).status).toBe(400);
    expect((await turn.POST(post("/api/agent/turn", { ...TURN, context: { ...TURN.context, scope: "Not A Slug" } }))).status).toBe(400);
  });

  it("accepts any business slug as the turn scope, not only the seeded ones", async () => {
    m.isOwner = true;
    // Past the body check: no ANTHROPIC_API_KEY, so the route answers 503, not 400 invalid_input.
    const res = await turn.POST(post("/api/agent/turn", { ...TURN, context: { ...TURN.context, scope: "studio-co" } }));
    expect(res.status).toBe(503);
  });
});

describe("confirm", () => {
  it("records yes or no once; a second answer is refused", async () => {
    m.isOwner = true;
    const mem = m.mem!;
    const approval = await mem.store.createApproval({
      source: "live", thread_id: null, run_id: null, device_id: null, tool: "delete_task", input: {}, summary: "Delete this task",
      reason: "delete", danger: true, expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const yes = await confirm.POST(post("/api/agent/confirm", { id: approval.id, approve: true }));
    expect(await yes.json()).toEqual({ ok: true, status: "approved" });
    const again = await confirm.POST(post("/api/agent/confirm", { id: approval.id, approve: false }));
    expect(again.status).toBe(409);
    expect((await confirm.POST(post("/api/agent/confirm", { id: "00000000-0000-4000-8000-000000000999", approve: true }))).status).toBe(404);
  });

  it("runs an unattended routine's step on yes and settles its run", async () => {
    m.isOwner = true;
    const mem = m.mem!;
    const routine = await mem.store.createRoutine({
      name: "Tidy", instruction: "Forget the old note", schedule: { kind: "daily", time: "08:00" }, tools: ["hydra"], delivery: ["notification"],
      when_mac_off: "wait", paused: false, next_run_at: new Date(Date.now() - 1000).toISOString(),
    });
    const [claimed] = await mem.store.claimDueRoutines(new Date(), 5);
    await mem.store.updateRun(claimed.run_id, { status: "waiting_approval" });
    await mem.store.remember("old", "note");
    const approval = await mem.store.createApproval({
      source: "routine", thread_id: null, run_id: claimed.run_id, device_id: null, tool: "forget", input: { key: "old" },
      summary: 'Forget "old"', reason: "delete", danger: true, expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await confirm.POST(post("/api/agent/confirm", { id: approval.id, approve: true }));
    expect(await res.json()).toMatchObject({ ok: true, status: "done" });
    expect(mem.memory.has("old")).toBe(false);
    expect(mem.actions[0]).toMatchObject({ tool: "forget", run_id: claimed.run_id, inverse: { tool: "remember" } });
    expect(mem.runs[0]).toMatchObject({ status: "ok", action_ids: [mem.actions[0].id] });
    expect(routine.id).toBe(mem.runs[0].routine_id);
  });
});

describe("device pairing", () => {
  it("makes a one-time code for the owner only, and trades it for a key stored as a hash", async () => {
    expect((await pair.POST(post("/api/agent/devices/pair", {}))).status).toBe(401);
    m.isOwner = true;
    const { code, expiresAt } = await (await pair.POST(post("/api/agent/devices/pair", { name: "Studio Mac" }))).json();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(m.insertedCodes[0]).toMatchObject({ code_hash: sha256(code), name: "Studio Mac", scopes: ["agent", "mcp", "relay"] });
    expect(JSON.stringify(m.insertedCodes)).not.toContain(code);

    m.exchange.mockReturnValueOnce(DEVICE_ID);
    const res = await exchange.POST(post("/api/agent/devices/exchange", { code: code.toLowerCase(), name: "Studio Mac" }));
    expect(res.status).toBe(201);
    const { deviceId, key } = await res.json();
    expect(deviceId).toBe(DEVICE_ID);
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(m.exchange).toHaveBeenCalledWith({ p_code_hash: sha256(code), p_key_hash: sha256(key), p_name: "Studio Mac" });

    m.exchange.mockReturnValueOnce(null);
    expect((await exchange.POST(post("/api/agent/devices/exchange", { code, name: "Again" }))).status).toBe(400);
  });

  it("the brain role comes only from a Server pairing code the owner made", async () => {
    // A Mac code by default; a Server code names the brain and holds the relay scope.
    m.isOwner = true;
    await pair.POST(post("/api/agent/devices/pair", {}));
    expect(m.insertedCodes[0]).toMatchObject({ role: "mac", name: "Hydra Desktop" });
    const server = await (await pair.POST(post("/api/agent/devices/pair", { role: "brain" }))).json();
    expect(m.insertedCodes[1]).toMatchObject({ code_hash: sha256(server.code), role: "brain", name: "Hydra server", scopes: ["agent", "mcp", "relay"] });
    // A brain without relay, or an unknown role, is refused before any write.
    expect((await pair.POST(post("/api/agent/devices/pair", { role: "brain", scopes: ["mcp"] }))).status).toBe(400);
    expect((await pair.POST(post("/api/agent/devices/pair", { role: "root" }))).status).toBe(400);
    expect(m.insertedCodes).toHaveLength(2);
    m.isOwner = false;

    // No session: no code, of any role. The device cannot name its role at the exchange: only the code's role counts.
    expect((await pair.POST(post("/api/agent/devices/pair", { role: "brain" }))).status).toBe(401);
    const wrong = await exchange.POST(post("/api/agent/devices/exchange", { code: "ABCD2345", name: "Studio Mac", role: "brain" }));
    expect(wrong.status).toBe(409); // a Mac code is never a brain, whatever the device says
    expect(m.exchange).not.toHaveBeenCalled();
    m.exchange.mockReturnValueOnce(DEVICE_ID);
    const res = await exchange.POST(post("/api/agent/devices/exchange", { code: "ABCD2345", name: "Studio Mac" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ deviceId: DEVICE_ID, role: "mac" });
    expect(m.exchange).toHaveBeenCalledWith({ p_code_hash: sha256("ABCD2345"), p_key_hash: expect.any(String), p_name: "Studio Mac" });
  });

  it("F10: Hydra Desktop refuses a Server code without using it up; hydra-brain gets it with its role", async () => {
    m.codeRole = "brain";
    const mac = await exchange.POST(post("/api/agent/devices/exchange", { code: "SERV2345", name: "Studio Mac", role: "mac" }));
    expect(mac.status).toBe(409);
    expect(await mac.json()).toEqual({ error: "wrong_role", role: "brain" });
    expect(m.exchange).not.toHaveBeenCalled(); // the code is still good for the server
    m.exchange.mockReturnValueOnce(DEVICE_ID);
    const brain = await exchange.POST(post("/api/agent/devices/exchange", { code: "SERV2345", name: "Hydra server", role: "brain" }));
    expect(brain.status).toBe(201);
    expect(await brain.json()).toMatchObject({ deviceId: DEVICE_ID, role: "brain" });
    // A code that is unknown, used or expired: 400, never a device.
    m.codeRole = null;
    expect((await exchange.POST(post("/api/agent/devices/exchange", { code: "SERV2345", role: "brain" }))).status).toBe(400);
    expect(m.exchange).toHaveBeenCalledTimes(1);
  });
});

describe("the cron route", () => {
  const get = (auth?: string) => new Request("https://hydra.example/api/cron/agent", { headers: auth ? { authorization: auth } : {} });

  it("is closed without CRON_SECRET and refuses a wrong bearer", async () => {
    expect((await cron.GET(get("Bearer x"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await cron.GET(get())).status).toBe(401);
    expect((await cron.GET(get("Bearer nope"))).status).toBe(401);
    expect(m.runCron).not.toHaveBeenCalled();
  });

  it("runs the cron and starts claimed runs as the owner through the bridge", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    m.runCron.mockImplementation(async (deps: { runRoutine: (id: string) => Promise<void> }) => {
      await deps.runRoutine("00000000-0000-4000-8000-0000000000e1");
      return { routines: ["00000000-0000-4000-8000-0000000000e1"], reminders: 0, scheduled: 1, failed: 0 };
    });
    const res = await cron.GET(get("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, routines: ["00000000-0000-4000-8000-0000000000e1"] });
    const [url, init] = m.fetchAsOwner.mock.calls[0] as unknown as [URL, { method: string; body: string }];
    expect(url.toString()).toBe("https://hydra.example/api/agent/routines/run");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ runId: "00000000-0000-4000-8000-0000000000e1" }) });
  });
});

describe("R1b repairs at the routes", () => {
  const approvalRow = (source: "live" | "mcp" | "routine", deviceId: string | null, runId: string | null = null) =>
    m.mem!.store.createApproval({
      source, thread_id: null, run_id: runId, device_id: deviceId, tool: "delete_task", input: { id: DEVICE_ID },
      summary: "Delete this task", reason: "delete", danger: true, expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  const asDevice = { "x-hydra-device": DEVICE_ID };

  it("a device never approves an MCP gate it raised; the owner's session does (AGT-3)", async () => {
    m.isOwner = true; // the device's call arrives through the bridge as the owner, labelled with the device
    const gate = await approvalRow("mcp", DEVICE_ID);
    const res = await confirm.POST(post("/api/agent/confirm", { id: gate.id, approve: true }, asDevice));
    expect(res.status).toBe(403);
    expect(m.mem!.approvals[0].status).toBe("pending");
    expect(await (await confirm.POST(post("/api/agent/confirm", { id: gate.id, approve: true }))).json()).toEqual({ ok: true, status: "approved" });
  });

  it("a device may answer the live confirm of its own turn, not another's, nor a routine's", async () => {
    m.isOwner = true;
    const own = await approvalRow("live", DEVICE_ID);
    const other = await approvalRow("live", "00000000-0000-4000-8000-0000000000d9");
    const routine = await approvalRow("routine", null);
    expect((await confirm.POST(post("/api/agent/confirm", { id: own.id, approve: true }, asDevice))).status).toBe(200);
    expect((await confirm.POST(post("/api/agent/confirm", { id: other.id, approve: true }, asDevice))).status).toBe(403);
    expect((await confirm.POST(post("/api/agent/confirm", { id: routine.id, approve: true }, asDevice))).status).toBe(403);
    expect((await confirm.POST(post("/api/agent/confirm", { id: routine.id, approve: false }, asDevice))).status).toBe(200); // no is always fine
  });

  it("lists MCP approvals where the owner sees them", async () => {
    m.isOwner = true;
    await approvalRow("mcp", DEVICE_ID);
    const body = await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json();
    expect(body.pendingApprovals).toEqual([expect.objectContaining({ source: "mcp", summary: "Delete this task" })]);
  });

  it("a device's undo of a gated inverse waits for the app (AGT-3)", async () => {
    m.isOwner = true;
    const actionId = await m.mem!.store.logAction({
      thread_id: null, run_id: null, device_id: null, tool: "create_task", input: {}, result: null, summary: "Task: W-9",
      inverse: { tool: "delete_task", input: { id: DEVICE_ID } }, surface: "web",
    });
    const res = await undo.POST(post("/api/agent/undo", { actionId }, asDevice));
    expect(res.status).toBe(409);
    expect(m.mem!.actions[0].undone_at).toBeNull();
  });

  it("declining a routine's step finishes its run (AGT-6)", async () => {
    m.isOwner = true;
    const mem = m.mem!;
    await mem.store.createRoutine({
      name: "Tidy", instruction: "Trash newsletters", schedule: { kind: "daily", time: "08:00" }, tools: ["gmail"], delivery: ["notification"],
      when_mac_off: "wait", paused: false, next_run_at: new Date(Date.now() - 1000).toISOString(),
    });
    const [claimed] = await mem.store.claimDueRoutines(new Date(), 5);
    await mem.store.updateRun(claimed.run_id, { status: "waiting_approval" });
    const gate = await approvalRow("routine", null, claimed.run_id);
    expect(await (await confirm.POST(post("/api/agent/confirm", { id: gate.id, approve: false }))).json()).toEqual({ ok: true, status: "declined" });
    expect(mem.runs[0]).toMatchObject({ status: "skipped", output: "You declined: Delete this task" });
    expect(mem.notifications.find((n) => n.kind === "routine")).toMatchObject({ title: "Tidy: Not done" });
  });

  it("a yes after the confirm's time ran out gets 409 expired (AGT-9)", async () => {
    m.isOwner = true;
    const gate = await m.mem!.store.createApproval({
      source: "live", thread_id: null, run_id: null, device_id: null, tool: "delete_task", input: {}, summary: "Delete this task",
      reason: "delete", danger: true, expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await confirm.POST(post("/api/agent/confirm", { id: gate.id, approve: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_pending", status: "expired" });
  });

  it("rate limits device keys per route kind and the pairing exchange per IP (AGT-10)", async () => {
    m.devices.set(sha256(KEY), { id: DEVICE_ID, scopes: ["agent", "mcp"] });
    await turn.POST(post("/api/agent/turn", TURN, { authorization: `Bearer ${KEY}` }));
    await state.GET(new Request("https://hydra.example/api/agent/state", { headers: { authorization: `Bearer ${KEY}` } }));
    expect(m.rateHits).toEqual([`device:${DEVICE_ID}:turn`, `device:${DEVICE_ID}:any`]);
    m.rateWait = 42;
    const limited = await turn.POST(post("/api/agent/turn", TURN, { authorization: `Bearer ${KEY}` }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(m.forwardAsOwner).toHaveBeenCalledTimes(2);

    m.rateHits.length = 0;
    const pairing = await exchange.POST(post("/api/agent/devices/exchange", { code: "ABCDEFGH" }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(pairing.status).toBe(429);
    expect(m.rateHits).toEqual(["pair:ip:203.0.113.9", "pair:all"]);
    expect(m.exchange).not.toHaveBeenCalled();
  });

  it("the pairing exchange checks the body shape before the rate limit: a bad body is 400 with no DB call", async () => {
    m.rateWait = 42;
    const bad = await exchange.POST(post("/api/agent/devices/exchange", {}));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_input" });
    expect(m.rateHits).toEqual([]);
    expect(m.exchange).not.toHaveBeenCalled();
    // A well-formed attempt still counts, and is refused while limited.
    expect((await exchange.POST(post("/api/agent/devices/exchange", { code: "ABCDEFGH" }))).status).toBe(429);
    expect(m.rateHits).toEqual(["pair:ip:unknown", "pair:all"]);
  });

  it("0200: GET /jobs hands a step approve all let through only to a pull that itself declares the tags", async () => {
    m.isOwner = true;
    const job = { run_id: null, thread_id: null, risky: true };
    await m.mem!.store.queueDesktopJob({ ...job, instruction: "Quit Safari", needs_tags: false });
    await m.mem!.store.queueDesktopJob({ ...job, instruction: "Quit TextEdit", needs_tags: true });
    const pull = async (headers: Record<string, string>) =>
      ((await (await jobs.GET(new Request("https://hydra.example/api/agent/jobs", { headers: { ...asDevice, ...headers } }))).json()) as { jobs: { instruction: string }[] }).jobs.map((j) => j.instruction);
    // A record from an earlier poll does not count: only this request's declaration.
    m.mem!.capabilities.set(DEVICE_ID, { approveAllDeletionTags: 1 });
    expect(await pull({})).toEqual(["Quit Safari"]);
    expect(await pull({ "x-hydra-capabilities": '{"approveAllDeletionTags":true}' })).toEqual([]);
    expect(await pull({ "x-hydra-capabilities": '{"approveAllDeletionTags":1}' })).toEqual(["Quit TextEdit"]);
  });

  it("state's activity rows carry their thread, time and surface, never the tool's input or result", async () => {
    m.isOwner = true;
    const mem = m.mem!;
    const thread = await mem.store.createThread("phone", "t");
    const id = await mem.store.logAction({ thread_id: thread, run_id: null, device_id: null, tool: "remember", input: { key: "gate", value: "4412" }, result: { secret: 1 }, summary: "Remembered gate", inverse: { tool: "forget", input: { key: "gate" } }, surface: "phone" });
    const body = await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json();
    expect(body.activity).toEqual([{ id, tool: "remember", summary: "Remembered gate", surface: "phone", createdAt: expect.any(String), threadId: thread, undoId: id, undoneAt: null }]);
  });

  it("state carries the newest thread's last messages as text only, and the sleep word", async () => {
    m.isOwner = true;
    const mem = m.mem!;
    const old = await mem.store.createThread("web", "old");
    await mem.store.appendMessage(old, { role: "user", content: [{ type: "text", text: "old question" }] }, "web");
    const id = await mem.store.createThread("desktop", "new");
    await mem.store.appendMessage(id, { role: "user", content: [{ type: "text", text: "<context>\nNow: ...\n</context>" }, { type: "text", text: "Delete the W-9 task" }] }, "desktop");
    await mem.store.appendMessage(id, { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "tu_1", name: "delete_task", input: {} }] } as never, "desktop");
    await mem.store.appendMessage(id, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done" }] }, "desktop");
    await mem.store.appendMessage(id, { role: "assistant", content: [{ type: "text", text: "Deleted." }] }, "desktop");
    const body = await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json();
    expect(body.threads[0].id).toBe(id);
    expect(body.threads[0].messages.map((x: { role: string; text: string }) => [x.role, x.text])).toEqual([
      ["user", "Delete the W-9 task"],
      ["assistant", "Deleted."],
    ]);
    expect(body.threads[0].messages[0]).toEqual({ id: expect.any(String), role: "user", text: "Delete the W-9 task", created_at: expect.any(String) });
    expect(body.threads[1].messages).toBeUndefined();
    expect(body.settings).toEqual({ ...SETTINGS, brain: "server" });

    const patch = (b: unknown) => state.PATCH(new Request("https://hydra.example/api/agent/state", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    expect((await patch({ sleepWord: "  " })).status).toBe(400);
    expect(await (await patch({ sleepWord: "Goodnight Hydra" })).json()).toEqual({ ok: true, settings: { ...SETTINGS, sleepWord: "Goodnight Hydra", brain: "server" }, activeAvatar: null });
    expect((await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json()).settings).toEqual({ ...SETTINGS, sleepWord: "Goodnight Hydra", brain: "server" });
  });
});

describe("the shared agent settings (W6 contract, 0190)", () => {
  const patch = (b: unknown, headers: Record<string, string> = {}) =>
    state.PATCH(new Request("https://hydra.example/api/agent/state", { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) }));

  it("PATCH sets any subset and answers every setting; GET reads them back", async () => {
    m.isOwner = true;
    const res = await patch({ wakePhrase: "  Okay Hydra ", clapSensitivity: "high", model: "claude-sonnet-5-5", effortLive: "medium" });
    expect(res.status).toBe(200);
    const after = { ...SETTINGS, brain: "server", wakePhrase: "Okay Hydra", clapSensitivity: "high", model: "claude-sonnet-5-5", effortLive: "medium" };
    expect(await res.json()).toEqual({ ok: true, settings: after, activeAvatar: null });
    expect(await (await patch({ effortRoutine: "high", sleepWord: "Night Hydra" })).json()).toEqual({ ok: true, settings: { ...after, effortRoutine: "high", sleepWord: "Night Hydra" }, activeAvatar: null });
    expect((await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json()).settings).toEqual({ ...after, effortRoutine: "high", sleepWord: "Night Hydra" });
  });

  it("0200: approve all is off by default, turns on and off through PATCH, and the store reads it back", async () => {
    m.isOwner = true;
    expect((await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json()).settings.approveAll).toBe(false);
    expect(await (await patch({ approveAll: true })).json()).toEqual({ ok: true, settings: { ...SETTINGS, brain: "server", approveAll: true }, activeAvatar: null });
    expect((await m.mem!.store.settings()).approveAll).toBe(true);
    expect((await patch({ approveAll: "yes" })).status).toBe(400);
    expect((await (await patch({ approveAll: false })).json()).settings.approveAll).toBe(false);
    expect((await m.mem!.store.settings()).approveAll).toBe(false);
  });

  it("0200: a paired device may not turn approve all on or off (it may not approve its own gates); other settings it may", async () => {
    m.isOwner = true;
    const asDevice = { "x-hydra-device": DEVICE_ID };
    for (const approveAll of [true, false]) {
      const res = await patch({ approveAll }, asDevice);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "owner_only" });
    }
    expect((await patch({ approveAll: true, wakePhrase: "Okay Hydra" }, asDevice)).status).toBe(403);
    expect(await m.mem!.store.settings()).toMatchObject({ approveAll: false, wakePhrase: "Hey Hydra" });
    expect((await patch({ wakePhrase: "Okay Hydra" }, asDevice)).status).toBe(200);
  });

  it("refuses anything invalid with 400 and changes nothing", async () => {
    m.isOwner = true;
    const bad: unknown[] = [
      {},
      { wakePhrase: "a" },
      { wakePhrase: "x".repeat(41) },
      { sleepWord: "z" },
      { sleepWord: "x".repeat(61) },
      { clapSensitivity: "max" },
      { model: "claude-opus-4-1" },
      { effortLive: "turbo" },
      { effortRoutine: "off" },
      { brain: "server" },
      { wakePhrase: "Okay Hydra", extra: 1 },
      { wakePhrase: 42 },
    ];
    for (const b of bad) expect([b, (await patch(b)).status]).toEqual([b, 400]);
    const { activeAvatarId, ...stored } = SETTINGS;
    expect(activeAvatarId).toBeNull();
    expect(await m.mem!.store.settings()).toEqual({ ...stored, brain: "server", activeAvatar: null });
  });

  it("models: GET answers the providers the owner can pick now (Claude; Grok with its key; ChatGPT while a live Mac is signed in)", async () => {
    m.isOwner = true;
    const providers = async () => (await (await state.GET(new Request("https://hydra.example/api/agent/state"))).json()).providers;
    expect(await providers()).toEqual(["anthropic"]);
    await m.mem!.store.putModelKey("xai", "v1.a.b.c", "4f2a");
    expect(await providers()).toEqual(["anthropic", "xai"]);
    // The server brain's sign-in does not count, nor a Mac last seen over 2 minutes ago.
    m.mem!.brainDevices.add("brain-1");
    await m.mem!.store.setCapabilities("brain-1", { signedIn: ["chatgpt"] });
    await m.mem!.store.setCapabilities("mac-old", { signedIn: ["chatgpt"] });
    m.mem!.capabilitiesAt.set("mac-old", new Date(Date.now() - 3 * 60_000));
    expect(await providers()).toEqual(["anthropic", "xai"]);
    await m.mem!.store.setCapabilities("mac-1", { approveAllDeletionTags: 1, signedIn: ["chatgpt"] });
    expect(await providers()).toEqual(["anthropic", "openai", "xai"]);
  });

  it("models: a model whose provider is not connected is 409 and changes nothing; connected, it saves and clamps both efforts", async () => {
    m.isOwner = true;
    await patch({ effortLive: "max", effortRoutine: "xhigh" });
    for (const model of ["grok-4.7", "gpt-6.2-sol"]) {
      const res = await patch({ model });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "model_not_connected" });
    }
    expect((await m.mem!.store.settings()).model).toBe("claude-opus-5-5");
    await m.mem!.store.putModelKey("xai", "v1.a.b.c", "4f2a");
    const res = await patch({ model: "grok-4.7" });
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ model: "grok-4.7", effortLive: "xhigh", effortRoutine: "xhigh" });
    // An effort the model does not offer is 400: max on Grok.
    const max = await patch({ effortLive: "max" });
    expect(max.status).toBe(400);
    expect(await max.json()).toMatchObject({ error: "effort_not_offered" });
    expect((await patch({ model: "claude-opus-5-5", effortLive: "max" })).status).toBe(200);
    expect(await m.mem!.store.settings()).toMatchObject({ model: "claude-opus-5-5", effortLive: "max", effortRoutine: "xhigh" });
    // ChatGPT while a Mac reports the sign-in.
    await m.mem!.store.setCapabilities("mac-1", { signedIn: ["chatgpt"] });
    expect((await (await patch({ model: "gpt-6.2-astra", effortRoutine: "low" })).json()).settings).toMatchObject({ model: "gpt-6.2-astra", effortLive: "xhigh", effortRoutine: "low" });
  });

  it("a paired device with the agent scope is forwarded as the owner; no session and no key is 401", async () => {
    expect((await patch({ wakePhrase: "Okay Hydra" })).status).toBe(401);
    m.devices.set(sha256(KEY), { id: DEVICE_ID, scopes: ["agent"] });
    expect(await (await patch({ wakePhrase: "Okay Hydra" }, { authorization: `Bearer ${KEY}` })).json()).toEqual({ forwarded: DEVICE_ID });
  });
});

describe("POST /api/agent/turn/append (0191)", () => {
  it("adds the owner's words to a server-loop turn holding its thread lease: 202 with the seq, in order", async () => {
    m.isOwner = true;
    const mem = m.mem!;
    const threadId = await mem.store.createThread("web", "t");
    const turnId = "00000000-0000-4000-8000-0000000000f1";
    expect(await mem.store.claimThread(threadId, turnId, 300)).toBe(true);
    const first = await append.POST(post("/api/agent/turn/append", { turnId, text: " and only overdue " }));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, seq: 1 });
    expect(await (await append.POST(post("/api/agent/turn/append", { turnId, text: "also tomorrow" }))).json()).toEqual({ ok: true, seq: 2 });
    expect(await mem.store.inputsAfter(turnId, 0)).toEqual([
      { seq: 1, text: "and only overdue" },
      { seq: 2, text: "also tomorrow" },
    ]);
    // The turn ends: its lease goes, and an addition is 409 (the client starts a new turn instead).
    await mem.store.releaseThread(threadId, turnId);
    const late = await append.POST(post("/api/agent/turn/append", { turnId, text: "late" }));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "turn_over" });
  });

  it("400 on a bad body: no turn id, empty or too long words", async () => {
    m.isOwner = true;
    for (const b of [{ text: "hi" }, { turnId: "nope", text: "hi" }, { turnId: "00000000-0000-4000-8000-0000000000f1", text: "  " }, { turnId: "00000000-0000-4000-8000-0000000000f1", text: "x".repeat(8001) }]) {
      expect((await append.POST(post("/api/agent/turn/append", b))).status).toBe(400);
    }
    expect(m.mem!.inputs).toEqual([]);
  });
});
