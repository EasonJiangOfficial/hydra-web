import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { AccountsFixture } from "./fixture";

export const metadata: Metadata = { title: "Accounts fixture" };

/** Fixture: the Accounts page on in-memory data, inside the app shell. */
export default function AccountsFixturePage() {
  return (
    <AppShell activeHref="/accounts">
      <div className="flex flex-col gap-5">
        <PageHeader title="Accounts" />
        <Suspense fallback={null}>
          <AccountsFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
