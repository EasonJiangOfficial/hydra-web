// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in supabase client: records each query and answers it from `reply`. */
interface Op {
  table: string;
  action: string;
  values?: unknown;
  filters: string[];
}
type Reply = { data?: unknown; error?: { code?: string; message: string } | null };

function fakeDb(reply: (op: Op) => Reply) {
  const ops: Op[] = [];
  const answer = (op: Op) => {
    ops.push(op);
    return Promise.resolve({ data: null, error: null, ...reply(op) });
  };
  return {
    ops,
    rpc: (name: string, values: unknown) => answer({ table: `rpc:${name}`, action: "rpc", values, filters: [] }),
    from(table: string) {
      const op: Op = { table, action: "select", filters: [] };
      const builder: Record<string, unknown> = {};
      const step = (fn: (...a: never[]) => void) => (...a: never[]) => (fn(...a), builder);
      const set = (action: string) => step((values: unknown) => Object.assign(op, { action, values }));
      const filter = (name: string) => step((col: string, v: unknown) => op.filters.push(`${col} ${name} ${JSON.stringify(v)}`));
      Object.assign(builder, {
        select: step(() => {}),
        insert: set("insert"),
        update: set("update"),
        upsert: set("upsert"),
        delete: step(() => Object.assign(op, { action: "delete" })),
        eq: filter("="),
        neq: filter("!="),
        is: filter("is"),
        in: filter("in"),
        gte: filter(">="),
        lte: filter("<="),
        contains: filter("@>"),
        order: step(() => {}),
        limit: step(() => {}),
        range: step(() => {}),
        maybeSingle: step(() => {}),
        single: step(() => {}),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer(op).then(resolve, reject),
      });
      return builder;
    },
  };
}

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: mocks.createServerClient }));

const { applyRules, createRule, pairTransfers, setTransactionCategory } = await import("./actions");

const TX = "11111111-0000-4000-8000-000000000001";
const TX2 = "11111111-0000-4000-8000-000000000002";
const CAT = "cccccccc-0000-4000-8000-000000000001";
const ACC = "aaaaaaaa-0000-4000-8000-000000000001";

const row = (over: Record<string, unknown> = {}) => ({
  id: TX,
  account_id: ACC,
  amount_cents: -1549,
  name: "NETFLIX.COM",
  merchant: "Netflix",
  note: null,
  renamed: false,
  entity_id: "eeeeeeee-0000-4000-8000-000000000001",
  category_id: null,
  category_source: "none",
  tax_line_id: null,
  is_transfer: false,
  recurring_id: null,
  posted_on: "2026-11-15",
  ...over,
});

function owner(reply: (op: Op) => Reply, isOwner = true) {
  const db = fakeDb((op) => (op.table === "rpc:is_owner" ? { data: isOwner } : reply(op)));
  mocks.createServerClient.mockResolvedValue(db);
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe("owner and input checks", () => {
  it("refuses a caller who is not the owner before any read or write", async () => {
    const db = owner(() => ({}), false);
    await expect(applyRules({ from: "2026-01-01" })).resolves.toEqual({ ok: false, error: { code: "not_owner", message: "Sign in as the owner" } });
    expect(db.ops.map((o) => o.table)).toEqual(["rpc:is_owner"]);
  });

  it("a bad transaction id never falls through to every row", async () => {
    const db = owner(() => ({}));
    await expect(applyRules({ transactionId: "not-an-id" })).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(db.ops.map((o) => o.table)).toEqual(["rpc:is_owner"]);
  });

  it("refuses a bad rule before writing", async () => {
    const db = owner(() => ({}));
    const result = await createRule({ conditions: [{ field: "name", op: "regex", value: "(" }], actions: [{ type: "mark_transfer" }] });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(db.ops.filter((o) => o.action !== "rpc")).toEqual([]);
  });
});

describe("applying rules", () => {
  it("loads only rows not categorized by hand and writes the first match through the guarded function", async () => {
    const db = owner((op) => {
      if (op.table === "rules")
        return {
          data: [
            { id: "r2", position: 2, enabled: true, conditions: [{ field: "amount", op: "between", value: [-5000, 0] }], actions: [{ type: "mark_transfer" }] },
            { id: "r1", position: 1, enabled: true, conditions: [{ field: "name", op: "contains", value: "netflix" }], actions: [{ type: "set_category", categoryId: CAT }] },
            { id: "bad", position: 0, enabled: true, conditions: "nope", actions: [] },
          ],
        };
      if (op.table === "transactions") return { data: [row(), row({ id: TX2, name: "Hulu" })] };
      if (op.table === "rpc:rules_apply_patches") return { data: 2 };
      return {};
    });
    await expect(applyRules({ from: "2026-11-01", to: "2026-11-30" })).resolves.toEqual({ ok: true, data: { checked: 2, changed: 2 } });
    const load = db.ops.find((o) => o.table === "transactions")!;
    expect(load.filters).toEqual(['category_source != "manual"', 'posted_on >= "2026-11-01"', 'posted_on <= "2026-11-30"']);
    expect(db.ops.find((o) => o.table === "rpc:rules_apply_patches")?.values).toEqual({
      p_patches: [{ id: TX, category_id: CAT }, { id: TX2, is_transfer: true }],
    });
  });
});

describe("a manual category", () => {
  it("marks the row manual, returns what it replaced and offers a rule", async () => {
    const db = owner((op) => {
      if (op.table === "transactions" && op.action === "select") return { data: row({ category_source: "rule", category_id: null }) };
      if (op.table === "transactions" && op.action === "update") return { data: { id: TX } };
      if (op.table === "rules") return { data: [] };
      return {};
    });
    const result = await setTransactionCategory({ transactionId: TX, categoryId: CAT });
    expect(result).toEqual({
      ok: true,
      data: {
        transactionId: TX,
        before: { category_id: null, category_source: "rule", entity_id: row().entity_id },
        suggestion: { conditions: [{ field: "merchant", op: "is", value: "Netflix" }], actions: [{ type: "set_category", categoryId: CAT }] },
      },
    });
    expect(db.ops.find((o) => o.action === "update")?.values).toEqual({ category_id: CAT, category_source: "manual" });
  });
});

describe("pairing by hand", () => {
  it("a pair the database refuses comes back as rejected", async () => {
    owner((op) => (op.table === "rpc:ledger_pair_transfers" ? { data: 0 } : {}));
    await expect(pairTransfers({ aId: TX, bId: TX2 })).resolves.toMatchObject({ ok: false, error: { code: "rejected" } });
  });

  it("a pair it accepts", async () => {
    const db = owner((op) => (op.table === "rpc:ledger_pair_transfers" ? { data: 1 } : {}));
    await expect(pairTransfers({ aId: TX, bId: TX2 })).resolves.toEqual({ ok: true, data: { paired: true } });
    expect(db.ops.at(-1)?.values).toEqual({ p_pairs: [{ a: TX, b: TX2 }] });
  });
});
