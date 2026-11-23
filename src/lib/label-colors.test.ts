import { describe, expect, it } from "vitest";

import { LABEL_PALETTE, categoryColor, colorName, contrast, normalizeHex, pillColors } from "./label-colors";

describe("label palette", () => {
  it("has 18 distinct named swatches, three rows of six", () => {
    expect(LABEL_PALETTE).toHaveLength(18);
    expect(new Set(LABEL_PALETTE.map((c) => c.hex)).size).toBe(18);
    expect(new Set(LABEL_PALETTE.map((c) => c.name)).size).toBe(18);
    for (const c of LABEL_PALETTE) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("holds every seeded status and option color, so seeded labels are ringed and named", () => {
    // supabase/migrations/0040_planning.sql: statuses (lines 32-35) and Priority options (lines 818-821).
    const seeds = ["#c7c7cc", "#1d1d1f", "#6e6e73", "#8e8e93", "#424245", "#a1a1a6"];
    for (const hex of seeds) expect(colorName(hex), hex).not.toBe(hex);
    // The first row is that ramp, darkest first, so "darker means more urgent" can be picked back.
    expect(LABEL_PALETTE.slice(0, 6).map((c) => c.hex)).toEqual(["#1d1d1f", "#424245", "#6e6e73", "#8e8e93", "#a1a1a6", "#c7c7cc"]);
  });

  it("pill text reads at 4.5:1 or better on every swatch's tint (computed)", () => {
    for (const c of LABEL_PALETTE) {
      const p = pillColors(c.hex);
      expect(contrast(p.color, p.background), c.name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("any custom color still gets readable pill text", () => {
    for (const hex of ["#ffff00", "#00ff00", "#ffffff", "#000000", "#ff0000", "#b3261e", "#e5e5ea", "#7fdbff"]) {
      const p = pillColors(hex);
      expect(contrast(p.color, p.background), hex).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("every swatch shows as a dot on white and on the dark hero card", () => {
    // A dot needs 1.4:1 against at least one of the two backgrounds it sits on; the two darkest seed
    // grays (Ink, Charcoal) are for white only.
    for (const c of LABEL_PALETTE) {
      expect(Math.max(contrast(c.hex, "#ffffff"), contrast(c.hex, "#1d1d1f")), c.name).toBeGreaterThanOrEqual(1.4);
      if (c.name !== "Ink" && c.name !== "Charcoal") expect(contrast(c.hex, "#1d1d1f"), c.name).toBeGreaterThanOrEqual(2);
    }
  });

  it("the rose is not the overdue and loss red", () => {
    const rose = LABEL_PALETTE.find((c) => c.name === "Rose")!;
    expect(rose.hex).not.toBe("#b3261e");
    expect(contrast(rose.hex, "#b3261e")).toBeGreaterThan(1.5);
  });

  it("contrast matches WCAG's reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("normalizes hex input and names colors", () => {
    expect(normalizeHex("ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #4F7CB8 ")).toBe("#4f7cb8");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
    expect(colorName("#4F7CB8")).toBe("Blue");
    expect(colorName("#123456")).toBe("#123456");
    expect(colorName(null)).toBe("None");
    expect(colorName("#C7C7CC")).toBe("Mist");
  });

  it("a subcategory with no color shows its parent's; its own color wins", () => {
    const cats = [
      { id: "food", color: "#4b8a8c", parent_id: null },
      { id: "coffee", color: null, parent_id: "food" },
      { id: "tea", color: "#8466ae", parent_id: "food" },
      { id: "misc", color: null, parent_id: null },
    ];
    expect(categoryColor(cats, "coffee")).toBe("#4b8a8c");
    expect(categoryColor(cats, "tea")).toBe("#8466ae");
    expect(categoryColor(cats, "misc")).toBeNull();
    expect(categoryColor(cats, null)).toBeNull();
    expect(categoryColor(cats, "gone")).toBeNull();
  });
});
