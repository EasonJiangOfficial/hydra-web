import { Card } from "@/components/kit/card";
import { Skeleton as B } from "@/components/kit/skeleton";
import { PageHeader } from "@/components/shell/page-header";

const DAYS = [
  ["w-64", "w-48", "w-72", "w-40"],
  ["w-56", "w-44", "w-60"],
];

/** The Activity page while it loads: the real top bar, then day labels over list cards with rows shaped like the live ones. */
export function ActivityLoading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Activity" />
      <div role="status" aria-label="Loading Activity" className="flex flex-col gap-6">
        {DAYS.map((rows, d) => (
          <div key={d} className="flex flex-col gap-2.5">
            <B className="h-3.5 w-20" />
            <Card className="gap-0 p-0 max-md:p-0">
              {rows.map((w, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-t border-rule px-6 py-4 first:border-t-0 max-md:px-4 md:grid-cols-[minmax(0,1fr)_64px_72px_minmax(84px,auto)]"
                >
                  <B className={`h-3.5 max-w-full ${w} md:row-start-1`} />
                  <B className="h-3 w-24 max-md:col-start-1 max-md:row-start-2 md:col-start-2 md:row-start-1 md:w-12" />
                  <B className="h-3.5 w-14 max-md:hidden md:col-start-3 md:row-start-1" />
                  <B className="col-start-2 row-span-2 row-start-1 h-7 w-14 justify-self-end rounded-lg md:col-start-4 md:row-span-1" />
                </div>
              ))}
            </Card>
          </div>
        ))}
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}
