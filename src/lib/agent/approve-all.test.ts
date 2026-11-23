// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./events";

/*
 * Approve all (0200, owner: "there should be a mode that approves all actions"): with it on, a gated step that is not
 * a deletion runs without asking, in the server loop (live and routine) and the MCP gate, and its approval row is still
 * written, already approved, then done (the audit trail; Gmail send needs its id). Every deletion still asks. Off, the
 * gate is unchanged. A risky Mac step runs without an ask only when every desktop declared approveAllDeletionTags
 * (that Mac then asks locally for a deletion); an older desktop gets the ask. The relay route's half is in
 * relay.routes.test.ts.
 */
const m = vi.hoisted(() => {
  const task = { id: "00000000-0000-4000-8000-0000000000b1", title: "Send the W-9", statusId: "s", position: 1, values: {} };
  return {
    task,
    loadPlanning: vi.fn(async () => ({ ok: true, value: { statuses: [], tasks: [task], goals: [], events: [], properties: [], timeZone: "UTC" } })),
    deleteTask: vi.fn(async () => ({ ok: true, value: null })),
    sendEmail: vi.fn(async (...args: [unknown, string]) => (void args, { ok: true, data: { messageId: "m1", threadId: "t1" } })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/planning/actions", () => ({ loadPlanning: m.loadPlanning, deleteTask: m.deleteTask }));
vi.mock("@/lib/google/gmail", async (orig) => ({ ...(await orig<object>()), sendEmail: m.sendEmail }));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const { runTurn } = await import("./loop");
const { callMcpTool } = await import("./mcp");
const { executeTool } = await import("./tools");
const { MCP_GROUPS } = await import("./config");
const { memoryStore } = await import("./testing");
const { scriptedModel, toolUse, toolCtx, ALL } = await import("./fixtures");
const { DEFAULT_SETTINGS } = await import("./store");
const { macDeletes } = await import("./registry");

type Mem = ReturnType<typeof memoryStore>;
const NOW = new Date("2026-11-21T15:00:00Z");
const DEVICE = "00000000-0000-4000-8000-0000000000d1";
const SEND = { to: ["brand@example.com"], subject: "Rates", body: "Hi" };
/** A build 4 desktop's declaration, as /relay/next records it. */
const tags = () => mem.capabilities.set(DEVICE, { approveAllDeletionTags: 1 });
let mem: Mem;
beforeEach(() => {
  vi.clearAllMocks();
  mem = memoryStore({ now: () => NOW });
});

function turn(call: { name: string; input: unknown }, opts: { approveAll: boolean; mode?: "live" | "routine" }) {
  const { client, requests } = scriptedModel([
    { content: [toolUse("tu_1", call.name, call.input)], stop_reason: "tool_use" },
    { text: "Done.", content: [], stop_reason: "end_turn" },
  ]);
  const events: AgentEvent[] = [];
  const done = runTurn({
    client,
    store: mem.store,
    ctx: { db: {} as never, surface: "web", runId: null, deviceId: null, unattended: opts.mode === "routine", allowed: ALL, now: () => NOW, timeZone: async () => "UTC" },
    text: "Go",
    emit: (e) => events.push(e),
    mode: opts.mode ?? "live",
    settings: { ...DEFAULT_SETTINGS, approveAll: opts.approveAll },
    confirmWaitMs: 60,
    pollMs: 5,
  });
  return { events, done, requests };
}
const tools = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool");

describe("approve all in the server loop", () => {
  it.each(["live", "routine"] as const)("%s: a send runs at once with an approved row and its id; no confirm, no wait", async (mode) => {
    const { events, done } = turn({ name: "gmail_send", input: SEND }, { approveAll: true, mode });
    const result = await done;
    expect(events.some((e) => e.type === "confirm")).toBe(false);
    expect(result.approvals).toEqual([]); // a routine run does not wait on it
    expect(mem.approvals).toHaveLength(1);
    const row = mem.approvals[0];
    expect(row).toMatchObject({ source: mode, tool: "gmail_send", reason: "send", danger: true, status: "done", action_id: mem.actions[0].id });
    expect(row.decided_at).not.toBeNull();
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0][1]).toBe(row.id); // Gmail gets the approval id
    expect(tools(events).map((e) => [e.status, e.summary])).toEqual([
      ["start", "Send an email from the owner's Gmail"],
      ["done", "Sent email to brand@example.com: Rates"],
    ]);
    expect(mem.notifications).toHaveLength(0); // nothing waits for the owner
  });

  it("a risky Mac step that deletes nothing runs at once when the desktop tags its deletions", async () => {
    tags();
    const { events, done } = turn({ name: "mac_do", input: { instruction: "Quit Safari", risky: true, deletes: false } }, { approveAll: true });
    await done;
    expect(events.some((e) => e.type === "confirm")).toBe(false);
    expect(mem.approvals[0]).toMatchObject({ reason: "mac", status: "done" });
    expect(mem.actions[0]).toMatchObject({ tool: "mac_do" });
  });

  it("the step approve all let through goes only to a pull that declares the tags, not a desktop that is older by then", async () => {
    tags();
    const { done } = turn({ name: "mac_do", input: { instruction: "Quit TextEdit", risky: true, deletes: false } }, { approveAll: true });
    await done;
    // An older build pairs, or this Mac downgrades, before it pulls: its pull declares nothing.
    mem.capabilities.set("00000000-0000-4000-8000-0000000000d2", {});
    expect(await mem.store.claimDesktopJobs("00000000-0000-4000-8000-0000000000d2", 10)).toEqual([]);
    expect(await mem.store.claimDesktopJobs(DEVICE, 10, true)).toMatchObject([{ instruction: "Quit TextEdit", risky: true, needs_tags: true }]);
  });

  it("a risky step the owner said yes to, or a plain one, goes to any desktop", async () => {
    // The owner's yes reruns the step approved (confirm route), with no autoApproved mark.
    expect((await executeTool("mac_do", { instruction: "Quit Safari", risky: true, deletes: false }, toolCtx(mem.store), { approved: true })).status).toBe("ok");
    await turn({ name: "mac_do", input: { instruction: "Open Notes", risky: false } }, { approveAll: true }).done;
    expect(await mem.store.claimDesktopJobs(DEVICE, 10)).toMatchObject([{ instruction: "Quit Safari", needs_tags: false }, { instruction: "Open Notes", needs_tags: false }]);
  });

  it.each([
    ["no desktop declared anything", () => {}],
    ["an older desktop", () => mem.capabilities.set(DEVICE, {})],
    ["one of two desktops is older", () => (tags(), mem.capabilities.set("00000000-0000-4000-8000-0000000000d2", {}))],
  ])("a risky Mac step asks as with approve all off when %s", async (_, setup) => {
    setup();
    const { events, done } = turn({ name: "mac_do", input: { instruction: "Quit Safari", risky: true, deletes: false } }, { approveAll: true });
    await done;
    expect(events.some((e) => e.type === "confirm")).toBe(true);
    expect(mem.approvals[0]).toMatchObject({ reason: "mac", status: "expired" });
    expect(mem.actions).toHaveLength(0);
  });

  it("a deletion word with deletes false still asks, as a deletion, even with tags", async () => {
    tags();
    const { events, done } = turn({ name: "mac_do", input: { instruction: "Run pkill TextEdit", risky: true, deletes: false } }, { approveAll: true });
    await done;
    expect(events.some((e) => e.type === "confirm")).toBe(true);
    expect(mem.approvals[0]).toMatchObject({ reason: "delete", status: "expired" });
  });

  it.each([
    { instruction: "Move ~/Documents/2025-taxes.pdf to the Trash and empty the Trash", risky: true },
    { instruction: "Tidy the Desktop", risky: true, deletes: true },
    { instruction: "Move ~/Downloads/old.zip to the Bin", risky: true, deletes: false },
    { instruction: "Get rid of every .dmg in Downloads", risky: false },
    // Fail closed: a risky step that did not say it deletes nothing.
    { instruction: "Quit Safari", risky: true },
  ])("a Mac deletion still asks: $instruction", async (input) => {
    tags();
    const { events, done } = turn({ name: "mac_do", input }, { approveAll: true });
    await done;
    expect(events.some((e) => e.type === "confirm")).toBe(true);
    expect(mem.approvals[0]).toMatchObject({ reason: "delete", status: "expired" });
    expect(mem.actions).toHaveLength(0);
  });

  it.each(["live", "routine"] as const)("%s: a deletion still asks", async (mode) => {
    const { events, done } = turn({ name: "delete_task", input: { id: m.task.id } }, { approveAll: true, mode });
    const result = await done;
    expect(m.deleteTask).not.toHaveBeenCalled();
    expect(mem.approvals[0]).toMatchObject({ reason: "delete", tool: "delete_task", status: mode === "live" ? "expired" : "pending" });
    if (mode === "live") expect(events.some((e) => e.type === "confirm")).toBe(true);
    else expect(result.approvals).toEqual([mem.approvals[0].id]);
  });

  it("off: a send asks exactly as before", async () => {
    const { events, done } = turn({ name: "gmail_send", input: SEND }, { approveAll: false });
    await done;
    expect(events.some((e) => e.type === "confirm")).toBe(true);
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(mem.approvals[0].status).toBe("expired");
  });

  it("a failed step leaves its approved row failed, never approved", async () => {
    m.sendEmail.mockResolvedValueOnce({ ok: false, error: { code: "gmail", message: "Gmail is down" } } as never);
    await turn({ name: "gmail_send", input: SEND }, { approveAll: true }).done;
    expect(mem.approvals[0].status).toBe("failed");
  });
});

describe("approve all from a paired device", () => {
  it("a Mac deletion over MCP still asks", async () => {
    mem.setSettings({ approveAll: true });
    const ctx = toolCtx(mem.store, { surface: "mcp", allowed: MCP_GROUPS, deviceId: DEVICE });
    const res = await callMcpTool("mac_do", { instruction: "Delete ~/Downloads/old.zip", risky: true }, ctx);
    expect(res.structuredContent).toMatchObject({ needsApproval: true });
    expect(mem.actions).toHaveLength(0);
  });
});

describe("approve all in the MCP gate", () => {
  const ctx = () => toolCtx(mem.store, { surface: "mcp", allowed: MCP_GROUPS, deviceId: DEVICE });

  it("a non-delete gated call runs in the same call, with its row approved then done", async () => {
    mem.setSettings({ approveAll: true });
    tags();
    const res = await callMcpTool("mac_do", { instruction: "Quit Safari", risky: true, deletes: false }, ctx());
    expect(res.isError).toBe(false);
    expect(JSON.stringify(res.content)).not.toContain("needsApproval");
    expect(mem.approvals).toHaveLength(1);
    expect(mem.approvals[0]).toMatchObject({ source: "mcp", device_id: DEVICE, reason: "mac", status: "done", action_id: mem.actions[0].id });
    expect(mem.notifications).toHaveLength(0);
    // Bound to a desktop that tags its deletions: a pull that declares nothing does not get it.
    expect(await mem.store.claimDesktopJobs(DEVICE, 10)).toEqual([]);
    expect(await mem.store.claimDesktopJobs(DEVICE, 10, true)).toMatchObject([{ needs_tags: true }]);
  });

  it("a risky Mac step from an older desktop asks", async () => {
    mem.setSettings({ approveAll: true });
    mem.capabilities.set(DEVICE, {});
    const res = await callMcpTool("mac_do", { instruction: "Quit Safari", risky: true, deletes: false }, ctx());
    expect(res.structuredContent).toMatchObject({ needsApproval: true });
    expect(mem.approvals[0]).toMatchObject({ reason: "mac", status: "pending" });
    expect(mem.actions).toHaveLength(0);
  });

  it("a deletion still needs the owner's yes", async () => {
    mem.setSettings({ approveAll: true });
    const res = await callMcpTool("delete_task", { id: m.task.id }, ctx());
    expect(res.structuredContent).toMatchObject({ needsApproval: true });
    expect(m.deleteTask).not.toHaveBeenCalled();
    expect(mem.approvals[0]).toMatchObject({ status: "pending", reason: "delete" });
  });

  it("the same send twice at once (a retry) sends once; the second asks the owner", async () => {
    mem.setSettings({ approveAll: true });
    const [a, b] = await Promise.all([callMcpTool("gmail_send", SEND, ctx()), callMcpTool("gmail_send", SEND, ctx())]);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect([a, b].filter((r) => (r.structuredContent as { needsApproval?: boolean } | undefined)?.needsApproval)).toHaveLength(1);
    expect(mem.approvals.map((r) => r.status).sort()).toEqual(["done", "pending"]);
    // A retry after the first one finished, in the same window, asks too.
    await callMcpTool("gmail_send", SEND, ctx());
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("the window slides: the same call retried across a 2-minute mark runs once; 2 minutes after the last run, again", async () => {
    let now = new Date("2026-11-21T15:01:59.900Z");
    mem = memoryStore({ now: () => now });
    mem.setSettings({ approveAll: true });
    tags();
    const at = () => toolCtx(mem.store, { surface: "mcp", allowed: MCP_GROUPS, deviceId: DEVICE, now: () => now });
    const quit = { instruction: "Quit Xcode", risky: true, deletes: false };
    await callMcpTool("gmail_send", SEND, at());
    await callMcpTool("mac_do", quit, at());
    now = new Date("2026-11-21T15:02:00.300Z");
    const again = await callMcpTool("gmail_send", SEND, at());
    await callMcpTool("mac_do", quit, at());
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(again.structuredContent).toMatchObject({ needsApproval: true });
    expect(mem.actions.filter((a) => a.tool === "mac_do")).toHaveLength(1);
    // Two minutes after the last auto-approved run it is a new call: it runs, and the old row keeps a renamed key.
    now = new Date("2026-11-21T15:04:00.000Z");
    await callMcpTool("gmail_send", SEND, at());
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
    const sends = mem.approvals.filter((a) => a.tool === "gmail_send" && a.status === "done");
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((a) => a.dedupe_key)).size).toBe(2);
    expect(sends[0].dedupe_key).toBe(`${sends[1].dedupe_key}:${sends[0].id}`);
  });

  it("a failed auto-approved call keeps its error on the row, as the loop does", async () => {
    mem.setSettings({ approveAll: true });
    m.sendEmail.mockResolvedValueOnce({ ok: false, error: { code: "gmail", message: "Gmail is down" } } as never);
    await callMcpTool("gmail_send", SEND, ctx());
    expect(mem.approvals[0]).toMatchObject({ status: "failed", result: { error: expect.stringContaining("Gmail is down") } });
  });

  it("off: the same call asks", async () => {
    const res = await callMcpTool("mac_do", { instruction: "Quit Safari", risky: true }, ctx());
    expect(res.structuredContent).toMatchObject({ needsApproval: true });
    expect(mem.actions).toHaveLength(0);
  });
});

describe("the deletion words: an extra layer that only adds asks", () => {
  // Every phrasing the round 4 reviews found, after the fold (\p{Cf} stripped, typographic quotes plain, one space).
  it.each([
    "Run pkill TextEdit",
    "Run killall Dock",
    "Reformat the USB drive as APFS",
    "Run git checkout -- . in the repo",
    "Run git restore .",
    "Run git branch -D feature",
    "Run docker system prune -a",
    "Run npx rimraf node_modules",
    "Nuke the Downloads folder",
    "Run diskutil zeroDisk disk2",
    "Run diskutil partitionDisk disk2 GPT APFS Untitled 100%",
    "Run dd if=/dev/zero of=/dev/disk2",
    "Run dd if=/dev/zero of=disk.img",
    "Run cp blank.txt report.pdf",
    "Run echo '' > notes.txt",
    "Run echo hi > notes.txt",
    "Run :>log.txt",
    "Run srm secret.txt",
    `Run sqlite3 db "update users set name=''"`,
    "Press Cmd+D in the save sheet",
    "Close the document; do not keep changes",
    'tell application "Pages" to close every document saving no',
    "Click No when Pages asks to save",
    "Close Pages without save",
    "Click \u201cDon\u2019t Save\u201d in the TextEdit dialog",
    'Click "Don\'t  Save"',
    "Click Don\u2019t\u00a0\u00a0Save",
    "Del\u200bete the Drafts folder",
    "Tr\u200dash it\ufeff",
  ])("asks: %s", (words) => expect(macDeletes(words)).toBe(true));

  it.each(["Quit Safari", "Quit Xcode", "Arrange Safari and Notes side by side", "Choose File > Save As", "Get info on report.pdf", "Add a coffee"])(
    "no deletion: %s",
    (words) => expect(macDeletes(words)).toBe(false),
  );
});
