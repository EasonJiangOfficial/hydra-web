import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { ActivityFixture } from "./fixture";

export const metadata: Metadata = { title: "Activity fixture" };

/** Fixture: the Activity page and the undo bar on in-memory entries, inside the app shell. */
export default function ActivityFixturePage() {
  return (
    <AppShell activeHref="/activity">
      <div className="flex flex-col gap-5">
        <PageHeader title="Activity" />
        <Suspense fallback={null}>
          <ActivityFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
