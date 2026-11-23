"use client";

import {
  Bar,
  Bars,
  Card,
  Donut,
  HoverCard,
  Label,
  ListRow,
  Money,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  formatMoney,
} from "@/components/kit";
import { ChartHits } from "./chart-hits";
import { dayLabel, monthLabel, monthShort, percent, type ReportsData } from "./model";

const count = (n: number) => `${n} ${n === 1 ? "transaction" : "transactions"}`;
/** The kit donut's gray ramp, in the order it paints slices, for the dot beside each row. */
const RAMP = ["var(--ramp-1)", "var(--ramp-3)", "var(--ramp-4)", "var(--ramp-2)", "var(--ramp-5)", "var(--ramp-6)"];
/** Slices before "The rest": one ramp step each, so no two slices share a gray (DESIGN 7). */
const SLICES = RAMP.length - 1;
/** RAMP's values (theme.css), to keep a gray a category already wears off the other slices. */
const RAMP_HEX = ["#1d1d1f", "#6e6e73", "#a1a1a6", "#424245", "#d2d2d7", "#e5e5ea"];

/**
 * Each slice's fill, so no two slices look the same. A slice keeps its category's color unless an
 * earlier slice already has it; the others take the grays nobody wears, in ramp order, and the
 * last slice ("The rest" when `folded`) takes the lightest gray left.
 */
export function sliceFills(colors: readonly (string | null | undefined)[], folded: boolean): string[] {
  const seen = new Set<string>();
  const own = colors.map((c) => {
    const hex = c?.toLowerCase();
    if (!hex || seen.has(hex)) return null;
    seen.add(hex);
    return hex;
  });
  const pool = RAMP.filter((_, i) => !seen.has(RAMP_HEX[i]));
  const rest = folded ? pool.pop() : undefined;
  return own.map((hex, i) => hex ?? (folded && i === own.length - 1 ? rest : pool.shift()) ?? RAMP[i % RAMP.length]);
}

/** The donut's slices: the five largest categories, then the rest as one slice (the last ramp step). */
export function donutSlices<T extends { name: string; cents: number; count: number; color?: string | null }>(rows: readonly T[]) {
  // A category with its own color keeps it; the others take the gray ramp.
  const slice = (r: T) => ({ label: r.name, value: r.cents, count: r.count, ...(r.color ? { color: r.color } : {}) });
  if (rows.length <= RAMP.length) return rows.map(slice);
  const rest = rows.slice(SLICES);
  return [
    ...rows.slice(0, SLICES).map(slice),
    { label: "The rest", value: rest.reduce((a, r) => a + r.cents, 0), count: rest.reduce((a, r) => a + r.count, 0) },
  ];
}

