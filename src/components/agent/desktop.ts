import type { DesktopSnapshot, HydraDesktopBridge, Woke } from "./types";

const SYNC = ["detach", "attach", "listen", "stop", "pause", "resume", "setMuted"] as const;
const ASYNC = ["setup", "pair", "signInClaude", "requestPermission", "unpair"] as const;

/**
 * Hydra Desktop's `window.hydraDesktop` (Hydra Desktop docs/BRIDGE.md, versions 1, 2 and 3) as the one typed bridge
 * the controller and Set up this Mac use. The object is native code from another release train: every read and call
 * is guarded, so nothing here can throw into React. wake/sleep always exist (a no-op if missing); every other method
 * exists only when the desktop has it, so callers feature-detect (a v2 Mac has no stop/pause/mute/setup) and a call
 * that throws is a no-op (sync) or a rejection (async, which the caller already handles). Undefined when unusable.
 */
export function desktopBridge(raw: unknown): HydraDesktopBridge | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const get = (k: string): unknown => {
    try {
      return d[k];
    } catch {
      return undefined;
    }
  };
  if (typeof get("subscribe") !== "function") return undefined;
  const has = (k: string) => typeof get(k) === "function";
  const run = (k: string, ...args: unknown[]): unknown => (get(k) as (...a: unknown[]) => unknown).apply(d, args);
  const safe =
    (k: string) =>
    (...args: unknown[]) => {
      try {
        run(k, ...args);
      } catch {
        // A failed native call never breaks the page.
      }
    };
  /** The getters, for a desktop with no snapshot() (or one that throws). */
  const fromGetters = (): DesktopSnapshot => ({ state: get("state"), micLevel: get("micLevel"), outputLevel: get("outputLevel"), detached: get("detached") }) as DesktopSnapshot;
  const asSnap = (s: unknown): DesktopSnapshot | null => (s && typeof s === "object" ? (s as DesktopSnapshot) : null);

  const b: Record<string, unknown> = {
    get version() {
      const v = get("version");
      return typeof v === "number" ? v : 1;
    },
    get state() {
      return get("state");
    },
    get micLevel() {
      return get("micLevel");
    },
    get outputLevel() {
      return get("outputLevel");
    },
    get detached() {
      return get("detached") === true;
    },
    snapshot: (): DesktopSnapshot => {
      try {
        if (has("snapshot")) return asSnap(run("snapshot")) ?? fromGetters();
      } catch {}
      return fromGetters();
    },
    subscribe: (fn: (s: DesktopSnapshot) => void): (() => void) => {
      try {
        const off = run("subscribe", (s: unknown) => {
          const snap = asSnap(s);
          if (snap) fn(snap);
        });
        return () => {
          try {
            if (typeof off === "function") off();
          } catch {}
        };
      } catch {
        return () => {};
      }
    },
    wake: safe("wake"),
    sleep: safe("sleep"),
  };
  for (const k of SYNC) if (has(k)) b[k] = safe(k);
  for (const k of ASYNC)
    if (has(k))
      b[k] = (...args: unknown[]) => {
        try {
          return Promise.resolve(run(k, ...args));
        } catch (e) {
          return Promise.reject(e);
        }
      };
  return b as HydraDesktopBridge;
}

/** A snapshot's `woke`, if it is one: {at: epoch ms > 0, from: "clap" | "phrase"}. Anything else is no wake. */
export function wokeOf(raw: unknown): Woke | null {
  if (!raw || typeof raw !== "object") return null;
  const { at, from } = raw as Record<string, unknown>;
  return typeof at === "number" && Number.isFinite(at) && at > 0 && (from === "clap" || from === "phrase") ? { at, from } : null;
}
