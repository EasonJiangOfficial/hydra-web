"use client";

import {
  Bar,
  Card,
  DayCell,
  DayLegend,
  HoverCard,
  Label,
  ListRow,
  Money,
  Pill,
  Stat,
  Strip,
  TrendLine,
} from "@/components/kit";
import * as fx from "../kit/fixtures";

/** Fixture cards for /dev/grid: kit pieces composed like Main.dc.html. U6 replaces them with the real ones. */

function Head({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Label className="flex-1">{children}</Label>
      {aside}
    </div>
  );
}

export function NetWorthCard() {
  return (
    <Card tone="hero" className="gap-3 overflow-hidden px-8 pt-8 pb-0 max-md:px-5 max-md:pt-5 max-md:pb-0">
      <div className="flex flex-col gap-2 md:gap-3">
        <Label>Net worth</Label>
        <span className="text-hero max-md:text-[52px]">
          <Money cents={fx.netWorth.cents} dimCents className="max-md:hidden" />
          <Money cents={fx.netWorth.cents} whole className="md:hidden" />
        </span>
        <span className="flex items-center gap-2.5">
          <Money cents={fx.netWorth.change} signed />
          <Label>{fx.netWorth.pct} this month</Label>
        </span>
      </div>
      <div className="-mx-5 mt-auto min-h-0 flex-1 md:-mx-8">
        <TrendLine tone="hero" data={fx.trend} height="100%" label="Net worth trend" />
      </div>
    </Card>
  );
}

/** The phone's Cash / Cards / UGC tiles (Mobile.dc.html), like the real SummaryCard. */
export function SummaryCard() {
  const ugc = fx.ugc.filter((r) => !r.loss && r.name !== "Projected, 30 days").reduce((a, r) => a + r.cents, 0);
  const tiles = [
    ["Cash", fx.cash.total],
    ["Cards", fx.cards.total],
    ["UGC", ugc],
  ] as const;
  return (
    <div className="grid h-full grid-cols-3 gap-2" data-testid="summary-tiles">
      {tiles.map(([label, cents]) => (
        <Card key={label} className="min-w-0 justify-between gap-1 p-3 max-md:p-3">
          <Label className="truncate">{label}</Label>
          <span className="truncate text-[20px] leading-tight tabular-nums">
            <Money cents={cents} compact />
          </span>
        </Card>
      ))}
    </div>
  );
}

export function AccountsCard() {
  return (
    <Card className="gap-5">
      <div className="flex flex-col gap-1.5">
        <Head>Cash</Head>
        <span className="text-figure-s">
          <Money cents={fx.cash.total} whole />
        </span>
        <div className="border-t border-rule">
          {fx.cash.rows.map((r) => (
            <ListRow key={r.name}>
              <span className="flex-1 text-ink-2">{r.name}</span>
              <Money cents={r.cents} />
            </ListRow>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Head aside={<Pill tone="strong">{fx.cards.due}</Pill>}>Credit cards</Head>
        <span className="text-figure-s">
          <Money cents={fx.cards.total} whole />
        </span>
        <div className="border-t border-rule">
          {fx.cards.rows.map((r) => (
            <ListRow key={r.name}>
              <span className="flex-1 text-ink-2">{r.name}</span>
              <Money cents={r.cents} />
            </ListRow>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function MonthCard() {
  return (
    <Strip cols={4} className="h-full [&>*]:justify-center">
      {fx.month.map((m) => (
        <Stat
          key={m.label}
          label={m.label}
          aside={m.pill ? <Pill tone="loss">{m.pill}</Pill> : m.unit ? <Label>{m.unit}</Label> : undefined}
        >
          <Money cents={m.cents} whole />
        </Stat>
      ))}
    </Strip>
  );
}

export function UgcCard() {
  const total = fx.ugc.filter((r) => !r.loss && r.name !== "Projected, 30 days").reduce((a, r) => a + r.cents, 0);
  return (
    <Card className="gap-1.5">
      <Head>UGC revenue</Head>
      <span className="text-figure-s">
        <Money cents={total} whole />
      </span>
      <div className="border-t border-rule">
        {fx.ugc.map((r) => (
          <ListRow key={r.name}>
            <span className="flex-1 text-ink-2">{r.name}</span>
            <Money cents={r.cents} whole tone={r.loss ? "loss" : "default"} />
          </ListRow>
        ))}
      </div>
    </Card>
  );
}

export function PostingCard() {
  return (
    <Card>
      <Head aside={<Pill tone="soft">Streak 5</Pill>}>Posting</Head>
      <div className="grid grid-cols-7 gap-1.5 max-md:hidden">
        {fx.days.map((d) => (
          <DayCell key={d.day} {...d} />
        ))}
      </div>
      <DayLegend className="max-md:hidden" />
      {/* Phone: the week to today, as the real card's week strip (its block is 3 rows there). */}
      <div className="grid grid-cols-7 gap-1.5 md:hidden">
        {fx.days.filter((d) => !d.future).slice(-7).map((d) => (
          <DayCell key={d.day} {...d} />
        ))}
      </div>
    </Card>
  );
}

export function RecentCard() {
  return (
    <Card className="gap-1.5">
      <Head>Recent</Head>
      <div>
        {fx.recent.map((t) => (
          <ListRow key={t.name}>
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            <Pill>{t.cat}</Pill>
            <Money cents={t.cents} signed className="w-[84px] text-right" />
          </ListRow>
        ))}
      </div>
    </Card>
  );
}

export function GoalsCard() {
  return (
    <Card className="gap-1.5">
      <Head>Goals</Head>
      <div>
        {fx.goals.map((g) => (
          <ListRow key={g.name}>
            <span className="w-[42%] shrink-0 truncate md:w-[230px]">{g.name}</span>
            <HoverCard content={g.info}>
              <div className="flex-1 py-2">
                <Bar value={g.value} aria-label={g.name} />
              </div>
            </HoverCard>
            <span className="w-24 text-right text-label text-ink-3 tabular-nums">{g.text}</span>
          </ListRow>
        ))}
      </div>
    </Card>
  );
}

export function ComingUpCard() {
  return (
    <Card className="gap-1.5">
      <Head>Coming up</Head>
      <div>
        {fx.comingUp.map((c) => (
          <ListRow key={c.name}>
            <Label className="w-14 tabular-nums">{c.date}</Label>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <Money cents={c.cents} signed={c.signed} />
          </ListRow>
        ))}
      </div>
    </Card>
  );
}
