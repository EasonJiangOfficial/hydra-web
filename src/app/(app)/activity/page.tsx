import { connection } from "next/server";
import { Suspense } from "react";

import { SkeletonCard } from "@/components/kit";
import { PageHeader } from "@/components/shell/page-header";
import { listActivity } from "@/lib/activity/queries";
import { ownerSession } from "@/lib/agent/caller";
import { supabaseStore } from "@/lib/agent/store";

import { ActivityLive } from "./live";

export const metadata = { title: "Activity" };

const PAGE = 50;

/** The next page (or a reload of what is on screen) for the client list. `listActivity` reads as the signed-in owner. */
async function loadActivity(opts: { before?: string; limit?: number }) {
  "use server";
  const limit = Math.min(Math.max(1, Math.floor(Number(opts?.limit) || PAGE)), 200);
  return listActivity({ before: typeof opts?.before === "string" ? opts.before : undefined, limit });
}

async function ActivityBody() {
  // Dynamic before anything reads the environment, so a build with no Supabase env still prerenders the shell.
  await connection();
  const db = await ownerSession();
  if (!db) {
    return (
      <p role="alert" className="text-label text-ink-3">
        Sign in as the owner to see activity.
      </p>
    );
  }
  const [first, timeZone] = await Promise.all([listActivity({ limit: PAGE }), supabaseStore(db).timeZone()]);
  return <ActivityLive first={first} timeZone={timeZone} now={new Date().toISOString()} load={loadActivity} />;
}

export default function ActivityPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Activity" />
      <Suspense fallback={<SkeletonCard />}>
        <ActivityBody />
      </Suspense>
    </div>
  );
}
