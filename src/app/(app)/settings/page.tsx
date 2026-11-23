import { connection } from "next/server";
import { Suspense } from "react";

import { SkeletonCard } from "@/components/kit";
import { PageHeader } from "@/components/shell/page-header";

import { loadSettingsData } from "./data";
import { SettingsLive } from "./live";

export const metadata = { title: "Settings" };

async function SettingsBody() {
  // Dynamic before anything reads the environment, so a build with no Supabase env still prerenders the shell.
  await connection();
  return <SettingsLive data={await loadSettingsData()} />;
}

/** Settings (owner, 2026-11-22): `?tab=businesses|general|agent|connections`; `?business=<id>|new` opens the slide-out. */
export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" />
      <Suspense fallback={<SkeletonCard />}>
        <SettingsBody />
      </Suspense>
    </div>
  );
}
