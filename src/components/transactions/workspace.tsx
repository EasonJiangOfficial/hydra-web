"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/kit";

import { BulkBar } from "./bulk-bar";
import { TransactionFilters } from "./filters";
import { NoticeBar } from "./notice-bar";
import { RuleEditorDialog } from "./rule-editor";
import { RulesTab } from "./rules-tab";
import { TxProvider, useTx } from "./store";
import { TransactionsTable } from "./table";
import { TransferSuggestions } from "./transfer-suggestions";
import type { Lookups, StoredRule, TxApi } from "./types";
import { TransactionDrawer } from "./tx-panel";

export interface TransactionsWorkspaceProps {
  api: TxApi;
  lookups: Lookups;
  rules: StoredRule[];
  reviewCount: number;
  /** The owner's today, YYYY-MM-DD. */
  today: string;
}

/** The Transactions page body: the table with its filters and queue, the Rules tab, the panel and the rule editor. */
export function TransactionsWorkspace({ api, lookups, rules, reviewCount, today }: TransactionsWorkspaceProps) {
  return (
    <TxProvider api={api} lookups={lookups} initialRules={rules} initialReviewCount={reviewCount} today={today}>
      <Body />
    </TxProvider>
  );
}

function Body() {
  const s = useTx();
  return (
    <>
      <Tabs value={s.tab} onValueChange={(v) => s.setParams({ tab: v === "rules" ? "rules" : null })}>
        <TabsList>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="transactions" className="flex flex-col gap-4">
          <TransactionFilters />
          <BulkBar />
          <TransferSuggestions />
          <TransactionsTable />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab />
        </TabsContent>
      </Tabs>
      <TransactionDrawer />
      <RuleEditorDialog />
      <NoticeBar />
    </>
  );
}
