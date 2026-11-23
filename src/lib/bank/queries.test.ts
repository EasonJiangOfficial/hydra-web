// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fixtures/fake-db";
import { balanceHistory, listAccounts, listTransactions } from "./queries";

describe("bank queries", () => {
  it("reads balance history from the walk-back function, estimated days flagged", async () => {
    const rows = [
      { as_of: "2026-11-20", current_cents: 41500, available_cents: null, limit_cents: null, estimated: true },
      { as_of: "2026-11-21", current_cents: 41000, available_cents: 40000, limit_cents: 200000, estimated: false },
    ];
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    await expect(balanceHistory({ rpc } as never, { accountId: "acc-1" })).resolves.toEqual(rows);
    expect(rpc).toHaveBeenCalledWith("account_balance_history", { p_account_id: "acc-1", p_from: null, p_to: null });
    await balanceHistory({ rpc } as never, { accountId: "acc-1", from: "2026-01-01", to: "2026-02-01" });
    expect(rpc).toHaveBeenLastCalledWith("account_balance_history", { p_account_id: "acc-1", p_from: "2026-01-01", p_to: "2026-02-01" });
    const fail = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(balanceHistory({ rpc: fail } as never, { accountId: "acc-1" })).rejects.toThrow("balance history: boom");
  });

  it("filters a transactions page and keeps a search literal (no filter injection)", async () => {
    const db = fakeDb(() => ({ data: [], count: 0 }));
    await listTransactions(db as never, {
      accountId: "acc-1",
      entityId: "ent-1",
      from: "2026-11-01",
      to: "2026-11-30",
      search: 'x",hidden.eq.true,name.eq."y',
      page: 2,
      pageSize: 500,
    });
    const filters = db.ops[0].filters;
    expect(filters).toEqual([
      "range 400-599",
      "account_id=acc-1",
      "entity_id=ent-1",
      "posted_on>=2026-11-01",
      "posted_on<=2026-11-30",
      "hidden=false",
      String.raw`or(name.ilike."%x\",hidden.eq.true,name.eq.\"y%",merchant.ilike."%x\",hidden.eq.true,name.eq.\"y%",raw_description.ilike."%x\",hidden.eq.true,name.eq.\"y%",note.ilike."%x\",hidden.eq.true,name.eq.\"y%")`,
    ]);
  });

  it("returns each account's latest balance and the effective card statement", async () => {
    const db = fakeDb(() => ({
      data: [
        {
          id: "a1",
          statement_balance_cents: 170877,
          statement_due_on: "2026-11-28",
          statement_balance_override_cents: null,
          statement_due_on_override: "2026-12-01",
          balances: [{ as_of: "2026-11-21", current_cents: 41000, available_cents: null, limit_cents: 200000 }],
        },
        { id: "a2", statement_balance_cents: null, statement_due_on: null, statement_balance_override_cents: null, statement_due_on_override: null, balances: [] },
      ],
    }));
    const accounts = await listAccounts(db as never);
    expect(db.ops[0].filters).toEqual(["closed_at is null"]);
    expect(accounts[0]).toMatchObject({
      balance: { as_of: "2026-11-21", current_cents: 41000 },
      statement_balance_effective_cents: 170877,
      statement_due_effective_on: "2026-12-01",
    });
    expect(accounts[0]).not.toHaveProperty("balances");
    expect(accounts[1].balance).toBeNull();
  });
});
