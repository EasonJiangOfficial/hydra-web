"use client";

import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { DetailDrawer, MotionNumber, setDrawerUrl, Stat, Strip, Tabs, TabsContent, TabsList, TabsTrigger, formatMoney } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/shell/page-header";
import { cn } from "@/lib/utils";
import { CashFlowCard, parseChart, type ChartKind } from "./cash-flow";
import { CategoryPanel } from "./category-panel";
import { DOWNLOADS, TABS, headline, incomeSources, monthLabel, parseTab, percent, shiftMonth, type ReportsActions, type ReportsData } from "./model";
import { IncomeTab, SpendingTab, TrendsTab } from "./report-tabs";

const count = (n: number) => `${n} ${n === 1 ? "transaction" : "transactions"}`;

/** Sets or clears one search param without a server round trip (the tab, the chart, the open panel). */
function setParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

/**
 * The Reports page (DESIGN.md section 6.4). `data` is one scope and one month; scope and month live in
 * the URL and change `data` (the server, or the fixture, answers). Tab, chart and the open category panel
 * live in the URL too and change only what shows. Every figure carries `data-row-ids`.
 */
export function ReportsView({
  data,
  actions,
  onChanged,
  exportBase,
}: {
  data: ReportsData;
  actions: ReportsActions;
  /** An edit in the category panel changed the books: reload the figures. */
  onChanged: () => void;
  /** Where downloads come from, e.g. `/reports/export`. */
  exportBase: string;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, start] = useTransition();
  const tab = parseTab(params.get("tab"));
  const chart = parseChart(params.get("chart"));
  const { scope, month, flow } = data;
  const h = headline(flow);

  const goMonth = (next: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("month", next);
    q.delete("category");
    start(() => router.replace(`${pathname}?${q.toString()}`, { scroll: false }));
  };
  const open = (key: string) => setParam("category", key);
  const href = (kind: string) => `${exportBase}?${new URLSearchParams({ kind, scope, month })}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Reports" />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Month">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => goMonth(shiftMonth(month, -1))}>
            <ChevronLeft aria-hidden strokeWidth={1.5} />
          </Button>
          <span className="min-w-36 text-center text-body font-medium" data-testid="month-label">
            {monthLabel(month)}
          </span>
          <Button variant="outline" size="icon" aria-label="Next month" onClick={() => goMonth(shiftMonth(month, 1))}>
            <ChevronRight aria-hidden strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="primary">
              <Download aria-hidden strokeWidth={1.5} />
              Download
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {DOWNLOADS.map((d) => (
              <DropdownMenuItem key={d.kind} asChild>
                <a href={href(d.kind)} download data-testid={`download-${d.kind}`}>
                  {d.label}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className={cn("flex flex-col gap-5 transition-opacity duration-200", pending && "opacity-60")} aria-busy={pending}>
        <Tabs value={tab} onValueChange={(v) => setParam("tab", v === "cash-flow" ? null : v)}>
          <TabsList aria-label="Report">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <Strip cols={4} data-testid="strip" data-row-ids={flow.rowIds.join(" ")}>
            <Stat label="Net income" info={`Income ${formatMoney(h.incomeCents)} minus expenses ${formatMoney(h.spendingCents)}, from ${count(flow.rowIds.length)} in ${monthLabel(month)}. Taxes set aside count as expenses.`}>
              <MotionNumber value={h.netCents} money={{ whole: true }} />
            </Stat>
            <Stat label="Income" info={`${formatMoney(h.incomeCents)} from ${count(incomeSources(flow).reduce((a, l) => a + l.rowIds.length, 0))}. Transfers and card payments are left out.`}>
              <MotionNumber value={h.incomeCents} money={{ whole: true }} />
            </Stat>
            <Stat label="Expenses" info={`${formatMoney(h.spendingCents)} from ${count(data.spending.rows.reduce((a, r) => a + r.count, 0))}, taxes set aside included. Refunds net out.`}>
              <MotionNumber value={h.spendingCents} money={{ whole: true }} />
            </Stat>
            <Stat label="Savings rate" info="Share of income kept after expenses and the tax set-aside.">
              <span data-testid="savings-rate">{h.savingsRate === null ? "-" : percent(h.savingsRate)}</span>
            </Stat>
          </Strip>

          <TabsContent value="cash-flow">
            <CashFlowCard data={data} chart={chart} onChart={(c: ChartKind) => setParam("chart", c === "sankey" ? null : c)} onOpen={open} />
          </TabsContent>
          <TabsContent value="spending">
            <SpendingTab data={data} onOpen={open} />
          </TabsContent>
          <TabsContent value="income">
            <IncomeTab data={data} />
          </TabsContent>
          <TabsContent value="trends">
            <TrendsTab data={data} />
          </TabsContent>
        </Tabs>
      </div>

      <DetailDrawer param="category" label="Category">
        {(key) => (
          <CategoryPanel
            key={`${key}|${scope}|${month}`}
            categoryKey={key}
            scope={scope}
            month={month}
            actions={actions}
            onChanged={onChanged}
            onClose={() => setDrawerUrl(`${pathname}${closeQuery(params)}`)}
          />
        )}
      </DetailDrawer>
    </div>
  );
}

function closeQuery(params: URLSearchParams | { toString(): string }) {
  const q = new URLSearchParams(params.toString());
  q.delete("category");
  const s = q.toString();
  return s ? `?${s}` : "";
}
