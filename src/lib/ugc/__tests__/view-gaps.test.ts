import { describe, expect, it } from "vitest";
import { viewGapWarning } from "@/lib/ugc/view-gaps";

describe("missed-day view warning", () => {
  it("is null when every open post was read", () => {
    expect(viewGapWarning([])).toBeNull();
    expect(viewGapWarning([{ day: "2026-11-20", needing: 3, read: 3 }])).toBeNull();
  });
  it("counts the days with a gap and lists each one, oldest first", () => {
    expect(
      viewGapWarning([
        { day: "2026-11-20", needing: 6, read: 0 },
        { day: "2026-11-19", needing: 6, read: 4 },
        { day: "2026-11-18", needing: 1, read: 0 },
      ]),
    ).toEqual({
      title: "Views missing for 3 days",
      lines: ["Nov 18: 0 of 1 post read", "Nov 19: 4 of 6 posts read", "Nov 20: 0 of 6 posts read"],
    });
    expect(viewGapWarning([{ day: "2026-12-31", needing: 2, read: 1 }])?.title).toBe("Views missing for 1 day");
  });
});
