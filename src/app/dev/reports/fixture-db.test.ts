// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadReport } from "@/components/reports/load-report";
import { fixtureActions, fixtureClient, fixtureDb, fixtureExport, fixturePanel, type FxDb } from "./fixture-db";

const C = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the report fixture, read through src/lib/reports", () => {
  it("November adds up", async () => {
    const d = await loadReport(fixtureClient(fixtureDb), "all", "2026-11");
    expect(d.flow.incomeCents).toBe(648000);
    expect(d.flow.spendingCents).toBe(423000);
    expect(d.flow.savingsCents).toBe(225000);
    expect(d.spending.rows.map((r) => r.name)).toEqual(["Housing", "Taxes", "Food", "Software", "Shopping", "Other", "Transport", "Uncategorized"]);
    expect(d.spending.rows.find((r) => r.name === "Food")).toMatchObject({ cents: 52000, count: 4 }); // Groceries rolls up
    expect(d.spending.rows.find((r) => r.name === "Shopping")?.cents).toBe(24500); // the refund nets out
    expect(d.trend.months).toHaveLength(12);
    expect(d.trend.months.at(-1)).toMatchObject({ incomeCents: 648000, spendingCents: 423000 });
  });

  it("every number cites its rows, once, and leaves out transfers and hidden rows", async () => {
    const d = await loadReport(fixtureClient(fixtureDb), "all", "2026-11");
    expect(new Set(d.flow.rowIds).size).toBe(d.flow.rowIds.length);
    expect(d.flow.rowIds).toHaveLength(23);
    const db = fixtureDb();
    const hidden = db.transactions.filter((t) => t.hidden || t.transfer).map((t) => t.id);
    expect(d.flow.rowIds.some((r) => hidden.includes(r))).toBe(false);
  });

  it("scope keeps one business", async () => {
    const ugc = await loadReport(fixtureClient(fixtureDb), "ugc", "2026-11");
    expect(ugc.flow.incomeCents).toBe(648000);
    expect(ugc.flow.spendingCents).toBe(161000);
    const personal = await loadReport(fixtureClient(fixtureDb), "personal", "2026-11");
    expect(personal.flow.incomeCents).toBe(0);
    expect(personal.flow.drawnCents).toBe(262000);
  });

  it("the export's transactions sum to net income", async () => {
    const x = await fixtureExport(fixtureDb(), "all", "2026-11");
    expect(x.transactions.reduce((a, t) => a + t.cents, 0)).toBe(225000);
    expect(x.year.taxLines.find((l) => l.code === "23")).toMatchObject({ cents: 1430000, count: 11 });
  });
});

describe("the panel and its edits", () => {
  const edits = (db: FxDb) => {
    const store = { db, set: (n: FxDb) => void (store.db = n) };
    return { store, actions: fixtureActions(store, () => "2026-11", () => "all") };
  };

  it("loads a category with its trend and rows", async () => {
    const r = await fixturePanel(fixtureDb(), "all", "2026-11", C(12));
    expect(r.ok && r.data).toMatchObject({ name: "Food", cents: 52000, count: 4, editable: true });
    expect(r.ok && r.data.trend).toHaveLength(6);
    expect(r.ok && r.data.transactions).toHaveLength(4);
  });

  it("renames, merges and refuses to delete a category in use", async () => {
    const { store, actions } = edits(fixtureDb());
    expect((await actions.rename({ id: C(12), name: "Eating out" })).ok).toBe(true);
    expect((await actions.remove({ id: C(16) })).ok).toBe(false);
    expect((await actions.merge({ fromId: C(14), intoId: C(15) })).ok).toBe(true);
    expect((await actions.merge({ fromId: C(1), intoId: C(15) })).ok).toBe(false); // income into expense
    const d = await loadReport(fixtureClient(() => store.db), "all", "2026-11");
    expect(d.spending.rows.find((r) => r.name === "Other")?.cents).toBe(44500);
    expect(d.spending.rows.some((r) => r.name === "Shopping")).toBe(false);
    expect(d.spending.rows.some((r) => r.name === "Eating out")).toBe(true);
  });
});
