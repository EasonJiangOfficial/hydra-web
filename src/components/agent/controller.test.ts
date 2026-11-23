import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController, MIC_OFF, NOT_HEARING, NOTHING_HEARD, BARGE_MS, BARGE_RESUME_MS, ECHO_TAIL_MS, FILLER_MS, FRESH_UI_MS, IDLE_MS, SECOND_FILLER_MS, STEP_GRACE_MS, VAD_CALIBRATE_FRAMES, VAD_TICK_MS, type ControllerDeps } from "./controller";
import type { Meter } from "./audio";
import { FILLERS } from "./words";
import { CAUGHT_MS, createListener, type Listener, type ListenerHandlers } from "./listener";
import type { SpeakerLike } from "./speaker";
import { fakeBridge } from "@/app/dev/agent/fake-bridge";
import type { UiEvent } from "./types";

type Ev = Record<string, unknown>;
/** A turn response in the server's wire format: text/event-stream, one `data:` frame per event. */
const stream = (events: Ev[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
/** A turn that stays open after `events` until `release` runs, like the server paused at a confirm. */
function held(events: Ev[]) {
  let release: (more: Ev[]) => void = () => {};
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      release = (more) => {
        for (const e of more) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.close();
      };
    },
  });
  return { res: new Response(body, { headers: { "content-type": "text/event-stream" } }), release: (more: Ev[]) => release(more) };
}
const bodyOf = (call: Parameters<typeof fetch> | undefined) => JSON.parse(String(call?.[1]?.body));
const THREAD = "00000000-0000-4000-8000-0000000000aa";
const text = (...d: string[]): Ev[] => d.map((delta) => ({ type: "text", delta }));

function setup(over: Partial<ControllerDeps> = {}) {
  let busyCb: (b: boolean) => void = () => {};
  const speaker = {
    say: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    level: () => 0.5,
    busy: false,
    onBusy: (cb: (b: boolean) => void) => (busyCb = cb),
    played: vi.fn((): string[] => []),
    prefetch: vi.fn(),
    unlock: vi.fn(),
  } satisfies SpeakerLike;
  const heard: { h: ListenerHandlers; listener: Listener }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async () => stream([...text("Done."), { type: "done" }]));
  const runUi = vi.fn<(e: UiEvent) => void>();
  const blip = vi.fn();
  const ctl = new AgentController({
    fetch: fetchFn,
    nav: { push: vi.fn(), replace: vi.fn() },
    speaker,
    createListener: (h) => {
      const listener = { start: vi.fn(), stop: vi.fn() };
      heard.push({ h, listener });
      return listener;
    },
    openMic: async () => null,
    blip,
    supported: () => true,
    runUi,
    here: () => ({ path: "/transactions", search: "?scope=ugc&tx=1" }),
    surface: () => "web",
    storage: { getItem: () => null, removeItem: vi.fn() },
    ...over,
  });
  const off = ctl.init(undefined);
  return { ctl, speaker, busy: (b: boolean) => busyCb(b), heard, fetchFn, runUi, blip, off };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("status", () => {
  it("owner report (no voice on the phone): a tap and a typed Send unlock audio inside the gesture; a spoken turn does not", () => {
    const { ctl, speaker } = setup();
    ctl.tapOrb();
    expect(speaker.unlock).toHaveBeenCalledTimes(1);
    ctl.submit("typed", false);
    expect(speaker.unlock).toHaveBeenCalledTimes(2);
    ctl.submit("spoken", true);
    expect(speaker.unlock).toHaveBeenCalledTimes(2);
  });

  it("starts asleep and wakes on a tap into listening, with the recognizer on", () => {
    const { ctl, heard } = setup();
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(heard).toHaveLength(0);
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("listening");
    expect(heard).toHaveLength(1);
    expect(heard[0].listener.start).toHaveBeenCalled();
  });

  it("owner report: a tap while listening shuts it off; inside Hydra Desktop the tap reaches the Mac", () => {
    const { ctl, heard } = setup();
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("listening");
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(heard[0].listener.stop).toHaveBeenCalled();
    for (const version of [1, 3] as const) {
      const { bridge, calls, push } = fakeBridge(version, { snap: { state: "Listening" } });
      const d = setup();
      d.ctl.init(bridge);
      d.ctl.tapOrb(); // listening: off
      push({ state: "Speaking" });
      d.ctl.tapOrb(); // speaking: never a dead tap (v3 stops the voice, v1 sleeps)
      expect(calls).toEqual(version === 1 ? ["sleep", "sleep"] : ["sleep", "stop"]);
    }
  });

  it("goes thinking, then speaking while the voice is busy, then back to listening", async () => {
    vi.useRealTimers();
    const { ctl, busy, speaker, heard } = setup();
    ctl.tapOrb();
    ctl.heard("what is my balance");
    expect(ctl.getSnapshot().status).toBe("thinking");
    expect(heard[0].listener.stop).not.toHaveBeenCalled(); // thinking, it still listens: his words join the turn (0191)
    await vi.waitFor(() => expect(speaker.say).toHaveBeenCalledWith("Done."));
    busy(true);
    expect(ctl.getSnapshot().status).toBe("speaking");
    busy(false);
    await vi.waitFor(() => expect(ctl.getSnapshot().status).toBe("listening"));
  });

  it("tapping the orb while Hydra speaks interrupts it", () => {
    const { ctl, busy, speaker } = setup();
    ctl.tapOrb();
    busy(true);
    expect(ctl.getSnapshot().status).toBe("speaking");
    ctl.tapOrb();
    expect(speaker.stop).toHaveBeenCalled();
    expect(ctl.getSnapshot().status).toBe("listening");
  });

  it("asks for the typed input when there is no recognizer", () => {
    const { ctl, heard } = setup({ supported: () => false });
    expect(ctl.getSnapshot().typedOnly).toBe(true);
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("listening");
    expect(ctl.getSnapshot().expanded).toBe(true);
    expect(heard).toHaveLength(0);
  });

  it("falls back to typed input when the microphone is refused", () => {
    const { ctl, heard } = setup();
    ctl.tapOrb();
    heard[0].h.onFatal("not-allowed");
    expect(ctl.getSnapshot().typedOnly).toBe(true);
    expect(ctl.getSnapshot().error).toMatch(/Type instead/);
  });
});

describe("sleep", () => {
  it("sleeps after 5 minutes without the owner talking, and talking resets the clock", () => {
    const { ctl, heard } = setup();
    ctl.tapOrb();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    heard[0].h.onInterim("hello"); // the owner is talking
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(ctl.getSnapshot().status).toBe("listening");
    vi.advanceTimersByTime(1500);
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(heard[0].listener.stop).toHaveBeenCalled();
  });

  it('"Hydra, sleep" sleeps at once with one short sound, and sends nothing to the agent', () => {
    const { ctl, blip, fetchFn } = setup();
    ctl.tapOrb();
    ctl.heard("Hydra, sleep");
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(blip).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalledWith("/api/agent/turn", expect.anything());
  });

  it("uses the server's sleep word, and saves a new one to the server", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async (u, init) =>
      u === "/api/agent/state" && !init ? Response.json({ threads: [], settings: { sleepWord: "Hydra, go dark" } }) : Response.json({ ok: true }),
    );
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    expect(ctl.getSnapshot().sleepWord).toBe("Hydra, go dark");
    ctl.tapOrb();
    ctl.heard("Hydra, sleep");
    expect(ctl.getSnapshot().status).not.toBe("asleep");
    ctl.heard("hydra go dark");
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(await ctl.setSleepWord("  Night Hydra ")).toBe(true);
    const patch = fetchFn.mock.calls.find((c) => c[1]?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/agent/state");
    expect(bodyOf(patch)).toEqual({ sleepWord: "Night Hydra" });
    expect(ctl.getSnapshot().sleepWord).toBe("Night Hydra");
    await ctl.setSleepWord("");
    expect(ctl.getSnapshot().sleepWord).toBe("Hydra, sleep");
  });

  it("keeps the old sleep word when the server refuses the new one", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_input" }, { status: 400 }));
    const { ctl } = setup({ fetch: fetchFn });
    expect(await ctl.setSleepWord("Night Hydra")).toBe(false);
    expect(ctl.getSnapshot().sleepWord).toBe("Hydra, sleep");
    expect(ctl.getSnapshot().error).not.toBeNull();
  });

  it("a tap wakes it again", () => {
    const { ctl } = setup();
    ctl.tapOrb();
    ctl.sleep();
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("listening");
  });
});

