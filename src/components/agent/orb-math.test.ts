import { describe, expect, it } from "vitest";
import {
  ASLEEP_MS,
  ATTACK_S,
  BACK_A,
  BACK_R,
  bandAt,
  blend,
  BLEND_S,
  blendStep,
  blendTo,
  dotCount,
  dotFloor,
  dotInk,
  dotRadius,
  DOT_K,
  DOT_MIN_PX,
  frameDelay,
  INWARD,
  levelBands,
  LIS_GROW,
  MAX_DOTS,
  MAX_R,
  MIN_DOTS,
  ORB_R,
  PEND_GROW,
  pendingPulse,
  PENDING_DELAY_S,
  PENDING_LOOP_S,
  place,
  placed,
  pressWave,
  RELEASE_S,
  RING_MS,
  scene,
  SHIMMER,
  SHIMMER_S,
  shimmerAt,
  smoothBands,
  SPIKE,
  SEAT_AZ,
  SEAT_Y,
  SPOT_AWAY,
  SPOT_PAUSE_S,
  SPOT_SETTLE_S,
  sphere,
  spotAzimuth,
  spots,
  spotStep,
  type Spots,
  springTo,
  TALK_GROW,
  WOBBLE,
  WAKE_MS,
  wakeBurst,
  wakeFade,
  wakeRing,
  type Scene,
  type Wake,
} from "./orb-math";
import type { AgentStatus } from "./types";

type P = { x: number; y: number; r: number; a: number };
const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const dots = sphere(600);

/** A settled frame of one look; `over` sets the rest. Returns plain objects, so frames compare. */
function at(status: AgentStatus, t: number, over: Partial<Scene> = {}): P[] {
  const sc = { ...scene(status, t), turn: t * 0.2, ...over };
  const out = place(dots, sc, placed(dots.n));
  return Array.from({ length: out.n }, (_, i) => ({ x: out.x[i], y: out.y[i], r: out.r[i], a: out.a[i] }));
}
const bands = (f: (i: number) => number) => {
  const raw = new Float32Array(24).map((_, i) => f(i));
  const m = new Float32Array(24);
  smoothBands(raw, m, new Float32Array(24));
  return m;
};

describe("sphere and dotCount", () => {
  it("is an open shell: every point on the unit sphere, both poles covered", () => {
    for (let i = 0; i < dots.n; i++) expect(Math.hypot(dots.x[i], dots.y[i], dots.z[i])).toBeCloseTo(1, 5);
    expect(Math.min(...dots.y)).toBeLessThan(-0.99);
    expect(Math.max(...dots.y)).toBeGreaterThan(0.99);
  });
  it("is dense where it is big and sharp, fewer and crisp where it is small (critic rounds 7, 9): 90 to 800", () => {
    // Critic round 9: Phonon draws about 800 dots; the 96 px sidebar orb must keep well over round 8's 130.
    expect(dotCount(240, 2)).toBeGreaterThanOrEqual(780);
    expect(dotCount(240, 2)).toBeLessThanOrEqual(MAX_DOTS);
    expect(MAX_DOTS).toBe(800);
    expect(dotCount(1000, 2)).toBe(MAX_DOTS);
    expect(dotCount(96, 2)).toBeGreaterThanOrEqual(190);
    expect(dotCount(96, 2)).toBeLessThanOrEqual(230);
    expect(dotCount(96, 1)).toBeLessThan(dotCount(96, 2));
    expect(dotCount(48, 3)).toBe(dotCount(48, 2)); // the canvas caps at 2x
    expect(dotCount(10, 1)).toBe(MIN_DOTS);
    expect(dotCount(160, 2)).toBeGreaterThan(300);
  });
  it("is see-through dust: small dots, a crisp back, and the same share of ink at every size (critic rounds 3, 7, 9)", () => {
    // Round 9: more, smaller dots, not bigger ones: the front dot is under 1 % of R across (rounds 4-8: 1.13 %).
    expect(2 * 1.15 * DOT_K).toBeLessThan(0.0096);
    // Round 7: the back is 85 % alpha at 0.7x, not 34 % at 0.58x.
    expect(dotInk()).toBeCloseTo(0.82, 2);
    // Ink goes with count x drawn dot area / R^2: a floored small orb must not carry more than a big one.
    const ink = (size: number, dpr: number) => dotCount(size, dpr) * dotInk(dotFloor(size, dpr)) * (dotRadius(size) / (size * ORB_R)) ** 2;
    // Round 9 keeps round 8's total ink (it matched Phonon's): 553 dots at 0.0049, the back floored at 1.4 device px.
    const round8 = 553 * dotInk(0.7 / 2 / (240 * ORB_R * 0.0049)) * 0.0049 ** 2;
    expect(ink(240, 2)).toBeGreaterThan(round8 * 0.97);
    expect(ink(240, 2)).toBeLessThan(round8 * 1.03);
    expect(ink(96, 2)).toBeLessThanOrEqual(ink(240, 2) * 1.02);
    expect(ink(96, 2)).toBeGreaterThanOrEqual(ink(240, 2) * 0.98);
    // Device px: no dot drawn under the floor, at either size (the smallest factor is the back's, or the floor).
    for (const size of [96, 240]) expect(2 * Math.max(BACK_R, dotFloor(size, 2)) * dotRadius(size) * 2).toBeGreaterThanOrEqual(2 * DOT_MIN_PX - 1e-9);
  });
  it("a small orb raises its small dots to the floor, and a voice still grows them on top of it", () => {
    const floor = dotFloor(96, 2);
    expect(floor).toBeGreaterThan(1.15); // at 96 px every quiet dot is floored
    const quiet = at("listening", 2, { floor });
    for (const p of quiet) expect(p.r).toBeGreaterThanOrEqual(floor - 1e-6);
    // The floor below the back's factor changes nothing.
    expect(at("listening", 2, { floor: 0.5 })).toEqual(at("listening", 2));
  });
});

