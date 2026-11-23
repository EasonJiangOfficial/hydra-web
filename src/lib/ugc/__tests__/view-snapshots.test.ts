/**
 * View reading rules (replaces Ripple's prisma-mocked view-snapshots test: the
 * 20-hour throttle is gone, one reading per post per day is a unique index).
 * Lower counts, jumps held for review, and the freeze window.
 */
import { describe, it, expect } from "vitest";
import { decideViewSnapshot } from "@/lib/ugc/view-snapshots";
import { DEFAULT_VIEW_FREEZE_DAYS, freezeCutoff, isViewsFrozen, resolveViewFreezeDays } from "@/lib/ugc/view-freeze";

const POSTED = new Date("2026-11-02T15:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(POSTED.getTime() + days * DAY);

describe("decideViewSnapshot", () => {
  it.each([
    { name: "first reading", previous: null, views: 5_000_000, kind: "write" },
    { name: "higher", previous: 1_000, views: 1_500, kind: "write" },
    { name: "equal", previous: 1_000, views: 1_000, kind: "write" },
    { name: "lower is rejected", previous: 1_000, views: 999, kind: "reject_lower" },
    { name: "lower but forced", previous: 1_000, views: 999, force: true, kind: "write" },
    { name: "a jump over 10x is held", previous: 1_000, views: 10_001, kind: "hold" },
    { name: "exactly 10x is normal", previous: 1_000, views: 10_000, kind: "write" },
    { name: "early growth from a small count is never held", previous: 999, views: 50_000, kind: "write" },
    { name: "a forced jump is accepted", previous: 1_000, views: 50_000, force: true, kind: "write" },
  ])("$name", ({ previous, views, force, kind }) => {
    const d = decideViewSnapshot({
      previous: previous === null ? null : { views: previous },
      views,
      capturedAt: at(1),
      postedAt: POSTED,
      freezeDays: null,
      force,
    });
    expect(d.kind).toBe(kind);
    expect("held" in d ? d.held : null).toBe(kind === "hold" ? true : kind === "write" ? false : null);
  });

  it.each([
    { name: "inside the default 14 days", capturedAt: at(14), freezeDays: null, kind: "write" },
    { name: "1 ms after the default window", capturedAt: new Date(at(14).getTime() + 1), freezeDays: null, kind: "reject_frozen" },
    { name: "a 30-day deal still counts day 20", capturedAt: at(20), freezeDays: 30, kind: "write" },
    { name: "forcing never beats the freeze", capturedAt: at(31), freezeDays: 30, force: true, kind: "reject_frozen" },
  ])("freeze: $name", ({ capturedAt, freezeDays, force, kind }) => {
    expect(
      decideViewSnapshot({ previous: { views: 10 }, views: 20, capturedAt, postedAt: POSTED, freezeDays, force }).kind,
    ).toBe(kind);
  });
});

describe("freeze window (ported from Ripple resolveViewFreezeDays)", () => {
  it.each([
    { deal: 30, fallback: 7, days: 30 },
    { deal: 400, fallback: null, days: 365 },
    { deal: 2.9, fallback: null, days: 2 },
    { deal: null, fallback: 7, days: 7 },
    { deal: 0, fallback: 500, days: 365 },
    { deal: Number.NaN, fallback: undefined, days: DEFAULT_VIEW_FREEZE_DAYS },
    { deal: undefined, fallback: null, days: 14 },
  ])("deal $deal, fallback $fallback → $days", ({ deal, fallback, days }) => {
    expect(resolveViewFreezeDays(deal, fallback)).toBe(days);
  });

  it("the cutoff is exact 24-hour days from posting, matching the SQL view", () => {
    // Crosses the Nov 1 DST change in New York: still 14 x 24 h.
    const posted = new Date("2026-10-25T12:00:00Z");
    expect(freezeCutoff(posted, null).toISOString()).toBe("2026-11-08T12:00:00.000Z");
    expect(isViewsFrozen(posted, null, new Date("2026-11-08T12:00:00Z"))).toBe(false);
    expect(isViewsFrozen(posted, null, new Date("2026-11-08T12:00:00.001Z"))).toBe(true);
  });
});
