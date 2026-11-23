import { describe, expect, it } from "vitest";

import { SEEDED_ENTITIES, filesScheduleC, parseScope, scopeChoices, showsUgc, slugFor, type Entity } from "./model";

describe("parseScope", () => {
  it.each([
    ["personal", "personal"],
    ["ugc", "ugc"],
    ["studio-co", "studio-co"],
    ["all", "all"],
    [null, "all"],
    ["", "all"],
    ["Studio", "all"],
    ["-x", "all"],
    ["a".repeat(41), "all"],
    ["x;drop", "all"],
  ])("%s -> %s", (raw, want) => expect(parseScope(raw)).toBe(want));
});

describe("slugFor", () => {
  it("lower case, dashes, no accents", () => expect(slugFor("  Café Studio & Co. ", [])).toBe("cafe-studio-co"));
  it("never all", () => expect(slugFor("All", [])).toBe("all-2"));
  it("unique among taken", () => expect(slugFor("UGC", ["ugc", "ugc-2"])).toBe("ugc-3"));
  it("a name with no letters still gets a slug", () => expect(slugFor("!!!", [])).toBe("business"));
  it("at most 40, even with a suffix", () => {
    const long = "a".repeat(60);
    expect(slugFor(long, [])).toHaveLength(40);
    const second = slugFor(long, ["a".repeat(40)]);
    expect(second).toBe(`${"a".repeat(38)}-2`);
    expect(second).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });
});

describe("scope rules", () => {
  it("UGC data shows for All and UGC only", () => {
    expect(showsUgc("all")).toBe(true);
    expect(showsUgc("ugc")).toBe(true);
    expect(showsUgc("personal")).toBe(false);
    expect(showsUgc("studio-co")).toBe(false);
  });
  it("Schedule C for sole proprietors and LLCs", () => {
    expect(["sole_prop", "llc", "s_corp", "partnership", "other", null].map((s) => filesScheduleC(s as never))).toEqual([true, true, false, false, false, false]);
  });
  it("the switch: All, Personal, active businesses; a closed one only while it is the scope", () => {
    const studio: Entity = { id: "s", slug: "studio-co", name: "Studio Co", kind: "business", taxShape: "llc", status: "active", closedOn: null };
    const list = [...SEEDED_ENTITIES, studio];
    expect(scopeChoices(list, "all").map((c) => c.value)).toEqual(["all", "personal", "ugc", "studio-co"]);
    expect(scopeChoices(list, "ugm").map((c) => c.value)).toEqual(["all", "personal", "ugc", "ugm", "studio-co"]);
    expect(scopeChoices(list, "all").map((c) => c.short)).toEqual(["All", "Me", "UGC", "Studio."]);
  });
  it("the phone's short labels never collide", () => {
    const biz = (slug: string, name: string): Entity => ({ id: slug, slug, name, kind: "business", taxShape: "llc", status: "active", closedOn: null });
    const list = [...SEEDED_ENTITIES, biz("north-partners", "North Partners"), biz("north-pacific", "North Pacific"), biz("studio-co", "Studio Co")];
    expect(scopeChoices(list, "all").map((c) => c.short)).toEqual(["All", "Me", "UGC", "North Par.", "North Pac.", "Studio."]);
  });
});
