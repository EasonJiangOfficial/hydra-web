import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, HydraLoader } from "@/components/kit";

/** Explicit props, not the generated PageProps: the pre-push hook runs plain tsc, which sees stale route types. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: "Loader" };

/** Fixture for the loading logo. `?t=<seconds>` freezes every loader on one frame (screenshots). */
export default function LoaderPage(props: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-10 p-10 max-md:p-4">
      <Suspense fallback={null}>
        <Loaders searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

async function Loaders({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).t;
  const t = typeof raw === "string" && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  return (
    <>
      <div className="flex flex-wrap items-end gap-10">
        {[64, 128, 256].map((size) => (
          <div key={size} className="flex flex-col items-center gap-2">
            <HydraLoader size={size} at={t} className="outline outline-1 -outline-offset-1 outline-rule" data-testid={`loader-${size}`} />
            <span className="text-tag text-ink-3">{size}</span>
          </div>
        ))}
      </div>
      <Card tone="hero" className="items-center py-10">
        <HydraLoader size={256} tone="white" at={t} data-testid="loader-hero" />
      </Card>
    </>
  );
}
