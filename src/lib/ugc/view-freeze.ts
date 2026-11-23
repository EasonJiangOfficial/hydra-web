/**
 * View counting window (ported from Ripple lib/view-freeze.ts + view-freeze-defaults.ts).
 *
 * A post older than its deal's freeze window stops counting views: pay uses the
 * last reading captured inside the window, and the set-views action refuses a
 * reading captured after it. Resolution: deal value (1-365) → caller-supplied
 * fallback → 14 days. The SQL view `ugc_post_views` applies the same cutoff
 * (`posted_at + freeze days`), so pay and writes agree.
 */

/** Default counting window in days (Ripple's site default). */
export const DEFAULT_VIEW_FREEZE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deal override (1-365) → fallback → 14. Invalid or below-1 deal values (null,
 * undefined, <1, NaN) inherit; values above 365 clamp to 365.
 */
export function resolveViewFreezeDays(
  dealDays: number | null | undefined,
  fallbackDays?: number | null,
): number {
  if (typeof dealDays === "number" && Number.isFinite(dealDays) && dealDays >= 1) {
    return Math.min(365, Math.floor(dealDays));
  }
  if (typeof fallbackDays === "number" && Number.isFinite(fallbackDays) && fallbackDays >= 1) {
    return Math.min(365, Math.floor(fallbackDays));
  }
  return DEFAULT_VIEW_FREEZE_DAYS;
}

/** The last instant a reading still counts: postedAt + freeze days of exactly 24 h (SQL: `posted_at + make_interval(hours => 24 * days)`). */
export function freezeCutoff(postedAt: Date, freezeDays: number | null | undefined): Date {
  return new Date(postedAt.getTime() + resolveViewFreezeDays(freezeDays) * DAY_MS);
}

/** True when a reading captured at `capturedAt` falls after the window and must not count. */
export function isViewsFrozen(
  postedAt: Date,
  freezeDays: number | null | undefined,
  capturedAt: Date,
): boolean {
  return capturedAt.getTime() > freezeCutoff(postedAt, freezeDays).getTime();
}
