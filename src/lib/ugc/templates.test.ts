import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDealFromTemplate, readTemplates, type TemplateDbRow } from "@/lib/ugc/templates";
import type { Db } from "@/lib/ugc/writes";
import type { DealDbRow } from "@/lib/ugc/schemas";

const mocks = vi.hoisted(() => ({ createDeal: vi.fn() }));
// Stand-ins so createDeal is a spy; the last describe plugs the real createDeal into it.
vi.mock("@/lib/ugc/writes", () => ({
  ok: (data: unknown) => ({ ok: true, data }),
  fail: (code: string, message: string) => ({ ok: false, error: { code, message } }),
  dbFail: (e: { message: string }) => ({ ok: false, error: { code: "db_error", message: e.message } }),
  zoneOf: async () => "UTC",
  createDeal: mocks.createDeal,
}));

const ID = "11111111-1111-4111-8111-111111111111";

const template: TemplateDbRow = {
  id: ID,
  brand_name: "Acme",
  logo_path: "ripple/acme/logo.png",
  per_deal_model: false,
  base_pay_cents: 5000,
  base_min_views: 1000,
  view_bonuses: [{ views: 10000, bonusCents: 2500 }],
  view_bonus_mode: "ADD",
  cpm_rate: "1.5" as unknown as number, // Postgres numeric arrives as a string
  cpm_view_unit: 1000,
  cpm_cap_views: null,
  cpm_min_views: 500,
  cpm_tiers: [{ views: 50000, ratePerUnit: 2 }],
  cpm_mode: "ADD",
  cpm_tier_mode: "PER_VIDEO",
  view_aggregation_mode: "HIGHEST",
  view_freeze_days: 14,
  retainer_cents: null,
  flat_rate_cents: null,
  daily_target_posts: 2,
  pay_cycle: "WEEKLY",
  pay_cycle_anchor_day: null,
  pay_cycle_anchor_weekday: 5,
  pay_cycle_anchor_days: [],
  payout_rule: { payerContains: "acme" },
  source: "ripple",
  source_id: "r-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  archived: false,
};

/** A fake Supabase client: each table answers with a fixed result; calls are logged. */
function fakeDb(opts: {
  templates?: { data: unknown; error: unknown };
  copyError?: { message: string } | null;
}) {
  const calls: { table: string; op: string; arg?: unknown }[] = [];
  const copy = vi.fn(async () => ({ error: opts.copyError ?? null }));
  const remove = vi.fn(async () => ({ error: null }));
  const db = {
    from(table: string) {
      const res = opts.templates ?? { data: null, error: null };
      const c: Record<string, unknown> = {
        then: (f: (v: unknown) => unknown) => Promise.resolve(res).then(f),
      };
      for (const op of ["select", "eq", "order", "maybeSingle", "single"]) {
        c[op] = (arg?: unknown) => (calls.push({ table, op, arg }), c);
      }
      return c;
    },
    storage: { from: () => ({ copy, remove }) },
  };
  return { db: db as unknown as Db, calls, copy, remove };
}

describe("readTemplates", () => {
  it("hides archived templates unless asked", async () => {
    const a = fakeDb({ templates: { data: [template], error: null } });
    expect(await readTemplates(a.db)).toEqual([template]);
    expect(a.calls).toContainEqual({ table: "deal_templates", op: "eq", arg: "archived" });
    const b = fakeDb({ templates: { data: [template], error: null } });
    await readTemplates(b.db, { includeArchived: true });
    expect(b.calls.some((c) => c.op === "eq")).toBe(false);
  });

  it("throws on a database error", async () => {
    const { db } = fakeDb({ templates: { data: null, error: { message: "boom" } } });
    await expect(readTemplates(db)).rejects.toThrow("UGC read failed: boom");
  });
});

