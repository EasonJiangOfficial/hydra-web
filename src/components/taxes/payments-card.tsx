"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

import {
  parseDollars,
  parseRate,
  rateText,
  shortCents,
  shortDate,
  timeline,
  type Payment,
  type Quarter,
  type QuarterView,
  type TaxActions,
  type TaxesData,
} from "@/app/(app)/taxes/model";
import { offerUndo } from "@/components/activity/undo-bar";
import { Button, Card, HoverCard, Input, Label, Money, Pill, cn } from "@/components/kit";
import { formatMoney } from "@/components/kit/money";
import { DatePicker } from "@/components/ui/date-picker";

type Props = {
  data: TaxesData;
  actions: TaxActions;
  rateBps: number;
  onRate: (bps: number) => void;
  payments: Payment[];
  onPayments: Dispatch<SetStateAction<Payment[]>>;
  setAside: number;
};

const dollars = (cents: number) => (cents / 100).toFixed(2);

function statusLabel(q: QuarterView, closed: boolean) {
  if (q.status === "paid") return { text: "Paid", tone: "strong" as const };
  if (q.status === "overdue") return { text: closed ? "Not paid" : "Overdue", tone: closed ? ("default" as const) : ("loss" as const) };
  if (q.status === "due-soon") {
    const text = q.daysLeft === 0 ? "Due today" : q.daysLeft === 1 ? "Due tomorrow" : `Due in ${q.daysLeft} days`;
    return { text, tone: "soft" as const };
  }
  return { text: "Upcoming", tone: "default" as const };
}

const longDate = (s: string) =>
  new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The rate the owner types, the four IRS due dates for the year and a payment editor for each. */
