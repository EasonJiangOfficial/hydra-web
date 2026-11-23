"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useState } from "react";

import {
  Button,
  Card,
  DayCell,
  DayLegend,
  HoverCard,
  Input,
  Label,
  Money,
  Pill,
  Stat,
  Strip,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  EASE,
  InfoDot,
  MotionNumber,
  cn,
  formatMoney,
} from "@/components/kit";

import { projectionDays } from "@/lib/ugc/ledger";

import { UgcAnalytics } from "./analytics";
import { SectionLabel } from "./controls";
import {
  calendarFor,
  calendarRange,
  earnedSeries,
  firstWeekday,
  monthLabel,
  periodTotals,
  projectFor,
  shiftMonth,
  shortDay,
  summarizeCalendar,
  visibleDeals,
} from "./model";
import { PayoutMatches } from "./payout-matches";
import { dayCount, periodLabel, stepPeriod, type PeriodRange } from "./period";
import { PeriodControl } from "./period-control";
import { useUgc } from "./store";
import { useHrefWith } from "./url";
import { ViewGapNotice } from "./view-gap-notice";

const money = (c: number) => formatMoney(c, { whole: c % 100 === 0 });

/** The calendar's month for a period: the month of the day being looked at (today when the period holds it). */
function monthOf(range: PeriodRange, today: string): string {
  const day = range.from <= today && today <= range.to ? today : range.to < today ? range.to : range.from;
  return day.slice(0, 7);
}

export function Overview({ dealId, range, onRange }: { dealId: string | null; range: PeriodRange; onRange: (r: PeriodRange) => void }) {
  const { model, raw } = useUgc();
  const t = periodTotals(model, dealId, range.from, range.to);
  const active = visibleDeals(model, dealId).filter((d) => d.deal.status === "active");
  const updated = model.lastReadingDay ? `Views read through ${shortDay(model.lastReadingDay)}.` : "No views read yet.";
  const label = periodLabel(range, model.today);
  // A monthly period and the calendar are the same month, so its arrows step the period. Other periods leave the
  // calendar its own month, back on the period's month whenever the period changes.
  const key = `${range.period}|${range.from}|${range.to}`;
  const [browse, setBrowse] = useState<{ key: string; month: string } | null>(null);
  const month = range.period === "monthly" ? range.from.slice(0, 7) : browse?.key === key ? browse.month : monthOf(range, model.today);
  const onMonth = (m: string) =>
    range.period === "monthly" ? onRange(stepPeriod(range, m < month ? -1 : 1)) : setBrowse({ key, month: m });
  return (
    <div className="flex flex-col gap-5">
      {/* Under the tabs, beside what it drives: the header above stays the same on every tab. */}
      <PeriodControl value={range} today={model.today} zone={model.zone} onChange={onRange} />
      <ViewGapNotice days={raw.missedViewDays} />
      <Strip cols={4} className="lg:grid-cols-5">
        <Stat
          label="Earned"
          info={
            <>
              {`Base ${money(t.baseCents)} + CPM ${money(t.cpmCents)} + bonus ${money(t.bonusCents)}`}
              {t.adjustCents !== 0 ? ` + per-deal adjustment ${money(t.adjustCents)}` : ""}
              {t.flatCents !== 0 ? ` + flat rates ${money(t.flatCents)}` : ""}
              {` = ${money(t.earnedCents)} from ${t.videoCount} counted videos posted ${label}. Excluded videos pay $0.\n${updated}`}
            </>
          }
        >
          <MotionNumber value={t.earnedCents} money={{ whole: true }} />
        </Stat>
        <Stat label="Paid" info={`${t.paymentCount} bank deposits matched to deals, ${money(t.paidCents)} in all, paid ${label}.`}>
          <MotionNumber value={t.paidCents} money={{ whole: true }} />
        </Stat>
        <Stat
          label="Owed"
          info={`Balance at ${shortDay(range.to)}: earned ${money(t.owedCents + t.paidToEndCents)} - paid ${money(t.paidToEndCents)} = ${money(t.owedCents)}.${t.owedCents < 0 ? " Negative means paid ahead." : ""}`}
        >
          <MotionNumber value={t.owedCents} money={{ whole: true }} />
        </Stat>
        <Stat
          label="Missed"
          info={`${t.missedCount} missed ${t.missedCount === 1 ? "video" : "videos"} x base pay = ${money(t.missedCents)}, ${label}. Counts days under the target before today. A day off never counts.`}
        >
          <span className={t.missedCents > 0 ? "text-neg" : undefined}>
            <MotionNumber value={-t.missedCents} money={{ whole: true }} />
          </span>
        </Stat>
        <Stat
          label="Projected, 30 days"
          className="max-lg:col-span-2"
          info={
            active.length === 0
              ? "No active deals."
              : `${active
                  .map(
                    (d) =>
                      `${d.deal.brand_name} ${d.deal.daily_target_posts} x ${money(Number(d.deal.base_pay_cents ?? 0))} x ${projectionDays(d.row, model.today)} = ${money(d.summary.projectedCents)}`,
                  )
                  .join("\n")}\nTotal ${money(t.projectedCents)}. Bonuses and CPM are not in it.`
          }
        >
          <MotionNumber value={t.projectedCents} money={{ whole: true }} />
        </Stat>
      </Strip>

      <PayoutMatches dealId={dealId} />

      <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-7">
          <PostingCalendar dealId={dealId} month={month} onMonth={onMonth} range={range} />
        </div>
        <div className="flex flex-col gap-5 lg:col-span-5">
          <Projection dealId={dealId} />
          <EarnedPerDay dealId={dealId} range={range} label={label} />
        </div>
      </div>

      <UgcAnalytics dealId={dealId} range={range} />
    </div>
  );
}

