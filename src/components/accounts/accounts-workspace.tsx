"use client";

import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/kit";

import { AccountPanel } from "./account-panel";
import { AccountsTab } from "./accounts-tab";
import { AddAccountDialog } from "./add-account";
import { ago, itemHealth } from "./format";
import { RecurringTab } from "./recurring-tab";
import { AccountsProvider, useAccounts } from "./store";
import type { AccountsActions, AccountsData } from "./types";

const TABS = [
  { value: "accounts", label: "Accounts" },
  { value: "recurring", label: "Recurring" },
] as const;
type Tab = (typeof TABS)[number]["value"];

/** The tab lives in `?tab=`, so the drawer's own param changes keep it. replaceState: no server round trip. */
function useTab(): [Tab, (next: Tab) => void] {
  const search = useSearchParams();
  const asked = search.get("tab");
  const tab = TABS.find((t) => t.value === asked)?.value ?? "accounts";
  return [
    tab,
    (next) => {
      const url = new URL(window.location.href);
      if (next === "accounts") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      // `null` state: Next syncs useSearchParams only for a replaceState that does not carry its own history state.
      window.history.replaceState(null, "", url);
    },
  ];
}

function Actions() {
  const { data, actions, say, openAdd } = useAccounts();
  const [syncing, setSyncing] = useState(false);
  const syncable = data.items.filter((i) => itemHealth(i) === "healthy");
  const last = data.items.map((i) => i.last_synced_at).filter((t): t is string => !!t).sort().at(-1);

  async function syncAll() {
    setSyncing(true);
    const results = await Promise.all(syncable.map((i) => actions.syncBankItem({ itemId: i.id })));
    setSyncing(false);
    const failed = results.find((r) => !r.ok);
    say(failed && !failed.ok ? failed.error.message : "Synced.");
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-label text-ink-3 max-md:basis-full">{last ? `Last sync ${ago(last, data.now)}` : data.items.length ? "Not synced yet" : "No bank feed"}</span>
      <div className="flex-1 max-md:hidden" />
      <Button disabled={syncing || !syncable.length} onClick={() => void syncAll()}>
        Sync now
      </Button>
      <Button variant="primary" onClick={() => openAdd("choose")}>
        <Plus aria-hidden strokeWidth={1.5} />
        Add account
      </Button>
    </div>
  );
}

function Notice() {
  const { notice, say } = useAccounts();
  if (!notice) return null;
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg bg-tint px-3.5 py-2.5 text-body">
      <span className="min-w-0 flex-1">{notice}</span>
      <button type="button" onClick={() => say(null)} className="text-label text-ink-3 underline underline-offset-2 hover:text-ink">
        Dismiss
      </button>
    </div>
  );
}

function Body() {
  const [tab, setTab] = useTab();
  return (
    <div className="flex flex-col gap-5">
      <Actions />
      <Notice />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="accounts">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="recurring">
          <RecurringTab />
        </TabsContent>
      </Tabs>
      <AccountPanel />
      <AddAccountDialog />
    </div>
  );
}

/**
 * The Accounts page body: tabs, the account panel (`?account=`) and the add-account dialog. It holds no data of its
 * own: the live page passes server data and the U2/U3 actions, /dev/accounts passes memory ones. Render it inside a
 * Suspense boundary (it reads the search params).
 */
export function AccountsWorkspace({ data, actions }: { data: AccountsData; actions: AccountsActions }) {
  return (
    <AccountsProvider data={data} actions={actions}>
      <Body />
    </AccountsProvider>
  );
}
