import { connection } from "next/server";
import { Suspense } from "react";

import { RoutinesLoading } from "@/components/routines/loading";
import { PageHeader } from "@/components/shell/page-header";

import { loadRoutinesData } from "./data";
import { RoutinesLive } from "./live";

export const metadata = { title: "Routines" };

async function RoutinesBody() {
  // Dynamic before anything reads the environment, so a build with no Supabase env still prerenders the shell.
  await connection();
  const data = await loadRoutinesData();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Routines" />
      {data ? (
        <RoutinesLive data={data} />
      ) : (
        <p role="alert" className="text-label text-ink-3">
          Sign in as the owner to see routines.
        </p>
      )}
    </div>
  );
}

/** The route skeleton is the fallback, so a click shows it at full strength and the page simply takes its place. */
export default function RoutinesPage() {
  return (
    <Suspense fallback={<RoutinesLoading />}>
      <RoutinesBody />
    </Suspense>
  );
}
