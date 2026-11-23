"use client";

import { useId, useState, type ReactNode } from "react";

import { Button, DetailDrawer, Label } from "@/components/kit";
import { ColorDot, ColorPicker } from "@/components/ui/color-picker";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { fromLocalInput, toLocalInput } from "@/lib/planning/dates";
import { REPEAT_LABELS, REPEAT_RULES, repeatRuleSchema } from "@/lib/planning/repeat";
import { taskTitleSchema } from "@/lib/planning/schemas";
import { categoriesOf, isDoneTask } from "@/lib/planning/tasks";
import type { PlanningTask } from "@/lib/planning/types";

import { FieldRow, SaveLabel, useAutosave } from "./controls";
import { DrawerHeader } from "./drawer-header";
import { usePlanning } from "./planning-store";
import { AddPropertyForm, PropertyValueEditor } from "./property-value-editor";

function TaskFields({ task }: { task: PlanningTask }) {
  const store = usePlanning();
  const { snapshot, timeZone, updateTask, moveTask, openTask } = store;
  const uid = useId();
  const done = isDoneTask(task, snapshot.statuses);
  const [confirming, setConfirming] = useState(false);
  const notes = useAutosave(task.notes, (text) => updateTask(task.id, { notes: text }));
  const categories = categoriesOf(snapshot);
  const status = snapshot.statuses.find((s) => s.id === task.statusId);

  return (
    <div className="flex flex-col gap-5" data-task-panel={task.id}>
      <DrawerHeader
        title={task.title}
        schema={taskTitleSchema}
        onSave={(title) => void updateTask(task.id, { title })}
        aside={<SaveLabel state={notes.state} />}
      />

      <div>
        <FieldRow label="Status" htmlFor={`${uid}-status`}>
          {status ? <ColorPicker value={status.color} onChange={(c) => c && void store.setStatusColor(status.id, c)} label={status.label} /> : null}
          <Select
            id={`${uid}-status`}
            className="flex-1"
            value={task.statusId}
            onChange={(e) => void moveTask(task.id, { statusId: e.target.value })}
            // Each status shows its color dot in the list.
            options={snapshot.statuses.map((s) => ({ value: s.id, label: s.label, icon: <ColorDot reserve color={s.color} /> }))}
          />
        </FieldRow>
        <FieldRow label="Category" htmlFor={`${uid}-category`}>
          <Combobox
            key={task.category ?? ""}
            id={`${uid}-category`}
            suggestions={categories}
            defaultValue={task.category ?? ""}
            placeholder="None"
            maxLength={60}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              const next = e.target.value.trim() || null;
              if (next !== task.category) void updateTask(task.id, { category: next });
            }}
          />
        </FieldRow>
        <FieldRow label="Goal" htmlFor={`${uid}-goal`}>
          <Select
            id={`${uid}-goal`}
            className="flex-1"
            value={task.goalId ?? ""}
            onChange={(e) => void updateTask(task.id, { goalId: e.target.value || null })}
          >
            <option value="">No goal</option>
            {snapshot.goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Due" htmlFor={`${uid}-due`}>
          <DatePicker
            id={`${uid}-due`}
            timeZone={timeZone}
            value={task.dueDate ?? ""}
            onChange={(e) => void updateTask(task.id, { dueDate: e.target.value || null })}
          />
        </FieldRow>
        <FieldRow label="Repeat" htmlFor={`${uid}-repeat`}>
          <Select
            id={`${uid}-repeat`}
            className="flex-1"
            value={task.repeatRule ?? ""}
            onChange={(e) => void updateTask(task.id, { repeatRule: repeatRuleSchema.safeParse(e.target.value).data ?? null })}
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
            value={toLocalInput(task.alertAt, timeZone)}
            onChange={(e) => {
              const at = fromLocalInput(e.target.value, timeZone);
              if (at) void updateTask(task.id, { alertAt: at });
            }}
          />
          {task.alertAt ? (
            <Button variant="ghost" aria-label="Clear alert" onClick={() => void updateTask(task.id, { alertAt: null })}>
              Clear
            </Button>
          ) : null}
        </FieldRow>
        {snapshot.properties.map((p) => (
          <FieldRow key={p.id} label={p.name}>
            <PropertyValueEditor task={task} property={p} />
          </FieldRow>
        ))}
      </div>

      <AddPropertyForm />

      <label className="flex flex-col gap-1.5">
        <Label>Notes</Label>
        <textarea
          aria-label="Notes"
          rows={6}
          value={notes.draft}
          onChange={(e) => notes.edit(e.target.value)}
          onBlur={() => void notes.flush()}
          className="w-full resize-none rounded-lg border border-rule-2 bg-surface p-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
          placeholder="Write notes, checklists and links here"
        />
      </label>

      <div className="flex items-center gap-2 border-t border-rule pt-4">
        <Button variant="outline" onClick={() => void store.completeTask(task.id, !done)}>
          {done ? "Reopen" : "Mark done"}
        </Button>
        <div className="flex-1" />
        {confirming ? (
          <>
            <span className="text-label text-ink-3">Delete this task?</span>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (await store.deleteTask(task.id)) openTask(null);
              }}
            >
              Delete
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="text-ink-3" onClick={() => setConfirming(true)}>
            Delete task
          </Button>
        )}
      </div>
    </div>
  );
}

function TaskPanel({ id }: { id: string }): ReactNode {
  const { snapshot } = usePlanning();
  const task = snapshot.tasks.find((t) => t.id === id);
  if (!task) return <p className="text-label text-ink-3">This task is gone.</p>;
  // Keyed by id: opening another task starts its fields fresh.
  return <TaskFields key={task.id} task={task} />;
}

/** The kit's slide-out for `?task=<id>`. Every field saves by itself. */
export function TaskDrawer() {
  return (
    <DetailDrawer param="task" label="Task">
      {(id) => <TaskPanel id={id} />}
    </DetailDrawer>
  );
}
