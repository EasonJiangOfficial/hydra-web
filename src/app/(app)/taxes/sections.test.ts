import { describe, expect, it } from "vitest";

import type { Entity } from "@/lib/entities/model";

import { pickSection, taxSections, treatmentOf } from "./model";

const e = (slug: string, kind: Entity["kind"], taxShape: Entity["taxShape"], status: Entity["status"] = "active"): Entity => ({
  id: slug,
  slug,
  name: slug.toUpperCase(),
  kind,
  taxShape,
  status,
  closedOn: null,
});

describe("Taxes sections from entities", () => {
  const entities = [
    e("personal", "personal", null),
    e("ugc", "business", "sole_prop"),
    e("ugm", "business", "llc", "closed"),
    e("studio", "business", "llc"),
    e("north", "business", "partnership"),
    e("old", "business", "s_corp", "closed"),
  ];

  it("active businesses, Personal, then closed businesses that still have data", () => {
    const sections = taxSections(entities, (id) => id !== "old");
    expect(sections.map((s) => s.slug)).toEqual(["ugc", "studio", "north", "personal", "ugm"]);
    expect(sections.find((s) => s.slug === "ugm")).toMatchObject({ closed: true, treatment: "schedule_c" });
  });

  it("sole proprietors and LLCs get Schedule C; S corps, partnerships and other get the summary", () => {
    expect(entities.map(treatmentOf)).toEqual(["personal", "schedule_c", "schedule_c", "schedule_c", "summary", "summary"]);
  });

  it("an entity the switch does not offer falls back to UGC, then the first section", () => {
    const sections = taxSections(entities, () => true);
    expect(pickSection(sections, "north").slug).toBe("north");
    expect(pickSection(sections, "nope").slug).toBe("ugc");
    expect(pickSection(sections.filter((s) => s.slug !== "ugc"), "nope").slug).toBe("studio");
  });
});
