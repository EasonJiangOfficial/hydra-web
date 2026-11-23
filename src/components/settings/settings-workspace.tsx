"use client";

import { useSearchParams } from "next/navigation";

import { ConnectionsTab } from "@/components/accounts/connections-tab";
import { AccountsProvider, useAccounts } from "@/components/accounts/store";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/kit";

import { AgentTab } from "./agent-tab";
import { BusinessesTab } from "./businesses-tab";
import { GeneralTab } from "./general-tab";
import { SettingsProvider, useSettings } from "./store";
import type { SettingsActions, SettingsData } from "./types";

const TABS = [
  { value: "businesses", label: "Businesses" },
  { value: "general", label: "General" },
  { value: "agent", label: "Agent" },
  { value: "connections", label: "Connections" },
] as const;
type Tab = (typeof TABS)[number]["value"];

/** The tab lives in `?tab=` (like Accounts), so the slide-out's own param keeps it. replaceState: no server round trip. */
function useTab(): [Tab, (next: Tab) => void] {
  const asked = useSearchParams().get("tab");
  const tab = TABS.find((t) => t.value === asked)?.value ?? "businesses";
  return [
    tab,
    (next) => {
      const url = new URL(window.location.href);
      if (next === "businesses") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url);
    },
  ];
}

function Notice() {
  const settings = useSettings();
  const accounts = useAccounts();
  const text = settings.notice ?? accounts.notice;
  if (!text) return null;
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg bg-tint px-3.5 py-2.5 text-body">
      <span className="min-w-0 flex-1">{text}</span>
      <button
        type="button"
        onClick={() => (settings.say(null), accounts.say(null))}
        className="text-label text-ink-3 underline underline-offset-2 hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}

function Body() {
  const [tab, setTab] = useTab();
  return (
    <div className="flex flex-col gap-5">
      <Notice />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="businesses">
          <BusinessesTab />
        </TabsContent>
        <TabsContent value="general">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="agent">
          <AgentTab />
        </TabsContent>
        <TabsContent value="connections">
          <ConnectionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The Settings page body (owner, 2026-11-22: one page for every setting): Businesses, General, Agent, Connections.
 * Connections and the idle lock run on the Accounts store, as they did on Accounts. Render inside Suspense.
 */
export function SettingsWorkspace({ data, actions }: { data: SettingsData; actions: SettingsActions }) {
  return (
    <AccountsProvider data={data.accounts} actions={actions.accounts}>
      <SettingsProvider data={data} actions={actions}>
        <Body />
      </SettingsProvider>
    </AccountsProvider>
  );
}
