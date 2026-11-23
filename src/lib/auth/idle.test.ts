import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleTimer, LAST_ACTIVITY_KEY, LOCKED_KEY, markUnlocked, type IdleStore } from "./idle";

const MIN = 60_000;
const LIMIT = 5 * MIN;

function memoryStore(): IdleStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** A clock the test moves by hand. Fake timers move the interval; the clock can jump on its own (sleep). */
function clock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

function setup(start = Date.UTC(2026, 10, 21, 12), store = memoryStore()) {
  const c = clock(start);
  const states: boolean[] = [];
  const timer = createIdleTimer({ limitMs: LIMIT, store, now: c.now, onChange: (l) => states.push(l) });
  /** Advance wall clock and fake timers together, as a running machine does. */
  const run = (ms: number) => {
    for (let i = 0; i < ms / 1000; i++) {
      c.advance(1000);
      vi.advanceTimersByTime(1000);
    }
  };
  return { c, store, timer, states, run };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("idle lock timer", () => {
  it("stays unlocked with activity and locks after the limit without it", () => {
    const { timer, run, states } = setup();
    timer.start();
    expect(states).toEqual([false]);
    run(4 * MIN);
    timer.activity();
    run(4 * MIN);
    expect(timer.isLocked()).toBe(false);
    run(1 * MIN);
    expect(timer.isLocked()).toBe(true);
    expect(states.at(-1)).toBe(true);
  });

  it("locks on the first tick after a sleep that jumps the clock past the limit", () => {
    const { c, timer, store } = setup();
    timer.start();
    c.advance(30 * MIN); // laptop lid closed: the clock moves, the interval does not
    expect(timer.isLocked()).toBe(false);
    vi.advanceTimersByTime(1000); // first tick after wake
    expect(timer.isLocked()).toBe(true);
    expect(store.getItem(LOCKED_KEY)).toBe("1");
  });

  it("does not let activity after a sleep revive an expired session", () => {
    const { c, timer } = setup();
    timer.start();
    c.advance(10 * MIN);
    timer.activity(); // the wake-up mouse move arrives before the tick
    expect(timer.isLocked()).toBe(true);
  });

  it("is unaffected by a DST change: epoch time is continuous", () => {
    // 2026-03-08 01:58 America/New_York; wall clock jumps 02:00 -> 03:00 two minutes in.
    const { timer, run } = setup(Date.UTC(2026, 2, 8, 6, 58));
    timer.start();
    run(4 * MIN);
    expect(timer.isLocked()).toBe(false);
    run(1 * MIN);
    expect(timer.isLocked()).toBe(true);
  });

  it("re-anchors when the clock goes backwards, then still locks after the limit", () => {
    const { c, timer, run } = setup();
    timer.start();
    c.advance(-60 * MIN);
    run(4 * MIN);
    expect(timer.isLocked()).toBe(false);
    run(2 * MIN);
    expect(timer.isLocked()).toBe(true);
  });

  it("ignores activity while locked", () => {
    const { run, timer } = setup();
    timer.start();
    run(LIMIT);
    expect(timer.isLocked()).toBe(true);
    timer.activity();
    run(10_000);
    expect(timer.isLocked()).toBe(true);
  });

  it("a reload stays locked: the lock flag survives in storage", () => {
    const store = memoryStore();
    const first = setup(undefined, store);
    first.timer.start();
    first.run(LIMIT);
    first.timer.stop();
    const reload = setup(first.c.now(), store);
    reload.timer.start();
    expect(reload.states).toEqual([true]);
  });

  it("a reload after the limit locks even without the flag (last activity is stored)", () => {
    const store = memoryStore();
    const start = Date.UTC(2026, 10, 21, 12);
    store.setItem(LAST_ACTIVITY_KEY, String(start - 6 * MIN));
    const { timer, states } = setup(start, store);
    timer.start();
    expect(states).toEqual([true]);
  });

  it("a second tab follows the first: lock and unlock sync through storage", () => {
    const store = memoryStore();
    const a = setup(undefined, store);
    const b = setup(undefined, store);
    a.timer.start();
    b.timer.start();
    a.run(LIMIT); // advances the shared fake timers: both tabs tick
    expect(a.timer.isLocked()).toBe(true);
    b.timer.sync();
    expect(b.timer.isLocked()).toBe(true);
    a.timer.unlock();
    b.timer.sync();
    expect(b.timer.isLocked()).toBe(false);
    expect(store.getItem(LOCKED_KEY)).toBeNull();
  });

  it("activity in another tab keeps this tab unlocked", () => {
    const store = memoryStore();
    const a = setup(undefined, store);
    const b = setup(undefined, store);
    a.timer.start();
    b.timer.start();
    for (let i = 0; i < 3; i++) {
      a.run(3 * MIN);
      b.c.advance(3 * MIN);
      a.timer.activity(); // only tab A sees the user
    }
    b.timer.tick();
    expect(b.timer.isLocked()).toBe(false);
  });

  it("unlock failure keeps it locked; unlock success clears it", () => {
    const { run, timer, store } = setup();
    timer.start();
    run(LIMIT);
    // A failed passkey never calls unlock(): nothing else clears the lock.
    run(60_000);
    expect(timer.isLocked()).toBe(true);
    timer.unlock();
    expect(timer.isLocked()).toBe(false);
    expect(store.getItem(LOCKED_KEY)).toBeNull();
  });

  it("markUnlocked resets storage for a fresh sign-in", () => {
    const store = memoryStore();
    store.setItem(LOCKED_KEY, "1");
    markUnlocked(store, 123);
    expect(store.getItem(LOCKED_KEY)).toBeNull();
    expect(store.getItem(LAST_ACTIVITY_KEY)).toBe("123");
  });

  it("survives storage that throws (private mode)", () => {
    const broken: IdleStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const { timer, run } = setup(undefined, broken as ReturnType<typeof memoryStore>);
    timer.start();
    run(LIMIT);
    expect(timer.isLocked()).toBe(true);
  });
});