function PostingCalendar({
  dealId,
  month,
  onMonth,
  range,
}: {
  dealId: string | null;
  month: string;
  onMonth: (m: string) => void;
  range: PeriodRange;
}) {
  // Days outside a daily, weekly or custom period stay readable but step back.
  const outside = (day: string) => day < range.from || day > range.to;
  const { model } = useUgc();
  const href = useHrefWith();
  const days = calendarFor(model, month, dealId);
  // The pills count the period, as the cards above do, not the month on screen.
  const sum = summarizeCalendar(calendarRange(model, range.from, range.to, dealId));
  const blanks = firstWeekday(month);
  return (
    <Card aria-label="Posting calendar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label className="mr-1">Posting calendar</Label>
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>
          <ChevronLeft strokeWidth={1.5} />
        </Button>
        <span aria-live="polite" className="min-w-[120px] text-center text-body font-medium">
          {monthLabel(month)}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>
          <ChevronRight strokeWidth={1.5} />
        </Button>
        <div className="flex-1" />
        {sum.streak > 0 && <Pill tone="strong">{`Streak ${sum.streak} ${sum.streak === 1 ? "day" : "days"}`}</Pill>}
        {sum.targetDays > 0 && <Pill>{`Hit target ${sum.hitDays} of ${sum.targetDays} days`}</Pill>}
      </div>
      <div className="grid grid-cols-7 gap-1.5" role="grid" aria-label={monthLabel(month)}>
        {["M", "T", "W", "T", "F", "S", "S"].map((w, i) => (
          <span key={i} className="pb-1 text-center text-tag text-ink-3">
            {w}
          </span>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <span key={`b${i}`} aria-hidden />
        ))}
        {days.map((d) => {
          const day = Number(d.date.slice(8));
          const link = href("day", d.date);
          const dealLines = d.deals.length > 1 ? d.deals.map((c) => `${c.brandName} ${c.posted} of ${c.target}`) : [];
          if (d.status === "none") {
            return (
              <HoverCard key={d.date} content={`${shortDay(d.date)}\nNo target`} describe={false}>
                <Link
                  href={link}
                  scroll={false}
                  aria-label={`${shortDay(d.date)}, no target`}
                  data-state-day="none"
                  className={cn(
                    "grid h-11 min-w-0 place-items-center rounded-sm border border-tint bg-tint text-tag text-ink-3 tabular-nums transition-opacity duration-200 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
                    outside(d.date) && "opacity-35",
                  )}
                >
                  {day}
                </Link>
              </HoverCard>
            );
          }
          return (
            <DayCell
              key={d.date}
              day={day}
              date={shortDay(d.date)}
              lines={dealLines}
              posted={d.posted}
              target={d.target}
              future={d.status === "future"}
              amountCents={d.missedCents > 0 ? -d.missedCents : d.earnedCents}
              href={link}
              className={cn("h-11", outside(d.date) && "opacity-35")}
            />
          );
        })}
      </div>
      <DayLegend />
    </Card>
  );
}

