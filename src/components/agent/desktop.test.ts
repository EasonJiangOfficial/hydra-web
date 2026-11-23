import { describe, expect, it } from "vitest";
import { desktopBridge, wokeOf } from "./desktop";
import { setupBridge } from "@/components/setup-mac/steps";

/** Hydra Desktop's object as its bridge script builds it (hydra.rs BRIDGE_JS; docs/BRIDGE.md), minus the transport. */
function native(version: 2 | 3) {
  let snap: Record<string, unknown> = { state: "Asleep", micLevel: 0, outputLevel: 0, detached: false, ui: null };
  const subs = new Set<(s: unknown) => void>();
  const calls: unknown[][] = [];
  const call = (...a: unknown[]) => calls.push(a);
  const obj: Record<string, unknown> = {
    version,
    get state() {
      return snap.state;
    },
    get detached() {
      return snap.detached;
    },
    get micLevel() {
      return snap.micLevel;
    },
    get outputLevel() {
      return snap.outputLevel;
    },
    snapshot: () => ({ ...snap }),
    subscribe(fn: (s: unknown) => void) {
      subs.add(fn);
      fn({ ...snap });
      return () => subs.delete(fn);
    },
    wake: () => call("wake"),
    sleep: () => call("sleep"),
    detach: () => call("detach"),
    attach: () => call("attach"),
  };
  if (version === 3)
    Object.assign(obj, {
      stop: () => call("stop"),
      pause: () => call("pause"),
      resume: () => call("resume"),
      setMuted: (m: boolean) => call("mute", m),
      setup: async () => ({ paired: true, claude: "signed_in", permissions: { mic: "granted", accessibility: "granted", screen: "granted" }, version: "0.3.0" }),
      pair: async (c: string) => (call("pair", c), { ok: true }),
      signInClaude: async () => ({ ok: true }),
      requestPermission: async () => "granted",
      unpair: async () => {},
    });
  const push = (m: Record<string, unknown>) => {
    snap = { ...snap, ...m };
    subs.forEach((fn) => fn({ ...snap }));
  };
  return { obj: Object.freeze(obj), push, calls };
}

describe("desktopBridge", () => {
  it("is undefined without a usable bridge", () => {
    expect(desktopBridge(undefined)).toBeUndefined();
    expect(desktopBridge("x")).toBeUndefined();
    expect(desktopBridge({ getState: () => "asleep" })).toBeUndefined();
    expect(desktopBridge(Object.freeze({ version: 1 }))).toBeUndefined();
  });

  it("version 2: state, levels, wake/sleep/detach/attach; no voice controls and no setup", () => {
    const { obj, push, calls } = native(2);
    const b = desktopBridge(obj)!;
    expect(b.version).toBe(2);
    expect(b.state).toBe("Asleep");
    const seen: string[] = [];
    const off = b.subscribe((s) => seen.push(s.state));
    push({ state: "Speaking", outputLevel: 0.7 });
    expect(b.outputLevel).toBe(0.7);
    expect(b.snapshot().state).toBe("Speaking");
    for (const k of ["stop", "pause", "resume", "setMuted", "setup", "pair", "signInClaude", "requestPermission", "unpair"] as const) expect(b[k]).toBeUndefined();
    expect(setupBridge(b)).toBeNull();
    b.wake();
    b.sleep();
    b.detach!();
    b.attach!();
    expect(calls).toEqual([["wake"], ["sleep"], ["detach"], ["attach"]]);
    off();
    push({ state: "Thinking" });
    expect(seen).toEqual(["Asleep", "Speaking"]);
  });

  it("version 3: forwards voice controls and the setup calls", async () => {
    const { obj, calls } = native(3);
    const b = desktopBridge(obj)!;
    b.setMuted!(true);
    b.stop!();
    b.pause!();
    b.resume!();
    expect(await b.pair!("C0DE")).toEqual({ ok: true });
    expect(calls).toEqual([["mute", true], ["stop"], ["pause"], ["resume"], ["pair", "C0DE"]]);
    const s = setupBridge(b)!;
    expect((await s.setup())?.paired).toBe(true);
    expect(await s.requestPermission("mic")).toBe("granted");
  });

  it("swallows a bridge that throws: reads fall back, sync calls no-op, async calls reject", async () => {
    const boom = () => {
      throw new Error("x");
    };
    const bad = {
      get state(): never {
        return boom();
      },
      get version(): never {
        return boom();
      },
      snapshot: boom,
      subscribe: boom,
      wake: boom,
      stop: boom,
      setup: boom,
      pair: async () => boom(),
    };
    const b = desktopBridge(bad)!;
    expect(b.state).toBeUndefined();
    expect(b.version).toBe(1);
    expect(b.snapshot()).toMatchObject({ state: undefined });
    expect(() => b.subscribe(() => {})()).not.toThrow();
    expect(() => b.wake()).not.toThrow();
    expect(() => b.sleep()).not.toThrow();
    expect(() => b.stop!()).not.toThrow();
    await expect(b.setup!()).rejects.toThrow("x");
    await expect(b.pair!("c")).rejects.toThrow("x");
  });

  it("drops pushes that are not objects", () => {
    let fn: (s: unknown) => void = () => {};
    const b = desktopBridge({ subscribe: (f: (s: unknown) => void) => ((fn = f), () => {}) })!;
    const seen: unknown[] = [];
    b.subscribe((s) => seen.push(s));
    fn(null);
    fn("Speaking");
    fn({ state: "Speaking" });
    expect(seen).toEqual([{ state: "Speaking" }]);
  });
});

describe("wokeOf (the snapshot's woke, newer desktops)", () => {
  it("takes {at, from: clap | phrase} and nothing else", () => {
    expect(wokeOf({ at: 1_700_000_000_000, from: "clap" })).toEqual({ at: 1_700_000_000_000, from: "clap" });
    expect(wokeOf({ at: 1, from: "phrase", extra: true })).toEqual({ at: 1, from: "phrase" });
    for (const bad of [undefined, null, 5, "clap", {}, { at: 0, from: "clap" }, { at: -1, from: "clap" }, { at: Number.NaN, from: "clap" }, { at: Infinity, from: "phrase" }, { at: "1", from: "clap" }, { at: 1, from: "web" }]) {
      expect(wokeOf(bad)).toBeNull();
    }
  });
});

describe("build 4: listen and a dragged detach", () => {
  it("passes listen through when the desktop has it, and the drag point to detach", () => {
    const calls: unknown[][] = [];
    const raw = { subscribe: () => () => {}, snapshot: () => ({ state: "Listening" }), detach: (...a: unknown[]) => calls.push(["detach", ...a]), listen: () => calls.push(["listen"]) };
    const b = desktopBridge(raw)!;
    b.listen?.();
    b.detach?.({ x: 10, y: 20, dragging: true });
    expect(calls).toEqual([["listen"], ["detach", { x: 10, y: 20, dragging: true }]]);
    expect(desktopBridge({ subscribe: () => () => {} })!.listen).toBeUndefined();
  });
});