describe("createDealFromTemplate", () => {
  const input = { templateId: ID, startDate: "2026-11-01" };
  const created = { ok: true, data: { id: "d1" } };

  beforeEach(() => mocks.createDeal.mockReset());

  it("copies the pay structure and the logo into createDeal", async () => {
    mocks.createDeal.mockResolvedValue(created);
    const { db, copy } = fakeDb({ templates: { data: template, error: null } });
    expect(await createDealFromTemplate(db, input)).toEqual(created);
    const sent = mocks.createDeal.mock.calls[0][1];
    expect(sent).toMatchObject({
      brandName: "Acme",
      startDate: "2026-11-01",
      endDate: null,
      basePayCents: 5000,
      baseMinViews: 1000,
      viewBonuses: [{ views: 10000, bonusCents: 2500 }],
      viewBonusMode: "ADD",
      cpmRate: 1.5,
      cpmMinViews: 500,
      cpmTiers: [{ views: 50000, ratePerUnit: 2 }],
      viewFreezeDays: 14,
      dailyTargetPosts: 2,
      payCycle: "WEEKLY",
      payCycleAnchorWeekday: 5,
      payoutRule: { payerContains: "acme" },
      source: "hydra",
      sourceId: null,
    });
    // The deal owns its own logo file, not the template's path.
    expect(copy).toHaveBeenCalledWith("ripple/acme/logo.png", expect.stringMatching(/^deals\/[0-9a-f-]+\/logo\.png$/));
    expect(sent.logoPath).toMatch(/^deals\/[0-9a-f-]+\/logo\.png$/);
  });

  it("takes a new brand name and end date from the input; no logo, no copy", async () => {
    mocks.createDeal.mockResolvedValue(created);
    const { db, copy } = fakeDb({ templates: { data: { ...template, logo_path: null }, error: null } });
    await createDealFromTemplate(db, { ...input, endDate: "2026-12-01", brandName: "Acme 2" });
    expect(mocks.createDeal.mock.calls[0][1]).toMatchObject({ brandName: "Acme 2", endDate: "2026-12-01", logoPath: null });
    expect(copy).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing template and rejected for an archived one", async () => {
    const missing = await createDealFromTemplate(fakeDb({ templates: { data: null, error: null } }).db, input);
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    const archived = await createDealFromTemplate(
      fakeDb({ templates: { data: { ...template, archived: true }, error: null } }).db,
      input,
    );
    expect(archived).toMatchObject({ ok: false, error: { code: "rejected" } });
    expect(mocks.createDeal).not.toHaveBeenCalled();
  });

  it("creates nothing when the logo copy fails", async () => {
    const { db } = fakeDb({ templates: { data: template, error: null }, copyError: { message: "gone" } });
    expect(await createDealFromTemplate(db, input)).toMatchObject({ ok: false, error: { code: "db_error" } });
    expect(mocks.createDeal).not.toHaveBeenCalled();
  });

  it("removes the copied logo and passes the error on when the deal write fails", async () => {
    const failure = { ok: false, error: { code: "conflict", message: "dup" } };
    mocks.createDeal.mockResolvedValue(failure);
    const { db, remove } = fakeDb({ templates: { data: template, error: null } });
    expect(await createDealFromTemplate(db, input)).toEqual(failure);
    expect(remove).toHaveBeenCalledWith([expect.stringMatching(/^deals\//)]);
  });
});

/** A stateful fake: deals and logo objects live in memory, so the real createDeal twin check runs. */
function memoryDb() {
  const deals: DealDbRow[] = [];
  const objects = new Set([template.logo_path!]);
  const db = {
    from(table: string) {
      let op = "select";
      let payload: Record<string, unknown> = {};
      const filters: [string, string, unknown][] = [];
      const match = (r: Record<string, unknown>) =>
        filters.every(([f, k, v]) => (f === "gte" ? String(r[k]) >= String(v) : r[k] === v));
      const run = () => {
        if (table === "deal_templates") return { data: template, error: null };
        if (op === "insert") {
          const now = new Date().toISOString();
          const row = { ...payload, id: `d${deals.length}`, entity_id: "e1", status: "active", created_at: now, updated_at: now };
          deals.push(row as DealDbRow);
          return { data: row, error: null };
        }
        if (op === "delete") {
          deals.splice(0, deals.length, ...deals.filter((d) => !match(d)));
          return { data: null, error: null };
        }
        return { data: deals.filter(match), error: null };
      };
      const q: Record<string, unknown> = {
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
        insert: (p: Record<string, unknown>) => ((op = "insert"), (payload = p), q),
        delete: () => ((op = "delete"), q),
        eq: (k: string, v: unknown) => (filters.push(["eq", k, v]), q),
        is: (k: string, v: unknown) => (filters.push(["eq", k, v]), q),
        gte: (k: string, v: unknown) => (filters.push(["gte", k, v]), q),
      };
      for (const m of ["select", "order", "limit", "single", "maybeSingle"]) q[m] = () => q;
      return q;
    },
    storage: {
      from: () => ({
        copy: async (from: string, to: string) => (objects.has(from) ? (objects.add(to), { error: null }) : { error: { message: "gone" } }),
        remove: async (paths: string[]) => (paths.forEach((p) => objects.delete(p)), { error: null }),
      }),
    },
  };
  return { db: db as unknown as Db, deals, objects };
}

describe("createDealFromTemplate against the real createDeal", () => {
  const input = { templateId: ID, startDate: "2026-11-01" };

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("@/lib/ugc/writes")>("@/lib/ugc/writes");
    mocks.createDeal.mockReset().mockImplementation(real.createDeal);
  });

  it("a retry returns the deal already made and leaves no orphan logo", async () => {
    const { db, deals, objects } = memoryDb();
    const a = await createDealFromTemplate(db, input);
    const b = await createDealFromTemplate(db, input);
    expect(a.ok && b.ok && b.data.id === a.data.id).toBe(true);
    expect(deals).toHaveLength(1);
    expect([...objects].sort()).toEqual([deals[0]!.logo_path, template.logo_path].sort());
  });

  it("a double submit leaves one deal and one logo copy", async () => {
    const { db, deals, objects } = memoryDb();
    const [a, b] = await Promise.all([createDealFromTemplate(db, input), createDealFromTemplate(db, input)]);
    expect(a.ok && b.ok && b.data.id === a.data.id).toBe(true);
    expect(deals).toHaveLength(1);
    expect([...objects].sort()).toEqual([deals[0]!.logo_path, template.logo_path].sort());
  });
});
