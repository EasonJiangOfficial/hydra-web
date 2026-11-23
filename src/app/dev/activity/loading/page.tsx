import type { Metadata } from "next";

import { ActivityLoading } from "@/components/activity/loading";
import { AppShell } from "@/components/shell/app-shell";

export const metadata: Metadata = { title: "Activity loading fixture" };

/** Fixture: the Activity loading skeleton inside the app shell (the real one is app/(app)/activity/loading.tsx). */
export default function ActivityLoadingFixturePage() {
  return (
    <AppShell activeHref="/activity">
      <ActivityLoading />
    </AppShell>
  );
}
