/**
 * View-count display (ported from Ripple lib/format-views.ts).
 *
 * A post with no reading yet must never render as a measured "0 views": that
 * reads as "earned nothing" on a video nobody measured. Use `formatViewCount`
 * for ONE post's views (0 or unusable → em dash). Use `formatCompactCount` for
 * likes, comments and any total, where zero is a real value.
 */

/** Rendered in place of a view count for a post without a reading. */
export const NO_VIEW_READING = "—";

const COMPACT_UNITS = [
  { div: 1_000_000_000, suffix: "B" },
  { div: 1_000_000, suffix: "M" },
  { div: 1_000, suffix: "K" },
] as const;

/** Compact count: "1.2M", "9.4K", "412". A 0 renders as "0". */
export function formatCompactCount(n: number): string {
  for (const { div, suffix } of COMPACT_UNITS) {
    // The threshold is the ROUNDING boundary: 999,950 must print "1.0M", not
    // "1000.0K". `div * 0.99995` is the smallest value that rounds to 1000.0.
    if (n >= div * 0.99995) return `${(n / div).toFixed(1)}${suffix}`;
  }
  return String(n);
}

/** ONE post's view count: anything but a positive finite count is NO_VIEW_READING. */
export function formatViewCount(viewCount: number | null | undefined): string {
  if (typeof viewCount !== "number" || !Number.isFinite(viewCount) || viewCount <= 0) {
    return NO_VIEW_READING;
  }
  return formatCompactCount(viewCount);
}
