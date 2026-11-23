"use client";

import { useId, useState, type ReactNode } from "react";

import { Button, Input } from "@/components/kit";
import { Select } from "@/components/ui/select";
import type { DealInput } from "@/lib/ugc/schemas";

import { DollarInput, ErrorText, Field } from "./controls";

export type PayoutValues = Pick<
  DealInput,
  "payoutRule" | "payCycle" | "payCycleAnchorDay" | "payCycleAnchorWeekday" | "payCycleAnchorDays"
>;

export function payoutValuesOf(d: DealInput): PayoutValues {
  return {
    payoutRule: d.payoutRule,
    payCycle: d.payCycle,
    payCycleAnchorDay: d.payCycleAnchorDay,
    payCycleAnchorWeekday: d.payCycleAnchorWeekday,
    payCycleAnchorDays: d.payCycleAnchorDays,
  };
}

const CYCLES = [
  ["", "None"],
  ["WEEKLY", "Every week"],
  ["BIWEEKLY", "Every 2 weeks"],
  ["MONTHLY", "Every month"],
  ["DAYS_OF_MONTH", "Days of the month"],
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every 2 weeks on Friday", "Every month on day 15": the cycle in plain words. */
export function cycleText(v: Pick<PayoutValues, "payCycle" | "payCycleAnchorDay" | "payCycleAnchorWeekday" | "payCycleAnchorDays">): string {
  switch (v.payCycle) {
    case "WEEKLY":
      return `Every week on ${WEEKDAYS[v.payCycleAnchorWeekday ?? 5]}`;
    case "BIWEEKLY":
      return `Every 2 weeks on ${WEEKDAYS[v.payCycleAnchorWeekday ?? 5]}`;
    case "MONTHLY":
      return `Every month on day ${v.payCycleAnchorDay ?? 1}`;
    case "DAYS_OF_MONTH":
      return `Days ${v.payCycleAnchorDays.join(", ")} of the month`;
    default:
      return "No pay cycle";
  }
}

export type PayoutFormProps = {
  initial: PayoutValues;
  saving?: boolean;
  onSubmit: (patch: PayoutValues) => void | Promise<void>;
  /** Replaces the default Save button (the wizard's Back and Continue). */
  renderActions?: (ctx: { submit: () => void; saving: boolean }) => ReactNode;
  saveLabel?: string;
};

/** How a bank deposit finds the deal (name, size) and when the brand pays. */
export function PayoutForm({ initial, saving = false, onSubmit, renderActions, saveLabel = "Save payout" }: PayoutFormProps) {
  const id = useId();
  const rule = initial.payoutRule;
  const [payer, setPayer] = useState(rule.payerContains ?? "");
  const [min, setMin] = useState(rule.minCents !== undefined ? String(rule.minCents / 100) : "");
  const [max, setMax] = useState(rule.maxCents !== undefined ? String(rule.maxCents / 100) : "");
  const [cycle, setCycle] = useState<string>(initial.payCycle ?? "");
  const [weekday, setWeekday] = useState(String(initial.payCycleAnchorWeekday ?? 5));
  const [day, setDay] = useState(String(initial.payCycleAnchorDay ?? 1));
  const [days, setDays] = useState(initial.payCycleAnchorDays.join(", "));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    const cents = (s: string) => (s.trim() === "" ? undefined : Math.round(Number(s) * 100));
    const minCents = cents(min);
    const maxCents = cents(max);
    if ((minCents !== undefined && !(minCents >= 0)) || (maxCents !== undefined && !(maxCents >= 0))) {
      setProblem("Amounts must be zero or more");
      return;
    }
    if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
      setProblem("Smallest deposit is above the largest");
      return;
    }
    const list = days
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (cycle === "DAYS_OF_MONTH" && (list.length === 0 || list.some((n) => !Number.isInteger(n) || n < 1 || n > 31))) {
      setProblem("Days of the month are numbers from 1 to 31");
      return;
    }
    const dayN = Number(day);
    if (cycle === "MONTHLY" && (!Number.isInteger(dayN) || dayN < 1 || dayN > 31)) {
      setProblem("The day is a number from 1 to 31");
      return;
    }
    setProblem(null);
    void onSubmit({
      payoutRule: {
        ...(payer.trim() ? { payerContains: payer.trim() } : {}),
        ...(minCents !== undefined ? { minCents } : {}),
        ...(maxCents !== undefined ? { maxCents } : {}),
      },
      payCycle: (cycle || null) as DealInput["payCycle"],
      payCycleAnchorWeekday: cycle === "WEEKLY" || cycle === "BIWEEKLY" ? Number(weekday) : null,
      payCycleAnchorDay: cycle === "MONTHLY" ? dayN : null,
      payCycleAnchorDays: cycle === "DAYS_OF_MONTH" ? list : [],
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label="Bank deposit name contains" htmlFor={`${id}-payer`}>
        <Input id={`${id}-payer`} placeholder="WORDWISE" value={payer} onChange={(e) => setPayer(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Smallest deposit" htmlFor={`${id}-min`}>
          <DollarInput id={`${id}-min`} placeholder="Any" value={min} onChange={(e) => setMin(e.target.value)} />
        </Field>
        <Field label="Largest deposit" htmlFor={`${id}-max`}>
          <DollarInput id={`${id}-max`} placeholder="Any" value={max} onChange={(e) => setMax(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Pays" htmlFor={`${id}-cycle`}>
          <Select id={`${id}-cycle`} value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label="Pay cycle">
            {CYCLES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {(cycle === "WEEKLY" || cycle === "BIWEEKLY") && (
          <Field label="On" htmlFor={`${id}-wd`}>
            <Select id={`${id}-wd`} value={weekday} onChange={(e) => setWeekday(e.target.value)} aria-label="Pay weekday">
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {cycle === "MONTHLY" && (
          <Field label="On day" htmlFor={`${id}-day`}>
            <Input id={`${id}-day`} type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} className="tabular-nums" />
          </Field>
        )}
        {cycle === "DAYS_OF_MONTH" && (
          <Field label="On days" htmlFor={`${id}-days`}>
            <Input id={`${id}-days`} placeholder="1, 15" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        )}
      </div>
      <ErrorText>{problem}</ErrorText>
      {renderActions ? (
        renderActions({ submit, saving })
      ) : (
        <div>
          <Button onClick={submit} disabled={saving}>
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
