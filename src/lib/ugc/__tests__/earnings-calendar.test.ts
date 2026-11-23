/**
 * Finances money-calendar bucketing. Pinned:
 *  - local YYYY-MM-DD (same as finances CSV / thisMonth)
 *  - bonusDelta lands on the deal's latest contributing day
 *  - a $0 row with no views and no override is UNKNOWN, never a painted $0
 *  - best week is 7 consecutive in-month days, skipped if any day is unknown
 */
import { describe, it, expect } from "vitest";
import {
  buildEarningsCalendar,
  isRowEarningsUnknown,
  formatDayMoney,
  type CalendarCampaignLine,
  type CalendarEarningRow,
} from "@/lib/ugc/earnings-calendar";

const NOW = new Date("2026-08-24T18:00:00");

function row(
  partial: Partial<CalendarEarningRow> & { postedAt: string },
): CalendarEarningRow {
  return {
    campaignId: "deal-1",
    campaignName: "Glow",
    description: "hook take",
    totalViews: 0,
    cpm: 0,
    basePay: 0,
    bonus: 0,
    totalEarned: 0,
    tier: null,
    excluded: false,
    ...partial,
  };
}

const glowLine: CalendarCampaignLine = {
  campaignId: "deal-1",
  campaignName: "Glow",
  bonusDelta: 0,
  totalEarned: 0,
};

describe("isRowEarningsUnknown", () => {
  it("a $0 row with no views and no override is unknown", () => {
    expect(isRowEarningsUnknown(row({ postedAt: "2026-08-10T12:00:00" }))).toBe(
      true,
    );
  });

  it("an override or a positive view count is known", () => {
    expect(
      isRowEarningsUnknown(
        row({ postedAt: "2026-08-10T12:00:00", isManualOverride: true }),
      ),
    ).toBe(false);
    expect(
      isRowEarningsUnknown(
        row({ postedAt: "2026-08-10T12:00:00", totalViews: 12 }),
      ),
    ).toBe(false);
  });
});

describe("buildEarningsCalendar", () => {
  it("puts bonusDelta on the deal's latest contributing day", () => {
    const model = buildEarningsCalendar({
      month: "2026-08",
      now: NOW,
      thisMonth: 175,
      avgPerVideo: 87.5,
      rows: [
        row({
          postedAt: "2026-08-10T12:00:00",
          totalViews: 200,
          totalEarned: 50,
        }),
        row({
          postedAt: "2026-08-20T12:00:00",
          totalViews: 400,
          totalEarned: 75,
        }),
      ],
      lines: [
        { ...glowLine, bonusDelta: 50, totalEarned: 175 },
      ],
    });
    const tenth = model.days.find((d) => d.date === "2026-08-10");
    const twentieth = model.days.find((d) => d.date === "2026-08-20");
    expect(tenth?.earnings).toBe(50);
    expect(twentieth?.earnings).toBe(125);
    expect(model.byDeal[0]?.earnings).toBe(175);
  });

  it("does not paint a fake $0 on a never-measured video day", () => {
    const model = buildEarningsCalendar({
      month: "2026-08",
      now: NOW,
      rows: [row({ postedAt: "2026-08-12T12:00:00" })],
      lines: [glowLine],
    });
    const day = model.days.find((d) => d.date === "2026-08-12");
    expect(day?.earnings).toBeNull();
    expect(day?.isPaid).toBe(false);
    expect(formatDayMoney(day?.earnings ?? null)).toBe("—");
  });

  it("skips a 7-day stretch that contains an unknown day", () => {
    const rows: CalendarEarningRow[] = [];
    for (let d = 1; d <= 10; d++) {
      rows.push(
        row({
          postedAt: `2026-08-${String(d).padStart(2, "0")}T12:00:00`,
          totalViews: d === 4 ? 0 : 100,
          totalEarned: d === 4 ? 0 : 10,
        }),
      );
    }
    const model = buildEarningsCalendar({
      month: "2026-08",
      now: NOW,
      rows,
      lines: [glowLine],
    });
    expect(model.highlights.bestWeek).not.toBeNull();
    expect(model.highlights.bestWeek?.start).toBe("2026-08-05");
    expect(model.highlights.bestWeek?.earnings).toBe(60);
  });

  it("marks today and carries only the highlights the view renders", () => {
    const model = buildEarningsCalendar({
      month: "2026-08",
      now: NOW,
      rows: [
        row({
          postedAt: "2026-08-02T12:00:00",
          totalViews: 50,
          totalEarned: 20,
        }),
      ],
      lines: [{ ...glowLine, totalEarned: 20 }],
    });
    // Paid days / Top video were replaced by Projected income and Income
    // earned so far (owner, 2026-10-19): nothing reads them, so none computed.
    expect(Object.keys(model.highlights).sort()).toEqual(["bestDay", "bestWeek"]);
    expect(model.days.find((d) => d.date === "2026-08-24")?.isToday).toBe(true);
  });

  it("counts unpaid synced posts in content metrics without adding them to money", () => {
    const model = buildEarningsCalendar({
      month: "2026-08",
      now: NOW,
      thisMonth: 20,
      rows: [
        row({
          postedAt: "2026-08-10T12:00:00",
          totalViews: 50,
          totalEarned: 20,
        }),
      ],
      contentRows: [
        row({
          postedAt: "2026-08-10T12:00:00",
          totalViews: 50,
          totalEarned: 20,
        }),
        row({
          postedAt: "2026-08-24T09:00:00",
          totalViews: 400,
          totalEarned: 0,
          description: "organic hook",
          campaignName: "Glow",
        }),
      ],
      lines: [{ ...glowLine, totalEarned: 20 }],
    });
    const tenth = model.days.find((d) => d.date === "2026-08-10");
    const today = model.days.find((d) => d.date === "2026-08-24");
    expect(tenth?.earnings).toBe(20);
    expect(tenth?.videoCount).toBe(1);
    expect(today?.earnings).toBe(0);
    expect(today?.videoCount).toBe(1);
    expect(model.sidebar.postsToday).toBe(1);
    expect(model.sidebar.viewsToday).toBe(400);
    expect(model.sidebar.thisMonth).toBe(20);
  });
});