describe("a turn", () => {
  it("posts the contract body, keeps the thread id, streams text, runs ui events, and speaks sentence by sentence", async () => {
    vi.useRealTimers();
    const events: Ev[] = [
      { type: "thread", threadId: THREAD },
      ...text("Opening Plan", "ning. Here is "),
      { type: "ui", action: { kind: "navigate", href: "/planning" } },
      { type: "ui", action: { kind: "navigate", href: "/\t/evil.example" } },
      { type: "tool", name: "navigate", status: "done", summary: "Opened /planning" },
      ...text("your week."),
      { type: "done", usage: {} },
    ];
    const fetchFn = vi.fn<typeof fetch>(async (u) => (String(u) === "/api/agent/turn" ? stream(events) : Response.json({ threads: [], pendingApprovals: [], activity: [] })));
    const { ctl, runUi, speaker } = setup({ fetch: fetchFn });
    ctl.tapOrb();
    ctl.heard("go to planning", true);
    await vi.waitFor(() => expect(speaker.say).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchFn.mock.calls[0])).toEqual({
      input: { audioTranscript: "go to planning" },
      surface: "web",
      context: { path: "/transactions", search: "?scope=ugc&tx=1", scope: "ugc" },
    });
    expect(runUi).toHaveBeenCalledTimes(1);
    expect(runUi).toHaveBeenCalledWith({ kind: "navigate", href: "/planning" });
    expect(speaker.say.mock.calls.map((c) => c[0])).toEqual(["Opening Planning.", "Here is your week."]);
    expect(ctl.getSnapshot().thread.map((m) => [m.role, m.text])).toEqual([
      ["user", "go to planning"],
      ["hydra", "Opening Planning. Here is your week."],
    ]);
    await vi.waitFor(() => expect(ctl.getSnapshot().status).toBe("listening"));
    ctl.heard("and tomorrow"); // typed
    await vi.waitFor(() => expect(fetchFn.mock.calls.filter((c) => c[0] === "/api/agent/turn")).toHaveLength(2));
    expect(bodyOf(fetchFn.mock.calls.filter((c) => c[0] === "/api/agent/turn")[1])).toMatchObject({ threadId: THREAD, input: { text: "and tomorrow" } });
  });

  it("does not speak when muted, and the text still streams", async () => {
    vi.useRealTimers();
    const { ctl, speaker } = setup();
    ctl.tapOrb();
    ctl.toggleMute();
    ctl.heard("hi");
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Done."));
    expect(speaker.say).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ctl.getSnapshot().status).toBe("listening"));
  });

  it("shows the server's error when the agent is down, and returns to listening", async () => {
    vi.useRealTimers();
    const { ctl } = setup({ fetch: vi.fn(async () => Response.json({ error: "invalid_input", message: "bad body" }, { status: 400 })) });
    ctl.tapOrb();
    ctl.heard("hi");
    await vi.waitFor(() => expect(ctl.getSnapshot().error).toBe("bad body"));
    expect(ctl.getSnapshot().status).toBe("listening");
    expect(ctl.getSnapshot().thread.map((m) => m.role)).toEqual(["user"]); // no empty Hydra bubble
  });

  it("owner report: Stop ends the turn, the voice and the listening, and asleep it does nothing harmful", async () => {
    vi.useRealTimers();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const { ctl, speaker } = setup({ fetch: fetchFn as unknown as typeof fetch });
    ctl.stop(); // asleep: nothing to stop, nothing breaks
    expect(ctl.getSnapshot().status).toBe("asleep");
    ctl.tapOrb();
    ctl.heard("hi");
    expect(ctl.getSnapshot().status).toBe("thinking");
    ctl.stop();
    expect(signal?.aborted).toBe(true);
    expect(speaker.stop).toHaveBeenCalled();
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(ctl.getSnapshot().thread.map((m) => m.role)).toEqual(["user"]); // no empty Hydra bubble
    ctl.tapOrb();
    expect(ctl.getSnapshot().status).toBe("listening");
  });

  it("a tap while Hydra speaks barges in: the speech ends and it listens", async () => {
    vi.useRealTimers();
    const { ctl, speaker, busy } = setup();
    ctl.tapOrb();
    busy(true);
    expect(ctl.getSnapshot().status).toBe("speaking");
    ctl.tapOrb();
    expect(speaker.stop).toHaveBeenCalled();
    busy(false);
    expect(ctl.getSnapshot().status).toBe("listening");
  });

  it("the Mac error codes map to the card's words, and a spoken turn says the error out loud", async () => {
    vi.useRealTimers();
    for (const [code, issue] of [
      ["brain_offline", "brain_offline"],
      ["brain_timeout", "brain_timeout"],
      ["brain_failed", "brain_failed"],
      ["mac_offline", "offline"],
      ["mac_timeout", "timeout"],
      ["mac_bad_event", "bad_event"],
      ["mac_failed", "failed"],
      ["mac_claude", "claude"],
      ["mac_signed_out", "claude"],
    ] as const) {
      const fetchFn = vi.fn(async () => stream([{ type: "thread", threadId: THREAD }, { type: "error", code, message: "Your Mac is offline." }]));
      const { ctl, speaker } = setup({ fetch: fetchFn as unknown as typeof fetch });
      ctl.tapOrb();
      ctl.heard("hi", true);
      await vi.waitFor(() => expect(ctl.getSnapshot().macIssue).toBe(issue));
      expect(speaker.say).toHaveBeenCalledWith("Your Mac is offline.");
    }
  });
});

describe("confirm", () => {
  /** The server keeps the turn open at a confirm; /api/agent/confirm answers it, and the same stream goes on. */
  function confirmServer() {
    const turn = held([{ type: "thread", threadId: THREAD }, ...text("That deletes one row. "), { type: "confirm", id: "c1", summary: "Delete Costco?", danger: true }]);
    const fetchFn = vi.fn<typeof fetch>(async (u, init) => {
      if (u === "/api/agent/turn") return turn.res;
      if (u === "/api/agent/confirm") {
        const { approve } = JSON.parse(String(init?.body));
        turn.release(approve ? [...text("Deleted."), { type: "done", usage: {} }] : [...text("Left it."), { type: "done", usage: {} }]);
        return Response.json({ ok: true });
      }
      return Response.json({ threads: [], pendingApprovals: [], activity: [] });
    });
    return { fetchFn, turn };
  }

  it("shows the prompt and listens while the turn waits; a spoken yes posts the answer without ending the stream", async () => {
    vi.useRealTimers();
    const { fetchFn } = confirmServer();
    const { ctl, heard, speaker } = setup({ fetch: fetchFn });
    ctl.tapOrb();
    ctl.heard("delete the costco row");
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm).toEqual({ id: "c1", prompt: "Delete Costco?", danger: true }));
    expect(ctl.getSnapshot().expanded).toBe(true);
    expect(ctl.getSnapshot().status).toBe("listening"); // the stream is still open, and the mic is on for the answer
    expect(heard.at(-1)!.listener.start).toHaveBeenCalled();
    expect(speaker.say).toHaveBeenCalledWith("That deletes one row."); // the lead-in is spoken while it waits
    const turnSignal = fetchFn.mock.calls[0][1]!.signal!;
    heard.at(-1)!.h.onFinal("Yes.");
    expect(ctl.getSnapshot().confirm).toBeNull();
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("That deletes one row. Deleted."));
    expect(turnSignal.aborted).toBe(false);
    const confirms = fetchFn.mock.calls.filter((c) => c[0] === "/api/agent/confirm");
    expect(confirms.map(bodyOf)).toEqual([{ id: "c1", approve: true }]);
    expect(fetchFn.mock.calls.filter((c) => c[0] === "/api/agent/turn")).toHaveLength(1);
  });

  it("a tap on Decline answers no through the same route", async () => {
    vi.useRealTimers();
    const { fetchFn } = confirmServer();
    const { ctl } = setup({ fetch: fetchFn });
    ctl.tapOrb();
    ctl.heard("delete the costco row");
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm).not.toBeNull());
    await ctl.decide("c1", false);
    expect(bodyOf(fetchFn.mock.calls.find((c) => c[0] === "/api/agent/confirm"))).toEqual({ id: "c1", approve: false });
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("That deletes one row. Left it."));
  });

  it("a longer sentence is a new request, not an answer", async () => {
    vi.useRealTimers();
    const { fetchFn } = confirmServer();
    const { ctl } = setup({ fetch: fetchFn });
    ctl.tapOrb();
    ctl.heard("delete the costco row");
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm).not.toBeNull());
    ctl.heard("yes and also add a coffee");
    await vi.waitFor(() => expect(fetchFn.mock.calls.filter((c) => c[0] === "/api/agent/turn")).toHaveLength(2));
    expect(bodyOf(fetchFn.mock.calls.filter((c) => c[0] === "/api/agent/turn")[1]).input).toEqual({ text: "yes and also add a coffee" });
    expect(fetchFn.mock.calls.some((c) => c[0] === "/api/agent/confirm")).toBe(false);
  });
});

describe("undo, approvals and the shared thread", () => {
  const STATE = {
    threads: [
      { id: "00000000-0000-4000-8000-0000000000r1", title: "Run the routine Morning brief", surface: "routine" },
      { id: THREAD, title: "Hydra", surface: "web", messages: [{ id: "m1", role: "user", text: "hi" }, { id: "m2", role: "assistant", text: "Hello." }] },
    ],
    pendingApprovals: [
      { id: "ap1", source: "routine", summary: "Send it?" },
      { id: "live1", source: "live", summary: "Delete?" },
    ],
    activity: [
      { id: "a1", tool: "add_transaction", summary: "Added Coffee", undoId: "a1", undoneAt: null, createdAt: "2026-11-21T11:00:00Z", threadId: THREAD, surface: "web" },
      { id: "a0", tool: "add_transaction", summary: "Added Tea", undoId: null, undoneAt: "2026-11-21T10:00:00Z" },
    ],
    notifications: [],
  };

  it("maps /state: activity with undo ids, routine approvals, and the latest thread for the next turn", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async (u) => (u === "/api/agent/state" ? Response.json(STATE) : stream([{ type: "done", usage: {} }])));
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    // An older server's row (no time, thread or surface) reads as null for them.
    expect(ctl.getSnapshot().activity).toEqual([
      { id: "a1", label: "Added Coffee", undoId: "a1", undone: false, createdAt: "2026-11-21T11:00:00Z", threadId: THREAD, surface: "web" },
      { id: "a0", label: "Added Tea", undoId: null, undone: true, createdAt: null, threadId: null, surface: null },
    ]);
    expect(ctl.getSnapshot().threadId).toBe(THREAD);
    expect(ctl.getSnapshot().approvals).toEqual([{ id: "ap1", prompt: "Send it?" }]);
    // Never a routine's thread; the shared one's messages fill the empty panel.
    expect(ctl.currentThread).toBe(THREAD);
    expect(ctl.getSnapshot().thread).toEqual([
      { id: "m1", role: "user", text: "hi" },
      { id: "m2", role: "hydra", text: "Hello." },
    ]);
    ctl.heard("hi");
    await vi.waitFor(() => expect(bodyOf(fetchFn.mock.calls.find((c) => c[0] === "/api/agent/turn")).threadId).toBe(THREAD));
  });

  it("undo posts {actionId} and marks the row undone", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async (u) => (u === "/api/agent/state" ? Response.json(STATE) : Response.json({ ok: true })));
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    fetchFn.mockImplementation(async (u) => (u === "/api/agent/state" ? new Response("", { status: 500 }) : Response.json({ ok: true })));
    expect(await ctl.undo("a1")).toBe(true);
    expect(bodyOf(fetchFn.mock.calls.find((c) => c[0] === "/api/agent/undo"))).toEqual({ actionId: "a1", surface: "web" });
    expect(ctl.getSnapshot().activity[0]).toMatchObject({ undone: true, undoId: null });
  });

  it("a failed undo leaves the row and shows the server's reason", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ok: false, message: "Already changed" }, { status: 409 }));
    const { ctl } = setup({ fetch: fetchFn });
    expect(await ctl.undo("a1")).toBe(false);
    expect(ctl.getSnapshot().error).toBe("Already changed");
  });

  it("a routine approval is answered through /api/agent/confirm and leaves the list", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async (u) => (u === "/api/agent/state" ? Response.json(STATE) : Response.json({ ok: true, status: "done" })));
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    await ctl.decideApproval("ap1", true);
    expect(fetchFn).toHaveBeenCalledWith("/api/agent/confirm", expect.objectContaining({ body: JSON.stringify({ id: "ap1", approve: true }) }));
    expect(ctl.getSnapshot().approvals).toHaveLength(0);
  });

  it("a missing server leaves the panel as it is", async () => {
    vi.useRealTimers();
    const { ctl } = setup({ fetch: vi.fn(async () => new Response("", { status: 404 })) });
    await ctl.refresh();
    expect(ctl.getSnapshot().approvals).toEqual([]);
    expect(ctl.getSnapshot().error).toBeNull();
  });
});

