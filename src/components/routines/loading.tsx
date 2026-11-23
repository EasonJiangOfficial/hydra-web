import { Card } from "@/components/kit/card";
import { Skeleton as B } from "@/components/kit/skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { SkeletonShown } from "@/components/shell/skeleton-shown";

const NAMES = ["w-44", "w-36", "w-40", "w-32", "w-48"];

/** The Routines page while it loads: the real top bar, the New routine button, and a list card of rows shaped like the live ones. */
export function RoutinesLoading() {
  return (
    <div data-route-loading className="flex flex-col gap-5">
      <SkeletonShown />
      <PageHeader title="Routines" />
      <div role="status" aria-label="Loading Routines" className="flex flex-col gap-5">
        <div className="flex justify-end">
          <B className="h-[34px] w-32 rounded-lg" />
        </div>
        <Card className="gap-0 p-0 max-md:p-0">
          <div aria-hidden className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_auto] gap-x-6 px-6 py-3 max-md:hidden">
            <B className="h-3.5 w-16" />
            <B className="h-3.5 w-16" />
            <B className="h-3.5 w-16" />
            <span className="w-9" />
          </div>
          {NAMES.map((w, i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 border-t border-rule px-6 py-4 first:border-t-0 max-md:px-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_auto]"
            >
              <div className="flex flex-col gap-1.5 md:col-start-1 md:row-start-1">
                <B className={`h-3.5 ${w}`} />
                <B className="h-3 w-28" />
              </div>
              <B className="h-5 w-9 rounded-full max-md:col-start-2 max-md:row-start-1 md:col-start-4 md:row-start-1" />
              <div className="col-span-2 grid grid-cols-2 gap-x-6 md:contents">
                <B className="h-3.5 w-24 md:col-start-2 md:row-start-1" />
                <B className="h-3.5 w-36 max-w-full md:col-start-3 md:row-start-1" />
              </div>
            </div>
          ))}
        </Card>
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}