export function PaymentsCard({ data, actions, rateBps, onRate, payments, onPayments, setAside }: Props) {
  const [open, setOpen] = useState<Quarter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quarters = timeline(data.year, data.today, payments, setAside);

  return (
    <Card aria-label="Estimated tax payments">
      <div className="flex flex-wrap items-center gap-3">
        <Label>Estimated tax payments</Label>
        <div className="flex-1" />
        {setAside > 0 &&
          (shortCents(setAside, payments) > 0 ? (
            // Red only once money is overdue (DESIGN 7): before a due date passes, short is just a number.
            <Pill tone={!data.entityClosed && quarters.some((q) => q.status === "overdue") ? "loss" : "default"}>
              Short {formatMoney(shortCents(setAside, payments))}
            </Pill>
          ) : (
            <Pill>Covered</Pill>
          ))}
        <RateField rateBps={rateBps} onSave={saveRate} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {quarters.map((q) => {
          const label = statusLabel(q, data.entityClosed);
          const on = open === q.quarter;
          return (
            <HoverCard
              key={q.quarter}
              content={q.payment ? `Paid ${longDate(q.payment.paidOn)}` : `Due ${longDate(q.due)}`}
              describe={false}
            >
              <button
                type="button"
                aria-expanded={on}
                aria-label={`Q${q.quarter}, due ${shortDate(q.due)}`}
                onClick={() => {
                  setError(null);
                  setOpen(on ? null : q.quarter);
                }}
                className={cn(
                  "flex min-w-0 flex-col items-start gap-1 rounded-lg p-3 text-left transition-colors duration-200 outline-none hover:bg-tint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
                  on && "bg-tint",
                )}
              >
                <Pill tone={label.tone}>{label.text}</Pill>
                <span className="font-medium text-ink">
                  Q{q.quarter} · {shortDate(q.due)}
                </span>
                <span className="min-h-[19px] text-ink-3 tabular-nums">
                  {q.payment ? (
                    <Money cents={q.payment.amountCents} />
                  ) : q.suggestedCents > 0 ? (
                    <>
                      <Money cents={q.suggestedCents} /> suggested
                    </>
                  ) : null}
                </span>
              </button>
            </HoverCard>
          );
        })}
      </div>
      {open && (
        <PaymentEditor
          key={open}
          quarter={quarters[open - 1]}
          today={data.today}
          onClose={() => setOpen(null)}
          onSave={async (amountCents, paidOn) => {
            const r = await actions.savePayment({ entity: data.entity, year: data.year, quarter: open, amountCents, paidOn });
            if (!r.ok) return r.error.message;
            onPayments([...payments.filter((p) => p.quarter !== open), r.data].sort((a, b) => a.quarter - b.quarter));
            setOpen(null);
            return null;
          }}
          onRemove={async () => {
            const r = await actions.removePayment({ entity: data.entity, year: data.year, quarter: open });
            if (!r.ok) return r.error.message;
            const gone = payments.find((p) => p.quarter === open);
            onPayments(payments.filter((p) => p.quarter !== open));
            setOpen(null);
            // Undo puts back only the removed payment, into the list as it is then.
            offerUndo(r.activityId, `Q${open} payment`, () =>
              onPayments((now) => (gone && !now.some((p) => p.quarter === gone.quarter) ? [...now, gone].sort((a, b) => a.quarter - b.quarter) : now)),
            );
            return null;
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-tag text-ink-2">
          {error}
        </p>
      )}
    </Card>
  );

  async function saveRate(bps: number) {
    const before = rateBps;
    onRate(bps);
    setError(null);
    const r = await actions.saveRate({ entity: data.entity, year: data.year, rateBps: bps });
    if (!r.ok) {
      onRate(before);
      setError(r.error.message);
    }
  }
}

/** Percent input. Saves on Enter or when it loses focus; an unreadable rate goes back to the saved one. */
function RateField({ rateBps, onSave }: { rateBps: number; onSave: (bps: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (draft === null) return;
    const bps = parseRate(draft);
    setBad(bps === null);
    if (bps !== null && bps !== rateBps) onSave(bps);
    setDraft(null);
  };
  return (
    <label className="flex items-center gap-2 text-label text-ink-3">
      Set-aside rate
      <Input
        inputMode="decimal"
        aria-label="Set-aside rate"
        aria-invalid={bad || undefined}
        className="h-[30px] w-[72px] text-right tabular-nums"
        value={draft ?? rateText(rateBps)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function PaymentEditor({
  quarter,
  today,
  onClose,
  onSave,
  onRemove,
}: {
  quarter: QuarterView;
  today: string;
  onClose: () => void;
  onSave: (amountCents: number, paidOn: string) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
}) {
  const paid = quarter.payment;
  const [amount, setAmount] = useState(paid ? dollars(paid.amountCents) : quarter.suggestedCents > 0 ? dollars(quarter.suggestedCents) : "");
  const [paidOn, setPaidOn] = useState(paid?.paidOn ?? today);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (job: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    const failed = await job();
    if (failed) {
      setMessage(failed);
      setBusy(false);
    }
  };
  const save = () => {
    const cents = parseDollars(amount);
    if (cents === null) return setMessage("Type the amount you paid, like 1,250.00");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return setMessage("Pick the day you paid");
    return run(() => onSave(cents, paidOn));
  };

  return (
    <form
      aria-label={`Payment for Q${quarter.quarter}`}
      className="flex flex-wrap items-end gap-3 rounded-lg bg-tint p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="flex min-w-0 flex-col gap-1 text-label text-ink-3">
        Amount paid
        <Input
          inputMode="decimal"
          placeholder="0.00"
          className="w-36 bg-surface tabular-nums"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-label text-ink-3">
        Paid on
        <DatePicker aria-label="Paid on" className="w-40" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          Save payment
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {paid && !confirming && (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
            Remove
          </Button>
        )}
      </div>
      {paid && confirming && (
        <div className="flex basis-full items-center gap-2" role="group" aria-label="Confirm remove">
          <span className="text-body text-ink">Remove this payment?</span>
          <Button type="button" variant="outline" onClick={() => run(onRemove)} disabled={busy}>
            Yes, remove it
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
            Keep it
          </Button>
        </div>
      )}
      {message && (
        <p role="alert" className="basis-full text-tag text-ink">
          {message}
        </p>
      )}
    </form>
  );
}