function Projection({ dealId }: { dealId: string | null }) {
  const { model } = useUgc();
  const deals = visibleDeals(model, dealId).filter((d) => d.deal.status === "active");
  const [what, setWhat] = useState<Record<string, number>>({});
  const perDay = (id: string, fallback: number) => what[id] ?? fallback;
  const rows = deals.map((d) => {
    const posts = perDay(d.deal.id, d.deal.daily_target_posts);
    return { d, posts, cents: projectFor(d.row, posts) };
  });
  const total = rows.reduce((s, r) => s + r.cents, 0);
  const edited = Object.keys(what).length > 0;
  return (
    <Card aria-label="Projection calculator">
      <SectionLabel
        aside={
          <>
            {edited && (
              <Button variant="ghost" size="default" className="-my-1 h-7 px-2 text-tag text-ink-3" onClick={() => setWhat({})}>
                Reset
              </Button>
            )}
            <InfoDot>Posts per day x base pay x 30. Bonuses and CPM are not in the projection. Changes here are a what-if and are not saved.</InfoDot>
          </>
        }
      >
        Projection calculator
      </SectionLabel>
      {rows.length === 0 ? (
        <p className="text-body text-ink-3">No active deals.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deal</TableHead>
              <TableHead className="text-right">Posts / day</TableHead>
              <TableHead className="text-right">Base / video</TableHead>
              <TableHead className="text-right">30 days</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ d, posts, cents }) => (
              <TableRow key={d.deal.id}>
                <TableCell>{d.deal.brand_name}</TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    min={0}
                    max={30}
                    inputMode="numeric"
                    aria-label={`Posts per day for ${d.deal.brand_name}`}
                    value={posts}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(30, Math.floor(Number(e.target.value) || 0)));
                      setWhat((w) => ({ ...w, [d.deal.id]: v }));
                    }}
                    className="ml-auto h-[30px] w-16 text-right tabular-nums"
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Money cents={Number(d.deal.base_pay_cents ?? 0)} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Money cents={cents} whole />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="font-medium">
                Projected income
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums" data-testid="projection-total">
                <Money cents={total} whole />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </Card>
  );
}

const BAR_TONE = {
  hit: "bg-ink",
  under: "bg-rule-2",
  zero: "bg-rule",
  none: "bg-rule",
  future: "bg-tint",
} as const;

function EarnedPerDay({ dealId, range, label }: { dealId: string | null; range: PeriodRange; label: string }) {
  const { model } = useUgc();
  const reduced = useReducedMotion();
  const series = earnedSeries(model, range.from, range.to, dealId);
  const max = Math.max(1, ...series.map((s) => s.cents));
  // A long range keeps the bars apart with less space; the reveal takes at most ~0.6 s however many bars.
  const step = Math.min(0.02, 0.6 / Math.max(1, series.length));
  return (
    <Card aria-label="Earned per day">
      <SectionLabel aside={<InfoDot>Dark bars are days that hit the posting target. Gray bars are days under it.</InfoDot>}>Earned per day</SectionLabel>
      <div
        role="img"
        aria-label={`Earned per day, ${label}`}
        className={cn("flex h-[120px] items-end justify-center", dayCount(range) > 62 ? "gap-px" : "gap-[3px]")}
      >
        {series.map((s, i) => (
          <HoverCard
            key={s.day}
            describe={false}
            content={`${shortDay(s.day)}\n${s.status === "future" ? "Upcoming" : formatMoney(s.cents, { whole: s.cents % 100 === 0 })}`}
          >
            <motion.div
              data-bar={s.day}
              data-status={s.status}
              className={cn("min-w-0 max-w-12 flex-1 origin-bottom rounded-t-[3px]", BAR_TONE[s.status])}
              style={{ height: `${Math.max(3, Math.round((s.cents / max) * 120))}px` }}
              initial={{ scaleY: reduced ? 1 : 0 }}
              whileInView={{ scaleY: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.32, ease: EASE, delay: i * step }}
            />
          </HoverCard>
        ))}
      </div>
      <div className="flex justify-between text-tag text-ink-3">
        <span>{series[0] ? shortDay(series[0].day) : ""}</span>
        <span>{series.length ? shortDay(series[series.length - 1].day) : ""}</span>
      </div>
    </Card>
  );
}
