"use client";

import Link from "next/link";
import { Bars, Card, Donut, HoverCard, Label, Money, MotionNumber, cn } from "@/components/kit";
import { formatMoney } from "@/components/kit/money";
import { monthName } from "@/components/reports/model";
import { scopedHref } from "@/components/shell/scope";
import { useDashboard } from "./context";
import { prevMonthSpan } from "./derive";
import type { DashboardData } from "./types";

/**
 * Income and expenses for the scope (owner, 2026-11-22: the switch must change "income, expenses ... with graphs
 * and charts"). This month's three figures, twelve months of income against expenses, and this month's top
 * spending categories. Every figure opens Reports in the same scope.
 */

/** Six distinct grays, dark to light: the largest category darkest, "Other" lightest. Donut and legend share them. */
const SLICES = ["var(--slice-1)", "var(--slice-2)", "var(--slice-3)", "var(--slice-4)", "var(--slice-5)", "var(--slice-6)"];
const TOP = 5;
const money = (cents: number) => formatMoney(cents, { whole: true });

/** The five largest categories, largest first, then the rest as "Other"; each with its gray. */
export function topCategories(rows: DashboardData["categories"]) {
  const sorted = [...rows].sort((a, b) => b.cents - a.cents);
  const top =
    sorted.length <= TOP + 1 ? sorted : [...sorted.slice(0, TOP), { name: "Other", cents: sorted.slice(TOP).reduce((a, r) => a + r.cents, 0) }];
  return top.map((r, i) => ({ ...r, fill: SLICES[i] }));
}

/**
 * Whole dollars per legend row that add up to the rounded Expenses figure (largest remainder): each row rounds
 * down, then the rows with the largest cut-off cents take the dollars still missing.
 */
export function wholeDollars(cents: readonly number[], totalCents: number): number[] {
  const floors = cents.map((c) => Math.floor(c / 100));
  let left = Math.round(totalCents / 100) - floors.reduce((a, f) => a + f, 0);
  const order = cents.map((c, i) => ({ i, rem: c - floors[i] * 100 })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left !== 0 && order.length > 0; k++) {
    const { i } = order[k % order.length];
    floors[i] += Math.sign(left);
    left -= Math.sign(left);
  }
  return floors;
}

/** Legend rows on the phone, with the Refunds row. Each is 32 px; the block's phone height grows with them. */
export const legendRows = (d: Pick<DashboardData, "categories" | "refundCents">) => topCategories(d.categories).length + (d.refundCents > 0 ? 1 : 0);

/** True when the scope had no income and no expenses in the twelve months: the block shows only $0 figures. */
export function quietFlow(d: Pick<DashboardData, "trend" | "month">) {
  return d.month.incomeCents === 0 && d.month.spendingCents === 0 && d.trend.every((m) => m.incomeCents === 0 && m.spendingCents === 0);
}

/** Hover lines: the same days of last month, this month so far, and the change (as the This month card compares). */
function compare(now: number, last: number, lastName: string, thisName: string) {
  const diff = now - last;
  const pct = last !== 0 ? ` (${diff >= 0 ? "+" : "-"}${Math.abs(Math.round((diff / Math.abs(last)) * 100))}%)` : "";
  return `${lastName}: ${money(last)}\n${thisName} so far: ${money(now)}\nChange: ${formatMoney(diff, { whole: true, signed: true })}${pct}`;
}

function Figure({ label, cents, info, href, testId }: { label: string; cents: number; info: string; href: string; testId: string }) {
  return (
    <HoverCard content={info} describe={false}>
      <Link
        href={href}
        data-testid={testId}
        className="flex min-w-0 flex-col gap-2 rounded-lg max-md:gap-1 transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Label className="truncate">{label}</Label>
        <span className={cn("truncate text-figure-s tabular-nums max-md:text-[22px]", cents < 0 && "text-neg")}>
          <MotionNumber value={cents} money={{ whole: true }} />
        </span>
      </Link>
    </HoverCard>
  );
}

