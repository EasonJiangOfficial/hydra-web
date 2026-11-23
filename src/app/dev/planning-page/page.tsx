import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { PlanningPageFixture } from "./fixture";

export const metadata: Metadata = { title: "Planning page fixture" };

/** Fixture: the whole Planning page (goals, Board, Calendar, Table, panels) on in-memory data, inside the app shell. */
export default function PlanningPageFixturePage() {
  return (
    <AppShell activeHref="/planning">
      <div className="flex flex-col gap-5">
        <PageHeader title="Planning" />
        <Suspense fallback={null}>
          <PlanningPageFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
