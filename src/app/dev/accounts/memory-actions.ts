import { useState, useSyncExternalStore } from "react";

import type { AccountWithBalance, AccountsActions, AccountsData, ActionResult, BalanceRow } from "@/components/accounts/types";

import { NOW, TODAY } from "./fixture-data";
import { fixtureImport } from "./import-action";

/**
 * The Accounts actions on in-memory data, for /dev/accounts. Same shapes as the real U2/U3 actions; a reload starts over.
 * File import goes to a fixture server action that runs the real parser, so the dry run is the real one.
 */

const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
const fail = (code: string, message: string): ActionResult<never> => ({ ok: false, error: { code, message } });

export function createMemoryStore(initial: AccountsData) {
  let data = initial;
  const subs = new Set<() => void>();
  let next = 1000;
  const set = (change: (d: AccountsData) => AccountsData) => {
    data = change(data);
    subs.forEach((f) => f());
  };
  const patchAccount = (id: string, patch: Partial<AccountWithBalance>) =>
    set((d) => ({
      ...d,
      accounts: d.accounts.map((a) => {
        if (a.id !== id) return a;
        const merged = { ...a, ...patch };
        merged.statement_balance_effective_cents = merged.statement_balance_override_cents ?? merged.statement_balance_cents;
        merged.statement_due_effective_on = merged.statement_due_on_override ?? merged.statement_due_on;
        return merged;
      }),
    }));
  const find = (id: string) => data.accounts.find((a) => a.id === id);
  const status = (id: string, to: "confirmed" | "dismissed") => {
    const before = data.recurring.find((r) => r.id === id);
    if (!before) return fail("not_found", "recurring: not found");
    set((d) => ({ ...d, recurring: d.recurring.map((r) => (r.id === id ? { ...r, status: to } : r)) }));
    return ok({ before: before.status });
  };

  const actions: AccountsActions = {
    createLinkToken: async () => ok({ linkToken: "link-sandbox-fixture", expiration: "2026-11-21T22:00:00Z" }),
    startUpdateMode: async () => ok({ linkToken: "link-sandbox-update-fixture", expiration: "2026-11-21T22:00:00Z" }),
    exchangePublicToken: async () => {
      if (data.items.some((i) => i.institution_name === "First Platypus Bank")) return fail("duplicate_institution", "This bank is already linked. Repair it with update mode.");
      const itemId = `a0000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
      const accountId = `a0000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
      set((d) => ({
        ...d,
        plaidLoginsUsed: d.plaidLoginsUsed + 1,
        items: [...d.items, { id: itemId, institution_name: "First Platypus Bank", status: "active", last_synced_at: NOW, last_error: null }],
        accounts: [
          ...d.accounts,
          {
            ...d.accounts[0],
            id: accountId,
            bank_item_id: itemId,
            name: "Platypus Checking",
            mask: "0000",
            institution: "First Platypus Bank",
            balance: { as_of: TODAY, current_cents: 100_000, available_cents: null, limit_cents: null },
          },
        ],
      }));
      return ok({ itemId, institutionName: "First Platypus Bank" });
    },
    syncBankItem: async ({ itemId }) => {
      set((d) => ({ ...d, items: d.items.map((i) => (i.id === itemId ? { ...i, status: "active", last_error: null, last_synced_at: NOW } : i)) }));
      return ok({ status: "synced" as const, pages: 1, added: 0, modified: 0, removed: 0 });
    },
    importFile: (input) => fixtureImport(input),
    addManualAccount: async (input) => {
      const id = `a0000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
      set((d) => ({
        ...d,
        accounts: [
          ...d.accounts,
          {
            id,
            bank_item_id: null,
            kind: input.kind,
            entity_id: input.entityId ?? d.entities[0].id,
            name: input.name.trim(),
            nickname: null,
            mask: input.mask ?? null,
            institution: input.institution ?? null,
            in_net_worth: input.inNetWorth ?? true,
            is_manual: true,
            statement_balance_cents: null,
            statement_due_on: null,
            statement_balance_override_cents: null,
            statement_due_on_override: null,
            closed_at: null,
            created_at: NOW,
            balance: input.balanceCents === undefined ? null : { as_of: TODAY, current_cents: input.balanceCents, available_cents: null, limit_cents: null },
            statement_balance_effective_cents: null,
            statement_due_effective_on: null,
          },
        ],
      }));
      return ok({ accountId: id });
    },
    editAccount: async (input) => {
      const a = find(input.accountId);
      if (!a) return fail("not_found", "account: not found");
      const patch: Partial<AccountWithBalance> = {};
      const before: Record<string, unknown> = {};
      const take = <K extends keyof AccountWithBalance>(key: K, value: AccountWithBalance[K] | undefined) => {
        if (value === undefined) return;
        before[key] = a[key];
        patch[key] = value;
      };
      take("nickname", input.nickname === undefined ? undefined : input.nickname || null);
      take("entity_id", input.entityId);
      take("in_net_worth", input.inNetWorth);
      take("statement_balance_override_cents", input.statementBalanceOverrideCents);
      take("statement_due_on_override", input.statementDueOnOverride);
      if (a.is_manual) {
        take("name", input.name);
        take("kind", input.kind);
        take("institution", input.institution);
        take("mask", input.mask);
      } else if (input.name !== undefined || input.kind !== undefined || input.balanceCents !== undefined) {
        return fail("not_manual", "Only a manual account's name, kind, institution, mask and balance can be edited");
      }
      if (input.balanceCents !== undefined) {
        patch.balance = { as_of: TODAY, current_cents: input.balanceCents, available_cents: null, limit_cents: a.balance?.limit_cents ?? null };
      }
      patchAccount(a.id, patch);
      return ok({ accountId: a.id, before });
    },
    closeAccount: async ({ accountId }) => {
      if (!find(accountId)) return fail("not_found", "account: not found");
      set((d) => ({ ...d, accounts: d.accounts.filter((a) => a.id !== accountId) }));
      return ok({ accountId, closedAt: NOW });
    },
    confirmRecurring: async ({ id }) => status(id, "confirmed"),
    dismissRecurring: async ({ id }) => {
      const r = status(id, "dismissed");
      return r.ok ? ok({ ...r.data, unlinked: 0 }) : r;
    },
    detectRecurringNow: async () => ok({ found: data.recurring.filter((r) => r.status === "suggested").length, saved: 0 }),
    setIdleLock: async ({ minutes }) => {
      set((d) => ({ ...d, idleLockMinutes: minutes }));
      return ok({ minutes });
    },
    disconnectGoogle: async () => {
      set((d) => ({ ...d, google: { ...d.google, email: null, status: null } }));
      return ok(null);
    },
    disconnectInstagram: async () => {
      set((d) => ({ ...d, instagram: { ...d.instagram, username: null, lastSyncedAt: null, lastError: null } }));
      return ok(null);
    },
    createApiKey: async ({ name }) => {
      if (!name.trim()) return fail("invalid_input", "Name the key");
      const key = { id: `a0000000-0000-4000-8000-${String(next++).padStart(12, "0")}`, name: name.trim(), prefix: "hyd_ugc_Zq7n", created_at: NOW, last_used_at: null };
      set((d) => ({ ...d, apiKeys: [key, ...d.apiKeys] }));
      return ok({ key, secret: "hyd_ugc_Zq7nFixtureSecretShownOnce0000000000000" });
    },
    revokeApiKey: async ({ id }) => {
      set((d) => ({ ...d, apiKeys: d.apiKeys.filter((k) => k.id !== id) }));
      return ok(null);
    },
    pairDevice: async () => ok({ code: "K7Q4M2XP", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    revokeDevice: async ({ id }) => {
      set((d) => ({ ...d, devices: d.devices.filter((x) => x.id !== id) }));
      return ok(null);
    },
    balanceHistory: async ({ accountId }) => {
      const a = find(accountId);
      const current = a?.balance?.current_cents ?? 0;
      // 400 days ending today (so it spans two years, like a real walk-back): a gentle climb with a
      // steady wobble, last point = the current balance. Real balances for the last 5 days (a new
      // bank link); the days before are estimated.
      const N = 400;
      const rows: BalanceRow[] = Array.from({ length: N }, (_, i) => {
        const date = new Date(Date.parse(`${TODAY}T00:00:00Z`) - (N - 1 - i) * 86_400_000).toISOString().slice(0, 10);
        const wobble = 6 * Math.sin(i / 9);
        const value = i === N - 1 ? current : Math.round(current * (0.9 + (0.1 * i) / (N - 1) + wobble / 400));
        return { as_of: date, current_cents: value, available_cents: null, limit_cents: null, estimated: i < N - 5 };
      });
      return ok(rows);
    },
  };

  return { actions, get: () => data, subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)) };
}

export function useMemoryAccounts(initial: AccountsData) {
  const [store] = useState(() => createMemoryStore(initial));
  const data = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { data, actions: store.actions };
}
