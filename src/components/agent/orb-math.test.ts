import { describe, expect, it } from "vitest";
import {
  ASLEEP_MS,
  bandAt,
  driveLevel,
  frameDelay,
  place,
  RING_MS,
  SHIMMER,
  SHIMMER_S,
  shimmerAt,
  SPIKE,
  spherePoints,
  WAKE_MS,
  wakeBurst,
  wakeFade,
  wakeRing,
} from "./orb-math";

const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

describe("spherePoints", () => {
  it("is an open shell: every point sits on the unit sphere, none inside", () => {
    const dots = spherePoints(220);
    expect(dots).toHaveLength(220);
    for (const d of dots) expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
  });
  it("covers both hemispheres", () => {
    const ys = spherePoints(220).map((d) => d.y);
    expect(Math.min(...ys)).toBeLessThan(-0.95);
    expect(Math.max(...ys)).toBeGreaterThan(0.95);
  });
});

describe("place", () => {
  const dots = spherePoints(220);
  const spread = (level: number) => {
    const maxes = [0, 1, 2, 3].map((k) => Math.max(...place(dots, k * 0.37, level, "speaking").map(radius)));
    return Math.max(...maxes);
  };
  it("barely moves at rest: a breath of a few percent", () => {
    expect(spread(0)).toBeLessThan(1.02);
  });
  it("ripples outward with the level, and more with more level", () => {
    expect(spread(0.8)).toBeGreaterThan(spread(0.2));
    expect(spread(0.8)).toBeGreaterThan(1.1);
  });
  it("stays inside the box the canvas leaves for it", () => {
    for (const p of place(dots, 3.3, 1, "speaking")) expect(radius(p)).toBeLessThan(1.3);
  });
  it("is fainter asleep than awake and fainter at the back than the front", () => {
    const awake = place(dots, 0, 0, "listening");
    const asleep = place(dots, 0, 0, "asleep");
    expect(Math.max(...asleep.map((p) => p.a))).toBeLessThan(Math.max(...awake.map((p) => p.a)));
    expect(Math.min(...awake.map((p) => p.a))).toBeLessThan(Math.max(...awake.map((p) => p.a)));
  });
  it("is deterministic for the same time, so reduced motion holds still", () => {
    expect(place(dots, 1.5, 0, "listening")).toEqual(place(dots, 1.5, 0, "listening"));
  });
});

describe("place with a spectrum (W5 section 5)", () => {
  const dots = spherePoints(220);
  const flat = new Float32Array(24);
  // Screen angle of a placed dot: 0 at the bottom, 1 at the top (canvas y grows downward).
  const u = (p: { x: number; y: number }) => Math.atan2(Math.abs(p.x), p.y) / Math.PI;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  it("is calm with a quiet spectrum: no spikes at all", () => {
    for (const p of place(dots, 2, 0, "speaking", [], flat)) expect(radius(p)).toBeLessThan(1.02);
  });
  it("one loud low band spikes the bottom, not the top; a high band does the opposite", () => {
    const low = new Float32Array(24);
    low[2] = 1;
    const high = new Float32Array(24);
    high[21] = 1;
    // How far each dot moved out against the same frame with a quiet spectrum (its own radius, so depth cancels out).
    const quiet = place(dots, 2, 0.5, "speaking", [], flat).map((p) => ({ ...p }));
    const at = (bands: Float32Array) => place(dots, 2, 0.5, "speaking", [], bands).map((p, i) => ({ grow: radius(p) / radius(quiet[i]), u: u(p) }));
    const lowSpike = at(low);
    expect(mean(lowSpike.filter((d) => Math.abs(d.u - 2 / 23) < 0.025).map((d) => d.grow))).toBeGreaterThan(1.12);
    expect(mean(lowSpike.filter((d) => d.u > 0.4).map((d) => d.grow))).toBeLessThan(1.01);
    const highSpike = at(high);
    expect(mean(highSpike.filter((d) => Math.abs(d.u - 21 / 23) < 0.025).map((d) => d.grow))).toBeGreaterThan(1.12);
    expect(mean(highSpike.filter((d) => d.u < 0.6).map((d) => d.grow))).toBeLessThan(1.01);
  });
  it("two voices with different spectra make different shapes (not one animation)", () => {
    const a = new Float32Array(24).map((_, i) => (i < 8 ? 0.9 : 0.1));
    const b = new Float32Array(24).map((_, i) => (i > 14 ? 0.9 : 0.1));
    const ra = place(dots, 1, 0.6, "speaking", [], a).map(radius);
    const rb = place(dots, 1, 0.6, "speaking", [], b).map(radius);
    expect(mean(ra.map((r, i) => Math.abs(r - rb[i])))).toBeGreaterThan(0.05);
  });
  it("stays inside the box at full scale", () => {
    for (const p of place(dots, 3.3, 1, "speaking", [], new Float32Array(24).fill(1))) expect(radius(p)).toBeLessThan(1.32);
  });
  it("bandAt eases between neighbours and clamps", () => {
    expect(bandAt([0, 1], 0)).toBe(0);
    expect(bandAt([0, 1], 1)).toBe(1);
    expect(bandAt([0, 1], 0.5)).toBeCloseTo(0.5, 6);
    expect(bandAt([0, 1], 2)).toBe(1);
    expect(bandAt([], 0.5)).toBe(0);
  });
});

