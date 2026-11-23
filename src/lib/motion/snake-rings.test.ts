import { describe, expect, it } from "vitest";
import { BOUNDS, CENTERS, CENTROID, FADE, HALF, LENGTH, LOOP, PHASES, R, frame, type Pt } from "./snake-rings";

const len = (pts: Pt[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const dist = (p: Pt) => Math.hypot(p[0] - CENTROID[0], p[1] - CENTROID[1]);
const maxGap = (a: Pt[], b: Pt[]) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

describe("snake-rings frame()", () => {
  it("keeps the spine length at 2 pi r through the unroll and the crawl (within 0.5%)", () => {
    for (let t = PHASES.holdEnd; t < PHASES.crawlEnd; t += 0.02) {
      for (const p of frame(t)) {
        if (!p.spine.length) continue;
        expect(Math.abs(len(p.spine) - LENGTH) / LENGTH).toBeLessThan(0.005);
      }
    }
  });

  it("is the full ring at the end of the hold: every spine point on the circle, stroke half-width", () => {
    frame(PHASES.holdEnd - 1e-9).forEach((p, i) => {
      expect(p.kind).toBe("ring");
      for (const q of p.spine) expect(Math.abs(Math.hypot(q[0] - CENTERS[i][0], q[1] - CENTERS[i][1]) - R)).toBeLessThan(0.01);
      for (const w of p.width) expect(Math.abs(w - HALF)).toBeLessThan(0.01);
    });
  });

  it("has no jump at any phase boundary", () => {
    const eps = 1e-4;
    for (const b of [PHASES.drawEnd, PHASES.holdEnd, PHASES.unrollEnd]) {
      const before = frame(b - eps);
      const after = frame(b + eps);
      before.forEach((p, i) => {
        expect(maxGap(p.spine, after[i].spine)).toBeLessThan(0.05);
        expect(Math.max(...p.width.map((w, j) => Math.abs(w - after[i].width[j])))).toBeLessThan(0.05);
        expect(Math.abs(p.opacity - after[i].opacity)).toBeLessThan(0.01);
      });
    }
    // Ring at 0.8 equals the snake just after it.
    const ring = frame(PHASES.holdEnd - eps);
    frame(PHASES.holdEnd + eps).forEach((s, i) => {
      expect(s.kind).toBe("snake");
      expect(maxGap(ring[i].spine, s.spine)).toBeLessThan(0.05);
    });
    // Fully faded at the end of the crawl, empty after it.
    for (const p of frame(PHASES.crawlEnd - eps)) expect(p.opacity).toBeLessThan(0.01);
    for (const p of frame(PHASES.crawlEnd + eps)) expect(p.d).toBe("");
  });

  it("moves every snake strictly away from the centroid during the crawl", () => {
    let prev = frame(PHASES.unrollEnd);
    for (let t = PHASES.unrollEnd + 0.02; t < PHASES.crawlEnd; t += 0.02) {
      const cur = frame(t);
      cur.forEach((p, i) => {
        const head = (s: Pt[]) => dist(s[s.length - 1]);
        const mid = (s: Pt[]) => dist([s.reduce((a, q) => a + q[0], 0) / s.length, s.reduce((a, q) => a + q[1], 0) / s.length]);
        expect(head(p.spine)).toBeGreaterThan(head(prev[i].spine));
        expect(mid(p.spine)).toBeGreaterThan(mid(prev[i].spine));
      });
      prev = cur;
    }
  });

  it("loops: the end matches the start", () => {
    expect(frame(LOOP).map((p) => p.d)).toEqual(frame(0).map((p) => p.d));
    expect(frame(LOOP - 1e-6).every((p) => p.d === "")).toBe(true);
    expect(frame(0.3 + LOOP * 3).map((p) => p.d)).toEqual(frame(0.3).map((p) => p.d));
  });

  it("never yields NaN for t in [0, 10]", () => {
    for (let t = 0; t <= 10; t += 0.01) {
      for (const p of frame(t)) {
        expect(p.d).not.toMatch(/NaN|Infinity/);
        expect(Number.isFinite(p.opacity)).toBe(true);
      }
    }
  });

  it("keeps the fade ring inside the box, so nothing clips at the edge", () => {
    const { x, y, size } = BOUNDS;
    const [cx, cy] = CENTROID;
    expect(Math.min(cx - x, x + size - cx, cy - y, y + size - cy)).toBeGreaterThan(FADE.outer);
  });
});