describe("Hydra Desktop bridge", () => {
  it("v1: mirrors the desktop state and levels from snapshot/subscribe, and never starts its own recognizer", () => {
    const { bridge, push } = fakeBridge(1, { snap: { state: "Listening", micLevel: 0.3, outputLevel: 0.9 } });
    const { ctl, heard } = setup();
    ctl.init(bridge);
    expect(ctl.getSnapshot()).toMatchObject({ desktop: true, status: "listening", can: { voice: false, detach: false } });
    expect(ctl.level()).toBe(0.3);
    push({ state: "Speaking" });
    expect(ctl.getSnapshot().status).toBe("speaking");
    expect(ctl.level()).toBe(0.9);
    push({ state: "Nonsense" as never, micLevel: 7 });
    expect(ctl.getSnapshot().status).toBe("speaking");
    expect(heard).toHaveLength(0);
  });

  it("v1: wake and sleep go to the desktop; mute, pause and detach are not there, so nothing throws; Stop puts it to sleep", () => {
    const { bridge, calls } = fakeBridge(1, { snap: { state: "Speaking" } });
    const { ctl } = setup();
    ctl.init(bridge);
    ctl.tapOrb(); // speaking: a v1 desktop has no interrupt, so the tap puts it to sleep (never a dead tap)
    expect(calls).toEqual(["sleep"]);
    ctl.toggleMute();
    ctl.togglePause();
    ctl.detach();
    expect(ctl.getSnapshot()).toMatchObject({ muted: false, paused: false, detached: false });
    expect(calls).toEqual(["sleep"]);
    ctl.stop(); // never a dead button: an older desktop has no stop, so it sleeps
    ctl.wake();
    ctl.sleep();
    expect(calls).toEqual(["sleep", "sleep", "wake", "sleep"]);
  });

  it("owner report: inside Hydra Desktop, Stop also ends the window's own turn and voice, then tells the Mac", async () => {
    vi.useRealTimers();
    for (const version of [1, 3] as const) {
      let signal: AbortSignal | undefined;
      const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      const { bridge, calls } = fakeBridge(version, { snap: { state: "Listening" } });
      const { ctl, speaker } = setup({ fetch: fetchFn as unknown as typeof fetch });
      ctl.init(bridge);
      ctl.submit("are you there");
      ctl.stop();
      expect(signal?.aborted).toBe(true);
      expect(speaker.stop).toHaveBeenCalled();
      expect(calls).toContain(version === 1 ? "sleep" : "stop");
    }
  });

  it("v2: detach and attach go to the desktop and the card follows the pushed flag", () => {
    const { bridge, calls, push } = fakeBridge(2);
    const { ctl } = setup();
    ctl.init(bridge);
    expect(ctl.getSnapshot().can).toEqual({ voice: false, detach: true });
    ctl.detach();
    expect(calls).toEqual(["detach"]);
    expect(ctl.getSnapshot().detached).toBe(true);
    ctl.attach();
    expect(ctl.getSnapshot().detached).toBe(false);
    push({ detached: true }); // detached from the menu bar
    expect(ctl.getSnapshot().detached).toBe(true);
  });

  it("v3: mute, pause, stop and an orb tap while speaking act on the desktop's voice", () => {
    const { bridge, calls, push } = fakeBridge(3, { snap: { state: "Speaking" } });
    const { ctl, speaker } = setup();
    ctl.init(bridge);
    expect(ctl.getSnapshot().can).toEqual({ voice: true, detach: true });
    ctl.togglePause();
    expect(ctl.getSnapshot().paused).toBe(true);
    ctl.togglePause();
    ctl.toggleMute();
    expect(ctl.getSnapshot().muted).toBe(true);
    ctl.stop();
    expect(ctl.getSnapshot().status).toBe("listening");
    push({ state: "Speaking" });
    ctl.tapOrb();
    // Stop = silence AND sleep (owner: "stop button still doesnt put it to sleep"); a tap while speaking only silences.
    expect(calls).toEqual(["pause", "resume", "muted:true", "stop", "sleep", "stop"]);
    expect(speaker.pause).not.toHaveBeenCalled();
    ctl.togglePause(); // listening: nothing to pause
    expect(calls.filter((c) => c === "pause")).toHaveLength(1);
  });

  it("v3: the reply and heard text mirror the snapshot", () => {
    const { bridge, push } = fakeBridge(3);
    const { ctl } = setup();
    ctl.init(bridge);
    push({ state: "Listening", heard: { text: "how much on food", final: false } });
    expect(ctl.getSnapshot()).toMatchObject({ heard: "how much on food", reply: "" });
    push({ state: "Speaking", heard: { text: "how much on food this week", final: true }, reply: { id: "r1", text: "You spent", final: false } });
    push({ reply: { id: "r1", text: "You spent $212.", final: true } });
    expect(ctl.getSnapshot()).toMatchObject({ heard: "how much on food this week", reply: "You spent $212." });
    push({ reply: null, heard: null });
    expect(ctl.getSnapshot()).toMatchObject({ heard: "", reply: "" });
  });

  it("v3: runs each valid interface step once, never a stale one from before load, never an unsafe one", () => {
    const stale = { kind: "navigate", href: "/reports" };
    const { bridge, push } = fakeBridge(3, { snap: { ui: stale } });
    const { ctl, runUi } = setup();
    ctl.init(bridge);
    expect(runUi).not.toHaveBeenCalled();
    const step = { kind: "highlight", selector: "[data-row-id='1']" };
    push({ ui: step });
    push({ micLevel: 0.4 }); // the same ui rides along with a level update
    expect(runUi).toHaveBeenCalledTimes(1);
    expect(runUi).toHaveBeenCalledWith(step);
    push({ ui: { kind: "navigate", href: "https://evil.example/login" } });
    push({ ui: { kind: "navigate", href: "/\n/evil.example" } });
    push({ ui: { kind: "navigate", href: "/api/agent/turn" } });
    push({ ui: { action: "navigate", href: "/planning" } });
    expect(runUi).toHaveBeenCalledTimes(1);
    push({ ui: { kind: "navigate", href: "/planning" } });
    expect(runUi).toHaveBeenLastCalledWith({ kind: "navigate", href: "/planning" });
  });
});

describe("Hydra Desktop wake look (woke)", () => {
  it("sets wokeAt once per wake although the bridge repeats the snapshot; a new wake sets it again; sleep clears it", () => {
    const { bridge, push } = fakeBridge(3);
    const { ctl } = setup();
    ctl.init(bridge);
    expect(ctl.getSnapshot().wokeAt).toBeNull();
    const at = Date.now() - 6000;
    push({ state: "Listening", woke: { at, from: "clap" } });
    expect(ctl.getSnapshot().wokeAt).toBe(at);
    const seen: unknown[] = [];
    const off = ctl.subscribe(() => seen.push(ctl.getSnapshot().wokeAt));
    for (let i = 0; i < 5; i++) push({ micLevel: i / 10 }); // the 66 ms repeats carry the same woke
    expect(seen.every((w) => w === at)).toBe(true);
    push({ state: "Asleep" });
    expect(ctl.getSnapshot().wokeAt).toBeNull();
    push({ micLevel: 0.2 }); // still the old woke in the merged snapshot: it never plays again
    expect(ctl.getSnapshot().wokeAt).toBeNull();
    push({ state: "Listening", woke: { at: at + 5000, from: "phrase" } });
    expect(ctl.getSnapshot().wokeAt).toBe(at + 5000);
    off();
  });

  it("a woke stamped ahead of this clock (skew) plays from now, not frozen at its first frame until the clock catches up", () => {
    const { bridge, push } = fakeBridge(3);
    const { ctl } = setup();
    ctl.init(bridge);
    const before = Date.now();
    push({ state: "Listening", woke: { at: before + 8000, from: "clap" } });
    const wokeAt = ctl.getSnapshot().wokeAt!;
    expect(wokeAt).toBeGreaterThanOrEqual(before);
    expect(wokeAt).toBeLessThanOrEqual(Date.now());
    push({ micLevel: 0.1 }); // the repeat of the same stamp does not replay it
    expect(ctl.getSnapshot().wokeAt).toBe(wokeAt);
    push({ woke: { at: Date.now() + FRESH_UI_MS + 1, from: "phrase" } }); // too far ahead: stale
    expect(ctl.getSnapshot().wokeAt).toBe(wokeAt);
  });

  it("ignores a stale woke (older than 10 s), one in the first snapshot from before load, and junk", () => {
    const old = Date.now() - FRESH_UI_MS - 1;
    const { bridge, push } = fakeBridge(3, { snap: { state: "Listening", woke: { at: old, from: "clap" } } });
    const { ctl } = setup();
    ctl.init(bridge);
    expect(ctl.getSnapshot().wokeAt).toBeNull();
    push({ woke: { at: Date.now() - FRESH_UI_MS - 1, from: "phrase" } });
    push({ woke: { at: Date.now(), from: "web" } as never });
    push({ woke: { at: "now", from: "clap" } as never });
    push({ woke: null as never });
    expect(ctl.getSnapshot().wokeAt).toBeNull();
  });

  it("a wake from the web (tap) sets nothing: only the desktop's clap or phrase does", () => {
    const { bridge, calls } = fakeBridge(3);
    const { ctl } = setup();
    ctl.init(bridge);
    ctl.wake();
    expect(calls).toContain("wake");
    expect(ctl.getSnapshot().wokeAt).toBeNull();
  });
});

