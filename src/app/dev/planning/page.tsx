import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { PlanningFixture } from "./fixture";

export const metadata: Metadata = { title: "Planning fixture" };

/** Fixture: Board, Table and the task and goal drawers on in-memory data, inside the app shell. */
export default function PlanningFixturePage() {
  return (
    <AppShell activeHref="/planning">
      <div className="flex flex-col gap-5">
        <PageHeader title="Planning" />
        <Suspense fallback={null}>
          <PlanningFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
