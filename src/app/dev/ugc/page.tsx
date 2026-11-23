import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";

import { UgcFixture } from "./fixture";

export const metadata: Metadata = { title: "UGC fixture" };

/** Fixture: the whole UGC Tracker (tabs, day and deal panels, both add-deal flows) on in-memory data, inside the app shell. */
export default function UgcFixturePage() {
  return (
    <AppShell activeHref="/ugc">
      <Suspense fallback={null}>
        <UgcFixture />
      </Suspense>
    </AppShell>
  );
}
