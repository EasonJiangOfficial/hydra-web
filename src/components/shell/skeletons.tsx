import type { ReactNode } from "react";
import { Card } from "@/components/kit/card";
import { Skeleton } from "@/components/kit/skeleton";
import { NotesLoading } from "@/components/notes/loading";
import { RoutinesLoading } from "@/components/routines/loading";
import { PageHeader } from "./page-header";
import { SkeletonShown } from "./skeleton-shown";

/*
 * Route loading states. Each one is the real top bar plus Skeleton blocks laid out like that page's live board:
 * 12 columns at 1440, one column at 390. Real card outlines (hairline, 12 px corners), tint blocks inside.
 * The pulse lives in Skeleton and runs under motion-safe only.
 */

const B = Skeleton;


/** One card split by hairlines (the board's `.strip`). The 1 px gaps show the rule color through. */
function Strip({ n, className = "" }: { n: number; className?: string }) {
  return (
    <div className={`grid gap-px overflow-hidden rounded-xl border border-rule bg-rule ${className}`}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 bg-surface p-6">
          <B className="h-3.5 w-24" />
          <B className="h-6.5 w-28" />
        </div>
      ))}
    </div>
  );
}

function Tabs({ widths }: { widths: string[] }) {
  return (
    <div className="flex gap-7 border-b border-rule">
      {widths.map((w, i) => (
        <div key={i} className="box-content flex h-5 items-center pb-3">
          <B className={`h-4 ${w}`} />
        </div>
      ))}
    </div>
  );
}

const NAMES = ["w-40", "w-28", "w-36", "w-24", "w-32", "w-44", "w-28", "w-36", "w-24", "w-40"];

