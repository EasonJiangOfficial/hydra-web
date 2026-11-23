import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { TransactionsFixture } from "./fixture";

export const metadata: Metadata = { title: "Transactions fixture" };

/** Fixture: the Transactions page (table, panel, rule offer, Rules tab) on 3,000+ in-memory rows, inside the app shell. */
export default function TransactionsFixturePage() {
  return (
    <AppShell activeHref="/transactions">
      <div className="flex flex-col gap-5">
        <PageHeader title="Transactions" />
        <Suspense fallback={null}>
          <TransactionsFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