describe("driveLevel", () => {
  it("lets Thinking move on its own and Asleep not at all", () => {
    expect(driveLevel("thinking", 0, 1)).toBeGreaterThan(0.1);
    expect(driveLevel("asleep", 0.9, 1)).toBe(0);
    expect(driveLevel("speaking", 0.6, 1)).toBe(0.6);
  });
});

describe("frameDelay", () => {
  it("naps asleep only once the ripple from before sleep has settled", () => {
    // Speaking at 0.6, then Asleep: the ripple decays at 60 fps (frames 0 ms apart), then the orb naps.
    let lv = 0.6;
    let frames = 0;
    while (frameDelay("asleep", lv) === 0) {
      lv += (driveLevel("asleep", 0, 0) - lv) * 0.25;
      frames++;
    }
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(20); // about 0.25 s at 60 fps
    expect(frameDelay("asleep", lv)).toBe(ASLEEP_MS);
    expect(frameDelay("asleep", 0)).toBe(ASLEEP_MS);
  });
  it("never naps awake", () => {
    for (const st of ["listening", "thinking", "speaking"] as const) expect(frameDelay(st, 0)).toBe(0);
  });
});

describe("the wake look (texture, no color)", () => {
  const dots = spherePoints(220);
  const maxR = (ps: { x: number; y: number }[]) => Math.max(...ps.map(radius));
  const meanA = (ps: { a: number }[]) => ps.reduce((n, p) => n + p.a, 0) / ps.length;

  it("the burst: 0 at the wake, near its peak early, easing back, gone at 900 ms and after", () => {
    expect(wakeBurst(0)).toBe(0);
    expect(wakeBurst(100)).toBeGreaterThan(0.9);
    expect(wakeBurst(300)).toBeCloseTo(0.482, 2);
    expect(wakeBurst(600)).toBeCloseTo(0.06, 2);
    expect(wakeBurst(900)).toBe(0);
    expect(wakeBurst(1200)).toBe(0);
    expect(wakeBurst(-50)).toBe(0);
    expect(wakeBurst(Number.NaN)).toBe(0);
    // Monotone after the peak: it only eases back.
    for (let ms = 140; ms < WAKE_MS; ms += 20) expect(wakeBurst(ms + 20)).toBeLessThanOrEqual(wakeBurst(ms));
  });

  it("swells the shell up to +10 % and lifts every dot to full alpha at the peak, then is exactly the plain orb", () => {
    const plain = place(dots, 2, 0, "listening").map((p) => ({ ...p }));
    const peak = place(dots, 2, 0, "listening", [], null, { ms: 135, awake: true }).map((p) => ({ ...p }));
    expect(maxR(peak) / maxR(plain)).toBeGreaterThan(1.09);
    expect(maxR(peak) / maxR(plain)).toBeLessThan(1.101);
    expect(Math.min(...peak.map((p) => p.a))).toBeGreaterThan(0.99);
    expect(place(dots, 2, 0, "listening", [], null, { ms: WAKE_MS, awake: false })).toEqual(plain);
    for (const p of peak) expect(radius(p)).toBeLessThan(1.3); // still inside the canvas
  });

  it("a voice at the wake: the swell never takes a full spike past its plain reach (no dot cut by the canvas edge)", () => {
    const loud = new Float32Array(24).fill(1);
    for (let t = 0; t < 7; t += 0.25) {
      const plain = maxR(place(dots, t, 1, "listening", [], loud));
      for (let ms = 0; ms <= WAKE_MS; ms += 15) {
        const woke = maxR(place(dots, t, 1, "listening", [], loud, { ms, awake: true }));
        expect(woke).toBeLessThanOrEqual(Math.max(plain, 1 + SPIKE) + 1e-9);
        expect(woke).toBeLessThan(1.32); // the box the canvas leaves for it
      }
    }
    // Without a voice the swell is untouched: still up to +10 %.
    expect(maxR(place(dots, 2, 0, "listening", [], null, { ms: 135, awake: true })) / maxR(place(dots, 2, 0, "listening"))).toBeGreaterThan(1.09);
  });

  it("a ring runs out from the center over 600 ms and grows the dots it passes by up to 40 %", () => {
    expect(wakeRing(0)).toBe(0);
    expect(wakeRing(300)!).toBeGreaterThan(0.5);
    expect(wakeRing(RING_MS)).toBeNull();
    const plain = place(dots, 2, 0, "listening").map((p) => p.r);
    const mid = place(dots, 2, 0, "listening", [], null, { ms: 300, awake: true });
    const grow = mid.map((p, i) => p.r / plain[i]);
    expect(Math.max(...grow)).toBeGreaterThan(1.3);
    expect(Math.max(...grow)).toBeLessThanOrEqual(1.4 + 1e-9);
    expect(Math.min(...grow)).toBeCloseTo(1, 6); // dots away from the ring keep their size
  });

  it("the ring ends past the rim: the dots it grew are back to size before it stops, with no step at 600 ms", () => {
    const plain = place(dots, 2, 0, "listening").map((p) => p.r);
    const maxGrow = (ms: number) => Math.max(...place(dots, 2, 0, "listening", [], null, { ms, awake: true }).map((p, i) => p.r / plain[i] - 1));
    expect(maxGrow(RING_MS - 1)).toBeLessThan(0.01);
    // Frame to frame (16 ms) from the first frame on (the wake itself is the onset), no dot jumps by more than a few percent.
    for (let ms = 32; ms < RING_MS + 32; ms += 16) expect(Math.abs(maxGrow(ms) - maxGrow(ms - 16))).toBeLessThan(0.08);
  });

  it("the shimmer: awake only, after the burst, a band that crosses the sphere every 3 s, up to SHIMMER", () => {
    const after = WAKE_MS + 1000;
    expect(shimmerAt(0, 1, WAKE_MS - 1)).toBe(0);
    const peaks = Array.from({ length: 60 }, (_, k) => shimmerAt(0, (k / 60) * SHIMMER_S, after));
    expect(Math.max(...peaks)).toBeGreaterThan(SHIMMER * 0.95);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(SHIMMER);
    expect(Math.min(...peaks)).toBeLessThan(0.01); // it passes; it is not a steady glow
    expect(shimmerAt(0.3, 0.7, after)).toBeCloseTo(shimmerAt(0.3, 0.7 + SHIMMER_S, after), 9); // every 3 s
    // At the wrap the band is off the sphere on both sides: no dot at the edge lifts in one step.
    for (const x of [-1, 1]) for (const t of [SHIMMER_S - 1e-3, SHIMMER_S]) expect(shimmerAt(x, t, after)).toBeLessThan(0.005);
    const quiet = place(dots, 1.6, 0, "listening");
    const shimmer = place(dots, 1.6, 0, "listening", [], null, { ms: after, awake: true });
    expect(meanA(shimmer)).toBeGreaterThan(meanA(quiet) + 0.01);
    // Asleep: none, even with a wake on record.
    expect(place(dots, 1.6, 0, "asleep", [], null, { ms: after, awake: false })).toEqual(place(dots, 1.6, 0, "asleep"));
  });

  it("reduced motion: a 300 ms fade from the asleep alpha to full, nothing else", () => {
    expect(wakeFade(0)).toBe(0);
    expect(wakeFade(150)).toBeCloseTo(0.5, 6);
    expect(wakeFade(300)).toBe(1);
    expect(wakeFade(5000)).toBe(1);
  });
});