/** Spending tab: the donut in the gray ramp and the category table. A slice or a row opens its category. */
export function SpendingTab({ data, onOpen }: { data: ReportsData; onOpen: (key: string) => void }) {
  const { rows, totalCents, refundCents } = data.spending;
  const listedCents = totalCents + refundCents;
  const slices = donutSlices(rows);
  const folded = slices.length < rows.length;
  const fills = sliceFills(slices.map((s) => ("color" in s ? s.color : null)), folded);
  const keyOf = (i: number) => rows[i]?.categoryId ?? "none-expense";
  const hit = (i: number) => {
    const s = slices[i];
    if (!s) return null;
    const lines = [s.label, `${formatMoney(s.value)} · ${percent(listedCents > 0 ? s.value / listedCents : 0)}`, count(s.count)];
    return folded && i === SLICES ? { lines } : { lines, open: () => onOpen(keyOf(i)) };
  };
  /** A row's dot: its slice's fill; every row in the last slice shares its fill. */
  const dot = (i: number) => fills[folded ? Math.min(i, SLICES) : i];
  if (!rows.length) return <Card><p className="py-16 text-center text-label text-ink-3">No spending this month</p></Card>;
  return (
    <div className="grid gap-5 md:grid-cols-12">
      <Card className="items-center md:col-span-5">
        <Label className="self-start">Expenses by category</Label>
        <ChartHits targets={[{ selector: ".recharts-pie-sector", at: hit }]} className="w-full py-3">
          <Donut data={slices.map(({ label, value }, i) => ({ label, value, color: fills[i] }))} money={{ whole: true }} size={240} label="Expenses by category" />
        </ChartHits>
        <span className="text-figure-s tabular-nums" data-row-ids={data.spending.rowIds.join(" ")}>
          <Money cents={totalCents} whole />
        </span>
      </Card>
      <Card className="md:col-span-7">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead numeric>Share</TableHead>
              <TableHead numeric className="max-sm:hidden">
                Transactions
              </TableHead>
              <TableHead numeric>Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <HoverCard key={r.categoryId ?? "none"} content={`${r.name}\n${formatMoney(r.cents)} · ${percent(r.share)}\n${count(r.count)}`} describe={false}>
                <TableRow clickable data-row-ids={r.rowIds.join(" ")} onClick={() => onOpen(keyOf(i))} className="border-t border-rule first:border-t-0">
                  <TableCell>
                    <button
                      type="button"
                      aria-label={`Open ${r.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(keyOf(i));
                      }}
                      className="flex items-center gap-2.5 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: dot(i) }} />
                      {r.name}
                    </button>
                  </TableCell>
                  <TableCell numeric className="text-ink-3 tabular-nums">
                    {percent(r.share)}
                  </TableCell>
                  <TableCell numeric className="text-ink-3 tabular-nums max-sm:hidden">
                    {r.count}
                  </TableCell>
                  <TableCell numeric className="tabular-nums">
                    <Money cents={r.cents} whole />
                  </TableCell>
                </TableRow>
              </HoverCard>
            ))}
          </TableBody>
          <TableFooter>
            {refundCents > 0 && (
              // Categories a refund pushed below zero are off the list; their net comes off here so the
              // total is the same net spending as the headline and the Dashboard (RM-03).
              <TableRow data-testid="spending-refunds">
                <TableCell>Refunds</TableCell>
                <TableCell numeric />
                <TableCell numeric className="max-sm:hidden" />
                <TableCell numeric className="tabular-nums">
                  <Money cents={-refundCents} whole />
                </TableCell>
              </TableRow>
            )}
            <TableRow>
              <TableCell>Total</TableCell>
              <TableCell numeric />
              <TableCell numeric className="tabular-nums max-sm:hidden">
                {rows.reduce((a, r) => a + r.count, 0)}
              </TableCell>
              <TableCell numeric className="tabular-nums">
                <Money cents={totalCents} whole />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Card>
    </div>
  );
}

/** Income tab: who paid, year to date. */
export function IncomeTab({ data }: { data: ReportsData }) {
  const { rows, totalCents, range } = data.payers;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-3">
        <Label>Income by payer</Label>
        <span className="text-label text-ink-3">
          {dayLabel(range.from)} to {dayLabel(range.to)}
        </span>
        <div className="flex-1" />
        <span className="text-figure-s tabular-nums" data-testid="payers-total" data-row-ids={data.payers.rowIds.join(" ")}>
          <Money cents={totalCents} whole />
        </span>
      </div>
      {rows.length === 0 && <p className="py-12 text-center text-label text-ink-3">No income this year</p>}
      <div>
        {rows.map((p) => (
          <HoverCard key={p.payer} content={`${p.payer}\n${formatMoney(p.cents)} · ${percent(p.share)}\n${count(p.count)}`} describe={false}>
            <ListRow data-row-ids={p.rowIds.join(" ")} data-testid="payer-row" className="gap-4">
              <span className="min-w-0 flex-1 truncate">{p.payer}</span>
              <Bar value={p.share} className="hidden w-40 sm:block" aria-label={`${p.payer} share of income`} />
              <span className="w-12 text-right text-ink-3 tabular-nums">{percent(p.share)}</span>
              <span className="w-24 text-right tabular-nums">
                <Money cents={p.cents} whole />
              </span>
            </ListRow>
          </HoverCard>
        ))}
      </div>
    </Card>
  );
}

/** Trends tab: income and spending for each of the last twelve months. */
export function TrendsTab({ data }: { data: ReportsData }) {
  const { months } = data.trend;
  return (
    <Card>
      <Label>Last twelve months</Label>
      <div className="-mx-1 overflow-x-auto px-1">
        <div className="min-w-[560px]">
          <Bars
            data={months.map((m) => ({ label: monthShort(m.month.slice(0, 7)), values: [m.incomeCents, m.spendingCents] }))}
            series={["Income", "Spending"]}
            money={{ whole: true }}
            height={240}
            label="Income and spending by month"
          />
        </div>
      </div>
      <div className="flex gap-4 text-tag text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px] bg-ramp-1" />
          Income
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px] bg-ramp-3" />
          Spending
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead numeric>Income</TableHead>
            <TableHead numeric>Spending</TableHead>
            <TableHead numeric>Net</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...months].reverse().map((m) => {
            const key = m.month.slice(0, 7);
            return (
              <HoverCard
                key={m.month}
                content={`${monthLabel(key)}\nIncome ${formatMoney(m.incomeCents)}\nSpending ${formatMoney(m.spendingCents)}\nNet ${formatMoney(m.netCents, { signed: true })} · ${count(m.count)}`}
                describe={false}
              >
                <TableRow data-testid="trend-row" data-month={key} data-row-ids={m.rowIds.join(" ")} className="border-t border-rule first:border-t-0">
                  <TableCell>{monthLabel(key)}</TableCell>
                  <TableCell numeric className="tabular-nums">
                    <Money cents={m.incomeCents} whole />
                  </TableCell>
                  <TableCell numeric className="tabular-nums">
                    <Money cents={m.spendingCents} whole />
                  </TableCell>
                  <TableCell numeric className="tabular-nums">
                    <Money cents={m.netCents} whole signed tone={m.netCents < 0 ? "loss" : "default"} />
                  </TableCell>
                </TableRow>
              </HoverCard>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
