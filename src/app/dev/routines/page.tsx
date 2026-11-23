import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { RoutinesFixture } from "./fixture";

export const metadata: Metadata = { title: "Routines fixture" };

/** Fixture: the Routines page on in-memory data, inside the app shell. */
export default function RoutinesFixturePage() {
  return (
    <AppShell activeHref="/routines">
      <div className="flex flex-col gap-5">
        <PageHeader title="Routines" />
        <Suspense fallback={null}>
          <RoutinesFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
