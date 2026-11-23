"use client";

import { CircleAlert } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Card, DayCell, DayLegend, EASE, HoverCard, InfoDot, Label, ListRow, Money, Pill, Seg, Stat, Strip, cn } from "@/components/kit";
import { formatMoney } from "@/components/kit/money";
import { scopedHref } from "@/components/shell/scope";
import { ColorDot } from "@/components/ui/color-picker";
import { ViewGapNotice } from "@/components/ugc/view-gap-notice";
import { showsUgc } from "@/lib/entities/model";
import { formatDay } from "@/lib/planning/dates";
import { viewGapWarning } from "@/lib/ugc/view-gaps";
import { useDashboard } from "./context";
import { RANGES, dueLabel, netWorthDelta, pctText, signedPct, sinceText, sliceNetWorth, type Range } from "./derive";
import type { PostingDay } from "./types";
import { NetWorthChart } from "./net-worth-chart";

/**
 * The Dashboard's cards, one per block id in `src/lib/layout/blocks.ts`. Each fills its grid slot,
 * reads `useDashboard()`, and falls back to one plain line and a link when it has nothing to show.
 * Rows that open something are links (`?tx=`, `?account=`, `?goal=`, `?day=`), so the shared panel
 * and the browser's own back button handle them.
 */

const money = (cents: number) => formatMoney(cents, { whole: true });
/** A card's list: rows at their own 40 px height, top-aligned under the heading; the card fits them (fitFor). */
const LIST = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

function Head({ children, aside, href }: { children: ReactNode; aside?: ReactNode; href?: string }) {
  return (
    <div className="flex items-center gap-3">
      {href ? (
        <Link href={href} className="flex-1 text-label text-ink-3 transition-colors duration-200 max-md:-my-2 max-md:py-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          {children}
        </Link>
      ) : (
        <Label className="flex-1">{children}</Label>
      )}
      {aside}
    </div>
  );
}

/** One plain line and one link: the whole empty state of a card. */
function Empty({ text, link, href }: { text: string; link?: string; href?: string }) {
  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="empty-state">
      <Label>{text}</Label>
      {link && href && (
        <Link
          href={href}
          className="text-body text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink in-data-[tone=hero]:text-white"
        >
          {link}
        </Link>
      )}
    </div>
  );
}

const noAccounts = <Empty text="No accounts yet." link="Add account" href="/accounts" />;

// ---------------------------------------------------------------------------------------------
// Net worth (the one hero)
// ---------------------------------------------------------------------------------------------

