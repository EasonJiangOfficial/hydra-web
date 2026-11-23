/**
 * Tests for the Float→Decimal money migration (audit P1-8).
 *
 * Monetary columns are Postgres decimal(12,2), surfaced by Prisma as
 * Decimal. These tests pin down:
 *   - the lib/money.ts conversion helpers (toNum / toNumOrNull / toDecimal)
 *   - that Decimal arithmetic is exact where JS floats drift
 *   - that Decimal equality (.equals) is a correct value compare — the bug
 *     the audit flagged in closePayCycle's `existing.amount !== entry.totalPay`
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { toNum, toNumOrNull, toDecimal } from "@/lib/ugc/money";

describe("lib/money — conversion helpers", () => {
  it("toNum collapses a Decimal to a plain number", () => {
    expect(toNum(new Decimal("25.50"))).toBe(25.5);
  });

  it("toNum passes a plain number through unchanged", () => {
    expect(toNum(42.75)).toBe(42.75);
  });

  it("toNum maps null/undefined to 0", () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
  });

  it("toNumOrNull preserves null/undefined as null", () => {
    expect(toNumOrNull(null)).toBeNull();
    expect(toNumOrNull(undefined)).toBeNull();
  });

  it("toNumOrNull collapses a Decimal but keeps a real zero as 0", () => {
    expect(toNumOrNull(new Decimal("0"))).toBe(0);
    expect(toNumOrNull(new Decimal("99.99"))).toBe(99.99);
  });

  it("toDecimal builds a Decimal from a number or string", () => {
    expect(toDecimal(10).equals(new Decimal("10"))).toBe(true);
    expect(toDecimal("3.33").equals(new Decimal("3.33"))).toBe(true);
  });
});

describe("Decimal arithmetic — exactness vs JS float drift", () => {
  it("0.1 + 0.2 is exact with Decimal (the classic float bug)", () => {
    // Plain JS floats: 0.1 + 0.2 === 0.30000000000000004
    expect(0.1 + 0.2).not.toBe(0.3);
    // Decimal: exact.
    const sum = new Decimal("0.1").plus(new Decimal("0.2"));
    expect(sum.equals(new Decimal("0.3"))).toBe(true);
    expect(sum.toNumber()).toBe(0.3);
  });

  it("accumulating many per-video payments stays exact", () => {
    // 1000 videos at $0.07 each. Float accumulation drifts; Decimal does not.
    let dec = new Decimal(0);
    for (let i = 0; i < 1000; i++) dec = dec.plus("0.07");
    expect(dec.equals(new Decimal("70"))).toBe(true);
    expect(dec.toFixed(2)).toBe("70.00");
  });

  it(".minus / .times / .div behave exactly for cents", () => {
    const a = new Decimal("19.99");
    expect(a.minus("0.99").toFixed(2)).toBe("19.00");
    expect(a.times(3).toFixed(2)).toBe("59.97");
    expect(new Decimal("100").div(3).toFixed(2)).toBe("33.33");
  });

  it("Decimal.max picks the larger value (pay-cycle REPLACE mode)", () => {
    const basePay = new Decimal("25");
    const bonus = new Decimal("200");
    expect(Decimal.max(basePay, bonus).toNumber()).toBe(200);
    expect(Decimal.max(bonus, basePay).toNumber()).toBe(200);
  });
});

describe("Decimal equality — the closePayCycle idempotency-compare bug", () => {
  it(".equals is a value compare — two distinct Decimal objects of equal value match", () => {
    const a = new Decimal("150.00");
    const b = new Decimal("150");
    // Reference (`!==`) compare would be WRONG here — two objects. The audit
    // bug was `existing.amount !== entry.totalPay` doing exactly that.
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
  });

  it(".equals correctly detects a real amount drift (override edit)", () => {
    const stored = new Decimal("150.00");
    const recomputed = new Decimal("175.50");
    expect(stored.equals(recomputed)).toBe(false);
  });

  it(".lte(0) gates out zero/negative pay entries", () => {
    expect(new Decimal("0").lte(0)).toBe(true);
    expect(new Decimal("-5").lte(0)).toBe(true);
    expect(new Decimal("0.01").lte(0)).toBe(false);
  });
});

describe("Decimal serialization at API boundaries (audit P1-8)", () => {
  it("a raw Decimal JSON-stringifies to a quoted string — must convert first", () => {
    const raw = JSON.stringify({ amount: new Decimal("12.34") });
    // This is the bug: clients expecting a number get a string.
    expect(raw).toBe('{"amount":"12.34"}');
    // toNum fixes it.
    const fixed = JSON.stringify({ amount: toNum(new Decimal("12.34")) });
    expect(fixed).toBe('{"amount":12.34}');
  });
});
