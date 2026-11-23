import { connection } from "next/server";
import { Suspense } from "react";

import { Card } from "@/components/kit";
import { PageHeader } from "@/components/shell/page-header";
import { UgcLoading } from "@/components/shell/skeletons";
import { UgcApp } from "@/components/ugc/app";
import type { UgcRaw } from "@/components/ugc/types";

import { loadUgcRaw } from "./data";

export const metadata = { title: "UGC Tracker" };

export default function UgcPage() {
  return (
    <Suspense fallback={<UgcLoading />}>
      <UgcData />
    </Suspense>
  );
}

async function UgcData() {
  // Per-request data: never prerender this (a build without the database would bake in the error card).
  await connection();
  let raw: UgcRaw;
  try {
    raw = await loadUgcRaw();
  } catch {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="UGC Tracker" />
        <Card>
          <p role="alert" className="text-body text-ink-3">
            The UGC data did not load. Reload to try again.
          </p>
        </Card>
      </div>
    );
  }
  // The tracker reads the URL (tab, day, deal), which needs its own boundary under cacheComponents.
  return (
    <Suspense fallback={null}>
      <UgcApp raw={raw} />
    </Suspense>
  );
}
