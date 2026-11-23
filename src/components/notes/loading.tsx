import { Skeleton as B } from "@/components/kit/skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { SkeletonShown } from "@/components/shell/skeleton-shown";

const ROWS = ["w-40", "w-32", "w-44", "w-28", "w-36"];

/** The Notes page while it loads: the real top bar, then the list pane (search, New note, rows) and an empty note pane. */
export function NotesLoading() {
  return (
    <div data-route-loading className="flex flex-col gap-5">
      <SkeletonShown />
      <PageHeader title="Notes" />
      <div
        role="status"
        aria-label="Loading Notes"
        className="grid overflow-hidden md:h-[calc(100dvh-108px)] md:grid-cols-[288px_minmax(0,1fr)] md:rounded-xl md:border md:border-rule"
      >
        <div className="flex flex-col md:border-r md:border-rule">
          <div className="flex items-center gap-2 pb-3 md:p-3">
            <B className="h-[34px] flex-1 rounded-lg" />
            <B className="h-[34px] w-28 rounded-lg" />
          </div>
          <div className="flex flex-col gap-1 md:px-2">
            {ROWS.map((w, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-3 py-2.5">
                <B className={`h-3.5 ${w}`} />
                <B className="h-3 w-48 max-w-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="max-md:hidden" />
      </div>
    </div>
  );
}
