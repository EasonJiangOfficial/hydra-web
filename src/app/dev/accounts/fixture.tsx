"use client";

import { useSearchParams } from "next/navigation";

import { AccountsWorkspace } from "@/components/accounts/accounts-workspace";

import { fixtureData } from "./fixture-data";
import { useMemoryAccounts } from "./memory-actions";

/** The Accounts workspace on in-memory data. `?plaid=on`: the Plaid keys are set. `?connected=on`: every connector is connected. */
export function AccountsFixture() {
  const search = useSearchParams();
  const plaid = search.get("plaid") === "on";
  const connected = search.get("connected") === "on";
  const { data, actions } = useMemoryAccounts(fixtureData({ plaidConfigured: plaid, connected }));
  return <AccountsWorkspace data={data} actions={actions} />;
}