describe("Hydra Desktop bridge: done, echoes, stamps, approvals", () => {
  it("v3: reply and heard clear on done and stay cleared while the snapshot repeats them; the thread reloads once", async () => {
    const state = { threads: [{ id: THREAD, surface: "desktop", messages: [{ id: "m1", role: "user", text: "how much on food" }, { id: "m2", role: "assistant", text: "You spent $212." }] }] };
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(state));
    const { bridge, push } = fakeBridge(3);
    const { ctl } = setup({ fetch: fetchFn });
    ctl.init(bridge);
    push({ state: "Listening", heard: { text: "how much on food", final: true } });
    push({ state: "Thinking" });
    push({ state: "Speaking", reply: { id: "r1", text: "You spent $212.", final: true } });
    expect(ctl.getSnapshot()).toMatchObject({ heard: "how much on food", reply: "You spent $212." });
    fetchFn.mockClear();
    push({ state: "Listening" }); // done: the reply was final and the Mac went back to listening
    expect(ctl.getSnapshot()).toMatchObject({ heard: "", reply: "" });
    push({ micLevel: 0.2 });
    push({ micLevel: 0.3 });
    expect(ctl.getSnapshot()).toMatchObject({ heard: "", reply: "" });
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.map((m) => m.text)).toEqual(["how much on food", "You spent $212."]));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The next turn: new words show at once (the Mac cleared its reply).
    push({ heard: { text: "and on rent", final: false }, reply: null });
    expect(ctl.getSnapshot()).toMatchObject({ heard: "and on rent", reply: "" });
    push({ state: "Asleep" });
    expect(ctl.getSnapshot().heard).toBe("");
  });

  it("v2/v3: a flag this window set wins over pushes that still carry the old value, until the desktop echoes it", () => {
    const fake = fakeBridge(3, { snap: { muted: false } });
    const echo = fake.bridge.detach!;
    let later = () => {};
    Object.defineProperty(fake.bridge, "detach", { value: () => (later = echo) });
    Object.defineProperty(fake.bridge, "setMuted", { value: () => {} });
    const { ctl } = setup();
    ctl.init(fake.bridge);
    ctl.detach();
    ctl.toggleMute();
    fake.push({ micLevel: 0.4 }); // 15 Hz levels with the old merged flags
    fake.push({ micLevel: 0.5 });
    expect(ctl.getSnapshot()).toMatchObject({ detached: true, muted: true });
    later(); // the desktop catches up
    expect(ctl.getSnapshot().detached).toBe(true);
    fake.push({ detached: false }); // then the menu bar attaches it: the desktop wins again
    expect(ctl.getSnapshot().detached).toBe(false);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2500); // the mute echo never came: after HOLD_MS the desktop wins
    fake.push({ micLevel: 0.1 });
    expect(ctl.getSnapshot().muted).toBe(false);
    vi.restoreAllMocks();
  });

  it("v3: a ui step stamped just before load runs; an old stamp does not; the same stamp in a new object runs once", () => {
    const fresh = fakeBridge(3, { snap: { ui: { kind: "navigate", href: "/money", at: Date.now() - 500 } } });
    const a = setup();
    a.ctl.init(fresh.bridge);
    expect(a.runUi).toHaveBeenCalledTimes(1);
    expect(a.runUi).toHaveBeenCalledWith({ kind: "navigate", href: "/money" });

    const old = fakeBridge(3, { snap: { ui: { kind: "navigate", href: "/money", at: Date.now() - 60_000 } } });
    const b = setup();
    b.ctl.init(old.bridge);
    expect(b.runUi).not.toHaveBeenCalled();
    old.push({ ui: { kind: "setScope", scope: "ugc", at: 77 } });
    old.push({ ui: { kind: "setScope", scope: "ugc", at: 77 } }); // re-created object, same step
    expect(b.runUi).toHaveBeenCalledTimes(1);
  });

  it("v3: while the Mac thinks, the window polls for approvals and opens the panel on a new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let pending: unknown[] = [];
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ threads: [], pendingApprovals: pending, activity: [] }));
    const { bridge, push } = fakeBridge(3);
    const { ctl } = setup({ fetch: fetchFn });
    ctl.init(bridge);
    push({ state: "Thinking" });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchFn).toHaveBeenCalledWith("/api/agent/state");
    expect(ctl.getSnapshot().expanded).toBe(false);
    pending = [{ id: "ap1", source: "relay", summary: "Send the email to Sam?" }];
    await vi.advanceTimersByTimeAsync(4000);
    expect(ctl.getSnapshot()).toMatchObject({ expanded: true, approvals: [{ id: "ap1", prompt: "Send the email to Sam?" }] });
    push({ state: "Listening" });
    const n = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchFn.mock.calls.length).toBe(n);
  });
});

describe("Mac brain errors", () => {
  it("a turn that ends with mac_offline marks the card offline; the next turn clears it", async () => {
    const offline = [{ type: "thread", threadId: THREAD }, { type: "error", message: "Your Mac is offline.", code: "mac_offline" }];
    const fetchFn = vi.fn<typeof fetch>(async () => stream(offline));
    const { ctl } = setup({ fetch: fetchFn });
    ctl.init(undefined);
    ctl.submit("hello");
    await vi.waitFor(() => expect(ctl.getSnapshot().macIssue).toBe("offline"));
    expect(ctl.getSnapshot().error).toBe("Your Mac is offline.");
    expect(ctl.getSnapshot().thread.filter((m) => m.role === "hydra")).toHaveLength(0);
    fetchFn.mockImplementation(async () => stream([...text("Hi."), { type: "done" }]));
    ctl.submit("again");
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Hi."));
    expect(ctl.getSnapshot().macIssue).toBeNull();
  });

  it.each([
    ["mac_timeout", "timeout"],
    ["mac_bad_event", "bad_event"],
    ["agent_not_configured", null],
  ])("%s -> %s", async (code, issue) => {
    const { ctl } = setup({ fetch: vi.fn(async () => stream([{ type: "thread", threadId: THREAD }, { type: "error", message: "It stopped.", code }])) });
    ctl.init(undefined);
    ctl.submit("hello");
    await vi.waitFor(() => expect(ctl.getSnapshot().error).toBe("It stopped."));
    expect(ctl.getSnapshot().macIssue).toBe(issue);
  });

  it("a relay confirm is answered in its card, not twice in the approvals list", async () => {
    const turn = held([{ type: "thread", threadId: THREAD }, { type: "confirm", id: "ap9", summary: "Send it?", danger: true }]);
    const fetchFn = vi.fn<typeof fetch>(async (url) =>
      String(url) === "/api/agent/turn" ? turn.res : Response.json({ threads: [], pendingApprovals: [{ id: "ap9", source: "relay", summary: "Send it?" }], activity: [] }),
    );
    const { ctl } = setup({ fetch: fetchFn });
    ctl.init(undefined);
    ctl.submit("email Sam");
    await vi.waitFor(() => expect(ctl.getSnapshot().confirm?.id).toBe("ap9"));
    await ctl.refresh();
    expect(ctl.getSnapshot().approvals).toEqual([]);
    turn.release([{ type: "done" }]);
  });
});

/* ---- voice: barge-in, fillers, reply parts (owner: "if I interupt it's response it should also stop speaking") ---- */

/** A turn stream the test feeds event by event. */
function live() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return {
    res: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    push: (...evs: Ev[]) => evs.forEach((e) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))),
    end: () => ctrl.close(),
  };
}
const routed = (turn: () => Response) =>
  vi.fn<typeof fetch>(async (u) => (String(u) === "/api/agent/turn" ? turn() : Response.json({ threads: [], pendingApprovals: [], activity: [] })));
const turnBodies = (f: { mock: { calls: Parameters<typeof fetch>[] } }) => f.mock.calls.filter((c) => c[0] === "/api/agent/turn").map(bodyOf);
type SayMock = { mock: { calls: unknown[][] } };
const optsOf = (c: unknown[]) => c[1] as { filler?: boolean } | undefined;
const spokenOf = (say: SayMock) => say.mock.calls.filter((c) => !optsOf(c)?.filler).map((c) => c[0]);
const fillersOf = (say: SayMock) => say.mock.calls.filter((c) => optsOf(c)?.filler).map((c) => c[0]);
const fakeMic = (lvl: { v: number }) => async () => ({ meter: { read: () => lvl.v } as unknown as Meter, close: vi.fn() });