export function IncomeExpensesCard() {
  const d = useDashboard();
  const reports = scopedHref("/reports", d.scope);
  const m = d.month;
  const net = m.incomeCents - m.spendingCents;
  const thisName = monthName(d.today.slice(0, 7));
  const prev = m.prev;
  const span = prevMonthSpan(d.today);
  const prevName = `${monthName(span.from.slice(0, 7)).slice(0, 3)} 1 to ${Number(span.to.slice(8, 10))}`;
  const quiet = quietFlow(d);
  const slices = topCategories(d.categories);
  // The rows (and Refunds, below zero) add up to the Expenses figure in whole dollars.
  const dollars = wholeDollars([...slices.map((s) => s.cents), ...(d.refundCents > 0 ? [-d.refundCents] : [])], m.spendingCents);

  return (
    <Card className="gap-4 max-md:gap-2" data-testid="income-expenses">
      <div className="flex items-center gap-3">
        <Link
          href={reports}
          className="flex-1 text-label text-ink-3 transition-colors max-md:-my-2 max-md:py-2 duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Income and expenses
        </Link>
        <Label>{thisName}</Label>
      </div>

      <div className="grid grid-cols-3 gap-6 max-md:gap-3 max-md:pb-1" data-testid="flow-strip">
        <Figure label="Income" cents={m.incomeCents} href={reports} testId="flow-income" info={compare(m.incomeCents, prev.incomeCents, prevName, thisName)} />
        <Figure label="Expenses" cents={m.spendingCents} href={reports} testId="flow-expenses" info={compare(m.spendingCents, prev.spendingCents, prevName, thisName)} />
        <Figure
          label="Net"
          cents={net}
          href={reports}
          testId="flow-net"
          info={compare(net, prev.incomeCents - prev.spendingCents, prevName, thisName)}
        />
      </div>

      {quiet ? (
        <Label data-testid="flow-quiet">No income or expenses in the last 12 months.</Label>
      ) : (
        // Keyed by scope: a new scope's charts draw in fresh rather than jumping.
        <div key={d.scope} className="flex min-h-0 flex-1 gap-8 motion-safe:animate-hy-fade max-md:flex-col max-md:gap-4">
          {/* Phone: 160 px however many legend rows there are; the block grows with the rows instead (fitFor). */}
          <div className="min-w-0 flex-1 max-md:h-40 max-md:flex-none" data-testid="flow-chart">
            <Bars
              data={d.trend.map((t) => ({ label: monthName(t.month.slice(0, 7)).slice(0, 3), values: [t.incomeCents, t.spendingCents] }))}
              series={["Income", "Expenses"]}
              money={{ whole: true }}
              height="100%"
              label={`Income and expenses by month, ${d.scopeName}`}
            />
          </div>
          {slices.length > 0 && (
            // Phone: the legend takes the block's spare height and its rows share it, so no blank strip sits under "Other".
            <div className="flex shrink-0 items-center gap-5 max-md:flex-1 max-md:flex-col max-md:items-stretch max-md:gap-4 md:w-[340px]" data-testid="flow-categories">
              <Donut data={slices.map((s) => ({ label: s.name, value: s.cents, color: s.fill }))} money={{ whole: true }} size={132} label={`Spending by category, ${thisName}`} className="shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                {slices.map((s, i) => (
                  <Link
                    key={s.name}
                    href={scopedHref("/reports?tab=spending", d.scope)}
                    className="flex min-w-0 items-center gap-2 py-1 text-tag transition-colors max-md:min-h-8 max-md:flex-1 duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: s.fill }} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{s.name}</span>
                    <Money cents={dollars[i] * 100} whole />
                  </Link>
                ))}
                {d.refundCents > 0 && (
                  // Refunds that pushed a category below zero, as Reports lists them: rows less this is Expenses.
                  <Link
                    href={scopedHref("/reports?tab=spending", d.scope)}
                    data-testid="flow-refunds"
                    className="flex min-w-0 items-center gap-2 py-1 text-tag transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-md:min-h-8 max-md:flex-1"
                  >
                    <span aria-hidden className="size-2.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-ink-2">Refunds</span>
                    <Money cents={dollars[slices.length] * 100} whole />
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
