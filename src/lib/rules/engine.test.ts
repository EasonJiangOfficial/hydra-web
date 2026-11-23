// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findClearPairs, findTransferSuggestions, pairKey, processIngested, type AutoPairRow } from "./engine";

/** A stand-in supabase client: records each query and answers it from `reply`. */
interface Op {
  table: string;
  values?: unknown;
  filters: string[];
}
function fakeDb(reply: (op: Op) => unknown) {
  const ops: Op[] = [];
  const answer = (op: Op) => (ops.push(op), Promise.resolve({ data: reply(op) ?? null, error: null }));
  const db = {
    rpc: (name: string, values: unknown) => answer({ table: `rpc:${name}`, values, filters: [] }),
    from(table: string) {
      const op: Op = { table, filters: [] };
      const b: Record<string, unknown> = {};
      const step = (fn: (...a: never[]) => void) => (...a: never[]) => (fn(...a), b);
      const filter = (name: string) => step((col: string, v: unknown) => op.filters.push(`${col} ${name} ${String(v)}`));
      Object.assign(b, {
        select: step(() => {}),
        eq: filter("="),
        neq: filter("!="),
        is: filter("is"),
        in: filter("in"),
        gte: filter(">="),
        lte: filter("<="),
        order: step((col: string, o?: { ascending?: boolean }) => op.filters.push(`order ${col} ${o?.ascending === false ? "desc" : "asc"}`)),
        limit: step(() => {}),
        range: step(() => {}),
        maybeSingle: step(() => {}),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => answer(op).then(res, rej),
      });
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, ops };
}

const CHECKING = "aaaaaaaa-0000-4000-8000-000000000001";
const CARD = "aaaaaaaa-0000-4000-8000-000000000002";
const OUT = "11111111-0000-4000-8000-000000000001";
const IN = "11111111-0000-4000-8000-000000000002";
const LATTE = "11111111-0000-4000-8000-000000000003";
const COFFEE = "cccccccc-0000-4000-8000-000000000001";

const target = (id: string, account_id: string, amount_cents: number, name: string, posted_on: string) => ({
  id, account_id, amount_cents, name, merchant: null, note: null, renamed: false, entity_id: "eeeeeeee-0000-4000-8000-000000000001",
  entity_manual: false, category_id: null, category_source: "none", tax_line_id: null, is_transfer: false, recurring_id: null, posted_on, pending: false, transfer_pair_id: null,
});

describe("processIngested (apply on ingest)", () => {
  it("runs the rules over the new rows, then pairs a synced card payment so it is not income or spending", async () => {
    const rows = [
      target(OUT, CHECKING, -200000, "CARD AUTOPAY", "2026-11-18"),
      target(IN, CARD, 200000, "PAYMENT THANK YOU", "2026-11-19"),
      target(LATTE, CHECKING, -575, "STARBUCKS 123", "2026-11-19"),
    ];
    const { db, ops } = fakeDb((op) => {
      if (op.table === "rules")
        return [{ id: "r1", position: 0, enabled: true, created_at: "", updated_at: "", conditions: [{ field: "name", op: "contains", value: "starbucks" }], actions: [{ type: "set_category", categoryId: COFFEE }] }];
      if (op.table === "transactions" && op.filters.some((f) => f.startsWith("order posted_on"))) return { posted_on: op.filters.includes("order posted_on asc") ? "2026-11-18" : "2026-11-19" };
      if (op.table === "transactions") return rows;
      if (op.table === "accounts") return [{ id: CHECKING, kind: "cash" }, { id: CARD, kind: "card" }];
      if (op.table === "rpc:rules_apply_patches") return 1;
      if (op.table === "rpc:ledger_pair_transfers") return 1;
    });

    const result = await processIngested(db, new Date("2026-11-21T10:00:00Z"));

    expect(result).toEqual({ checked: 3, changed: 1, paired: 1 });
    const targets = ops.find((o) => o.table === "transactions")!;
    expect(targets.filters).toContain("updated_at >= 2026-11-21T09:55:00.000Z"); // five minutes of clock slack
    expect(ops.find((o) => o.table === "rpc:rules_apply_patches")!.values).toEqual({ p_patches: [{ id: LATTE, category_id: COFFEE }] });
    expect(ops.find((o) => o.table === "rpc:ledger_pair_transfers")!.values).toEqual({ p_pairs: [{ a: OUT, b: IN }] });
    const pairing = ops.filter((o) => o.table === "transactions").at(-1)!;
    // Two windows out, so a rival candidate just outside the span still makes a match unclear.
    expect(pairing.filters).toEqual(expect.arrayContaining(["posted_on >= 2026-11-08", "posted_on <= 2026-11-29"]));
  });

  it("does nothing more when no row came in", async () => {
    const { db, ops } = fakeDb((op) => (op.table === "rules" ? [] : null));
    expect(await processIngested(db, new Date("2026-11-21T10:00:00Z"))).toEqual({ checked: 0, changed: 0, paired: 0 });
    expect(ops.some((o) => o.table.startsWith("rpc:"))).toBe(false);
  });
});

describe("findClearPairs: automatic pairing takes only card and loan payments", () => {
  const BIZ = "aaaaaaaa-0000-4000-8000-000000000003";
  const SAVINGS = "aaaaaaaa-0000-4000-8000-000000000004";
  const LOAN = "aaaaaaaa-0000-4000-8000-000000000005";
  const kinds: Record<string, AutoPairRow["account_kind"]> = { [CHECKING]: "cash", [CARD]: "card", [BIZ]: "cash", [SAVINGS]: "cash", [LOAN]: "loan" };
  let n = 0;
  const row = (account_id: string, amount_cents: number, posted_on: string, name: string, extra: Partial<AutoPairRow> = {}): AutoPairRow => ({
    id: `11111111-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    account_id, amount_cents, posted_on, name, raw_description: null, pending: false, transfer_pair_id: null, category_source: "none",
    account_kind: kinds[account_id] ?? null, category_kind: null, deal_matched: false, ...extra,
  });

  it("pairs a card autopay with its card credit", () => {
    const out = row(CHECKING, -100000, "2026-11-10", "CHASE CREDIT CRD AUTOPAY");
    const credit = row(CARD, 100000, "2026-11-11", "AUTOMATIC PAYMENT - THANK YOU");
    expect(findClearPairs([out, credit])).toEqual([{ a: out.id, b: credit.id }]);
  });

  it("pairs a loan payment from checking (the bank's own words in raw_description)", () => {
    const out = row(CHECKING, -30000, "2026-11-10", "Auto loan");
    const credit = row(LOAN, 30000, "2026-11-10", "Toyota", { raw_description: "LOAN PYMT RECEIVED" });
    expect(findClearPairs([out, credit])).toEqual([{ a: out.id, b: credit.id }]);
  });

  it("never pairs two cash accounts: personal rent and a business payout of the same amount", () => {
    expect(findClearPairs([row(CHECKING, -100000, "2026-11-10", "LANDLORD RENT"), row(BIZ, 100000, "2026-11-10", "WORDWISE PAYOUT")])).toEqual([]);
  });

  it("never pairs an ATM withdrawal with a Zelle deposit into savings", () => {
    expect(findClearPairs([row(CHECKING, -20000, "2026-11-10", "ATM WITHDRAWAL"), row(SAVINGS, 20000, "2026-11-14", "ZELLE FROM SAM")])).toEqual([]);
  });

  it("never pairs a Venmo payment with a merchant refund on a card", () => {
    expect(findClearPairs([row(CHECKING, -4999, "2026-11-10", "VENMO"), row(CARD, 4999, "2026-11-12", "AMAZON.COM REFUND")])).toEqual([]);
  });

  it("RM-01, the card credit arrives later: nothing pairs until it does, then the autopay takes the card credit, never the payout", () => {
    const out = row(CHECKING, -100000, "2026-11-10", "CARD AUTOPAY");
    const payout = row(BIZ, 100000, "2026-11-10", "WORDWISE PAYOUT");
    expect(findClearPairs([out, payout])).toEqual([]);
    const credit = row(CARD, 100000, "2026-11-11", "PAYMENT THANK YOU");
    expect(findClearPairs([out, payout, credit])).toEqual([{ a: out.id, b: credit.id }]);
  });

  it("never takes a deal-matched row on either side", () => {
    const out = row(CHECKING, -100000, "2026-11-10", "CARD AUTOPAY");
    const credit = row(CARD, 100000, "2026-11-11", "PAYMENT THANK YOU", { deal_matched: true });
    expect(findClearPairs([out, credit])).toEqual([]);
    expect(findClearPairs([row(CHECKING, -100000, "2026-11-10", "CARD AUTOPAY", { deal_matched: true }), row(CARD, 100000, "2026-11-11", "PAYMENT THANK YOU")])).toEqual([]);
  });

  it("leaves a card credit with two possible outflows for the owner", () => {
    const a = row(CHECKING, -5000, "2026-11-10", "CARD PAYMENT");
    const b = row(BIZ, -5000, "2026-11-11", "CARD PAYMENT");
    expect(findClearPairs([a, b, row(CARD, 5000, "2026-11-12", "PAYMENT THANK YOU")])).toEqual([]);
  });

  it("does not pair a card purchase with a Venmo deposit (a card outflow is spending)", () => {
    expect(findClearPairs([row(CARD, -5000, "2026-11-12", "PAYMENT"), row(CHECKING, 5000, "2026-11-10", "VENMO PAYMENT")])).toEqual([]);
  });

  it("skips rows in an income or expense category, rows set by hand, unknown accounts and far dates; takes a rule's transfer mark", () => {
    const out = () => row(CHECKING, -2500, "2026-11-10", "CARD PAYMENT");
    const pay = "PAYMENT THANK YOU";
    expect(findClearPairs([out(), row(CARD, 2500, "2026-11-10", pay, { category_kind: "income" })])).toEqual([]);
    expect(findClearPairs([row(CHECKING, -2500, "2026-11-10", "CARD PAYMENT", { category_kind: "expense" }), row(CARD, 2500, "2026-11-10", pay)])).toEqual([]);
    expect(findClearPairs([out(), row(CARD, 2500, "2026-11-10", pay, { category_source: "manual" })])).toEqual([]);
    expect(findClearPairs([out(), row("aaaaaaaa-0000-4000-8000-00000000ffff", 2500, "2026-11-10", pay)])).toEqual([]);
    expect(findClearPairs([out(), row(CARD, 2500, "2026-11-16", pay)])).toEqual([]);
    const transfer = row(CARD, 2500, "2026-11-11", "Statement credit", { category_kind: "transfer" });
    const o = out();
    expect(findClearPairs([o, transfer])).toEqual([{ a: o.id, b: transfer.id }]);
  });

  it("suggests the cash-to-cash cases instead, one candidate a side, minus the ones the owner said no to", () => {
    const rent = row(CHECKING, -100000, "2026-11-10", "LANDLORD RENT");
    const payout = row(BIZ, 100000, "2026-11-10", "WORDWISE PAYOUT");
    const atm = row(CHECKING, -20000, "2026-11-10", "ATM WITHDRAWAL");
    const zelle = row(SAVINGS, 20000, "2026-11-14", "ZELLE FROM SAM");
    const venmo = row(CHECKING, -4999, "2026-11-10", "VENMO");
    const refund = row(CARD, 4999, "2026-11-12", "AMAZON.COM REFUND");
    const rows = [rent, payout, atm, zelle, venmo, refund];
    expect(findTransferSuggestions(rows)).toEqual([{ a: rent.id, b: payout.id }, { a: atm.id, b: zelle.id }]);
    expect(findTransferSuggestions(rows, new Set([pairKey(zelle.id, atm.id)]))).toEqual([{ a: rent.id, b: payout.id }]);
    expect(findTransferSuggestions([rent, { ...payout, deal_matched: true }])).toEqual([]);
    expect(findTransferSuggestions([rent, payout, row(SAVINGS, 100000, "2026-11-11", "DEPOSIT")])).toEqual([]);
  });
});

describe("processIngested reads deal payments before pairing", () => {
  it("does not pair a deal-matched payout with a rent payment the next day", async () => {
    const BIZ = "aaaaaaaa-0000-4000-8000-000000000003";
    const rows = [target(OUT, CHECKING, -100000, "LANDLORD RENT", "2026-06-02"), target(IN, BIZ, 100000, "WORDWISE PAYOUT", "2026-06-01")];
    const { db, ops } = fakeDb((op) => {
      if (op.table === "rules") return [];
      if (op.table === "transactions" && op.filters.some((f) => f.startsWith("order posted_on"))) return { posted_on: op.filters.includes("order posted_on asc") ? "2026-06-01" : "2026-06-02" };
      if (op.table === "transactions") return rows;
      if (op.table === "accounts") return [{ id: CHECKING, kind: "cash" }, { id: BIZ, kind: "cash" }];
      if (op.table === "deal_payments") return [{ transaction_id: IN }];
    });
    expect(await processIngested(db, new Date("2026-06-03T10:00:00Z"))).toEqual({ checked: 0, changed: 0, paired: 0 });
    expect(ops.some((o) => o.table === "rpc:ledger_pair_transfers")).toBe(false);
  });
});