/** Hairline list rows: a name and a right-aligned figure. */
function Rows({ n, lead }: { n: number; lead?: string }) {
  return (
    <div>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-rule py-3 first:border-t-0">
          {lead && <B className={`h-3.5 ${lead}`} />}
          <B className={`h-3.5 max-w-[60%] ${NAMES[i % NAMES.length]}`} />
          <div className="flex-1" />
          <B className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function Grid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-1 gap-3 md:grid-cols-12 md:gap-5 ${className}`}>{children}</div>;
}

function Loading({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div data-route-loading className="flex flex-col gap-5">
      <SkeletonShown />
      <PageHeader title={title} />
      <div role="status" aria-label={`Loading ${title ?? "Dashboard"}`} className="flex flex-col gap-3 md:gap-5">
        {children}
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}

const BARS = [38, 62, 45, 80, 52, 70, 30, 88, 64, 48, 76, 58, 92, 40, 66, 84, 54, 72, 60, 96, 50];

export function DashboardLoading() {
  return (
    <Loading>
      <Grid>
        {/* The hero stays ink, so the page keeps its one dark block while it loads. */}
        <section className="flex min-h-[260px] flex-col gap-3 overflow-hidden rounded-2xl bg-obsidian p-5 md:col-span-8 md:min-h-[332px] md:p-8">
          <B className="h-3.5 w-20 bg-white/10" />
          <B className="h-12 w-56 bg-white/10 md:h-[72px] md:w-96" />
          <B className="h-4 w-40 bg-white/10" />
          <B className="mt-auto h-20 w-full bg-white/10 md:h-24" />
        </section>
        <Card className="gap-5 md:col-span-4">
          {[0, 1].map((g) => (
            <div key={g} className="flex flex-col gap-2">
              <B className="h-3.5 w-20" />
              <B className="h-6.5 w-28" />
              <Rows n={2} />
            </div>
          ))}
        </Card>
        <Strip n={4} className="grid-cols-2 md:col-span-12 md:grid-cols-4" />
        <Card className="md:col-span-4">
          <B className="h-3.5 w-24" />
          <B className="h-6.5 w-28" />
          <Rows n={4} />
        </Card>
        <Card className="md:col-span-4">
          <B className="h-3.5 w-16" />
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: 30 }, (_, i) => (
              <B key={i} className="h-6.5 rounded-sm" />
            ))}
          </div>
          <B className="h-3 w-40" />
        </Card>
        <Card className="md:col-span-4">
          <B className="h-3.5 w-16" />
          <Rows n={5} />
        </Card>
        <Card className="md:col-span-6">
          <B className="h-3.5 w-14" />
          <div>
            {[72, 39, 80].map((w, i) => (
              <div key={i} className="flex items-center gap-3 border-t border-rule py-3 first:border-t-0">
                <B className={`h-3.5 ${NAMES[i]}`} />
                <div className="h-1 flex-1 overflow-hidden rounded-xs bg-tint">
                  <B className="h-full rounded-none bg-rule-2" style={{ width: `${w}%` }} />
                </div>
                <B className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        </Card>
        <Card className="md:col-span-6">
          <B className="h-3.5 w-20" />
          <Rows n={3} lead="w-12" />
        </Card>
      </Grid>
    </Loading>
  );
}

export function PlanningLoading() {
  const columns = [3, 2, 2, 1];
  return (
    <Loading title="Planning">
      <B className="h-3.5 w-12" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4 md:gap-5">
        {[64, 40, 82, 25].map((w, i) => (
          <Card key={i} className="gap-2 p-4">
            <div className="flex items-center gap-3">
              <B className={`h-4 ${NAMES[i]}`} />
              <div className="flex-1" />
              <B className="h-3 w-10" />
            </div>
            <div className="h-1 overflow-hidden rounded-xs bg-tint">
              <B className="h-full rounded-none bg-rule-2" style={{ width: `${w}%` }} />
            </div>
            <B className="h-3 w-24" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4 md:gap-5">
        {columns.map((n, c) => (
          <section key={c} className="flex flex-col gap-2 rounded-lg bg-tint p-3">
            <div className="flex items-center gap-2 px-1 py-1">
              <B className="h-3.5 w-20 bg-rule" />
              <div className="flex-1" />
              <B className="h-3.5 w-4 bg-rule" />
            </div>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-3">
                <B className={`h-4 ${NAMES[(c + i) % NAMES.length]}`} />
                <div className="flex gap-1.5">
                  <B className="h-3 w-14" />
                  <B className="h-3 w-16" />
                </div>
                <B className="h-3 w-10" />
              </div>
            ))}
          </section>
        ))}
      </div>
    </Loading>
  );
}

export function UgcLoading() {
  return (
    <Loading title="UGC Tracker">
      <Tabs widths={["w-16", "w-12", "w-10"]} />
      <Strip n={5} className="grid-cols-2 md:grid-cols-5" />
      <Grid>
        <Card className="md:col-span-7">
          <div className="flex items-center gap-3">
            <B className="h-3.5 w-28" />
            <div className="flex-1" />
            <B className="h-3 w-20" />
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: 7 }, (_, i) => (
              <B key={`d${i}`} className="mx-auto mb-1 h-3 w-6" />
            ))}
            {Array.from({ length: 35 }, (_, i) => (
              <B key={i} className="h-11 rounded-sm" />
            ))}
          </div>
          <div className="mt-2">
            <B className="mb-1 h-3.5 w-36" />
            <Rows n={3} />
          </div>
        </Card>
        <div className="flex flex-col gap-3 md:col-span-5 md:gap-4">
          <Card>
            <B className="h-3.5 w-36" />
            <Rows n={4} />
          </Card>
          <Card className="flex-1">
            <B className="h-3.5 w-28" />
            <div className="flex h-30 items-end gap-1">
              {BARS.map((h, i) => (
                <B key={i} className="flex-1 rounded-xs" style={{ height: `${h}%` }} />
              ))}
            </div>
            <div className="flex justify-between">
              <B className="h-3 w-10" />
              <B className="h-3 w-10" />
            </div>
          </Card>
        </div>
      </Grid>
    </Loading>
  );
}

/** Sankey placeholder: node bars in three columns, the way the chart stands before its bands draw in. */
const SANKEY = [
  [44, 30, 26],
  [100],
  [26, 16, 12, 10, 8, 6, 5],
];

export function ReportsLoading() {
  return (
    <Loading title="Reports">
      <Tabs widths={["w-16", "w-16", "w-14", "w-12"]} />
      <Strip n={4} className="grid-cols-2 md:grid-cols-4" />
      <Card>
        <div className="flex items-center gap-3">
          <B className="h-3.5 w-20" />
          <div className="flex-1" />
          <B className="hidden h-8 w-56 md:block" />
          <B className="h-8 w-28" />
        </div>
        <div className="mt-2 flex h-80 justify-between md:h-110">
          {SANKEY.map((col, c) => (
            <div key={c} className="flex w-[30%] flex-col justify-center gap-3 first:items-start last:items-end [&:nth-child(2)]:items-center">
              {col.map((h, i) => (
                <div key={i} className="flex items-center gap-2" style={{ height: `${h * 0.8}%` }}>
                  <B className="h-full w-2.5 rounded-xs" />
                  {c !== 1 && <B className="hidden h-3 w-16 md:block" />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </Loading>
  );
}

export function TransactionsLoading() {
  const cols = "grid grid-cols-[56px_minmax(0,1fr)_72px] items-center gap-3 md:grid-cols-[72px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_96px]";
  return (
    <Loading title="Transactions">
      <Tabs widths={["w-24", "w-12"]} />
      {/* The live filters, same wrap: the Seg (32 px) and Search; desktop the five pickers and the count, phone the Filters button. */}
      <div className="flex flex-col gap-4 max-md:mt-2">
        <div className="flex flex-wrap items-center gap-3">
          <B className="h-8 w-[228px] shrink-0" />
          <B className="h-[34px] max-w-[260px] min-w-[120px] flex-1 max-md:max-w-none" />
          <B className="h-[34px] w-[91px] md:hidden" />
          <div className="hidden flex-wrap items-center gap-3 md:flex">
            {["w-[170px]", "w-[170px]", "w-[200px]", "w-[150px]", "w-[150px]"].map((w, i) => (
              <B key={i} className={`h-[34px] ${w}`} />
            ))}
          </div>
          <B className="ml-auto h-3.5 w-24 max-md:hidden" />
        </div>
        <Card className="gap-0">
          <div className={`${cols} border-b border-rule pb-2`}>
            {["w-8", "w-10", "w-14", "w-16", "w-14", "w-12"].map((w, i) => (
              <B key={i} className={`h-3 ${w} ${i >= 2 && i <= 4 ? "hidden md:block" : ""} ${i === 5 ? "justify-self-end" : ""}`} />
            ))}
          </div>
          {Array.from({ length: 10 }, (_, r) => (
            <div key={r} className={`${cols} border-b border-rule py-3.5 last:border-b-0`}>
              <B className="h-3.5 w-12" />
              <B className={`h-3.5 max-w-full ${NAMES[r]}`} />
              <B className="hidden h-3.5 w-24 md:block" />
              <B className="hidden h-3.5 w-20 md:block" />
              <B className="hidden h-3.5 w-12 md:block" />
              <B className="h-3.5 w-16 justify-self-end" />
            </div>
          ))}
        </Card>
      </div>
    </Loading>
  );
}

export function TaxesLoading() {
  return (
    <Loading title="Taxes">
      <Grid>
        <div className="flex flex-col gap-3 md:col-span-8 md:gap-4">
          <Strip n={4} className="grid-cols-2 md:grid-cols-4" />
          <Card>
            <div className="flex items-center gap-3">
              <B className="h-3.5 w-36" />
              <div className="flex-1" />
              <B className="h-8 w-28" />
            </div>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
              {[0, 1, 2, 3].map((q) => (
                <div key={q} className="flex flex-col gap-2">
                  <B className="h-3 w-12" />
                  <B className="h-4 w-24" />
                  <B className="h-3.5 w-16" />
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <B className="h-3.5 w-36" />
            <Rows n={7} lead="w-6" />
          </Card>
        </div>
        <Card className="md:col-span-4">
          <B className="h-3.5 w-20" />
          <B className="h-10 w-3/4 self-end" />
          <B className="h-28 w-[92%]" />
          <div className="mt-auto flex flex-col gap-1.5 pt-6">
            <B className="h-9 w-full" />
            <B className="h-9 w-full" />
            <B className="h-9 w-full" />
          </div>
          <div className="flex gap-2">
            <B className="h-8.5 flex-1" />
            <B className="h-8.5 w-16" />
          </div>
        </Card>
      </Grid>
    </Loading>
  );
}

export function AccountsLoading() {
  return (
    <Loading title="Accounts">
      {/* The sync status and the Sync now / Add account buttons (34 px); on a phone the buttons wrap under the status. */}
      <div className="flex flex-wrap items-center gap-3 max-md:mb-2">
        <div className="flex h-5 items-center max-md:basis-full">
          <B className="h-3.5 w-20" />
        </div>
        <div className="flex-1 max-md:hidden" />
        <B className="h-[34px] w-[90px]" />
        <B className="h-[34px] w-[135px]" />
      </div>
      <Tabs widths={["w-16", "w-16"]} />
      <Grid className="max-md:mt-2">
        <div className="flex flex-col gap-3 md:col-span-8 md:gap-4">
          {[0, 1, 2].map((c) => (
            <Card key={c}>
              <div className="flex items-center gap-3">
                <B className="h-3.5 w-20" />
                <div className="flex-1" />
                <B className="h-6.5 w-32" />
              </div>
              <div>
                {[0, 1].map((r) => (
                  <div key={r} className="flex items-center gap-3 border-t border-rule py-3">
                    <div className="size-8 flex-none rounded-md border border-rule" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <B className={`h-3.5 ${NAMES[c * 2 + r]}`} />
                      <B className="h-3 w-24" />
                    </div>
                    <B className="h-3.5 w-20" />
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
        <Card className="md:col-span-4">
          <B className="h-3.5 w-28" />
          <B className="h-18 w-full" />
          <B className="h-18 w-full" />
          <B className="h-18 w-full" />
        </Card>
      </Grid>
    </Loading>
  );
}

export function BrandLoading() {
  return (
    <Loading title="Personal Brand">
      <div className="flex items-center gap-3 pt-3">
        <B className="h-4 w-28" />
        <div className="flex-1" />
        <B className="h-8 w-72 max-sm:w-40" />
      </div>
      <Strip n={6} className="grid-cols-2 lg:grid-cols-6" />
      <Card>
        <B className="h-3.5 w-24" />
        <B className="h-50 w-full" />
      </Card>
      <Card>
        <B className="h-3.5 w-36" />
        <B className="h-30 w-full" />
      </Card>
      <Card>
        <B className="h-3.5 w-20" />
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <B key={i} className="aspect-square w-full rounded-lg" />
          ))}
        </div>
      </Card>
    </Loading>
  );
}

export function SettingsLoading() {
  return (
    <Loading title="Settings">
      <Tabs widths={["w-20", "w-16", "w-12", "w-24"]} />
      <Card>
        <div className="flex items-center gap-3">
          <B className="h-3.5 w-24" />
          <div className="flex-1" />
          <B className="h-8.5 w-32" />
        </div>
        <div>
          {[0, 1, 2].map((r) => (
            <div key={r} className="flex items-center gap-3 border-t border-rule py-3 first:border-t-0">
              <B className={`h-3.5 ${NAMES[r]}`} />
              <div className="flex-1" />
              <B className="h-3 w-24 max-md:hidden" />
              <B className="h-3 w-16" />
            </div>
          ))}
        </div>
      </Card>
    </Loading>
  );
}

/** Every route's loading state by key, so the /dev/shell fixture renders the same components. */
export const LOADING = {
  dashboard: { href: "/", Component: DashboardLoading },
  planning: { href: "/planning", Component: PlanningLoading },
  notes: { href: "/notes", Component: NotesLoading },
  ugc: { href: "/ugc", Component: UgcLoading },
  brand: { href: "/brand", Component: BrandLoading },
  reports: { href: "/reports", Component: ReportsLoading },
  transactions: { href: "/transactions", Component: TransactionsLoading },
  taxes: { href: "/taxes", Component: TaxesLoading },
  accounts: { href: "/accounts", Component: AccountsLoading },
  routines: { href: "/routines", Component: RoutinesLoading },
  settings: { href: "/settings", Component: SettingsLoading },
} as const;

export type LoadingKey = keyof typeof LOADING;
