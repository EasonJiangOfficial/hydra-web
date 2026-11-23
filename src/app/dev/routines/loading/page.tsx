import type { Metadata } from "next";

import { RoutinesLoading } from "@/components/routines/loading";
import { AppShell } from "@/components/shell/app-shell";

export const metadata: Metadata = { title: "Routines loading fixture" };

/** Fixture: the Routines loading skeleton inside the app shell (the real one is app/(app)/routines/loading.tsx). */
export default function RoutinesLoadingFixturePage() {
  return (
    <AppShell activeHref="/routines">
      <RoutinesLoading />
    </AppShell>
  );
}