describe("voice", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  it("barge-in by voice energy: over the calibrated floor for 250 ms quiets Hydra on that frame; his words end the reply and the next turn says where it was cut off", async () => {
    const lvl = { v: 0.03 };
    const { ctl, speaker, busy, heard, fetchFn } = setup({ openMic: fakeMic(lvl) });
    speaker.played.mockReturnValue(["Your balance is forty dollars."]);
    ctl.tapOrb();
    await vi.advanceTimersByTimeAsync(0); // the mic opens
    busy(true); // Hydra speaks
    expect(ctl.getSnapshot().status).toBe("speaking");
    expect(heard[0].listener.stop).not.toHaveBeenCalled(); // the recognizer stays on for a barge-in
    await vi.advanceTimersByTimeAsync(VAD_TICK_MS * VAD_CALIBRATE_FRAMES); // the floor: room plus echo
    lvl.v = 0.08; // echo and room noise, under the bar
    await vi.advanceTimersByTimeAsync(2000);
    expect(speaker.stop).not.toHaveBeenCalled();
    lvl.v = 0.5; // the owner talks
    await vi.advanceTimersByTimeAsync(BARGE_MS - VAD_TICK_MS);
    expect(speaker.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * VAD_TICK_MS); // within one meter frame of the 250 ms mark
    expect(speaker.pause).toHaveBeenCalledTimes(1); // quiet at once; paused until his words come
    expect(ctl.getSnapshot().status).toBe("listening");
    heard[0].h.onFinal("what about savings");
    expect(speaker.stop).toHaveBeenCalled(); // his words: the rest of the reply is dropped
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)[0]).toMatchObject({ input: { audioTranscript: "what about savings" }, interruptedAfter: "Your balance is forty dollars." });
    await vi.advanceTimersByTimeAsync(1000);
    ctl.heard("and checking"); // used once
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)[1].interruptedAfter).toBeUndefined();
  });

  it("barge-in by words: two words that are not Hydra's own echo stop it; its own words leaking back do not", async () => {
    const fetchFn = routed(() => stream([...text("Your balance is forty dollars. "), { type: "done" }]));
    const { ctl, speaker, busy, heard } = setup({ fetch: fetchFn });
    ctl.tapOrb();
    ctl.heard("balance", true);
    await vi.advanceTimersByTimeAsync(STEP_GRACE_MS + 10);
    expect(spokenOf(speaker.say)).toEqual(["Your balance is forty dollars."]);
    busy(true);
    const rec = heard.at(-1)!;
    const stops = speaker.stop.mock.calls.length;
    rec.h.onInterim("balance is forty"); // its own voice
    rec.h.onInterim("hold"); // one word: not enough
    expect(speaker.stop).toHaveBeenCalledTimes(stops);
    rec.h.onInterim("hold on");
    expect(speaker.stop).toHaveBeenCalledTimes(stops + 1);
    expect(ctl.getSnapshot().status).toBe("listening");
    expect(ctl.getSnapshot().interim).toBe("hold on");
  });

  it("iOS: no barge-in by voice (the mic cannot stay open over audio); a tap interrupts and still sends interruptedAfter", async () => {
    const lvl = { v: 0.03 };
    const { ctl, speaker, busy, heard, fetchFn } = setup({ openMic: fakeMic(lvl), bargeIn: () => false });
    speaker.played.mockReturnValue(["Your rent is due Friday."]);
    ctl.tapOrb();
    await vi.advanceTimersByTimeAsync(0);
    busy(true);
    expect(heard[0].listener.stop).toHaveBeenCalled(); // never hears itself
    lvl.v = 0.9;
    await vi.advanceTimersByTimeAsync(2000);
    expect(speaker.stop).not.toHaveBeenCalled();
    ctl.tapOrb();
    expect(speaker.stop).toHaveBeenCalled();
    ctl.heard("which rent");
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)[0].interruptedAfter).toBe("Your rent is due Friday.");
  });

  it("a filler after 1.1 s with no answer, in the same voice, never stored, and never the same one twice in a row", async () => {
    let t = live();
    const fetchFn = routed(() => t.res);
    const { ctl, speaker } = setup({ fetch: fetchFn, random: () => 0 });
    ctl.tapOrb();
    ctl.heard("how much did I earn", true);
    await vi.advanceTimersByTimeAsync(FILLER_MS - 5);
    expect(fillersOf(speaker.say)).toEqual([]);
    expect(speaker.prefetch).toHaveBeenCalledWith(FILLERS[0]); // ready before it is needed
    await vi.advanceTimersByTimeAsync(10);
    expect(fillersOf(speaker.say)).toEqual([FILLERS[0]]);
    expect(ctl.getSnapshot().filler).toBe(FILLERS[0]);
    t.push(...text("You earned four thousand. "));
    await vi.advanceTimersByTimeAsync(STEP_GRACE_MS + 10);
    expect(ctl.getSnapshot().filler).toBeNull(); // the answer took over
    t.push({ type: "done" });
    t.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().thread.map((m) => m.text)).toEqual(["how much did I earn", "You earned four thousand."]);
    t = live();
    ctl.heard("and last month");
    await vi.advanceTimersByTimeAsync(FILLER_MS + 10);
    expect(fillersOf(speaker.say)).toEqual([FILLERS[0], FILLERS[1]]); // not the same line again
    t.end();
  });

  it("a tool start brings the filler at once; one per turn, a second only for a tool 6+ s later; none when muted or once the answer streams", async () => {
    const t = live();
    const { ctl, speaker } = setup({ fetch: routed(() => t.res) });
    ctl.tapOrb();
    ctl.heard("what did I spend on food");
    await vi.advanceTimersByTimeAsync(0);
    t.push({ type: "tool", name: "list_transactions", status: "start", summary: "List transactions" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fillersOf(speaker.say)).toHaveLength(1);
    t.push({ type: "tool", name: "list_transactions", status: "done", summary: "12 rows" }, { type: "tool", name: "report", status: "start", summary: "Report" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fillersOf(speaker.say)).toHaveLength(1); // the wait timer does not add one either
    await vi.advanceTimersByTimeAsync(SECOND_FILLER_MS);
    t.push({ type: "tool", name: "report", status: "done", summary: "" }, { type: "tool", name: "budget", status: "start", summary: "Budget" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fillersOf(speaker.say)).toHaveLength(2);
    const [a, b] = fillersOf(speaker.say);
    expect(a).not.toBe(b);
    await vi.advanceTimersByTimeAsync(SECOND_FILLER_MS * 2);
    t.push({ type: "tool", name: "budget", status: "done", summary: "" }, { type: "tool", name: "x", status: "start", summary: "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fillersOf(speaker.say)).toHaveLength(2); // two at most
    t.push({ type: "done" });
    t.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().thread.at(-1)!.parts!.every((p) => !(FILLERS as readonly string[]).includes(p.text))).toBe(true);

    // Muted: none. The answer already streaming: none.
    const m = setup({ fetch: routed(() => stream([{ type: "tool", name: "a", status: "start", summary: "" }])) });
    m.ctl.tapOrb();
    m.ctl.toggleMute();
    m.ctl.heard("hi");
    await vi.advanceTimersByTimeAsync(FILLER_MS * 2);
    expect(m.speaker.say).not.toHaveBeenCalled();
    const s = live();
    const n = setup({ fetch: routed(() => s.res) });
    n.ctl.tapOrb();
    n.ctl.heard("hi");
    await vi.advanceTimersByTimeAsync(0);
    s.push(...text("Hello there. "));
    await vi.advanceTimersByTimeAsync(FILLER_MS * 2);
    expect(fillersOf(n.speaker.say)).toEqual([]);
    s.end();
  });

  it("owner screenshots: emote tags go, narration before a tool is a step (not spoken), only the answer is text; phase follows", async () => {
    const t = live();
    const { ctl, speaker, busy } = setup({ fetch: routed(() => t.res) });
    ctl.tapOrb();
    ctl.heard("what did I earn this month", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().phase).toBe("thinking");
    t.push(...text("[wave] I need dates; ", "today 2026-11-22."), { type: "tool", name: "income_report", status: "start", summary: "Income report" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().phase).toBe("checking");
    t.push({ type: "tool", name: "income_report", status: "done", summary: "November income" }, ...text("You've earned $3,525 [nod] this month. ", "Nice work [smile]."));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().phase).toBe("thinking");
    await vi.advanceTimersByTimeAsync(STEP_GRACE_MS + 10);
    busy(true);
    expect(ctl.getSnapshot().phase).toBe("speaking");
    t.push({ type: "done" });
    t.end();
    await vi.advanceTimersByTimeAsync(0);
    const reply = ctl.getSnapshot().thread.at(-1)!;
    expect(reply.parts).toEqual([
      { kind: "step", text: "I need dates; today 2026-11-22." },
      { kind: "step", text: "November income", tool: "income_report", status: "done" },
      { kind: "text", text: "You've earned $3,525 this month. Nice work." },
    ]);
    expect(reply.text).toBe("You've earned $3,525 this month. Nice work.");
    expect(spokenOf(speaker.say)).toEqual(["You've earned $3,525 this month.", "Nice work."]);
    busy(false);
    expect(ctl.getSnapshot().phase).toBe("idle");
  });

  it("a stored reply loads without its emote tags", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({ threads: [{ id: THREAD, surface: "web", messages: [{ id: "m1", role: "assistant", text: "[wave] Goodnight, sir." }] }], pendingApprovals: [], activity: [] }),
    );
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    expect(ctl.getSnapshot().thread.map((m) => m.text)).toEqual(["Goodnight, sir."]);
  });

  it("wakePhrase: a desktop that only listens for Hey Hydra says so; older desktops never send it", () => {
    const a = setup();
    a.ctl.init(fakeBridge(3, { snap: { state: "Listening", wake: "phrase" } }).bridge);
    expect(a.ctl.getSnapshot().wakePhrase).toBe(true);
    const b = setup();
    b.ctl.init(fakeBridge(2, { snap: { state: "Listening" } }).bridge);
    expect(b.ctl.getSnapshot().wakePhrase).toBe(false);
  });
});

