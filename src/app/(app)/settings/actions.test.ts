// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Businesses actions against an in-memory stand-in for the owner's Supabase client: owner check, input
 * checks, the slug, the UGC Schedule C map copy, Personal guards, and "In use: close it instead".
 */

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  owner: true,
  entities: [] as Record<string, unknown>[],
  map: [] as Record<string, unknown>[],
  inUse: new Set<string>(),
  writes: [] as { table: string; op: string; value: unknown }[],
  error: null as null | { code: string; message: string },
  /** An error only for writes to category_tax_lines (the map copy). */
  mapError: null as null | { code: string; message: string },
}));

function builder(table: string) {
  let op = "select";
  let value: unknown = null;
  const filters: [string, unknown][] = [];
  let single = false;
  const rows = () => (table === "entities" ? db.entities : db.map).filter((r) => filters.every(([k, v]) => r[k] === v));
  const q = {
    select: () => q,
    order: () => q,
    eq: (k: string, v: unknown) => (filters.push([k, v]), q),
    single: () => ((single = true), q),
    insert: (v: unknown) => ((op = "insert"), (value = v), q),
    update: (v: unknown) => ((op = "update"), (value = v), q),
    delete: () => ((op = "delete"), q),
    then(resolve: (r: { data: unknown; error: unknown }) => void) {
      if (op !== "select") db.writes.push({ table, op, value });
      if (db.error && op !== "select") return resolve({ data: null, error: db.error });
      if (db.mapError && table !== "entities" && op !== "select") return resolve({ data: null, error: db.mapError });
      if (op === "insert") {
        const list = ([] as Row[]).concat(value as Row);
        if (table === "entities") {
          const row = { id: gid(100 + db.entities.length), status: "active", closed_on: null, ...list[0] };
          db.entities.push(row);
          return resolve({ data: single ? { id: row.id } : [row], error: null });
        }
        db.map.push(...list);
        return resolve({ data: null, error: null });
      }
      if (op === "update") {
        rows().forEach((r) => Object.assign(r, value));
        return resolve({ data: null, error: null });
      }
      if (op === "delete") {
        const gone = new Set(rows());
        db.entities = db.entities.filter((r) => !gone.has(r));
        return resolve({ data: null, error: null });
      }
      return resolve({ data: rows(), error: null });
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    from: builder,
    rpc: async (fn: string) =>
      fn === "is_owner"
        ? { data: db.owner, error: null }
        : { data: db.entities.map((e) => ({ id: e.id, in_use: db.inUse.has(e.id as string), accounts: 0 })), error: null },
  }),
}));

const actions = await import("./actions");

function gid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const ID: Record<string, string> = { personal: gid(1), ugc: gid(2), ugm: gid(3), north: gid(4) };
const idOf = (slug: string) => (db.entities.find((e) => e.slug === slug)?.id as string) ?? ID[slug];

const entity = (slug: string, name: string, kind = "business", tax_shape: string | null = "sole_prop", status = "active") => ({
  id: ID[slug],
  slug,
  name,
  kind,
  tax_shape,
  status,
  closed_on: null,
});

beforeEach(() => {
  db.owner = true;
  db.entities = [entity("personal", "Personal", "personal", null), entity("ugc", "UGC"), entity("ugm", "UGM LLC", "business", "llc", "closed")];
  db.map = [
    { category_id: "c1", tax_line_id: "t18", entity_id: ID.ugc },
    { category_id: "c2", tax_line_id: "t22", entity_id: ID.ugc },
  ];
  db.inUse = new Set([ID.personal, ID.ugc, ID.ugm]);
  db.writes = [];
  db.error = null;
  db.mapError = null;
});

