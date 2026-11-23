"use client";

import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";

import { usePlaidLink, type PlaidControl } from "./plaid-link";
import type { AccountsActions, AccountsData } from "./types";

export type AddStep = "choose" | "import" | "manual";

interface AccountsContext {
  data: AccountsData;
  actions: AccountsActions;
  plaid: PlaidControl;
  /** One status line at the top of the page. */
  notice: string | null;
  say(message: string | null): void;
  add: AddStep | null;
  openAdd(step: AddStep): void;
  closeAdd(): void;
}

const Ctx = createContext<AccountsContext | null>(null);

export function useAccounts(): AccountsContext {
  const ctx = use(Ctx);
  if (!ctx) throw new Error("useAccounts outside AccountsProvider");
  return ctx;
}

/** Holds the page's data, its actions, Plaid Link and the add-account dialog, so every tab and the panel share them. */
export function AccountsProvider({ data, actions, children }: { data: AccountsData; actions: AccountsActions; children: ReactNode }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [add, setAdd] = useState<AddStep | null>(null);
  const say = useCallback((message: string | null) => setNotice(message), []);
  const plaid = usePlaidLink(actions, data.plaidConfigured, say);
  const value = useMemo(
    () => ({ data, actions, plaid, notice, say, add, openAdd: setAdd, closeAdd: () => setAdd(null) }),
    [data, actions, plaid, notice, say, add],
  );
  return (
    <Ctx value={value}>
      {children}
      {plaid.script}
    </Ctx>
  );
}