/* ---- review fixes (owner: "if I interupt it's response it should also stop speaking and act accordingly, like I was talking to a person") ---- */
describe("voice: review fixes", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  it("F1: the recognizer's late final of Hydra's own last words, just after it stopped, is echo, not a new turn", async () => {
    const fetchFn = routed(() => stream([...text("Your balance is four hundred dollars."), { type: "done" }]));
    const { ctl, busy, heard } = setup({ fetch: fetchFn });
    ctl.tapOrb();
    ctl.heard("balance", true);
    await vi.advanceTimersByTimeAsync(10);
    busy(true);
    const rec = heard.at(-1)!;
    busy(false); // Hydra stops: listening, the same recognizer still on
    expect(ctl.getSnapshot().status).toBe("listening");
    rec.h.onFinal("four hundred dollars");
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)).toHaveLength(1);
    rec.h.onFinal("and my savings"); // his words, inside the tail: a turn
    await vi.advanceTimersByTimeAsync(10);
    expect(turnBodies(fetchFn)).toHaveLength(2);
    busy(true);
    busy(false);
    await vi.advanceTimersByTimeAsync(ECHO_TAIL_MS + 10);
    heard.at(-1)!.h.onFinal("four hundred dollars"); // long after: he said it
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)).toHaveLength(3);
  });

  it("F2: an answer already said aloud, then a tool, stays the answer; its last sentence is said and no filler follows", async () => {
    const t = live();
    const { ctl, speaker } = setup({ fetch: routed(() => t.res) });
    ctl.tapOrb();
    ctl.heard("how much", true);
    await vi.advanceTimersByTimeAsync(0);
    t.push(...text("You've earned $3,525 this month. I'll add a reminder too."));
    await vi.advanceTimersByTimeAsync(STEP_GRACE_MS + 10);
    t.push({ type: "tool", name: "create_task", status: "start", summary: "Create a task" }, { type: "tool", name: "create_task", status: "done", summary: "Created" }, { type: "done" });
    t.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(speaker.say.mock.calls.map((c) => c[0])).toEqual(["You've earned $3,525 this month.", "I'll add a reminder too."]);
    const reply = ctl.getSnapshot().thread.at(-1)!;
    expect(reply.parts).toEqual([
      { kind: "text", text: "You've earned $3,525 this month. I'll add a reminder too." },
      { kind: "step", text: "Created", tool: "create_task", status: "done" },
    ]);
    expect(reply.text).toBe("You've earned $3,525 this month. I'll add a reminder too.");
  });

  it("F3: a confirm lead-in never repeats what was said, and never reaches back past a tool to older narration", async () => {
    const a = live();
    const A = setup({ fetch: routed(() => a.res) });
    A.ctl.tapOrb();
    A.ctl.heard("delete netflix");
    await vi.advanceTimersByTimeAsync(0);
    a.push(...text("Okay. I'll delete the Netflix charge."));
    await vi.advanceTimersByTimeAsync(STEP_GRACE_MS + 10); // "Okay." is said
    a.push({ type: "tool", name: "delete_transaction", status: "start", summary: "Delete a transaction" }, { type: "confirm", id: "a1", summary: "Delete Netflix?", danger: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(spokenOf(A.speaker.say)).toEqual(["Okay.", "I'll delete the Netflix charge."]);

    const b = live();
    const B = setup({ fetch: routed(() => b.res) });
    B.ctl.tapOrb();
    B.ctl.heard("delete netflix");
    await vi.advanceTimersByTimeAsync(0);
    b.push(...text("I need dates; today 2026-11-22."), { type: "tool", name: "list_transactions", status: "start", summary: "Transactions" });
    await vi.advanceTimersByTimeAsync(0);
    b.push(
      { type: "tool", name: "list_transactions", status: "done", summary: "Transactions" },
      { type: "tool", name: "delete_transaction", status: "start", summary: "Delete a transaction" },
      { type: "confirm", id: "a1", summary: "Delete Netflix?", danger: true },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(spokenOf(B.speaker.say).join(" ")).not.toContain("2026-11-22");
    const reply = B.ctl.getSnapshot().thread.at(-1)!;
    expect(reply.parts?.[0]).toEqual({ kind: "step", text: "I need dates; today 2026-11-22." });
    expect(reply.text).toBe("");

    // The narration right before the gated tool is its lead-in: said once, as text.
    const c = live();
    const C = setup({ fetch: routed(() => c.res) });
    C.ctl.tapOrb();
    C.ctl.heard("delete netflix");
    await vi.advanceTimersByTimeAsync(0);
    c.push(...text("Want me to delete Netflix?"), { type: "tool", name: "delete_transaction", status: "start", summary: "Delete" }, { type: "confirm", id: "c1", summary: "Delete Netflix?", danger: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(spokenOf(C.speaker.say)).toEqual(["Want me to delete Netflix?"]);
    expect(C.ctl.getSnapshot().thread.at(-1)!.text).toBe("Want me to delete Netflix?");
  });

  it("F6: the barge-in floor is measured on Hydra's real audio, not the silence while the first sentence downloads", async () => {
    const lvl = { v: 0.02 };
    const audible = { v: false };
    const { ctl, speaker, busy } = setup({ openMic: fakeMic(lvl) });
    Object.assign(speaker, { audible: () => audible.v });
    ctl.tapOrb();
    await vi.advanceTimersByTimeAsync(0);
    busy(true); // busy, but the Fish blob is still downloading: room silence
    await vi.advanceTimersByTimeAsync(VAD_TICK_MS * VAD_CALIBRATE_FRAMES * 3);
    audible.v = true;
    lvl.v = 0.12; // Hydra's echo after cancellation, once sound plays
    await vi.advanceTimersByTimeAsync(VAD_TICK_MS * (VAD_CALIBRATE_FRAMES + 1));
    lvl.v = 0.2; // a louder syllable of its own echo: over 0.15, under three times the echo floor
    await vi.advanceTimersByTimeAsync(BARGE_MS * 3);
    expect(speaker.pause).not.toHaveBeenCalled();
    expect(ctl.getSnapshot().status).toBe("speaking");
  });

  it("F8: a quick answer comes without a filler; only a long wait (or a tool) brings one", async () => {
    const t = live();
    const { ctl, speaker } = setup({ fetch: routed(() => t.res) });
    ctl.tapOrb();
    ctl.heard("what time is it", true);
    await vi.advanceTimersByTimeAsync(2000); // adaptive thinking: the first word after two seconds
    expect(fillersOf(speaker.say)).toEqual([]);
    t.push(...text("It's 3 PM."), { type: "done" });
    t.end();
    await vi.advanceTimersByTimeAsync(FILLER_MS);
    expect(fillersOf(speaker.say)).toEqual([]);
    expect(spokenOf(speaker.say)).toEqual(["It's 3 PM."]);
  });

  it("F11: a cough over Hydra (energy, no words) pauses it; with no words in 1.5 s it carries on where it stopped", async () => {
    const lvl = { v: 0.03 };
    const { ctl, speaker, busy, heard, fetchFn } = setup({ openMic: fakeMic(lvl) });
    speaker.played.mockReturnValue(["Your balance is forty dollars."]);
    ctl.tapOrb();
    await vi.advanceTimersByTimeAsync(0);
    busy(true);
    Object.assign(speaker, { busy: true });
    await vi.advanceTimersByTimeAsync(VAD_TICK_MS * VAD_CALIBRATE_FRAMES);
    lvl.v = 0.6; // a cough
    await vi.advanceTimersByTimeAsync(BARGE_MS + VAD_TICK_MS);
    lvl.v = 0.03;
    expect(speaker.pause).toHaveBeenCalledTimes(1);
    expect(ctl.getSnapshot().status).toBe("listening");
    await vi.advanceTimersByTimeAsync(BARGE_RESUME_MS);
    expect(speaker.resume).toHaveBeenCalledTimes(1);
    expect(speaker.stop).not.toHaveBeenCalled();
    expect(ctl.getSnapshot().status).toBe("speaking");
    busy(false);
    await vi.advanceTimersByTimeAsync(ECHO_TAIL_MS);
    heard.at(-1)!.h.onFinal("thanks");
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)[0].interruptedAfter).toBeUndefined(); // it was not cut off
  });
});

describe("0191: words while it thinks are added to the turn, never a new one", () => {
  const TURN_ID = "00000000-0000-4000-8000-0000000000f1";
  const urls = (f: ReturnType<typeof vi.fn<typeof fetch>>) => f.mock.calls.map((c) => String(c[0]));

  /** A turn that stays open (thinking) with its thread and turn events sent; append answers `appendStatus`. */
  function thinking(appendStatus = 202, firstEvents: Ev[] = [{ type: "thread", threadId: THREAD }, { type: "turn", turnId: TURN_ID }]) {
    const turn = held(firstEvents);
    let turns = 0;
    const fetchFn = vi.fn<typeof fetch>(async (url): Promise<Response> => {
      if (String(url) === "/api/agent/turn/append") return Response.json(appendStatus === 202 ? { ok: true, seq: 1 } : { error: "turn_over" }, { status: appendStatus });
      if (String(url) === "/api/agent/turn") return ++turns === 1 ? turn.res : stream([...text("New."), { type: "done" }]);
      return Response.json({});
    });
    const d = setup({ fetch: fetchFn });
    d.ctl.tapOrb();
    d.heard.at(-1)!.h.onFinal("what is overdue");
    return { ...d, fetchFn, turn };
  }

  it("speech while thinking goes to /api/agent/turn/append with the turn id and shows as an added line above the reply", async () => {
    const { ctl, fetchFn, heard, turn } = thinking();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getSnapshot().status).toBe("thinking");
    // Still listening while it thinks.
    expect(heard.at(-1)!.listener.stop).not.toHaveBeenCalled();
    heard.at(-1)!.h.onFinal("Hey Hydra, and only this week");
    await vi.advanceTimersByTimeAsync(0);
    const append = fetchFn.mock.calls.find((c) => String(c[0]) === "/api/agent/turn/append");
    expect(bodyOf(append)).toEqual({ turnId: TURN_ID, text: "and only this week" }); // the wake phrase is not part of it
    expect(urls(fetchFn).filter((u) => u === "/api/agent/turn")).toHaveLength(1); // no new turn, nothing cancelled
    const thread = ctl.getSnapshot().thread;
    expect(thread.map((m) => [m.role, m.text, !!m.added])).toEqual([
      ["user", "what is overdue", false],
      ["user", "and only this week", true],
      ["hydra", "", false],
    ]);
    turn.release([...text("Two this week."), { type: "done" }]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)?.text).toBe("Two this week."));
    expect(ctl.getSnapshot().thread.filter((m) => m.added)).toHaveLength(1);
  });

  it("talking over a filler while it works stops only the filler: the words are added and the answer is still said", async () => {
    const { ctl, fetchFn, heard, speaker, busy, turn } = thinking();
    await vi.advanceTimersByTimeAsync(FILLER_MS);
    expect(FILLERS).toContain(speaker.say.mock.calls[0][0]);
    busy(true);
    expect(ctl.getSnapshot().status).toBe("speaking");
    heard.at(-1)!.h.onFinal("and last week too");
    await vi.advanceTimersByTimeAsync(0);
    expect(speaker.stop).toHaveBeenCalled();
    expect(bodyOf(fetchFn.mock.calls.find((c) => String(c[0]) === "/api/agent/turn/append"))).toEqual({ turnId: TURN_ID, text: "and last week too" });
    expect(urls(fetchFn).filter((u) => u === "/api/agent/turn")).toHaveLength(1);
    busy(false);
    turn.release([...text("Both weeks: $5,100. "), { type: "done" }]);
    await vi.waitFor(() => expect(speaker.say).toHaveBeenCalledWith("Both weeks: $5,100."));
  });

  it("typing while thinking is added too", async () => {
    const { ctl, fetchFn } = thinking();
    await vi.advanceTimersByTimeAsync(0);
    ctl.heard("and the gas ones");
    await vi.advanceTimersByTimeAsync(0);
    expect(bodyOf(fetchFn.mock.calls.find((c) => String(c[0]) === "/api/agent/turn/append"))).toEqual({ turnId: TURN_ID, text: "and the gas ones" });
  });

  it("words that come before the turn id are held, then sent once it arrives", async () => {
    const { ctl, fetchFn, turn } = thinking(202, [{ type: "thread", threadId: THREAD }]);
    await vi.advanceTimersByTimeAsync(0);
    ctl.heard("and gas");
    await vi.advanceTimersByTimeAsync(0);
    expect(urls(fetchFn)).not.toContain("/api/agent/turn/append");
    turn.release([{ type: "turn", turnId: TURN_ID }, ...text("Ok."), { type: "done" }]);
    await vi.waitFor(() => expect(urls(fetchFn)).toContain("/api/agent/turn/append"));
    expect(bodyOf(fetchFn.mock.calls.find((c) => String(c[0]) === "/api/agent/turn/append"))).toEqual({ turnId: TURN_ID, text: "and gas" });
  });

  it("409 (the turn ended first): the words start the next turn once its stream ends, and the added line goes", async () => {
    const { ctl, fetchFn, turn } = thinking(409);
    await vi.advanceTimersByTimeAsync(0);
    ctl.heard("and gas");
    await vi.advanceTimersByTimeAsync(0);
    // The turn's tail (the Mac closed it, the browser has not read the last text yet) is not cut off.
    const signal = fetchFn.mock.calls.find((c) => String(c[0]) === "/api/agent/turn")![1]!.signal!;
    expect(signal.aborted).toBe(false);
    expect(urls(fetchFn).filter((u) => u === "/api/agent/turn")).toHaveLength(1);
    turn.release([...text("Rent is due."), { type: "done" }]);
    await vi.waitFor(() => expect(urls(fetchFn).filter((u) => u === "/api/agent/turn")).toHaveLength(2));
    const second = fetchFn.mock.calls.filter((c) => String(c[0]) === "/api/agent/turn")[1];
    expect(bodyOf(second).input).toEqual({ text: "and gas" });
    expect(ctl.getSnapshot().thread.some((m) => m.text === "Rent is due.")).toBe(true);
    expect(ctl.getSnapshot().thread.some((m) => m.added)).toBe(false);
  });

  it("two additions refused with 409 go as one next turn; neither cancels the other", async () => {
    const { ctl, fetchFn, turn } = thinking(409);
    await vi.advanceTimersByTimeAsync(0);
    ctl.heard("and gas");
    ctl.heard("and water");
    await vi.advanceTimersByTimeAsync(0);
    turn.release([...text("Rent is due."), { type: "done" }]);
    await vi.waitFor(() => expect(urls(fetchFn).filter((u) => u === "/api/agent/turn")).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(0);
    const turns = fetchFn.mock.calls.filter((c) => String(c[0]) === "/api/agent/turn");
    expect(turns).toHaveLength(2);
    expect(bodyOf(turns[1]).input).toEqual({ text: "and gas\nand water" });
  });

  it("talking over a filler sets no interruptedAfter for the next question (nothing was cut off)", async () => {
    const { ctl, fetchFn, heard, speaker, busy, turn } = thinking();
    await vi.advanceTimersByTimeAsync(FILLER_MS);
    const filler = speaker.say.mock.calls[0][0];
    expect(FILLERS).toContain(filler);
    speaker.played.mockReturnValue([filler]);
    busy(true);
    heard.at(-1)!.h.onFinal("and last week too");
    await vi.advanceTimersByTimeAsync(0);
    busy(false);
    speaker.played.mockReturnValue([]);
    turn.release([...text("Both weeks. "), { type: "done" }]);
    await vi.waitFor(() => expect(ctl.getSnapshot().status).not.toBe("thinking"));
    await vi.advanceTimersByTimeAsync(0);
    ctl.heard("what about savings");
    await vi.waitFor(() => expect(urls(fetchFn).filter((u) => u === "/api/agent/turn")).toHaveLength(2));
    const second = fetchFn.mock.calls.filter((c) => String(c[0]) === "/api/agent/turn")[1];
    expect(bodyOf(second).interruptedAfter).toBeUndefined();
  });

  it("the sleep word while thinking cancels the turn and sleeps", async () => {
    const { ctl, fetchFn, heard, blip } = thinking();
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchFn.mock.calls.find((c) => String(c[0]) === "/api/agent/turn")![1]!.signal!;
    heard.at(-1)!.h.onFinal("Hydra, sleep");
    expect(blip).toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(ctl.getSnapshot().status).toBe("asleep");
    expect(urls(fetchFn)).not.toContain("/api/agent/turn/append");
  });
});

