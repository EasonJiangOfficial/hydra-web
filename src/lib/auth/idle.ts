/**
 * Idle lock timer. Pure: the clock and the storage are injected, so tests drive it with fake timers.
 * Last activity and the lock flag live in localStorage, so a reload or a second tab cannot skip the
 * lock; tabs sync through `storage` events (call sync()).
 * Time is epoch milliseconds, so DST changes the wall clock but not the math. A sleeping machine
 * stops the interval; the first tick after wake sees the jump and locks.
 */
/** Storage keys under a prefix, so a fixture on the same origin cannot lock the real app. */
export function idleKeys(prefix = "hydra") {
  return { last: `${prefix}:last-activity`, locked: `${prefix}:locked` };
}
export const LAST_ACTIVITY_KEY = idleKeys().last;
export const LOCKED_KEY = idleKeys().locked;

export type IdleStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type IdleTimerOptions = {
  limitMs: number;
  store: IdleStore;
  onChange: (locked: boolean) => void;
  now?: () => number;
  tickMs?: number;
  prefix?: string;
};

/** Writes to storage at most this often while the user is active. */
const WRITE_EVERY_MS = 1000;

function read(store: IdleStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(store: IdleStore, key: string, value: string | null) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage blocked (private mode): the in-memory timer still locks this tab.
  }
}

/** Call after a fresh sign-in or unlock: clears the lock for every tab and restarts the clock. */
export function markUnlocked(store: IdleStore, at: number, prefix?: string) {
  const keys = idleKeys(prefix);
  write(store, keys.last, String(at));
  write(store, keys.locked, null);
}

/**
 * True when start() would lock: the flag is set or the limit has passed since the stored activity.
 * Also runs inline before first paint (serialized with toString), so it must stay self-contained.
 */
export function shouldStartLocked(lockedKey: string, lastKey: string, limitMs: number, now: number): boolean {
  try {
    const last = Number(localStorage.getItem(lastKey)) || 0;
    return localStorage.getItem(lockedKey) === "1" || (last > 0 && now - last >= limitMs);
  } catch {
    return false;
  }
}

export function createIdleTimer({ limitMs, store, onChange, now = Date.now, tickMs = 1000, prefix }: IdleTimerOptions) {
  const { last: LAST_ACTIVITY_KEY, locked: LOCKED_KEY } = idleKeys(prefix);
  let locked = false;
  let last = 0;
  let lastWrite = -Infinity;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stored = () => Number(read(store, LAST_ACTIVITY_KEY)) || 0;

  function setLocked(next: boolean) {
    locked = next;
    onChange(next);
  }

  function lock() {
    if (locked) return;
    write(store, LOCKED_KEY, "1");
    setLocked(true);
  }

  function tick() {
    if (locked) return;
    const t = now();
    last = Math.max(last, stored());
    if (t < last) {
      // The clock went backwards: re-anchor so the lock is not pushed into the future.
      last = t;
      write(store, LAST_ACTIVITY_KEY, String(t));
    }
    if (t - last >= limitMs) lock();
  }

  return {
    start() {
      last = stored();
      if (read(store, LOCKED_KEY) === "1" || (last > 0 && now() - last >= limitMs)) {
        lock();
      } else {
        if (!last) {
          last = now();
          write(store, LAST_ACTIVITY_KEY, String(last));
        }
        setLocked(false);
      }
      interval = setInterval(tick, tickMs);
    },
    stop() {
      clearInterval(interval);
    },
    /** Pointer, key, touch, scroll or focus. Ignored while locked: activity on the lock screen does not unlock. */
    activity() {
      if (locked) return;
      const t = now();
      // Activity after a sleep must not revive an expired session: check before recording it.
      if (t - last >= limitMs) tick();
      if (locked) return;
      last = t;
      if (t - lastWrite >= WRITE_EVERY_MS) {
        lastWrite = t;
        write(store, LAST_ACTIVITY_KEY, String(t));
      }
    },
    tick,
    /** Another tab changed storage. */
    sync() {
      if (read(store, LOCKED_KEY) === "1") {
        if (!locked) setLocked(true);
      } else if (locked) {
        last = Math.max(stored(), now());
        setLocked(false);
      } else {
        tick();
      }
    },
    unlock() {
      const t = now();
      last = t;
      lastWrite = t;
      markUnlocked(store, t, prefix);
      setLocked(false);
    },
    isLocked: () => locked,
  };
}

export type IdleTimer = ReturnType<typeof createIdleTimer>;