describe("addBusiness", () => {
  it("adds with a slug from the name and copies UGC's Schedule C map for a sole proprietor", async () => {
    const r = await actions.addBusiness({ name: " Studio Co ", taxShape: "sole_prop" });
    expect(r).toMatchObject({ ok: true, data: { slug: "studio-co", name: "Studio Co", kind: "business", taxShape: "sole_prop", status: "active" } });
    expect(db.map.filter((m) => m.entity_id === idOf("studio-co"))).toEqual([
      { category_id: "c1", tax_line_id: "t18", entity_id: idOf("studio-co") },
      { category_id: "c2", tax_line_id: "t22", entity_id: idOf("studio-co") },
    ]);
  });

  it("a failed map copy takes the new business back, so a retry with the same name works", async () => {
    db.mapError = { code: "XX000", message: "copy failed" };
    expect(await actions.addBusiness({ name: "Studio Co", taxShape: "sole_prop" })).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(db.entities.some((e) => e.slug === "studio-co")).toBe(false);
    db.mapError = null;
    expect(await actions.addBusiness({ name: "Studio Co", taxShape: "sole_prop" })).toMatchObject({ ok: true, data: { slug: "studio-co" } });
  });

  it("an S corp gets no Schedule C map", async () => {
    expect((await actions.addBusiness({ name: "Corp", taxShape: "s_corp" })).ok).toBe(true);
    expect(db.map.some((m) => m.entity_id === idOf("corp"))).toBe(false);
  });

  it("a taken name is refused, case and spaces aside; a taken slug gets -2", async () => {
    expect(await actions.addBusiness({ name: "ugc ", taxShape: "llc" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    db.entities.push(entity("north", "Old North", "business", "llc", "closed"));
    expect(await actions.addBusiness({ name: "North", taxShape: "llc" })).toMatchObject({ ok: true, data: { slug: "north-2" } });
  });

  it.each([{ name: "", taxShape: "llc" }, { name: "x".repeat(61), taxShape: "llc" }, { name: "Ok", taxShape: "corp" }])("refuses %o before the database", async (input) => {
    expect(await actions.addBusiness(input as never)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(db.writes).toEqual([]);
  });

  it("refuses a caller who is not the owner", async () => {
    db.owner = false;
    expect(await actions.addBusiness({ name: "Studio", taxShape: "llc" })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(db.writes).toEqual([]);
  });
});

describe("updateBusiness", () => {
  it("renames and changes the tax type, never the slug", async () => {
    const r = await actions.updateBusiness({ id: ID.ugc, name: "UGC Studio", taxShape: "llc" });
    expect(r).toMatchObject({ ok: true, data: { slug: "ugc", name: "UGC Studio", taxShape: "llc" } });
    expect(db.writes.at(-1)).toEqual({ table: "entities", op: "update", value: { name: "UGC Studio", tax_shape: "llc" } });
  });
  it("Personal takes a name but no tax type", async () => {
    expect(await actions.updateBusiness({ id: ID.personal, name: "Me" })).toMatchObject({ ok: true, data: { name: "Me" } });
    expect(await actions.updateBusiness({ id: ID.personal, taxShape: "llc" })).toMatchObject({ ok: false, error: { message: "Personal has no tax type" } });
  });
  it("nothing to change, or another business's name, is refused", async () => {
    expect(await actions.updateBusiness({ id: ID.ugc })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await actions.updateBusiness({ id: ID.ugc, name: "personal" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("close, reopen, delete", () => {
  it("closes and reopens a business", async () => {
    expect(await actions.closeBusiness({ id: ID.ugc })).toMatchObject({ ok: true, data: { status: "closed" } });
    expect(await actions.reopenBusiness({ id: ID.ugc })).toMatchObject({ ok: true, data: { status: "active" } });
  });
  it("Personal is never closed or deleted", async () => {
    expect(await actions.closeBusiness({ id: ID.personal })).toMatchObject({ ok: false, error: { message: "Personal cannot be closed" } });
    expect(await actions.deleteBusiness({ id: ID.personal })).toMatchObject({ ok: false, error: { message: "Personal cannot be deleted" } });
    expect(db.writes).toEqual([]);
  });
  it("a business in use cannot be deleted: close it instead", async () => {
    expect(await actions.deleteBusiness({ id: ID.ugc })).toEqual({ ok: false, error: { code: "in_use", message: "In use: close it instead" } });
    expect(db.entities.some((e) => e.id === ID.ugc)).toBe(true);
  });
  it("the database's in-use refusal reads the same", async () => {
    db.inUse.delete(ID.ugm);
    db.error = { code: "23503", message: "In use: close it instead" };
    expect(await actions.deleteBusiness({ id: ID.ugm })).toEqual({ ok: false, error: { code: "in_use", message: "In use: close it instead" } });
  });
  it("an unused business is deleted", async () => {
    db.inUse.delete(ID.ugm);
    expect(await actions.deleteBusiness({ id: ID.ugm })).toMatchObject({ ok: true, data: null });
    expect(db.entities.some((e) => e.id === ID.ugm)).toBe(false);
  });
  it("an unknown id is not found", async () => {
    expect(await actions.closeBusiness({ id: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
