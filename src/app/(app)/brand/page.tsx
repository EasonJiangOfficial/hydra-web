import { connection } from "next/server";
import { Suspense } from "react";

import { BrandApp } from "@/components/brand/app";
import { Card } from "@/components/kit";
import { PageHeader } from "@/components/shell/page-header";
import { BrandLoading } from "@/components/shell/skeletons";
import type { BrandRaw } from "@/lib/brand/model";
import { thumbsFor } from "@/lib/brand/instagram-media";
import { loadBrandRaw } from "@/lib/brand/queries";
import { loadInstagramView } from "@/lib/instagram/oauth";
import type { InstagramView } from "@/lib/instagram/model";
import { createServerClient } from "@/lib/supabase/server";

export const metadata = { title: "Personal Brand" };

export default function BrandRoute() {
  return (
    <Suspense fallback={<BrandLoading />}>
      <BrandData />
    </Suspense>
  );
}

async function BrandData() {
  // Per-request data: never prerender this.
  await connection();
  let raw: BrandRaw;
  let instagram: InstagramView;
  try {
    const db = await createServerClient();
    [raw, instagram] = await Promise.all([loadBrandRaw(db), loadInstagramView(db)]);
    // Every post's thumbnail, so any range and every "Show more" page has them.
    raw = { ...raw, thumbs: await thumbsFor(raw.posts) };
  } catch {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Personal Brand" />
        <Card>
          <p role="alert" className="text-body text-ink-3">
            The Personal Brand data did not load. Reload to try again.
          </p>
        </Card>
      </div>
    );
  }
  // The range lives in the URL, which needs its own boundary under cacheComponents.
  return (
    <Suspense fallback={null}>
      <BrandApp raw={raw} instagram={instagram} />
    </Suspense>
  );
}
