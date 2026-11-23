"use client";

import { useId, useState } from "react";

import { Button, Label } from "@/components/kit";
import { FieldRow, SaveLabel, useAutosave } from "@/components/planning/controls";
import { DrawerHeader } from "@/components/planning/drawer-header";
import { usePlanning } from "@/components/planning/planning-store";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker, DateTimePicker, TimePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { fromLocalInput, toLocalInput } from "@/lib/planning/dates";
import { REPEAT_LABELS, REPEAT_RULES, repeatRuleSchema } from "@/lib/planning/repeat";
import { eventTitleSchema } from "@/lib/planning/schemas";
import { categoriesOf } from "@/lib/planning/tasks";
import type { PlanningEvent } from "@/lib/planning/types";

import { timingOf, timingPatch, type EventTiming } from "./calendar-model";
import { usePlanningExtras } from "./extras";

/** One event's fields. Every field saves by itself, like the task drawer. */
export function EventEditor({ event }: { event: PlanningEvent }) {
  const { snapshot, timeZone } = usePlanning();
  const { events, updateEvent, deleteEvent } = usePlanningExtras();
  const uid = useId();
  const [confirming, setConfirming] = useState(false);
  const notes = useAutosave(event.notes, (text) => updateEvent(event.id, { notes: text }));
  const timing = timingOf(event, timeZone);
  const setTiming = (change: Partial<EventTiming>) => void updateEvent(event.id, timingPatch(event, { ...timing, ...change }, timeZone));
  const categories = categoriesOf({ tasks: snapshot.tasks, goals: snapshot.goals, events });

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-tint p-3" data-event-panel={event.id}>
      <DrawerHeader
        title={event.title}
        schema={eventTitleSchema}
        label="Event title"
        onSave={(title) => void updateEvent(event.id, { title })}
        aside={<SaveLabel state={notes.state} />}
      />
      <div>
        <FieldRow label={event.repeat ? "Starts" : "Date"} htmlFor={`${uid}-date`}>
          <DatePicker id={`${uid}-date`} timeZone={timeZone} clearable={false} value={timing.date} onChange={(e) => e.target.value && setTiming({ date: e.target.value })} />
        </FieldRow>
        <FieldRow label="All day" htmlFor={`${uid}-allday`}>
          <Checkbox
            id={`${uid}-allday`}
            checked={timing.allDay}
            onChange={(e) => setTiming({ allDay: e.target.checked })}
          />
        </FieldRow>
        {timing.allDay ? null : (
          <>
            <FieldRow label="Start" htmlFor={`${uid}-start`}>
              <TimePicker id={`${uid}-start`} clearable={false} value={timing.start} onChange={(e) => e.target.value && setTiming({ start: e.target.value })} />
            </FieldRow>
            <FieldRow label="End" htmlFor={`${uid}-end`}>
              <TimePicker id={`${uid}-end`} value={timing.end ?? ""} onChange={(e) => setTiming({ end: e.target.value || null })} />
            </FieldRow>
          </>
        )}
        <FieldRow label="Category" htmlFor={`${uid}-category`}>
          <Combobox
            key={event.category ?? ""}
            id={`${uid}-category`}
            suggestions={categories}
            defaultValue={event.category ?? ""}
            placeholder="None"
            maxLength={60}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              const next = e.target.value.trim() || null;
              if (next !== event.category) void updateEvent(event.id, { category: next });
            }}
          />
        </FieldRow>
        <FieldRow label="Repeat" htmlFor={`${uid}-repeat`}>
          <Select
            id={`${uid}-repeat`}
            className="flex-1"
            value={event.repeat ?? ""}
            onChange={(e) => void updateEvent(event.id, { repeat: repeatRuleSchema.safeParse(e.target.value).data ?? null })}
          >
            <option value="">Does not repeat</option>
            {REPEAT_RULES.map((rule) => (
              <option key={rule} value={rule}>
                {REPEAT_LABELS[rule]}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Alert" htmlFor={`${uid}-alert`}>
          <DateTimePicker
            id={`${uid}-alert`}
            timeZone={timeZone}
            value={toLocalInput(event.alertAt, timeZone)}
            onChange={(e) => {
              const at = fromLocalInput(e.target.value, timeZone);
              if (at) void updateEvent(event.id, { alertAt: at });
            }}
          />
          {event.alertAt ? (
            <Button variant="ghost" aria-label="Clear event alert" onClick={() => void updateEvent(event.id, { alertAt: null })}>
              Clear
            </Button>
          ) : null}
        </FieldRow>
      </div>
      <label className="flex flex-col gap-1.5">
        <Label>Notes</Label>
        <textarea
          aria-label="Event notes"
          rows={3}
          value={notes.draft}
          onChange={(e) => notes.edit(e.target.value)}
          onBlur={() => void notes.flush()}
          className="w-full resize-none rounded-lg border border-rule-2 bg-surface p-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
          placeholder="Write notes here"
        />
      </label>
      <div className="flex items-center gap-2 border-t border-rule pt-3">
        <div className="flex-1" />
        {confirming ? (
          <>
            <span className="text-label text-ink-3">Delete this event?</span>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button variant="outline" onClick={() => void deleteEvent(event.id)}>
              Delete
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="text-ink-3" onClick={() => setConfirming(true)}>
            Delete event
          </Button>
        )}
      </div>
    </div>
  );
}
