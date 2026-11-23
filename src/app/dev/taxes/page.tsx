import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { TaxesFixture } from "./fixture";

export const metadata: Metadata = { title: "Taxes fixture" };

/** Fixture: the Taxes page on in-memory data (clock fixed at Nov 21, 2026), inside the app shell. */
export default function TaxesFixturePage() {
  return (
    <AppShell activeHref="/taxes">
      <div className="flex flex-col gap-5">
        <PageHeader title="Taxes" />
        <Suspense fallback={null}>
          <TaxesFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
