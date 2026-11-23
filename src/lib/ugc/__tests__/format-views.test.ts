/**
 * The read-side half of the fabricated-zero guard.
 *
 * The metric write guards (`buildPfmMetricsUpdate` in
 * lib/providers/post-for-me.ts) guarantee `PlatformPost.viewCount` is only
 * ever written from a POSITIVE provider reading, so a stored 0 always means
 * "no reading has ever landed" and never "measured, and it was zero". These
 * are money-path assertions: 269 live campaigns price on views, and 2591
 * production rows sat in exactly that state on 2026-08-24, so a per-post
 * surface that prints "0" tells a brand a creator earned nothing on a video
 * nobody ever measured.
 */
import { describe, it, expect } from "vitest";
import {
  formatCompactCount,
  formatViewCount,
  NO_VIEW_READING,
} from "@/lib/ugc/format-views";

describe("formatViewCount", () => {
  it("NEVER renders a missing reading as the digit zero", () => {
    const rendered = formatViewCount(0);
    expect(rendered).not.toBe("0");
    expect(rendered).not.toMatch(/\d/);
    expect(rendered).toBe(NO_VIEW_READING);
  });

  it("treats every other unusable value as a missing reading too", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(formatViewCount(bad as number)).toBe(NO_VIEW_READING);
    }
  });

  it("renders a real reading as a compact number", () => {
    expect(formatViewCount(1)).toBe("1");
    expect(formatViewCount(412)).toBe("412");
    expect(formatViewCount(999)).toBe("999");
    expect(formatViewCount(9_400)).toBe("9.4K");
    expect(formatViewCount(1_200_000)).toBe("1.2M");
  });

  it("keeps the smallest real reading distinguishable from a missing one", () => {
    expect(formatViewCount(1)).not.toBe(formatViewCount(0));
  });
});

/**
 * The unit must CARRY when one decimal place rounds up to a full 1000 of the
 * unit below. Picking the unit off the raw value and rounding afterwards
 * printed "1000.0K" for 999,950 — four digits before the suffix, which no
 * compact formatter should ever emit, and which reads as a thousand thousand.
 */
describe("formatCompactCount unit carry", () => {
  it("carries into the next unit instead of printing four digits", () => {
    expect(formatCompactCount(999_950)).toBe("1.0M");
    expect(formatCompactCount(999_999)).toBe("1.0M");
    expect(formatCompactCount(999_999_950)).toBe("1.0B");
  });

  it("never emits a value of 1000 or more before the suffix", () => {
    for (const n of [999, 1_000, 999_949, 999_950, 999_999_949, 999_999_950]) {
      expect(formatCompactCount(n)).not.toMatch(/^\d{4}/);
    }
  });

  it("leaves everything below the rounding boundary alone", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(412)).toBe("412");
    expect(formatCompactCount(999)).toBe("999");
    expect(formatCompactCount(1_000)).toBe("1.0K");
    expect(formatCompactCount(9_400)).toBe("9.4K");
    expect(formatCompactCount(999_949)).toBe("999.9K");
    expect(formatCompactCount(1_200_000)).toBe("1.2M");
    expect(formatCompactCount(999_949_999)).toBe("999.9M");
    expect(formatCompactCount(2_500_000_000)).toBe("2.5B");
  });
});
