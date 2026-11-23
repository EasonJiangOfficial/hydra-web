import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";

import { SettingsFixture } from "./fixture";

export const metadata: Metadata = { title: "Settings fixture" };

/** Fixture: the Settings page on in-memory data, inside the app shell. */
export default function SettingsFixturePage() {
  return (
    <AppShell activeHref="/settings">
      <div className="flex flex-col gap-5">
        <PageHeader title="Settings" />
        <Suspense fallback={null}>
          <SettingsFixture />
        </Suspense>
      </div>
    </AppShell>
  );
}
