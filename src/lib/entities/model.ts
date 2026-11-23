/**
 * Businesses and the scope (owner, 2026-11-22: "I should be able to add busineses"). Pure rules, no I/O:
 * server pages, client components, the agent and tests share them. An entity is Personal or a business
 * (public.entities); the scope is 'all' or one entity's slug, kept in `?scope=`.
 */

/** The slug rule the database checks (0170_businesses.sql), and never "all". */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const TAX_SHAPES = ["sole_prop", "llc", "s_corp", "partnership", "other"] as const;
export type TaxShape = (typeof TAX_SHAPES)[number];
export const TAX_SHAPE_LABEL: Record<TaxShape, string> = {
  sole_prop: "Sole proprietor",
  llc: "LLC",
  s_corp: "S corp",
  partnership: "Partnership",
  other: "Other",
};

export interface Entity {
  id: string;
  slug: string;
  name: string;
  kind: "personal" | "business";
  taxShape: TaxShape | null;
  status: "active" | "closed";
  /** YYYY-MM-DD the business closed; null while active. */
  closedOn: string | null;
}

/** 'all', or an entity slug. Any slug passes here; a slug with no entity simply has no rows. */
export type Scope = "all" | (string & {});

export function parseScope(value: string | null | undefined): Scope {
  return value && value !== "all" && SLUG_RE.test(value) ? value : "all";
}

/** An id no entity has: the entity filter for a slug with no entity (a typo, a deleted business), so it shows no rows, as Reports does. */
export const NO_ENTITY_ID = "00000000-0000-0000-0000-000000000000";

/** UGC deals, posts and payouts belong to UGC only: they show for All and for UGC. */
export const showsUgc = (scope: Scope) => scope === "all" || scope === "ugc";

/** Sole proprietors and single-member LLCs file Schedule C, like UGC. */
export const filesScheduleC = (shape: TaxShape | null) => shape === "sole_prop" || shape === "llc";

/** A slug from a name: lower case, dashes, at most 40, unique among `taken` (adds -2, -3 ...). */
export function slugFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  used.add("all");
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "business";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const s = `${base.slice(0, 40 - tail.length).replace(/-+$/, "")}${tail}`;
    if (!used.has(s)) return s;
  }
}

/** The switch: All, Personal, then the active businesses; a closed one shows only while it is the scope. */
export function scopeChoices(entities: readonly Entity[], current: Scope): { value: Scope; label: string; short: string }[] {
  const personal = entities.filter((e) => e.kind === "personal");
  const businesses = entities.filter((e) => e.kind === "business" && (e.status === "active" || e.slug === current));
  const cut = (name: string, n: number) => (name.length > n + 1 ? `${name.slice(0, n).trimEnd()}.` : name);
  // The shortest cut of each name (7 letters, then longer) that no other choice shares, so "North Partners" and
  // "North Pacific" read "North Par." and "North Pac." rather than both "North P.".
  const shorts = businesses.map((e) => {
    for (let n = 7; n < e.name.length; n++) {
      const s = cut(e.name, n);
      if (s === "All" || s === "Me") continue;
      if (businesses.every((o) => o === e || cut(o.name, n) !== s)) return s;
    }
    return e.name;
  });
  return [
    { value: "all", label: "All", short: "All" },
    ...personal.map((e) => ({ value: e.slug, label: e.name, short: "Me" })),
    ...businesses.map((e, i) => ({ value: e.slug, label: e.name, short: shorts[i]! })),
  ];
}

/** Personal and UGC as seeded: what a page shows before (or without) the entity list. */
export const SEEDED_ENTITIES: readonly Entity[] = [
  { id: "personal", slug: "personal", name: "Personal", kind: "personal", taxShape: null, status: "active", closedOn: null },
  { id: "ugc", slug: "ugc", name: "UGC", kind: "business", taxShape: "sole_prop", status: "active", closedOn: null },
  { id: "ugm", slug: "ugm", name: "UGM LLC", kind: "business", taxShape: "llc", status: "closed", closedOn: null },
];