describe("gridless, living dust (critic round 2: not a dotted golf ball)", () => {
  /** Nearest-neighbour spacing CV of the front dots in the inner 60 % disk: a lattice is ~0.06, Phonon's dust 0.38-0.47. */
  const nnCV = (ps: P[]) => {
    const front = ps.filter((p) => p.a > BACK_A + 0.6 * (1 - BACK_A)); // the front 40 % of the depth
    const nn = front.filter((p) => radius(p) < 0.6).map((p) => Math.min(...front.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.y - q.y))));
    const m = mean(nn);
    return Math.sqrt(mean(nn.map((d) => (d - m) ** 2))) / m;
  };
  it("the front dots sit on no grid, at the big and the small orb", () => {
    for (const n of [800, 200]) {
      const s = sphere(n);
      const out = place(s, { ...scene("listening", 2), turn: 0.4 }, placed(n));
      const ps = Array.from({ length: n }, (_, i) => ({ x: out.x[i], y: out.y[i], r: out.r[i], a: out.a[i] }));
      // Critic round 9 cut the scatter (it clumped): still over 3x a bare lattice's 0.06, so no rows line up.
      expect(nnCV(ps)).toBeGreaterThan(0.2);
    }
  });
  it("reads as a full, even sphere on screen, front and back together: no clumps, no holes (critic round 9)", () => {
    // Counts in 0.2 R cells inside 0.8 R, and the widest empty circle inside 0.7 R, over several frames. Critic round 9
    // measured Phonon at CV 0.16-0.19 and holes of 0.066 R; Hydra's scatter of 0.8 at CV 0.33-0.40 and holes of 0.13 R.
    const n = 800;
    const s = sphere(n);
    const out = placed(n);
    let cvs = 0;
    let hole = 0;
    const frames = [1, 2.3, 3.7, 5.2];
    for (const t of frames) {
      place(s, { ...scene("listening", t), turn: t * 0.22 }, out);
      const cells = new Map<string, number>();
      for (let gx = -4; gx < 4; gx++)
        for (let gy = -4; gy < 4; gy++) if (Math.hypot(Math.abs((gx + 0.5) * 0.2) + 0.1, Math.abs((gy + 0.5) * 0.2) + 0.1) < 0.8) cells.set(`${gx},${gy}`, 0);
      for (let i = 0; i < n; i++) {
        const key = `${Math.floor(out.x[i] / 0.2)},${Math.floor(out.y[i] / 0.2)}`;
        if (Math.hypot(out.x[i], out.y[i]) < 0.8 && cells.has(key)) cells.set(key, cells.get(key)! + 1);
      }
      const c = [...cells.values()];
      const m = mean(c);
      cvs += Math.sqrt(mean(c.map((v) => (v - m) ** 2))) / m;
      for (let y = -0.7; y <= 0.7; y += 0.02)
        for (let x = -0.7; x <= 0.7; x += 0.02) {
          if (Math.hypot(x, y) > 0.7) continue;
          let d = Infinity;
          for (let i = 0; i < n; i++) d = Math.min(d, Math.hypot(out.x[i] - x, out.y[i] - y));
          hole = Math.max(hole, d);
        }
    }
    expect(cvs / frames.length).toBeLessThan(0.24);
    expect(hole).toBeLessThan(0.1);
  });
  it("the cover stays even: no bald patch bigger than about a lattice spacing", () => {
    const n = 1000;
    const s = sphere(n);
    const spacing = Math.sqrt((4 * Math.PI) / n);
    // Probe directions on a fine lattice: the nearest dot is never more than 1.2 spacings away (scattered 0.8: 1.13; 1.5: 1.30).
    const probe = sphere(4000);
    let worst = 0;
    for (let j = 0; j < probe.n; j += 7) {
      let best = Infinity;
      for (let i = 0; i < n; i++) best = Math.min(best, Math.hypot(s.x[i] - probe.x[j], s.y[i] - probe.y[j], s.z[i] - probe.z[j]));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(1.2 * spacing);
  });
  it("each dot wanders sideways on its own phase, on the surface: neighbours move differently", () => {
    // The turn held, so only the wander (and the 1 % radial drift and breath) moves them.
    const a = at("listening", 2, { turn: 0.4 });
    const b = at("listening", 2.5, { turn: 0.4 });
    const moves = a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y));
    expect(mean(moves)).toBeGreaterThan(WOBBLE * 0.2);
    expect(Math.max(...moves)).toBeLessThan(WOBBLE * 2.5); // calm: a wander, never a jump
    // Not one rigid shift: the moves differ dot to dot.
    const dx = a.map((p, i) => b[i].x - p.x);
    const m = mean(dx);
    expect(Math.sqrt(mean(dx.map((v) => (v - m) ** 2)))).toBeGreaterThan(WOBBLE * 0.1);
  });
  it("the back fills the gaps: a step fainter and smaller than the front, but crisp (critic rounds 3, 7)", () => {
    const ps = at("listening", 0);
    // Round 6's back at 34 % landed under 40 % contrast; Phonon draws it at full strength.
    expect(Math.min(...ps.map((p) => p.a))).toBeGreaterThan(0.84);
    const rs = ps.map((p) => p.r);
    expect(Math.min(...rs)).toBeGreaterThan(0.69);
    expect(Math.min(...rs) / Math.max(...rs)).toBeGreaterThan(0.55);
    expect(Math.min(...rs) / Math.max(...rs)).toBeLessThan(0.66);
  });
});

