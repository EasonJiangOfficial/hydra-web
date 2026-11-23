"use client";

import { useId, useState } from "react";

import { Button, InfoDot, Input, Label, Seg, cn } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import { TimePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";

import { BLANK_INPUT, DAY_SHORT, DELIVERIES, TOOLS, nameFrom, toggle } from "./format";
import type { Result, RoutineInput, Schedule } from "./types";

const KINDS = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Certain days" },
  { value: "monthly", label: "Once a month" },
] as const;

const field = "flex flex-col gap-1.5";

function Check({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: string }) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2 text-body">
      <Checkbox checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}

/** Change the kind of schedule and keep what still fits: the time, and sensible days. */
function withKind(kind: Schedule["kind"], time: string, old: Schedule): Schedule {
  if (kind === "weekly") return { kind, time, days: old.kind === "weekly" ? old.days : [1] };
  if (kind === "monthly") return { kind, time, day: old.kind === "monthly" ? old.day : 1 };
  return { kind, time };
}

/**
 * The routine form, for a new routine (dialog) and for editing one (panel): the instruction in plain words,
 * the schedule, the tools it may use, where the result goes, and what to do when the Mac is off.
 * A blank name is taken from the instruction.
 */
export function RoutineForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: RoutineInput;
  submitLabel: string;
  onSubmit: (input: RoutineInput) => Promise<Result>;
}) {
  const uid = useId();
  const start = initial ?? BLANK_INPUT;
  const [name, setName] = useState(start.name);
  const [instruction, setInstruction] = useState(start.instruction);
  const [schedule, setSchedule] = useState<Schedule>(start.schedule);
  const [tools, setTools] = useState(start.tools);
  const [delivery, setDelivery] = useState(start.delivery);
  const [whenMacOff, setWhenMacOff] = useState(start.whenMacOff);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const valid = instruction.trim() !== "" && tools.length > 0 && (schedule.kind !== "weekly" || schedule.days.length > 0);
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setSaved(false);
    set(v);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const r = await onSubmit({ name: nameFrom(name, instruction), instruction: instruction.trim(), schedule, tools, delivery, whenMacOff });
    setBusy(false);
    if (r.ok) setSaved(true);
    else setError(r.message);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5" aria-label={`${submitLabel} form`}>
      <div className={field}>
        <Label as="label" htmlFor={`${uid}-instruction`}>
          What should Hydra do?
        </Label>
        <textarea
          id={`${uid}-instruction`}
          value={instruction}
          rows={3}
          maxLength={4000}
          placeholder="Check Gmail for brand payment emails and add them to my UGC deals"
          onChange={(e) => edit(setInstruction)(e.target.value)}
          className="min-h-20 w-full resize-y rounded-lg border border-rule-2 bg-surface px-3 py-2 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
        />
      </div>

      <div className={field}>
        <Label as="label" htmlFor={`${uid}-name`}>
          Name
        </Label>
        <Input id={`${uid}-name`} value={name} maxLength={120} placeholder="From the instruction" onChange={(e) => edit(setName)(e.target.value)} />
      </div>

      <fieldset className={field}>
        <Label as="legend" className="mb-1.5">
          When
        </Label>
        <div className="flex gap-2">
          <Select
            aria-label="How often"
            className="flex-1"
            value={schedule.kind}
            onChange={(e) => edit(setSchedule)(withKind(e.target.value as Schedule["kind"], schedule.time, schedule))}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          <TimePicker
            aria-label="Time"
            clearable={false}
            required
            value={schedule.time}
            onChange={(e) => e.target.value && edit(setSchedule)({ ...schedule, time: e.target.value })}
            className="w-32 flex-none"
          />
        </div>
        {schedule.kind === "weekly" && (
          <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5 pt-1">
            {DAY_SHORT.map((label, i) => {
              const on = schedule.days.includes(i);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => edit(setSchedule)({ ...schedule, days: toggle(schedule.days, i).sort() })}
                  className={cn(
                    "h-8 min-w-11 rounded-lg border px-2 text-label transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                    on ? "border-ink bg-ink text-white" : "border-rule-2 text-ink-2 hover:bg-tint",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {schedule.kind === "monthly" && (
          <Select aria-label="Day of the month" value={schedule.day} onChange={(e) => edit(setSchedule)({ ...schedule, day: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                Day {i + 1}
              </option>
            ))}
          </Select>
        )}
      </fieldset>

      <fieldset className={field}>
        <Label as="legend" className="mb-1">
          Tools allowed
        </Label>
        <div className="grid grid-cols-2 gap-x-4">
          {TOOLS.map((t) => (
            <Check key={t.value} checked={tools.includes(t.value)} onChange={() => edit(setTools)(toggle(tools, t.value))}>
              {t.label}
            </Check>
          ))}
        </div>
      </fieldset>

      <fieldset className={field}>
        <Label as="legend" className="mb-1">
          Deliver the result
        </Label>
        <div className="grid grid-cols-2 gap-x-4">
          {DELIVERIES.map((d) => (
            <Check key={d.value} checked={delivery.includes(d.value)} onChange={() => edit(setDelivery)(toggle(delivery, d.value))}>
              {d.label}
            </Check>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-2">
        <Label>When the Mac is off</Label>
        <InfoDot>Mac steps run only while Hydra Desktop is running. Wait keeps the run until the Mac is back. Skip drops it and says so.</InfoDot>
        <div className="flex-1" />
        <Seg
          aria-label="When the Mac is off"
          value={whenMacOff}
          items={[
            { value: "wait", label: "Wait" },
            { value: "skip", label: "Skip" },
          ]}
          onValueChange={(v) => edit(setWhenMacOff)(v as typeof whenMacOff)}
        />
      </div>

      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span role="status" className="text-label text-ink-3">
            Saved
          </span>
        )}
        <Button type="submit" variant="primary" disabled={!valid || busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
