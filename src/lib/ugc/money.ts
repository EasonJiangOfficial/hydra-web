/**
 * Money helpers (ported from Ripple lib/money.ts, Prisma.Decimal swapped for decimal.js).
 *
 * Hydra stores money as integer cents (bigint) in Postgres. Pay math runs in
 * decimal.js dollars, exactly as Ripple's did, and converts at the boundary:
 *   - cents from the database → dollars for the pay math: `centsToDollars`.
 *   - a computed dollar amount → cents for storage or display: `toCents`.
 * NEVER do `+ - * /` or `=== !==` on raw Decimal values; use the Decimal methods.
 */
import Decimal from "decimal.js";

export { Decimal };

/** A value that may be a Decimal, a plain number, or null/undefined. */
export type MaybeDecimal = Decimal | number | null | undefined;

/**
 * Convert a (possibly Decimal) money value to a plain JS number.
 * `null`/`undefined` collapse to 0. Callers that must tell "no value" from
 * "zero" use `toNumOrNull`.
 */
export function toNum(value: MaybeDecimal): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return value.toNumber();
}

/** Like `toNum` but keeps null/undefined as `null`. */
export function toNumOrNull(value: MaybeDecimal): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return value.toNumber();
}

/** Build a Decimal from a number or string. */
export function toDecimal(value: number | string | Decimal): Decimal {
  return new Decimal(value);
}

/**
 * Round a plain-number money value to whole cents (display-side float sums
 * can drift to values like 0.30000000000000004).
 */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Dollars (number or Decimal) → integer cents, half-up. Non-finite → 0. */
export function toCents(dollars: MaybeDecimal): number {
  if (dollars === null || dollars === undefined) return 0;
  if (typeof dollars === "number" && !Number.isFinite(dollars)) return 0;
  return new Decimal(dollars).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** Integer cents → dollars as a plain number (exact for any cents < 2^53). */
export function centsToDollars(cents: number): number {
  return new Decimal(cents).div(100).toNumber();
}

/** Nullable cents → nullable dollars (null keeps "no component on this deal"). */
export function centsToDollarsOrNull(cents: number | null | undefined): number | null {
  return cents === null || cents === undefined ? null : centsToDollars(cents);
}