describe("the shared settings in the orb menu (W6 contract)", () => {
  it("reads them from /api/agent/state; a change shows at once and is saved through PATCH; a refusal puts it back", async () => {
    vi.useRealTimers();
    let ok = true;
    const fetchFn = vi.fn<typeof fetch>(async (_u, init) => {
      if (init?.method === "PATCH") return ok ? Response.json({ ok: true }) : Response.json({ error: "invalid_input" }, { status: 400 });
      return Response.json({ threads: [], settings: { sleepWord: "Hydra, sleep", wakePhrase: "Okay Hydra", clapSensitivity: "high", model: "claude-sonnet-5-5", effortLive: "medium", effortRoutine: "medium", brain: "mac" } });
    });
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    // An older server sends no approveAll: it stays off.
    expect(ctl.getSnapshot().settings).toEqual({ wakePhrase: "Okay Hydra", clapSensitivity: "high", model: "claude-sonnet-5-5", effortLive: "medium", effortRoutine: "medium", approveAll: false });
    expect(await ctl.setSetting({ model: "claude-haiku-5-5", effortLive: "high" })).toBe(true);
    const patch = fetchFn.mock.calls.at(-1)!;
    expect(patch[1]!.method).toBe("PATCH");
    expect(bodyOf(patch)).toEqual({ model: "claude-haiku-5-5", effortLive: "high" });
    expect(ctl.getSnapshot().settings.model).toBe("claude-haiku-5-5");
    expect(await ctl.setSetting({ wakePhrase: "   " })).toBe(true); // empty goes back to the default
    expect(bodyOf(fetchFn.mock.calls.at(-1))).toEqual({ wakePhrase: "Hey Hydra" });
    ok = false;
    expect(await ctl.setSetting({ clapSensitivity: "low" })).toBe(false);
    expect(ctl.getSnapshot().settings.clapSensitivity).toBe("high");
  });

  it("models: /state's providers are read (Claude only from an older server); a model change clamps the efforts at once; a 409 says why", async () => {
    vi.useRealTimers();
    let providers: unknown = undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_u, init) => {
      if (init?.method === "PATCH")
        return JSON.parse(String(init.body)).model === "gpt-6.2-sol"
          ? Response.json({ error: "model_not_connected", message: "Sign in to ChatGPT in Hydra Desktop first." }, { status: 409 })
          : Response.json({ ok: true });
      return Response.json({ threads: [], settings: { model: "claude-opus-5-5", effortLive: "max", effortRoutine: "low" }, ...(providers ? { providers } : {}) });
    });
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    expect(ctl.getSnapshot().providers).toBeUndefined();
    providers = ["xai", "anthropic"];
    await ctl.refresh();
    expect(ctl.getSnapshot().providers).toEqual(["anthropic", "xai"]);
    expect(await ctl.setSetting({ model: "grok-4.7" })).toBe(true);
    expect(bodyOf(fetchFn.mock.calls.at(-1))).toEqual({ model: "grok-4.7" }); // the server clamps on its own
    expect(ctl.getSnapshot().settings).toMatchObject({ model: "grok-4.7", effortLive: "xhigh", effortRoutine: "low" });
    expect(await ctl.setSetting({ model: "gpt-6.2-sol" })).toBe(false);
    expect(ctl.getSnapshot().settings.model).toBe("grok-4.7");
    expect(ctl.getSnapshot().error).toBe("Sign in to ChatGPT in Hydra Desktop first.");
  });

  it("models: the model event puts who answered on the reply's hover, and why it fell back", async () => {
    vi.useRealTimers();
    const fetchFn = vi.fn<typeof fetch>(async (u) =>
      String(u) === "/api/agent/turn"
        ? stream([{ type: "thread", threadId: THREAD }, { type: "model", model: "claude-opus-5-5", effort: "high", fallback: "not_connected" }, ...text("Done."), { type: "done" }])
        : Response.json({ threads: [], settings: { model: "grok-4.7" } }),
    );
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    ctl.submit("hi", false);
    await vi.waitFor(() => expect(ctl.getSnapshot().thread.at(-1)).toMatchObject({ role: "hydra", text: "Done.", model: "Opus 5.5 · High. Grok 4.7 was not connected." }));
  });

  it("0200: approve all reads from /state, flips at once, saves through PATCH and goes back when refused", async () => {
    vi.useRealTimers();
    let ok = true;
    const fetchFn = vi.fn<typeof fetch>(async (_u, init) => {
      if (init?.method === "PATCH") return ok ? Response.json({ ok: true }) : Response.json({ error: "invalid_input" }, { status: 400 });
      return Response.json({ threads: [], settings: { approveAll: true } });
    });
    const { ctl } = setup({ fetch: fetchFn });
    await ctl.refresh();
    expect(ctl.getSnapshot().settings.approveAll).toBe(true);
    let saved: Promise<boolean> = ctl.setSetting({ approveAll: false });
    expect(ctl.getSnapshot().settings.approveAll).toBe(false); // optimistic
    expect(await saved).toBe(true);
    expect(bodyOf(fetchFn.mock.calls.at(-1))).toEqual({ approveAll: false });
    ok = false;
    saved = ctl.setSetting({ approveAll: true });
    expect(ctl.getSnapshot().settings.approveAll).toBe(true);
    expect(await saved).toBe(false);
    expect(ctl.getSnapshot().settings.approveAll).toBe(false); // rolled back
  });

  it("Hydra Desktop's status word names the custom wake phrase", async () => {
    vi.useRealTimers();
    const { bridge } = fakeBridge(3, { snap: { state: "Listening", wake: "phrase" } as never });
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ threads: [], settings: { wakePhrase: "Okay Hydra" } }));
    const { ctl } = setup({ fetch: fetchFn });
    ctl.init(bridge);
    await ctl.refresh();
    const { statusWord } = await import("./thread/model");
    expect(statusWord(ctl.getSnapshot(), "Listening")).toBe("Say “Okay Hydra”");
  });

  it("0220: reads the avatars and the active one; the orb's switch saves through PATCH, drops old-voice fillers, rolls back when refused", async () => {
    vi.useRealTimers();
    const TONY = { id: "00000000-0000-4000-8000-00000000a7a1", name: "Tony", voiceId: "0123456789abcdef0123456789abcdef" };
    let ok = true;
    let active: typeof TONY | null = null;
    const fetchFn = vi.fn<typeof fetch>(async (_u, init) => {
      if (init?.method === "PATCH") return ok ? Response.json({ ok: true }) : Response.json({ error: "invalid_input" }, { status: 400 });
      return Response.json({ threads: [], settings: { activeAvatarId: active?.id ?? null }, activeAvatar: active, avatars: [{ id: TONY.id, name: "Tony" }, { id: 5 }] });
    });
    const forget = vi.fn();
    const { ctl, speaker } = setup({ fetch: fetchFn });
    Object.assign(speaker, { forget });
    await ctl.refresh();
    expect(ctl.getSnapshot()).toMatchObject({ avatars: [{ id: TONY.id, name: "Tony" }], activeAvatarId: null });
    expect(forget).not.toHaveBeenCalled(); // the first read sets the voice; nothing to drop

    active = TONY;
    const saved = ctl.setAvatar(TONY.id);
    expect(ctl.getSnapshot().activeAvatarId).toBe(TONY.id); // at once
    expect(await saved).toBe(true);
    expect(fetchFn.mock.calls.some(([u, i]) => u === "/api/agent/state" && i?.method === "PATCH" && JSON.parse(String(i.body)).activeAvatarId === TONY.id)).toBe(true);
    expect(forget).toHaveBeenCalled();

    // Another device switched it back: the next read drops the fillers said in Tony's voice.
    forget.mockClear();
    active = null;
    await ctl.refresh();
    expect(ctl.getSnapshot().activeAvatarId).toBeNull();
    expect(forget).toHaveBeenCalledTimes(1);

    ok = false;
    expect(await ctl.setAvatar(TONY.id)).toBe(false);
    expect(ctl.getSnapshot().activeAvatarId).toBeNull();
  });
});