export function NetWorthCard() {
  const d = useDashboard();
  const [range, setRange] = useState<Range>("1m");
  const points = useMemo(() => sliceNetWorth(d.netWorth, range, d.today), [d.netWorth, range, d.today]);
  const last = d.netWorth.at(-1);

  if (!d.hasAccounts && d.scope !== "all") {
    // One row, so Income and expenses below reads as the top of the board (the grid fits this block to one row).
    return (
      <Card className="flex-row items-center gap-3 py-0 max-md:py-0" data-testid="net-worth-none">
        <Label className="shrink-0 max-md:hidden">Net worth</Label>
        <span className="min-w-0 flex-1 truncate text-body text-ink-2">No accounts in {d.scopeName}</span>
        <Link
          href="/accounts"
          className="shrink-0 py-2 text-body text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Assign an account
        </Link>
      </Card>
    );
  }
  if (!d.hasAccounts || !last) {
    return (
      <Card tone="hero" className="gap-3 px-8 pt-8 max-md:px-5 max-md:pt-5">
        <Label>Net worth</Label>
        {noAccounts}
      </Card>
    );
  }

  const delta = netWorthDelta(points);
  return (
    <Card tone="hero" className="gap-3 overflow-hidden px-8 pt-8 pb-0 max-md:px-5 max-md:pt-5 max-md:pb-0">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2 md:gap-3">
          <Label>Net worth</Label>
          <span className="text-hero max-md:text-[52px]" data-testid="net-worth-figure">
            <Money cents={last.netCents} dimCents className="max-md:hidden" />
            <Money cents={last.netCents} whole className="md:hidden" />
          </span>
          <span className="flex items-center gap-2.5">
            <Money cents={delta.cents} signed className="max-md:hidden" />
            <Money cents={delta.cents} signed whole className="md:hidden" />
            <Label>
              {delta.pct === null ? "" : `${pctText(delta.pct)} `}
              {sinceText(range)}
            </Label>
          </span>
        </div>
        <Seg
          aria-label="Range"
          tone="dark"
          items={RANGES}
          value={range}
          onValueChange={(v) => setRange(v as Range)}
          className="max-md:hidden"
        />
      </div>
      <div className="-mx-5 mt-auto min-h-0 flex-1 md:-mx-8">
        <NetWorthChart points={points} today={d.today} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Cash and credit cards
// ---------------------------------------------------------------------------------------------

export function AccountsCard() {
  const d = useDashboard();
  if (!d.hasAccounts) {
    return (
      <Card className="gap-5">
        <Label>Cash and cards</Label>
        {noAccounts}
      </Card>
    );
  }
  const due = d.cards.rows
    .filter((c) => c.owedCents > 0 && c.dueOn)
    .sort((a, b) => a.dueOn!.localeCompare(b.dueOn!))[0];
  const dueText = due ? dueLabel(due.dueOn!, d.today) : null;
  return (
    <Card className="gap-5 overflow-y-auto">
      <div className="flex flex-col gap-1.5">
        <Head href="/accounts">Cash</Head>
        <span className="text-figure-s" data-testid="cash-total">
          <Money cents={d.cash.totalCents} whole />
        </span>
        {d.cash.rows.length > 0 && (
          <div className="border-t border-rule">
            {d.cash.rows.map((r) => (
              <ListRow key={r.id} as={Link} href={`/accounts?account=${r.id}`}>
                <span className="min-w-0 flex-1 truncate text-ink-2">{r.name}</span>
                <Money cents={r.cents} />
              </ListRow>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Head
          href="/accounts"
          aside={dueText && <Pill tone={dueText.overdue ? "loss" : "strong"}>{dueText.text}</Pill>}
        >
          Credit cards
        </Head>
        <span className="text-figure-s" data-testid="cards-total">
          <Money cents={-d.cards.totalCents} whole />
        </span>
        {d.cards.rows.length > 0 && (
          <div className="border-t border-rule">
            {d.cards.rows.map((c) => {
              const lines = [
                c.statementCents !== null ? `Statement ${formatMoney(c.statementCents)}` : null,
                c.dueOn ? `Due ${formatDay(c.dueOn, d.today)}` : null,
                c.limitCents ? `Using ${Math.round((c.owedCents / c.limitCents) * 100)}% of ${money(c.limitCents)} limit` : null,
              ].filter(Boolean);
              return (
                <HoverCard key={c.id} content={lines.length ? lines.join("\n") : `${c.name}\nNo statement yet`} describe={false}>
                  <ListRow as={Link} href={`/accounts?account=${c.id}`}>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{c.name}</span>
                    <Money cents={c.owedCents} />
                  </ListRow>
                </HoverCard>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Cash, cards and UGC: the phone's three tiles (Mobile.dc.html)
// ---------------------------------------------------------------------------------------------

function Tile({ label, href, children, aside, className }: { label: string; href: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <Card as={Link} href={href} className={cn("min-w-0 justify-between gap-1 p-3 max-md:p-3", className)}>
      <span className="flex items-center gap-1.5">
        <Label className="truncate">{label}</Label>
        {aside}
      </span>
      <span className="truncate text-[20px] leading-tight tabular-nums">{children}</span>
    </Card>
  );
}

export function SummaryCard() {
  const d = useDashboard();
  const gap = d.ugc ? viewGapWarning(d.ugc.missedViewDays) : null;
  // No accounts: Cash and Cards would only read $0, so the third tile stands alone as one row (fitFor sizes it).
  const alone = !d.hasAccounts;
  const third = cn(alone && "h-full flex-row items-center");
  const last = showsUgc(d.scope) ? (
    <Tile
      label="UGC"
      href="/ugc"
      className={third}
      aside={gap && <CircleAlert role="img" aria-label={gap.title} strokeWidth={1.5} className="size-3.5 shrink-0 text-ink" />}
    >
      {d.ugc ? <Money cents={d.ugc.earnedCents} compact /> : <span className="text-ink-3">-</span>}
    </Tile>
  ) : (
    <Tile label="Income" href={scopedHref("/reports", d.scope)} className={third}>
      <Money cents={d.month.incomeCents} compact />
    </Tile>
  );
  return (
    <div className={cn("grid h-full gap-2", alone ? "grid-cols-1" : "grid-cols-3")} data-testid="summary-tiles">
      {!alone && (
        <>
          <Tile label="Cash" href="/accounts">
            <Money cents={d.cash.totalCents} compact />
          </Tile>
          <Tile label="Cards" href="/accounts">
            <Money cents={-d.cards.totalCents} compact />
          </Tile>
        </>
      )}
      {last}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// This month: one strip, four figures
// ---------------------------------------------------------------------------------------------

export function MonthCard() {
  const d = useDashboard();
  // Income and spending follow the transactions' business, so a scope shows them even with no accounts of its own.
  if (!d.hasAccounts && d.month.incomeCents === 0 && d.month.spendingCents === 0) {
    return (
      <Card className="justify-center">
        <Label>This month</Label>
        {noAccounts}
      </Card>
    );
  }
  const m = d.month;
  const since = d.balancesAsOf ? ` Balances as of ${d.balancesAsOf}.` : "";
  const first = `${d.today.slice(0, 7)}-01`;
  const span = `${formatDay(first, d.today)} to ${formatDay(d.today, d.today)}`;
  const change = m.spendingPrevCents ? ((m.spendingCents - m.spendingPrevCents) / m.spendingPrevCents) * 100 : null;
  return (
    <Strip cols={4} className="h-full md:grid-cols-4 [&>*]:justify-center">
      <Stat
        label="Income this month"
        info={`Deposits that are income, ${span}, before card bills are paid.\n${money(m.incomeCents)} from ${m.incomeCount} deposit${m.incomeCount === 1 ? "" : "s"}.${since}`}
      >
        <Money cents={m.incomeCents} whole />
      </Stat>
      <Stat
        label="Net after card bills"
        info={`Income ${money(m.incomeCents)} minus card balances ${money(m.cardBalanceCents)} owed now = ${money(m.netAfterCardsCents)}.${since}`}
      >
        <Money cents={m.netAfterCardsCents} whole />
      </Stat>
      <Stat
        label="Spending"
        aside={change === null ? undefined : <Pill>{signedPct(change)}</Pill>}
        info={
          `Spending ${span}, transfers and card payments left out: ${money(m.spendingCents)}.` +
          (m.spendingPrevCents ? `\nSame days last month: ${money(m.spendingPrevCents)}.` : "")
        }
      >
        <Money cents={m.spendingCents} whole />
      </Stat>
      <Stat
        label="Recurring"
        aside={<Label>a month</Label>}
        info={`${m.recurringCount} confirmed recurring charge${m.recurringCount === 1 ? "" : "s"}, each scaled to a month by how often it repeats (weekly x 52 / 12, monthly x 1, yearly / 12): ${money(m.recurringCents)}.`}
      >
        <Money cents={m.recurringCents} whole />
      </Stat>
    </Strip>
  );
}

// ---------------------------------------------------------------------------------------------
// UGC revenue
// ---------------------------------------------------------------------------------------------

export function UgcCard() {
  const { ugc } = useDashboard();
  // Outside All and UGC the grid leaves this block out; while editing it shows as a bare title.
  if (!ugc || ugc.deals === 0) {
    return (
      <Card className="gap-1.5">
        <Head href="/ugc">UGC revenue</Head>
        {ugc && <Empty text="No deals yet." link="Add a deal" href="/ugc" />}
      </Card>
    );
  }
  const rows = [
    { name: "Paid", cents: ugc.paidCents },
    { name: "Owed to you", cents: ugc.owedCents },
    { name: "Missed", cents: -ugc.missedCents, loss: ugc.missedCents > 0 },
    { name: "Projected, 30 days", cents: ugc.projectedCents },
  ];
  return (
    <Card className="gap-1.5">
      <Head
        href="/ugc"
        aside={
          <InfoDot>
            {`Earned ${money(ugc.earnedCents)} - paid ${money(ugc.paidCents)} = owed ${money(ugc.owedCents)}.\nMissed is pay lost on days under the posting target.\nProjected is target posts a day x base pay x 30 days, active deals only: ${money(ugc.projectedCents)}.`}
          </InfoDot>
        }
      >
        UGC revenue
      </Head>
      <span className="text-figure-s" data-testid="ugc-earned">
        <Money cents={ugc.earnedCents} whole />
      </span>
      <ViewGapNotice days={ugc.missedViewDays} className="py-1.5" />
      <div className={cn("border-t border-rule", LIST)}>
        {rows.map((r) => (
          <ListRow key={r.name}>
            <span className="flex-1 text-ink-2">{r.name}</span>
            <Money cents={r.cents} whole tone={r.loss ? "loss" : "default"} />
          </ListRow>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Posting calendar
// ---------------------------------------------------------------------------------------------

export function PostingCard() {
  const { posting, ugc } = useDashboard();
  if (!posting || !ugc || ugc.deals === 0) {
    return (
      <Card>
        <Head href="/ugc">Posting</Head>
        {ugc && <Empty text="No deals yet." link="Add a deal" href="/ugc" />}
      </Card>
    );
  }
  return (
    // Phone: the head, the week and the legend spread over the block's whole rows, so no blank strip sits at the bottom.
    <Card className="max-md:justify-between max-md:gap-2.5">
      <Head
        href="/ugc"
        aside={
          <>
            {posting.streak > 0 && <Pill tone="soft">Streak {posting.streak}</Pill>}
            {ugc.missedCents > 0 && (
              <Pill tone="loss" className="md:hidden">
                {formatMoney(-ugc.missedCents, { whole: true })}
              </Pill>
            )}
          </>
        }
      >
        Posting
      </Head>
      {/* The weeks share the card's spare height (each at least 26 px), so no blank strip sits under the legend. */}
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(26px,1fr)] grid-cols-7 gap-1.5 max-md:hidden" data-testid="posting-grid">
        {posting.days.map((day) => (
          <DayCell
            key={day.date}
            day={day.day}
            date={day.label}
            posted={day.posted}
            target={day.target}
            future={day.future}
            amountCents={day.amountCents}
            lines={day.lines}
            href={`/ugc?day=${day.date}`}
            className="h-auto"
          />
        ))}
      </div>
      <DayLegend className="max-md:order-last" />
      <WeekStrip days={posting.week} />
    </Card>
  );
}

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MAX_DOTS = 5;

/** The phone's posting week (Mobile.dc.html): seven days to today, a dot per video, and the picked day's line. */
function WeekStrip({ days }: { days: readonly PostingDay[] }) {
  const [picked, setPicked] = useState(days.length - 1);
  const sel = days[picked];
  if (!sel) return null;
  return (
    <div className="flex flex-col gap-2.5 md:hidden" data-testid="posting-week">
      <div className="grid grid-cols-7 gap-1.5" role="radiogroup" aria-label="Posting this week">
        {days.map((d, i) => {
          const state = d.posted >= d.target && d.target > 0 ? "hit" : d.posted > 0 ? "under" : "zero";
          const dots = d.target > 0 && d.target <= MAX_DOTS ? "●".repeat(Math.min(d.posted, d.target)) + "○".repeat(Math.max(0, d.target - d.posted)) : `${d.posted}/${d.target}`;
          return (
            <button
              key={d.date}
              type="button"
              role="radio"
              aria-checked={i === picked}
              aria-label={`${d.label}, ${d.posted} of ${d.target} posted`}
              data-state-day={state}
              onClick={() => setPicked(i)}
              className={cn(
                "flex h-[60px] min-w-0 flex-col items-center justify-center gap-px rounded-sm border tabular-nums outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
                state === "hit" && "border-ink bg-ink text-white",
                state === "under" && "border-rule-2 bg-rule-2 text-ink",
                state === "zero" && "border-ink-3 bg-surface text-ink-3",
                i === picked && "ring-2 ring-ink ring-offset-1",
              )}
            >
              <span className="text-[10px] leading-none">{DOW[new Date(`${d.date}T12:00:00Z`).getUTCDay()]}</span>
              <span className="text-[13px] leading-tight font-semibold">{d.day}</span>
              <span aria-hidden className="text-[7px] leading-none tracking-[1px]">
                {dots}
              </span>
            </button>
          );
        })}
      </div>
      <Link
        href={`/ugc?day=${sel.date}`}
        className="-my-2 flex items-center gap-2 py-2 text-tag text-ink-2 tabular-nums underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        data-testid="posting-week-day"
      >
        <span className="min-w-0 flex-1 truncate">
          {`${sel.label} · ${sel.posted} of ${sel.target}`}
          {sel.lines && sel.posted < sel.target ? ` · ${sel.lines.join(", ")}` : ""}
        </span>
        {sel.amountCents !== 0 && (
          <span className={cn(sel.amountCents < 0 && "text-neg")}>
            {`${formatMoney(sel.amountCents, { signed: true, whole: true })}${sel.amountCents < 0 ? " missed" : ""}`}
          </span>
        )}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Recent transactions
// ---------------------------------------------------------------------------------------------

/** Rows per column when Recent is as wide as the board (a scope without the UGC blocks): two columns, newest first down the left. */
export const recentWideRows = (rows: number) => Math.ceil(rows / 2);

export function RecentCard() {
  const d = useDashboard();
  const half = recentWideRows(d.recent.length);
  return (
    <Card className="@container gap-1.5">
      <Head href="/transactions">Recent</Head>
      {d.recent.length === 0 ? (
        <Empty text={d.hasAccounts ? "No transactions yet." : "No accounts yet."} link={d.hasAccounts ? undefined : "Add account"} href="/accounts" />
      ) : (
        // Wide, the rows template splits the list into two columns; narrow, the rows stack. Rows keep their own height.
        <div className={cn(LIST, "grid content-start @3xl:auto-cols-fr @3xl:grid-flow-col @3xl:gap-x-8")} style={{ gridTemplateRows: `repeat(${half}, auto)` }}>
          {d.recent.map((t, i) => (
            <ListRow key={t.id} as={Link} href={`/transactions?tx=${t.id}`} className={i === half ? "@3xl:border-t-0" : undefined}>
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <Pill className="max-w-[40%] gap-1.5">
                <ColorDot color={t.categoryColor} />
                <span className="truncate">{t.category ?? "Needs review"}</span>
              </Pill>
              <Money cents={t.cents} signed className="w-[84px] shrink-0 text-right max-md:w-auto" />
            </ListRow>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------------------------

/**
 * The kit Bar look (4 px, rule track, ink fill) that grows in on mount. The kit Bar waits for
 * `whileInView`, which never fires for its zero-width fill on the phone, so goal bars stayed empty there.
 */
function GoalBar({ value, label }: { value: number; label: string }) {
  const reduced = useReducedMotion();
  const v = Math.min(1, Math.max(0, value));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label} className="h-1 overflow-hidden rounded-[2px] bg-rule">
      <motion.div
        className="h-full origin-left bg-ink"
        initial={{ scaleX: reduced ? v : 0 }}
        animate={{ scaleX: v }}
        transition={{ duration: 0.6, ease: EASE }}
      />
    </div>
  );
}

export function GoalsCard() {
  const { goals } = useDashboard();
  return (
    <Card className="gap-1.5">
      <Head href="/planning">Goals</Head>
      {goals.length === 0 ? (
        <Empty text="No goals yet." link="Add a goal" href="/planning" />
      ) : (
        <div className={LIST}>
          {goals.map((g) => (
            <ListRow key={g.id} as={Link} href={`/planning?goal=${g.id}`}>
              <span className="w-[42%] shrink-0 truncate md:w-[230px]">{g.title}</span>
              <HoverCard content={g.info} describe={false}>
                <div className="min-w-0 flex-1 py-2">
                  <GoalBar value={g.percent / 100} label={g.title} />
                </div>
              </HoverCard>
              <span className="shrink-0 text-right text-label text-ink-3 tabular-nums">{g.text}</span>
            </ListRow>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Coming up
// ---------------------------------------------------------------------------------------------

export function ComingUpCard() {
  const { comingUp, today } = useDashboard();
  return (
    <Card className="gap-1.5">
      <Head href="/planning">Coming up</Head>
      {comingUp.length === 0 ? (
        <Empty text="Nothing in the next 30 days." />
      ) : (
        <div className={LIST}>
          {comingUp.map((c) => {
            const row = (
              <>
                <Label className="w-14 shrink-0 tabular-nums">{formatDay(c.date, today)}</Label>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.cents !== null && <Money cents={c.cents} signed={c.signed} />}
              </>
            );
            return c.href ? (
              <ListRow key={c.key} as={Link} href={c.href}>
                {row}
              </ListRow>
            ) : (
              <ListRow key={c.key}>{row}</ListRow>
            );
          })}
        </div>
      )}
    </Card>
  );
}
