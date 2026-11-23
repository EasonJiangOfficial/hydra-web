import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";

import { DevScopeEntities } from "../settings/dev-entities";
import { ReportsFixture } from "./fixture";

export const metadata: Metadata = { title: "Reports fixture" };

/**
 * Fixture: the Reports page on eleven months of in-memory transactions, inside the app shell. The scope switch
 * also lists businesses added on /dev/settings in this tab (and Studio Co with `?added=on`).
 */
export default function ReportsFixturePage() {
  return (
    <DevScopeEntities>
      <AppShell activeHref="/reports">
        <Suspense fallback={null}>
          <ReportsFixture />
        </Suspense>
      </AppShell>
    </DevScopeEntities>
  );
}
