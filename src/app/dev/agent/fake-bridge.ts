/*
 * A stand-in for Hydra Desktop's `window.hydraDesktop` (fixture, unit tests and e2e). It copies the real bridge's
 * mechanics (HydraDesktop showcase/tauri/src-tauri/src/hydra.rs): a snapshot merged by each push, subscribers called at
 * once and on every push. `version` picks the shape: 1 (state, levels, wake, sleep), 2 (+ detach/attach),
 * 3 (+ voice controls, reply/heard/ui, setup); `listen` adds build 4's listen() and dragged detach. Every call is
 * recorded in `calls`.
 */
import type { BridgeResult, DesktopSetup, DesktopSnapshot, HydraDesktopBridge, Perm, PermKind } from "@/components/agent/types";

export type FakeOptions = {
  snap?: Partial<DesktopSnapshot>;
  setup?: Partial<Omit<DesktopSetup, "permissions">> & { permissions?: Partial<Record<PermKind, Perm>> };
  /** pair() never answers (the "Pairing" state). */
  hangPair?: boolean;
  /** pair() answers { ok: false }. */
  failPair?: boolean;
  /** Permissions the owner refuses at the prompt. */
  deny?: PermKind[];
  /** Delay of each setup action, in ms. */
  delayMs?: number;
  /** Build 4: listen() (an orb tap) and a dragged detach. */
  listen?: boolean;
};

export const SETUP_DONE: DesktopSetup = {
  paired: true,
  claude: "signed_in",
  permissions: { mic: "granted", accessibility: "granted", screen: "granted" },
  version: "0.3.0",
};

export function fakeBridge(version: 1 | 2 | 3, o: FakeOptions = {}) {
  let snap: DesktopSnapshot = { state: "Asleep", micLevel: 0, outputLevel: 0, ...(version >= 2 ? { detached: false } : {}), ...o.snap };
  const setup: DesktopSetup = { ...SETUP_DONE, ...o.setup, permissions: { ...SETUP_DONE.permissions, ...o.setup?.permissions } };
  const subs = new Set<(s: DesktopSnapshot) => void>();
  const calls: string[] = [];
  const wait = () => new Promise((r) => setTimeout(r, o.delayMs ?? 0));
  const push = (m: Partial<DesktopSnapshot>) => {
    snap = { ...snap, ...m };
    for (const fn of subs) fn({ ...snap });
  };

  const v1 = {
    version,
    get state() {
      return snap.state;
    },
    get micLevel() {
      return snap.micLevel;
    },
    get outputLevel() {
      return snap.outputLevel;
    },
    snapshot: () => ({ ...snap }),
    subscribe(fn: (s: DesktopSnapshot) => void) {
      subs.add(fn);
      fn({ ...snap });
      return () => void subs.delete(fn);
    },
    wake: () => void calls.push("wake"),
    sleep: () => void calls.push("sleep"),
  };
  const v2 = {
    get detached() {
      return snap.detached === true;
    },
    detach: (drag?: { x: number; y: number; dragging: true }) => (calls.push(drag?.dragging ? `detach:${drag.x},${drag.y}` : "detach"), push({ detached: true })),
    attach: () => (calls.push("attach"), push({ detached: false })),
  };
  const v3 = {
    stop: () => (calls.push("stop"), push({ state: "Listening", reply: null, paused: false, outputLevel: 0 })),
    pause: () => (calls.push("pause"), push({ paused: true })),
    resume: () => (calls.push("resume"), push({ paused: false })),
    setMuted: (muted: boolean) => (calls.push(`muted:${muted}`), push({ muted })),
    setup: async (): Promise<DesktopSetup> => (calls.push("setup"), { ...setup, permissions: { ...setup.permissions } }),
    pair: async (code: string): Promise<BridgeResult> => {
      calls.push(`pair:${code}`);
      if (o.hangPair) return new Promise(() => {});
      await wait();
      if (o.failPair) return { ok: false, error: "exchange_failed" };
      setup.paired = true;
      return { ok: true };
    },
    signInClaude: async (): Promise<BridgeResult> => {
      calls.push("signInClaude");
      await wait();
      setup.claude = "signed_in";
      return { ok: true };
    },
    requestPermission: async (kind: PermKind): Promise<Perm> => {
      calls.push(`permission:${kind}`);
      await wait();
      setup.permissions[kind] = o.deny?.includes(kind) ? "denied" : "granted";
      return setup.permissions[kind];
    },
    unpair: async () => {
      calls.push("unpair");
      setup.paired = false;
    },
  };
  // Getters must survive the merge, so the shapes are joined with their descriptors, not spread.
  const bridge = Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(v1),
      ...(version >= 2 ? Object.getOwnPropertyDescriptors(v2) : {}),
      ...(version >= 3 ? Object.getOwnPropertyDescriptors(v3) : {}),
      ...(o.listen ? Object.getOwnPropertyDescriptors({ listen: () => void calls.push("listen") }) : {}),
    },
  ) as HydraDesktopBridge;
  return { bridge, push, calls, setup };
}

export type FakeBridge = ReturnType<typeof fakeBridge>;

/** Fixture presets, picked with `/dev/agent?desktop=<name>`. */
export const PRESETS: Record<string, () => FakeBridge> = {
  v1: () => fakeBridge(1, { snap: { state: "Listening", micLevel: 0.3 } }),
  v2: () => fakeBridge(2, { snap: { state: "Asleep" } }),
  asleep: () => fakeBridge(3),
  speaking: () =>
    fakeBridge(3, {
      snap: {
        state: "Speaking",
        outputLevel: 0.6,
        heard: { text: "What did I spend on food this week?", final: true },
        reply: { id: "r1", text: "You spent $212 on food this week. That is $40 less than last week, mostly fewer takeout nights.", final: false },
      },
    }),
  detached: () => fakeBridge(3, { snap: { detached: true } }),
  build4: () => fakeBridge(3, { listen: true, snap: { state: "Listening" } }),
  "setup-pairing": () => fakeBridge(3, { hangPair: true, setup: { paired: false, claude: "signed_out", permissions: { mic: "not_determined", accessibility: "not_determined", screen: "not_determined" } } }),
  "setup-pair-failed": () => fakeBridge(3, { failPair: true, setup: { paired: false, claude: "signed_out", permissions: { mic: "not_determined", accessibility: "not_determined", screen: "not_determined" } } }),
  "setup-claude": () => fakeBridge(3, { delayMs: 300, setup: { claude: "signed_out", permissions: { mic: "not_determined", accessibility: "not_determined", screen: "not_determined" } } }),
  "setup-claude-wait": () => fakeBridge(3, { delayMs: 600_000, setup: { claude: "signed_out" } }),
  "setup-permissions": () => fakeBridge(3, { delayMs: 300, setup: { permissions: { accessibility: "not_determined", screen: "not_determined" } } }),
  "setup-denied": () => fakeBridge(3, { delayMs: 300, setup: { permissions: { screen: "denied" } } }),
};
