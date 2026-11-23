// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sliceFills } from "./report-tabs";

const R = (n: number) => `var(--ramp-${n})`;

describe("donut slice fills", () => {
  it("with no category colors, the slices keep the gray ramp in its paint order", () => {
    expect(sliceFills([null, null, null], false)).toEqual([R(1), R(3), R(4)]);
    expect(sliceFills([null, null, null, null, null, null], true)).toEqual([R(1), R(3), R(4), R(2), R(5), R(6)]);
  });

  it("an uncolored slice never takes a gray a colored one already wears", () => {
    // Taxes is set to Ink (#1d1d1f = --ramp-1); Housing, the largest, has no color.
    const fills = sliceFills([null, "#1D1D1F", null], false);
    expect(fills).toEqual([R(3), "#1d1d1f", R(4)]);
    expect(new Set(fills).size).toBe(3);
  });

  it("two categories with the same color: the later one falls back to a free gray", () => {
    expect(sliceFills(["#4f7cb8", "#4f7cb8", null], false)).toEqual(["#4f7cb8", R(1), R(3)]);
  });

  it('"The rest" takes the lightest gray nobody wears', () => {
    const fills = sliceFills(["#e5e5ea", null, null, null, null, null], true);
    expect(fills[5]).toBe(R(5));
    expect(new Set(fills).size).toBe(6);
  });
});
