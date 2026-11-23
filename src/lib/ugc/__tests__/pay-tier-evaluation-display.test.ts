/**
 * Display attribution for COMBINED tier modes (ported from Ripple; only the
 * distributeCombinedCpm cases: video-earnings and pay-post were not ported).
 *
 * The MONEY PAID is the single combined CPM total (computeAggregatePay). This
 * suite pins the DISPLAY invariant the feature exists to protect: per-video
 * breakdown rows must sum EXACTLY to the header total, so a brand/creator never
 * sees rows that don't add up.
 *
 *   Σ row.cpmPay        == cpm.amount        (the CPM line reconciles)
 *   Σ row.attributedTotal == totalEarnings   (rows reconcile to the total)
 *
 * Worked schedule: $5/1k up to 500k, then $8/1k above.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { distributeCombinedCpm } from "@/lib/ugc/pay-cpm";

const n = (d: Decimal) => d.toNumber();

// ─── distributeCombinedCpm (exact largest-remainder) ────────────────────────
describe("distributeCombinedCpm", () => {
  const sum = (xs: Decimal[]) =>
    xs.reduce((a, b) => a + b.toNumber(), 0);

  it("splits by view share and sums EXACTLY to the total (500k/200k of $4,100)", () => {
    const parts = distributeCombinedCpm([500_000, 200_000], new Decimal(4100));
    expect(parts.map(n)).toEqual([2928.57, 1171.43]);
    expect(sum(parts)).toBe(4100);
  });

  it("3-way split that does NOT divide evenly still sums EXACTLY (remainder distributed)", () => {
    const parts = distributeCombinedCpm(
      [100_000, 200_000, 400_000],
      new Decimal(4100),
    );
    expect(sum(parts)).toBe(4100); // 585.71 + 1171.43 + 2342.86
    expect(parts.map(n)).toEqual([585.71, 1171.43, 2342.86]);
  });

  it("a 0-view contributor gets $0 and the rest still sum exactly", () => {
    const parts = distributeCombinedCpm([0, 700_000], new Decimal(4100));
    expect(n(parts[0])).toBe(0);
    expect(sum(parts)).toBe(4100);
  });

  it("degenerate inputs: empty → [], all-zero views → all $0, non-positive total → all $0", () => {
    expect(distributeCombinedCpm([], new Decimal(4100))).toEqual([]);
    expect(distributeCombinedCpm([0, 0], new Decimal(4100)).map(n)).toEqual([0, 0]);
    expect(distributeCombinedCpm([1, 2], new Decimal(0)).map(n)).toEqual([0, 0]);
  });

  it("property: an odd total over three equal shares still sums exactly", () => {
    const parts = distributeCombinedCpm([1, 1, 1], new Decimal(10.01));
    expect(sum(parts)).toBeCloseTo(10.01, 10);
    // 1001 cents / 3 = 333,334,334 → remainder distributed deterministically.
    const cents = parts.map((p) => Math.round(p.toNumber() * 100));
    expect(cents.reduce((a, b) => a + b, 0)).toBe(1001);
  });
});

// ─── distributeCombinedCpm non-finite guard (F7) ────────────────────────────
describe("distributeCombinedCpm — non-finite / negative inputs (F7)", () => {
  it("treats Infinity as a $0 share (never NaN), remaining views take the whole total", () => {
    const parts = distributeCombinedCpm([Infinity, 10], new Decimal(10.01));
    expect(parts.map(n)).toEqual([0, 10.01]);
    expect(parts.every((p) => Number.isFinite(p.toNumber()))).toBe(true);
  });

  it("treats negative and NaN views as $0 shares; the finite view takes the total", () => {
    const parts = distributeCombinedCpm([-5, NaN, 100], new Decimal(4100));
    expect(parts.map(n)).toEqual([0, 0, 4100]);
  });

  it("all-non-finite views → all $0 (no NaN leak)", () => {
    const parts = distributeCombinedCpm([Infinity, NaN, -1], new Decimal(4100));
    expect(parts.map(n)).toEqual([0, 0, 0]);
  });
});