describe("springTo: fast attack, slower release", () => {
  const run = (from: number, to: number, fps: number, until: (x: number) => boolean) => {
    const x = new Float32Array([from]);
    const v = new Float32Array(1);
    let t = 0;
    while (!until(x[0]) && t < 2) {
      springTo(x, v, 0, to, 1 / fps);
      t += 1 / fps;
    }
    return t;
  };
  it("rises to 90 % of a step in 40 to 60 ms, never past the step", () => {
    const t = run(0, 1, 1000, (x) => x >= 0.9);
    expect(t).toBeGreaterThan(0.04);
    expect(t).toBeLessThan(0.06);
    expect(t).toBeCloseTo(ATTACK_S, 2);
    const x = new Float32Array([0]);
    const v = new Float32Array(1);
    for (let k = 0; k < 120; k++) {
      springTo(x, v, 0, 1, 1 / 60);
      expect(x[0]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
  it("falls to 10 % in 200 to 300 ms, never below 0", () => {
    const t = run(1, 0, 1000, (x) => x <= 0.1);
    expect(t).toBeGreaterThan(0.2);
    expect(t).toBeLessThan(0.3);
    expect(t).toBeCloseTo(RELEASE_S, 2);
    const x = new Float32Array([1]);
    const v = new Float32Array([-50]);
    springTo(x, v, 0, 0, 0.1);
    expect(x[0]).toBeGreaterThanOrEqual(0);
  });
  it("is the same curve at 60 and 120 Hz (time in seconds, not frames)", () => {
    const at60 = run(0, 1, 60, (x) => x >= 0.9);
    const at120 = run(0, 1, 120, (x) => x >= 0.9);
    expect(Math.abs(at60 - at120)).toBeLessThanOrEqual(1 / 60 + 1e-9);
    // The exact step: one 1/60 s step equals two 1/120 s steps.
    const a = new Float32Array([0.2]);
    const av = new Float32Array([1]);
    const b = new Float32Array([0.2]);
    const bv = new Float32Array([1]);
    springTo(a, av, 0, 0.8, 1 / 60);
    springTo(b, bv, 0, 0.8, 1 / 120);
    springTo(b, bv, 0, 0.8, 1 / 120);
    expect(a[0]).toBeCloseTo(b[0], 5);
  });
});

describe("smoothBands: one membrane", () => {
  it("a lone loud band becomes a bump with shoulders, peak kept in place, energy kept", () => {
    const m = bands((i) => (i === 10 ? 1 : 0));
    expect(m[10]).toBeLessThan(1);
    expect(m[10]).toBeGreaterThan(0.3);
    expect(m[9]).toBeGreaterThan(0.15);
    expect(m[11]).toBeCloseTo(m[9], 6);
    for (let i = 10; i < 23; i++) expect(m[i + 1]).toBeLessThanOrEqual(m[i]);
    expect(m.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });
  it("a flat spectrum stays flat (edges held)", () => {
    for (const v of bands(() => 0.6)) expect(v).toBeCloseTo(0.6, 6);
  });
  it("copies the blur in place: no typed-array view per frame", () => {
    const src = new Float32Array(24).fill(0.4);
    const out = new Float32Array(24);
    const tmp = new Float32Array(24);
    const orig = Float32Array.prototype.subarray;
    let views = 0;
    Float32Array.prototype.subarray = function (this: Float32Array, ...args: [number?, number?]) {
      views++;
      return orig.apply(this, args);
    };
    try {
      smoothBands(src, out, tmp);
      smoothBands(out, out, tmp);
    } finally {
      Float32Array.prototype.subarray = orig;
    }
    expect(views).toBe(0);
    expect(out[0]).toBeCloseTo(0.4, 6);
    expect(out[23]).toBeCloseTo(0.4, 6);
  });
  it("bandAt eases between samples and clamps", () => {
    expect(bandAt([0, 1], 0)).toBe(0);
    expect(bandAt([0, 1], 1)).toBe(1);
    expect(bandAt([0, 1], 0.5)).toBeCloseTo(0.5, 6);
    expect(bandAt([0, 1], 2)).toBe(1);
    expect(bandAt([], 0.5)).toBe(0);
  });
});

describe("blend: each status its own look, 250 ms apart", () => {
  it("starts settled, eases to the new look in BLEND_S, weights always sum to 1", () => {
    const b = blend("listening", 0);
    expect(Array.from(b.w)).toEqual([0, 1, 0, 0]);
    blendTo(b, "speaking", 1);
    let prev = 0;
    for (let t = 1; t <= 1 + BLEND_S + 0.02; t += 1 / 60) {
      blendStep(b, t);
      expect(b.w.reduce((a, c) => a + c, 0)).toBeCloseTo(1, 5);
      expect(b.w[3]).toBeGreaterThanOrEqual(prev - 1e-6); // monotone toward speaking
      prev = b.w[3];
    }
    expect(blendStep(b, 1 + BLEND_S)).toBe(1);
    expect(Array.from(b.w)).toEqual([0, 0, 0, 1]);
  });
  it("eases in and out: slow at both ends, half way at half time", () => {
    const b = blend("asleep", 0);
    blendTo(b, "listening", 0);
    blendStep(b, BLEND_S * 0.1);
    expect(b.w[1]).toBeLessThan(0.02);
    blendStep(b, BLEND_S * 0.5);
    expect(b.w[1]).toBeCloseTo(0.5, 5);
  });
  it("a change mid-way starts from the mix on screen: no jump", () => {
    const b = blend("listening", 0);
    blendTo(b, "thinking", 0);
    blendStep(b, BLEND_S / 2);
    const mid = Array.from(b.w);
    blendTo(b, "speaking", BLEND_S / 2);
    blendStep(b, BLEND_S / 2);
    Array.from(b.w).forEach((w, i) => expect(w).toBeCloseTo(mid[i], 6));
    blendStep(b, BLEND_S / 2 + BLEND_S);
    expect(Array.from(b.w)).toEqual([0, 0, 0, 1]);
  });
  it("the same status twice is no change", () => {
    const b = blend("speaking", 0);
    blendTo(b, "speaking", 5);
    expect(blendStep(b, 5)).toBe(1);
  });
});

describe("the looks are clearly different", () => {
  const voice = bands((i) => 0.9 * Math.exp(-((i - 7) ** 2) / 8) + 0.5 * Math.exp(-((i - 15) ** 2) / 6));
  it("at rest it barely moves: a breath of a few percent", () => {
    for (const t of [0, 1.1, 2.7]) for (const p of at("listening", t)) expect(radius(p)).toBeLessThan(1.03);
  });
  it("speaking pushes out on the voice; listening draws in", () => {
    const quiet = at("listening", 2);
    const talk = at("speaking", 2, { m: voice, level: 0.8 });
    const hear = at("listening", 2, { m: voice, level: 0.8 });
    expect(Math.max(...talk.map(radius))).toBeGreaterThan(1.07);
    expect(mean(talk.map(radius))).toBeGreaterThan(mean(quiet.map(radius)) + 0.015);
    expect(mean(hear.map(radius))).toBeLessThan(mean(quiet.map(radius)) - INWARD * 0.5);
    // Speaking grows the dots where the voice is.
    expect(Math.max(...talk.map((p) => p.r))).toBeGreaterThan(Math.max(...quiet.map((p) => p.r)) * 1.5);
  });
  it("listening ripples: the same voice moves the dots differently a moment later", () => {
    const a = at("listening", 2, { m: voice, level: 0.6 });
    const b = at("listening", 2.1, { m: voice, level: 0.6 });
    // Rings of larger dots move (size; round 6 caps a dot at 2x, so the swing is a third of round 5's), and the
    // surface under them rises and falls (place).
    expect(mean(a.map((p, i) => Math.abs(p.r - b[i].r)))).toBeGreaterThan(0.025);
    expect(mean(a.map((p, i) => Math.abs(radius(p) - radius(b[i]))))).toBeGreaterThan(0.005);
  });
  it("one loud low band moves the bottom, not the top; a high band the opposite", () => {
    const quiet = at("speaking", 2);
    const grow = (m: Float32Array) => at("speaking", 2, { m }).map((p, i) => ({ g: radius(p) / radius(quiet[i]), h: (1 - quiet[i].y) / 2 })); // screen height: 0 bottom, 1 top
    const low = grow(bands((i) => (i === 2 ? 1 : 0)));
    expect(mean(low.filter((d) => d.h < 0.1).map((d) => d.g))).toBeGreaterThan(1.02);
    expect(mean(low.filter((d) => d.h > 0.4).map((d) => d.g))).toBeLessThan(1.005);
    const high = grow(bands((i) => (i === 21 ? 1 : 0)));
    expect(mean(high.filter((d) => d.h > 0.9).map((d) => d.g))).toBeGreaterThan(1.02);
    expect(mean(high.filter((d) => d.h < 0.6).map((d) => d.g))).toBeLessThan(1.005);
  });
  it("pending (no input) carries a band that orbits, and pulses", () => {
    const a = at("thinking", 2, { orbit: 0, pulse: 0.5 });
    const b = at("thinking", 2, { orbit: Math.PI / 2, pulse: 0.5 });
    const lifted = (ps: P[]) => ps.map((p) => p.r > 1.2 * (0.55 + 0.6 * 0.5));
    // A different set of dots is lifted as the band moves round.
    const la = lifted(a);
    const lb = lifted(b);
    expect(la.filter(Boolean).length).toBeGreaterThan(30);
    expect(la.filter((v, i) => v !== lb[i]).length).toBeGreaterThan(30);
    expect(mean(at("thinking", 2, { pulse: 1 }).map(radius))).toBeGreaterThan(mean(at("thinking", 2, { pulse: 0 }).map(radius)) + 0.02);
  });
  it("asleep is smaller and fainter than awake; the back fainter than the front", () => {
    const awake = at("listening", 0);
    const asleep = at("asleep", 0);
    expect(Math.max(...asleep.map(radius))).toBeLessThan(Math.max(...awake.map(radius)) * 0.92);
    expect(Math.max(...asleep.map((p) => p.a))).toBeLessThan(Math.max(...awake.map((p) => p.a)) * 0.6);
    expect(Math.min(...awake.map((p) => p.a))).toBeLessThan(Math.max(...awake.map((p) => p.a)) * 0.9);
  });
  it("stays inside the box the canvas leaves for it, at full scale in every look", () => {
    const loud = bands(() => 1);
    for (const st of ["asleep", "listening", "thinking", "speaking"] as const)
      for (const t of [0.3, 1.7, 3.3]) for (const p of at(st, t, { m: loud, level: 1, pulse: 1, hover: 1, hx: 1.2, hy: 0, press: 100 })) expect(radius(p)).toBeLessThanOrEqual(MAX_R + 1e-6);
  });
  it("is deterministic for the same frame, so reduced motion holds still", () => {
    expect(at("listening", 1.5)).toEqual(at("listening", 1.5));
  });
  it("reduced motion: a round still shell, the status only in its alpha", () => {
    const still = (st: AgentStatus) => at(st, 1.5, { still: true, m: voice, level: 1, pulse: 1, hover: 1, hx: 0.5, press: 100 });
    const plain = at("listening", 1.5, { still: true });
    for (const st of ["asleep", "listening", "thinking", "speaking"] as const) {
      const ps = still(st);
      ps.forEach((p, i) => {
        expect(p.x).toBeCloseTo(plain[i].x, 6);
        expect(p.y).toBeCloseTo(plain[i].y, 6);
        expect(p.r).toBeCloseTo(plain[i].r, 6);
      });
      expect(Math.max(...ps.map(radius))).toBeLessThan(1.001); // the plain shell, no breath
    }
    const a = (st: AgentStatus) => mean(still(st).map((p) => p.a));
    expect(a("asleep")).toBeLessThan(a("thinking"));
    expect(a("thinking")).toBeLessThan(a("listening"));
    expect(a("listening")).toBeLessThan(a("speaking"));
  });
});

describe("the voice erupts in one patch that turns with the sphere (critic round 4: not a mirrored barrel)", () => {
  const voice = bands((i) => 0.9 * Math.exp(-((i - 7) ** 2) / 8) + 0.5 * Math.exp(-((i - 15) ** 2) / 6));
  const T = 2;
  const TURN = T * 0.2;
  /** A patch placed by a phrase's first frame at the turn `at` uses, then 0.3 s of steady voice (heated). */
  const heated = (): Spots => {
    const sp = spots();
    for (let k = 0; k < 18; k++) spotStep(sp, voice, 0.7, TURN, 1 / 60);
    return sp;
  };
  /** The rim per 36 sectors (outermost dot), as a share of the quiet rim. */
  const rimDev = (ps: P[], quiet: P[]) => {
    const rim = (q: P[]) => {
      const r = new Array(36).fill(0);
      for (const p of q) {
        const s = Math.floor(((Math.atan2(p.y, p.x) + Math.PI) / (2 * Math.PI)) * 36) % 36;
        r[s] = Math.max(r[s], radius(p));
      }
      return r;
    };
    const a = rim(ps);
    const b = rim(quiet);
    return a.map((v, i) => v / b[i] - 1);
  };
  /** Slot `k`'s heart's screen height at `turn` (y down, TILT 0.38). */
  const heartY = (sp: Spots, k: number, turn: number) => {
    const z1 = -sp.x[k] * Math.sin(turn) + sp.z[k] * Math.cos(turn);
    return sp.y[k] * Math.cos(0.38) - z1 * Math.sin(0.38);
  };
  it("seats one patch on the face, on the side the turn brings in, once the voice is up (SPOT_SETTLE_S), heated in about the attack time", () => {
    const sp = spots();
    spotStep(sp, voice, 0, TURN, 1 / 60);
    spotStep(sp, voice, 0.7, TURN, 1 / 60);
    expect(sp.count).toBe(0);
    for (let f = 0; f < Math.ceil(SPOT_SETTLE_S * 60) + 2; f++) spotStep(sp, voice, 0.7, TURN, 1 / 60);
    expect(sp.count).toBe(1);
    // Critic round 10: at the limb the cap was seen edge-on. Now 0.3-0.9 rad off the front, left (the turn moves it right).
    const az = spotAzimuth(sp, sp.k, TURN);
    expect(az).toBeLessThan(-SEAT_AZ[0] + 1e-4);
    expect(az).toBeGreaterThan(-SEAT_AZ[1] - 1e-4);
    for (let k = 0; k < 5; k++) spotStep(sp, voice, 0.7, TURN, 1 / 60);
    expect(sp.g[sp.k]).toBeGreaterThan(0.9);
    expect(sp.g[1 - sp.k]).toBe(0);
  });
  it("one side erupts, the other stays calm: not its own mirror", () => {
    const sp = heated();
    const quiet = at("speaking", T);
    const talk = at("speaking", T, { m: voice, level: 0.7, sp });
    const dev = rimDev(talk, quiet);
    const mirror = dev.map((_, i) => dev[(18 - i + 36) % 36]);
    const dot = dev.reduce((a, v, i) => a + v * mirror[i], 0);
    const norm = Math.sqrt(dev.reduce((a, v) => a + v * v, 0) * mirror.reduce((a, v) => a + v * v, 0));
    expect(dot / norm).toBeLessThan(0.2);
    // The hot side bulges well past the calm side (sectors 0 west and 18 east, ±4 sectors).
    const side = (c: number) => Math.max(...[-4, -3, -2, -1, 0, 1, 2, 3, 4].map((o) => dev[(c + o + 36) % 36]));
    const hotWest = spotAzimuth(sp, sp.k, TURN) < 0;
    const hot = side(hotWest ? 0 : 18);
    const calm = side(hotWest ? 18 : 0);
    expect(hot).toBeGreaterThan(3 * Math.max(0.005, calm));
    // Critic round 10: the patch is on the face, so its dots move on the face: the hot half's front dots move on screen
    // several times the calm half's.
    const moved = (west: boolean) =>
      mean(talk.map((p, i) => ({ q: quiet[i], d: Math.hypot(p.x - quiet[i].x, p.y - quiet[i].y) })).filter(({ q }) => q.x < 0 === west && q.r > 1).map(({ d }) => d));
    expect(moved(hotWest)).toBeGreaterThan(4 * moved(!hotWest));
  });
  it("the rest of the dust stays calm, the patch's dots swell to about twice", () => {
    const sp = heated();
    const quiet = at("speaking", T);
    const talk = at("speaking", T, { m: voice, level: 0.7, sp });
    const far = (i: number) => dots.x[i] * sp.x[sp.k] + dots.y[i] * sp.y[sp.k] + dots.z[i] * sp.z[sp.k] < 0;
    const gain = talk.map((p, i) => radius(p) / radius(quiet[i]));
    expect(mean(gain.filter((_, i) => far(i)))).toBeLessThan(1.01);
    expect(Math.max(...gain)).toBeGreaterThan(1.08);
    expect(Math.max(...talk.map((p, i) => p.r / quiet[i].r))).toBeGreaterThan(1.8);
  });
  it("the patch turns with the sphere: steady voice keeps it, and its dots move across with the turn", () => {
    const sp = heated();
    const k = sp.k;
    const x = sp.x[k];
    for (let f = 1; f <= 60; f++) spotStep(sp, voice, 0.6, TURN + f * 0.003, 1 / 60);
    expect(sp.k).toBe(k);
    expect(sp.x[k]).toBe(x);
    const hotX = (turn: number) => {
      const quiet = at("speaking", T, { turn });
      const talk = at("speaking", T, { turn, m: voice, level: 0.7, sp });
      // The patch's dots by their swell (round 5: the cap is wide, and a dot facing the viewer pushes out along the view
      // ray, so a screen-radius test would only see the ones at the limb).
      const g = talk.map((p, i) => ({ x: quiet[i].x, k: p.r / quiet[i].r })).filter((q) => q.k > 1.5);
      return mean(g.map((q) => q.x));
    };
    // The turn carries the front to the right: the hot dots' mean screen x moves right.
    expect(hotX(TURN + 0.4)).toBeGreaterThan(hotX(TURN) + 0.1);
  });
  it("a new phrase moves the heat to a new patch; the old one cools without a pop", () => {
    const sp = heated();
    const first = sp.k;
    for (let f = 0; f < Math.ceil((SPOT_PAUSE_S + 0.05) * 60); f++) spotStep(sp, voice, 0, TURN, 1 / 60);
    for (let f = 0; f < Math.ceil(SPOT_SETTLE_S * 60) + 2; f++) spotStep(sp, voice, 0.7, TURN, 1 / 60);
    expect(sp.k).toBe(1 - first);
    let prev = sp.g[first];
    for (let f = 0; f < 30; f++) {
      spotStep(sp, voice, 0.7, TURN, 1 / 60);
      expect(Math.abs(sp.g[first] - prev)).toBeLessThan(0.15);
      prev = sp.g[first];
    }
    expect(sp.g[first]).toBeLessThan(0.1);
    expect(sp.g[sp.k]).toBeGreaterThan(0.95);
  });
  it("a phrase that opens on a hiss is placed on its voice, not on the hiss", () => {
    const sp = spots();
    const hiss = bands((i) => (i === 21 ? 0.8 : 0));
    spotStep(sp, hiss, 0.1, TURN, 1 / 60);
    for (let f = 0; f < 12; f++) spotStep(sp, voice, 0.7, TURN, 1 / 60);
    expect(sp.count).toBe(1);
    // The voice's loudest band is low-middle: the patch's heart sits below the middle of the screen (y down).
    expect(heartY(sp, sp.k, TURN)).toBeGreaterThan(0.08);
  });
  it("the patch sits near the equator for any voice, lows a little low, highs a little high (critic round 10: not the bottom rim)", () => {
    const y = [0, 23].map((loud) => {
      const sp = spots();
      const m = bands((i) => (i === loud ? 1 : 0));
      for (let f = 0; f < 12; f++) spotStep(sp, m, 0.7, TURN, 1 / 60);
      return heartY(sp, sp.k, TURN);
    });
    expect(y[0]).toBeGreaterThan(0.15);
    expect(y[1]).toBeLessThan(-0.15);
    for (const v of y) expect(Math.abs(v)).toBeLessThanOrEqual(SEAT_Y + 1e-4);
  });
  it("the turn carries a fresh patch across the face, toward the front first", () => {
    for (let c = 0; c < 8; c++) {
      const sp = spots();
      sp.count = c;
      for (let f = 0; f < 12; f++) spotStep(sp, voice, 0.7, TURN, 1 / 60);
      const az0 = spotAzimuth(sp, sp.k, TURN);
      expect(Math.abs(spotAzimuth(sp, sp.k, TURN + 0.25))).toBeLessThan(Math.abs(az0));
    }
  });
  it("a patch seated for a very low or very high voice is in view, so it is not re-seated every frame", () => {
    for (const loud of [0, 23]) {
      const sp = spots();
      const m = bands((i) => (i === loud ? 1 : 0));
      for (let f = 0; f < 60; f++) spotStep(sp, m, 0.7, TURN + f * 0.003, 1 / 60);
      expect(sp.count).toBe(1);
    }
  });
  it("a patch turned past the limb gives way to one in view", () => {
    const sp = heated();
    let turn = TURN;
    const k = sp.k;
    // Turn it away (voice on), and the next frame finds a patch in view.
    while (Math.abs(spotAzimuth(sp, k, turn)) <= SPOT_AWAY) turn += 0.05;
    for (let f = 0; f < Math.ceil(SPOT_SETTLE_S * 60) + 2; f++) spotStep(sp, voice, 0.6, turn, 1 / 60);
    expect(sp.k).toBe(1 - k);
    expect(Math.abs(spotAzimuth(sp, sp.k, turn))).toBeLessThan(1.5);
  });
  it("a voice swells a whole cap of dots, not a sliver (critic round 5: ~1 % swelled, Phonon 6.4 %)", () => {
    for (const st of ["speaking", "listening"] as const) {
      const sp = heated();
      const quiet = at(st, T);
      // A quiet syllable (the loudest band at 0.35) and a full one: both swell a cap; it stays one cap, not the shell.
      // Round 6: the dots peak at 2x (Phonon's), so a swell is 1.25x and up.
      for (const [k, lo] of [[0.4, 0.03], [1, 0.15]]) {
        const m = voice.map((v) => v * k);
        const talk = at(st, T, { m, level: 0.7 * k, sp });
        const share = mean(talk.map((p, i) => (p.r / quiet[i].r >= 1.25 ? 1 : 0)));
        expect(share).toBeGreaterThan(lo);
        expect(share).toBeLessThan(0.35);
      }
    }
  });
  it("the dust stays dust: no dot grows past twice its quiet size, in any look, at full voice, pointer and press (critic round 6)", () => {
    const loud = bands(() => 1);
    for (const st of ["listening", "thinking", "speaking"] as const) {
      const sp = heated();
      for (const t of [0.3, 1.7, 2, 3.3]) {
        // The pointer's tilt turns back dots to the front (a bigger depth factor), so the bound is the front dot's 1.15.
        const full = at(st, t, { m: loud, level: 1, sp, pulse: 1, hover: 1, hx: 0.4, hy: 0.2, press: 150, qx: 0.4, qy: 0.2 });
        expect(Math.max(...full.map((p) => p.r))).toBeLessThanOrEqual(2 * 1.15 + 1e-6);
        expect(Math.max(...full.map((p) => p.r))).toBeGreaterThan(1.8 * 1.15);
      }
    }
  });
  it("a voice swells more dots than pending's band; the owner's voice about as many as Hydra's (critic round 8)", () => {
    // Round 7: pending (no input) had the most swollen dots and listening a quarter of Phonon's. Now a loud syllable
    // takes a cap of dots to a crisp swell (size factor 1.75 and up: about 8 full-ink device px at 240 px, the critic's
    // hot dot) at both voice looks, and pending's band peaks at 1 + PEND_GROW, so only its front-most dots get there.
    const hot = (st: AgentStatus, over: Partial<Scene>) => mean(at(st, T, over).map((p) => (p.r >= 1.75 ? 1 : 0)));
    const talk = hot("speaking", { m: voice, level: 0.7, sp: heated() });
    const hear = hot("listening", { m: voice, level: 0.7, sp: heated() });
    const pend = hot("thinking", { pulse: 1 });
    expect(talk).toBeGreaterThan(0.08);
    // The listening rings move which dots crest, so one frame varies; over a capture its share is at or above talking's.
    expect(hear).toBeGreaterThan(0.85 * talk);
    expect(pend).toBeLessThan(talk / 2);
    // Pending is calm: no band dot past 1 + PEND_GROW of its bare size, even at the pulse's peak (the voices reach 2x).
    const quiet = at("listening", T);
    const peak = at("thinking", T, { pulse: 1, orbit: 0 });
    expect(Math.max(...peak.map((p, i) => p.r / quiet[i].r))).toBeLessThanOrEqual(1 + PEND_GROW + 1e-6);
    expect(PEND_GROW).toBeLessThan(TALK_GROW);
    expect(LIS_GROW).toBeGreaterThanOrEqual(TALK_GROW);
  });
  it("listening dents the patch and swells its dots; the shell as a whole barely pumps", () => {
    const sp = heated();
    const quiet = at("listening", T);
    const hear = at("listening", T, { m: voice, level: 0.8, sp });
    const near = (i: number) => dots.x[i] * sp.x[sp.k] + dots.y[i] * sp.y[sp.k] + dots.z[i] * sp.z[sp.k] > 0.9;
    const far = (i: number) => dots.x[i] * sp.x[sp.k] + dots.y[i] * sp.y[sp.k] + dots.z[i] * sp.z[sp.k] < 0;
    const gain = hear.map((p, i) => radius(p) / radius(quiet[i]));
    expect(mean(gain.filter((_, i) => far(i)))).toBeGreaterThan(0.97);
    // Over one period of the rings (2π / 6 s) the patch sits inside the shell: it draws in.
    const period: number[] = [];
    for (let t = T; t < T + 1.05; t += 0.05) {
      const q = at("listening", t, { turn: TURN });
      at("listening", t, { turn: TURN, m: voice, level: 0.8, sp }).forEach((p, i) => near(i) && period.push(radius(p) / radius(q[i])));
    }
    expect(mean(period)).toBeLessThan(0.98);
    expect(mean(hear.filter((_, i) => near(i)).map((p) => p.r))).toBeGreaterThan(1.4 * mean(quiet.filter((_, i) => near(i)).map((p) => p.r)));
    expect(mean(hear.filter((_, i) => far(i)).map((p) => p.r))).toBeLessThan(1.15 * mean(quiet.filter((_, i) => far(i)).map((p) => p.r)));
  });
});

describe("hyper interactive: hover and press", () => {
  it("the pointer tilts the sphere toward itself and pulls the nearby dots", () => {
    const [hx, hy] = [0.3, -0.2];
    const plain = at("listening", 2);
    const hover = at("listening", 2, { hover: 1, hx, hy });
    const dist = (p: P) => Math.hypot(p.x - hx, p.y - hy);
    // More dots gather near the pointer, and they grow.
    expect(hover.filter((p) => dist(p) < 0.25).length).toBeGreaterThan(plain.filter((p) => dist(p) < 0.25).length * 1.15);
    expect(mean(hover.filter((p) => dist(p) < 0.2).map((p) => p.r))).toBeGreaterThan(mean(plain.filter((p) => dist(p) < 0.2).map((p) => p.r)) * 1.1);
    // The tilt: the whole sphere turns toward the pointer, so every dot moves a little.
    expect(mean(hover.map((p, i) => Math.hypot(p.x - plain[i].x, p.y - plain[i].y)))).toBeGreaterThan(0.03);
    // No pointer: exactly the plain orb.
    expect(at("listening", 2, { hover: 0, hx, hy })).toEqual(plain);
  });
  it("a press sends one ripple out from the press point that fades away", () => {
    expect(pressWave(0, 0)).toBeCloseTo(1, 6);
    expect(pressWave(0.5, 250)).toBeGreaterThan(pressWave(0.5, 0));
    expect(pressWave(0.5, 250)).toBeGreaterThan(pressWave(0, 250));
    expect(pressWave(0.5, 899)).toBeLessThan(0.01);
    expect(pressWave(0.5, -1)).toBe(0);
    const plain = at("listening", 2).map((p) => p.r);
    const pressed = at("listening", 2, { press: 200, qx: 0, qy: 0 }).map((p, i) => p.r / plain[i]);
    expect(Math.max(...pressed)).toBeGreaterThan(1.3);
    expect(at("listening", 2, { press: 900 })).toEqual(at("listening", 2));
  });
});

describe("pending pulse, in time with the Mac's pending sound", () => {
  it("is still for the first 0.6 s, then pulses once per 2.4 s loop", () => {
    expect(pendingPulse(0)).toBe(0);
    expect(pendingPulse(PENDING_DELAY_S)).toBe(0);
    const s = 5;
    expect(pendingPulse(s)).toBeCloseTo(pendingPulse(s + PENDING_LOOP_S), 9);
    const loop = Array.from({ length: 48 }, (_, k) => pendingPulse(s + (k / 48) * PENDING_LOOP_S));
    expect(Math.max(...loop)).toBeGreaterThan(0.99);
    expect(Math.min(...loop)).toBeLessThan(0.01);
    // Fades in: never a jump from still to full.
    for (let t = 0; t < 2; t += 1 / 60) expect(Math.abs(pendingPulse(t + 1 / 60) - pendingPulse(t))).toBeLessThan(0.05);
  });
});

describe("levelBands: a bare level still moves the membrane", () => {
  it("silence is flat, a voice level is a low-middle hump", () => {
    const out = new Float32Array(24);
    levelBands(out, 0, 1);
    expect(Math.max(...out)).toBe(0);
    levelBands(out, 0.8, 1);
    expect(out[7]).toBeGreaterThan(out[22]);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
  });
});

describe("frameDelay", () => {
  it("naps asleep only once nothing moves faster than the sleep look", () => {
    // Falling asleep: the 250 ms blend runs at 60 fps (no nap), then the orb naps.
    const b = blend("listening", 0);
    blendTo(b, "asleep", 0);
    let frames = 0;
    let t = 0;
    while (frameDelay("asleep", 1 - blendStep(b, t)) === 0 && frames < 100) {
      t += 1 / 60;
      frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(14);
    expect(frames).toBeLessThanOrEqual(17);
    expect(frameDelay("asleep", 0)).toBe(ASLEEP_MS);
    expect(frameDelay("asleep", 0.5)).toBe(0); // a pointer on it
  });
  it("never naps awake", () => {
    for (const st of ["listening", "thinking", "speaking"] as const) expect(frameDelay(st, 0)).toBe(0);
  });
});

describe("the wake look (texture, no color)", () => {
  const maxR = (ps: P[]) => Math.max(...ps.map(radius));
  const meanA = (ps: P[]) => mean(ps.map((p) => p.a));
  const woke = (ms: number, awake = true): { wake: Wake } => ({ wake: { ms, awake } });

  it("the burst: 0 at the wake, near its peak early, easing back, gone at 900 ms and after", () => {
    expect(wakeBurst(0)).toBe(0);
    expect(wakeBurst(100)).toBeGreaterThan(0.9);
    expect(wakeBurst(300)).toBeCloseTo(0.482, 2);
    expect(wakeBurst(600)).toBeCloseTo(0.06, 2);
    expect(wakeBurst(900)).toBe(0);
    expect(wakeBurst(1200)).toBe(0);
    expect(wakeBurst(-50)).toBe(0);
    expect(wakeBurst(Number.NaN)).toBe(0);
    for (let ms = 140; ms < WAKE_MS; ms += 20) expect(wakeBurst(ms + 20)).toBeLessThanOrEqual(wakeBurst(ms));
  });

  it("swells the shell up to +10 % and lifts every dot to full alpha at the peak, then is exactly the plain orb", () => {
    const plain = at("listening", 2);
    const peak = at("listening", 2, woke(135));
    expect(maxR(peak) / maxR(plain)).toBeGreaterThan(1.09);
    expect(maxR(peak) / maxR(plain)).toBeLessThan(1.101);
    expect(Math.min(...peak.map((p) => p.a))).toBeGreaterThan(0.99);
    expect(at("listening", 2, woke(WAKE_MS, false))).toEqual(plain);
    for (const p of peak) expect(radius(p)).toBeLessThan(1.3);
  });

  it("a voice at the wake: the swell never takes a full spike past its plain reach (no dot cut by the canvas edge)", () => {
    const loud = bands(() => 1);
    for (let t = 0; t < 7; t += 0.5) {
      const plain = maxR(at("speaking", t, { m: loud, level: 1 }));
      for (let ms = 0; ms <= WAKE_MS; ms += 30) {
        const w = maxR(at("speaking", t, { m: loud, level: 1, ...woke(ms) }));
        expect(w).toBeLessThanOrEqual(Math.max(plain, 1 + SPIKE) + 1e-6);
        expect(w).toBeLessThan(1.32);
      }
    }
    expect(maxR(at("listening", 2, woke(135))) / maxR(at("listening", 2))).toBeGreaterThan(1.09);
  });

  it("a ring runs out from the center over 600 ms and grows the dots it passes by up to 40 %", () => {
    expect(wakeRing(0)).toBe(0);
    expect(wakeRing(300)!).toBeGreaterThan(0.5);
    expect(wakeRing(RING_MS)).toBeNull();
    const plain = at("listening", 2).map((p) => p.r);
    const grow = at("listening", 2, woke(300)).map((p, i) => p.r / plain[i]);
    expect(Math.max(...grow)).toBeGreaterThan(1.3);
    expect(Math.max(...grow)).toBeLessThanOrEqual(1.4 + 1e-6);
    expect(Math.min(...grow)).toBeCloseTo(1, 5);
  });

  it("the ring ends past the rim: the dots it grew are back to size before it stops, with no step at 600 ms", () => {
    const plain = at("listening", 2).map((p) => p.r);
    const maxGrow = (ms: number) => Math.max(...at("listening", 2, woke(ms)).map((p, i) => p.r / plain[i] - 1));
    expect(maxGrow(RING_MS - 1)).toBeLessThan(0.01);
    for (let ms = 32; ms < RING_MS + 32; ms += 16) expect(Math.abs(maxGrow(ms) - maxGrow(ms - 16))).toBeLessThan(0.08);
  });

  it("the shimmer: awake only, after the burst, a band that crosses the sphere every 3 s, up to SHIMMER", () => {
    const after = WAKE_MS + 1000;
    expect(shimmerAt(0, 1, WAKE_MS - 1)).toBe(0);
    const peaks = Array.from({ length: 60 }, (_, k) => shimmerAt(0, (k / 60) * SHIMMER_S, after));
    expect(Math.max(...peaks)).toBeGreaterThan(SHIMMER * 0.95);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(SHIMMER);
    expect(Math.min(...peaks)).toBeLessThan(0.01);
    expect(shimmerAt(0.3, 0.7, after)).toBeCloseTo(shimmerAt(0.3, 0.7 + SHIMMER_S, after), 9);
    for (const x of [-1, 1]) for (const t of [SHIMMER_S - 1e-3, SHIMMER_S]) expect(shimmerAt(x, t, after)).toBeLessThan(0.005);
    expect(meanA(at("listening", 1.6, woke(after)))).toBeGreaterThan(meanA(at("listening", 1.6)) + 0.01);
    expect(at("asleep", 1.6, woke(after, false))).toEqual(at("asleep", 1.6));
  });

  it("reduced motion: a 300 ms fade from the asleep alpha to full, nothing else", () => {
    expect(wakeFade(0)).toBe(0);
    expect(wakeFade(150)).toBeCloseTo(0.5, 6);
    expect(wakeFade(300)).toBe(1);
    expect(wakeFade(5000)).toBe(1);
  });
});