describe("the orb's spectrum (W5 section 5)", () => {
  it("passes Hydra Desktop's 24 bands through, clamped, only while it speaks or listens", () => {
    const { bridge, push } = fakeBridge(3, { snap: { state: "Speaking" } });
    const { ctl } = setup();
    ctl.init(bridge);
    const out = new Float32Array(24);
    expect(ctl.bands(out)).toBe(false); // none sent yet
    push({ state: "Speaking", bands: Array.from({ length: 24 }, (_, i) => (i === 3 ? 2 : i === 4 ? -1 : 0.5)) } as never);
    expect(ctl.bands(out)).toBe(true);
    expect([out[3], out[4], out[5]]).toEqual([1, 0, 0.5]);
    push({ state: "Thinking", bands: new Array(24).fill(0.5) } as never);
    expect(ctl.bands(out)).toBe(false);
    push({ state: "Speaking", bands: [0.5, 0.5] } as never); // not 24: ignored
    expect(ctl.bands(out)).toBe(false);
  });

  it("on the web: the voice's bands while speaking, the mic's while listening", async () => {
    const micBands = vi.fn((o: Float32Array) => (o.fill(0.3), true));
    const meter = { read: () => 0.2, bands: micBands } as unknown as Meter;
    const speakerBands = vi.fn((o: Float32Array) => (o.fill(0.7), true));
    let busyCb: (b: boolean) => void = () => {};
    const { ctl } = setup({
      openMic: async () => ({ meter, close: vi.fn() }),
      speaker: { say: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), level: () => 0.5, busy: false, onBusy: (cb) => (busyCb = cb), bands: speakerBands },
    });
    const out = new Float32Array(24);
    expect(ctl.bands(out)).toBe(false); // asleep
    ctl.tapOrb();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.bands(out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.3);
    busyCb(true);
    expect(ctl.bands(out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.7);
  });
});

describe("mobile voice: listening that ends and recovers", () => {
  it("C5: with no barge-in (iOS) the meter mic never opens; elsewhere it does", async () => {
    for (const barge of [false, true]) {
      const openMic = vi.fn(async () => null);
      const { ctl } = setup({ openMic, bargeIn: () => barge });
      ctl.tapOrb();
      ctl.submit("typed", false);
      await vi.advanceTimersByTimeAsync(0);
      expect(openMic).toHaveBeenCalledTimes(barge ? 1 : 0);
      ctl.sleep();
    }
  });

  it("C3: after the recognizer fails (refused, or not hearing him), the next tap tries it again", () => {
    const { ctl, heard } = setup();
    ctl.tapOrb();
    heard[0].h.onFatal("not-allowed");
    expect(ctl.getSnapshot()).toMatchObject({ typedOnly: true, error: MIC_OFF, status: "listening" });
    ctl.tapOrb(); // still awake: the tap retries instead of only opening the thread
    expect(heard).toHaveLength(2);
    expect(heard[1].listener.start).toHaveBeenCalled();
    expect(ctl.getSnapshot()).toMatchObject({ typedOnly: false, error: null, expanded: false });
    heard[1].h.onFatal("no-result");
    expect(ctl.getSnapshot()).toMatchObject({ typedOnly: true, error: NOT_HEARING });
    ctl.sleep();
    ctl.tapOrb(); // asleep: a wake retries too
    expect(heard).toHaveLength(3);
    expect(ctl.getSnapshot().typedOnly).toBe(false);
  });

  it("owner report: a second tap while listening sends what it heard so far at once; nothing heard, it turns off and says so", async () => {
    const { ctl, heard, fetchFn } = setup();
    ctl.tapOrb();
    heard[0].h.onInterim("what is my balance"); // no final yet
    ctl.tapOrb();
    expect(heard[0].listener.stop).toHaveBeenCalled(); // its session ends: no late final repeats the words
    expect(ctl.getSnapshot().status).toBe("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(turnBodies(fetchFn)[0].input).toMatchObject({ audioTranscript: "what is my balance" });
    expect(heard).toHaveLength(2); // a new session listens while it thinks
    const quiet = setup();
    quiet.ctl.tapOrb();
    quiet.ctl.tapOrb(); // he only meant to turn it off: no error
    expect(quiet.ctl.getSnapshot()).toMatchObject({ status: "asleep", error: null });
    quiet.ctl.tapOrb();
    quiet.heard.at(-1)!.h.onSpeech?.(); // he spoke, the recognizer gave no words
    quiet.ctl.tapOrb();
    expect(quiet.ctl.getSnapshot()).toMatchObject({ status: "asleep", error: NOTHING_HEARD });
    expect(turnBodies(quiet.fetchFn)).toHaveLength(0);
    quiet.ctl.tapOrb();
    expect(quiet.ctl.getSnapshot()).toMatchObject({ status: "listening", error: null });
    quiet.ctl.tapOrb(); // a new wake: the old speech does not count
    expect(quiet.ctl.getSnapshot().error).toBeNull();
  });

  it("owner report (iOS): with only audiostart from the recognizer, a tap after CAUGHT_MS of capture says it missed him; a quick tap is silent", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1");
    const recs: { onaudiostart?: () => void }[] = [];
    vi.stubGlobal(
      "webkitSpeechRecognition",
      class {
        onaudiostart?: () => void;
        constructor() {
          recs.push(this);
        }
        start() {}
        stop() {}
        abort() {}
      },
    );
    try {
      const { ctl } = setup({ createListener });
      ctl.tapOrb();
      recs.at(-1)!.onaudiostart?.();
      await vi.advanceTimersByTimeAsync(CAUGHT_MS / 2);
      ctl.tapOrb(); // he only meant to turn it off
      expect(ctl.getSnapshot()).toMatchObject({ status: "asleep", error: null });
      ctl.tapOrb();
      recs.at(-1)!.onaudiostart?.(); // iOS: capture, no speechstart, no words
      await vi.advanceTimersByTimeAsync(CAUGHT_MS);
      ctl.tapOrb();
      expect(ctl.getSnapshot()).toMatchObject({ status: "asleep", error: NOTHING_HEARD });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("the recognizer expects words only while listening: a quiet stretch while Hydra thinks is not the iOS deaf state", () => {
    const { ctl, heard } = setup({ fetch: vi.fn<typeof fetch>(async () => held([]).res) });
    ctl.tapOrb();
    expect(heard[0].h.expecting?.()).toBe(true);
    ctl.heard("what is my balance");
    expect(ctl.getSnapshot().status).toBe("thinking");
    expect(heard.at(-1)!.h.expecting?.()).toBe(false);
  });

  it("the mic refused for good: after the same failure twice in a row a tap opens the typing sheet, not another retry", () => {
    const { ctl, heard } = setup();
    ctl.tapOrb();
    heard[0].h.onFatal("service-not-allowed");
    ctl.tapOrb(); // first failure: retry
    expect(heard).toHaveLength(2);
    heard[1].h.onFatal("service-not-allowed");
    ctl.tapOrb();
    expect(heard).toHaveLength(2);
    expect(ctl.getSnapshot()).toMatchObject({ typedOnly: true, expanded: true });
    ctl.setExpanded(false);
    ctl.sleep();
    ctl.tapOrb(); // a wake still tries the recognizer once, and opens the sheet beside it
    expect(heard).toHaveLength(3);
    expect(ctl.getSnapshot().expanded).toBe(true);
  });

  it("the tap primes the browser voice only when no recognizer will hold the mic (WebKit 218815)", () => {
    const on = setup();
    on.ctl.tapOrb();
    expect(on.speaker.unlock).toHaveBeenLastCalledWith(true);
    const off = setup({ supported: () => false });
    off.ctl.tapOrb();
    off.ctl.submit("typed", false);
    expect(off.speaker.unlock.mock.calls).toEqual([[false], [false]]);
  });
});
