"use client";

import { useState } from "react";

import { Button, Card, HoverCard, InfoDot, Label, Money, Pill, formatMoney } from "@/components/kit";
import { addDays } from "@/lib/planning/dates";

import { everyLabel, perMonthCents, perYearCents, shortDate } from "./format";
import { useAccounts } from "./store";
import type { RecurringSeriesRow } from "./types";

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 md:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1fr]";

function PriceFlag({ series }: { series: RecurringSeriesRow }) {
  const change = series.last_price_change;
  if (!series.price_change_flagged || !change) return null;
  const delta = change.to_cents - change.from_cents;
  // Series amounts are signed (a charge is negative): "up" means the charge grew, whatever the sign.
  const grew = Math.abs(change.to_cents) > Math.abs(change.from_cents);
  const by = formatMoney(Math.abs(delta), { whole: Math.abs(delta) % 100 === 0 });
  return (
    <HoverCard content={`${formatMoney(Math.abs(change.from_cents))} to ${formatMoney(Math.abs(change.to_cents))} on ${shortDate(change.on)}`} className="px-3 py-2">
      <span tabIndex={0} className="ml-2 cursor-help">
        <Pill tone="strong">{`Price ${grew ? "up" : "down"} ${by}`}</Pill>
      </span>
    </HoverCard>
  );
}

function Suggestion({ series }: { series: RecurringSeriesRow }) {
  const { actions, say } = useAccounts();
  const [busy, setBusy] = useState(false);
  async function run(kind: "confirm" | "dismiss") {
    setBusy(true);
    const r = kind === "confirm" ? await actions.confirmRecurring({ id: series.id }) : await actions.dismissRecurring({ id: series.id });
    setBusy(false);
    if (!r.ok) say(r.error.message);
  }
  return (
    <div data-series-id={series.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-tint px-3.5 py-2.5">
      <span className="min-w-0 flex-1 basis-60">
        Found a repeating charge: <b className="font-medium">{series.name}</b>, <Money cents={Math.abs(series.average_amount_cents)} /> every {everyLabel(series.gap_days).toLowerCase()}, next{" "}
        {shortDate(series.next_expected_on)}.
        <PriceFlag series={series} />
      </span>
      <Button disabled={busy} onClick={() => void run("dismiss")}>
        Not recurring
      </Button>
      <Button disabled={busy} onClick={() => void run("confirm")}>
        Confirm
      </Button>
    </div>
  );
}

export function RecurringTab() {
  const { data, actions, say } = useAccounts();
  const [looking, setLooking] = useState(false);
  const suggested = data.recurring.filter((r) => r.status === "suggested");
  const confirmed = data.recurring.filter((r) => r.status === "confirmed");
  const out = confirmed.filter((r) => r.average_amount_cents < 0);
  const monthOut = out.reduce((s, r) => s + perMonthCents(-r.average_amount_cents, r.gap_days), 0);
  const { today } = data;
  const horizon = addDays(today, 30);
  const next30 = out.filter((r) => r.next_expected_on >= today && r.next_expected_on <= horizon).reduce((s, r) => s - r.average_amount_cents, 0);

  async function lookAgain() {
    setLooking(true);
    const r = await actions.detectRecurringNow();
    setLooking(false);
    say(r.ok ? (r.data.found ? `Found ${r.data.found} repeating charge${r.data.found === 1 ? "" : "s"}.` : "Nothing new repeating.") : r.error.message);
  }

  return (
    <Card aria-label="Recurring">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label>Recurring</Label>
        <InfoDot label="About recurring">
          Hydra finds repeating charges by itself: same name, steady amount, steady gap. You confirm or dismiss each one. A price change is flagged. Recurring dates also show on the Planning calendar.
        </InfoDot>
        {confirmed.length > 0 && (
          <span className="text-label text-ink-3">
            <Money cents={monthOut} /> a month out · next 30 days <Money cents={next30} />
          </span>
        )}
        <div className="flex-1" />
        <Button disabled={looking} onClick={() => void lookAgain()}>
          Look again
        </Button>
      </div>

      {suggested.length > 0 && (
        <div className="flex flex-col gap-2" aria-label="Found by Hydra">
          {suggested.map((s) => (
            <Suggestion key={s.id} series={s} />
          ))}
        </div>
      )}

      {confirmed.length > 0 ? (
        <div role="table" aria-label="Confirmed recurring">
          <div role="row" className={`${ROW} border-b border-rule pb-2 text-tag text-ink-3 max-md:hidden`}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Every</span>
            <span role="columnheader">Next date</span>
            <span role="columnheader" className="text-right">
              Amount
            </span>
            <span role="columnheader" className="text-right">
              Per year
            </span>
          </div>
          {confirmed.map((r) => (
            <div key={r.id} role="row" data-series-id={r.id} className={`${ROW} border-t border-rule py-2.5 first:border-t-0`}>
              <span role="cell" className="min-w-0 font-medium">
                <span className="truncate">{r.name}</span>
                <PriceFlag series={r} />
              </span>
              <span role="cell" className="hidden md:block">
                {everyLabel(r.gap_days)}
              </span>
              <span role="cell" className="hidden tabular-nums md:block">
                {shortDate(r.next_expected_on)}
              </span>
              <span role="cell" className="col-start-2 row-start-1 text-right tabular-nums md:col-auto md:row-auto">
                <Money cents={r.average_amount_cents} />
              </span>
              <span role="cell" className="hidden text-right text-ink-3 tabular-nums md:block">
                <Money cents={perYearCents(r.average_amount_cents, r.gap_days)} />
              </span>
              <span className="col-span-2 text-tag text-ink-3 md:hidden">
                {everyLabel(r.gap_days)} · next {shortDate(r.next_expected_on)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-ink-3">{suggested.length ? "Confirm what Hydra found to track it here." : "No repeating charges found yet."}</p>
      )}
    </Card>
  );
}
