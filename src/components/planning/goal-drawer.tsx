"use client";

import { X } from "lucide-react";
import { useId, useState } from "react";

import { Bar, Button, DetailDrawer, HoverCard, Input, Label, ListRow, Pill } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorDot } from "@/components/ui/color-picker";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { goalTaskProgress } from "@/lib/planning/goals";
import { METRICS, METRIC_KEYS, formatMetric, metricPercent, type MetricKey } from "@/lib/planning/metrics";
import { goalTitleSchema } from "@/lib/planning/schemas";
import { categoriesOf, isDoneTask } from "@/lib/planning/tasks";
import type { PlanningGoal } from "@/lib/planning/types";

import { FieldRow, SaveLabel, useAutosave } from "./controls";
import { DrawerHeader } from "./drawer-header";
import { useGoalReading } from "./goal-reading";
import { usePlanning } from "./planning-store";

/** The X only asks: the row turns into "Remove …?" with Keep and Remove. */
function RemoveX({ label, onAsk }: { label: string; onAsk: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${label}`} onClick={onAsk}>
      <X aria-hidden strokeWidth={1.5} />
    </Button>
  );
}

function ConfirmRemove({ label, onKeep, onRemove, ...row }: { label: string; onKeep: () => void; onRemove: () => unknown } & Record<`data-${string}`, string>) {
  return (
    <ListRow role="group" aria-label={`Remove ${label}?`} {...row}>
      <span className="min-w-0 flex-1 truncate">Remove {label}?</span>
      <Button variant="ghost" onClick={onKeep}>
        Keep
      </Button>
      <Button variant="outline" onClick={() => void onRemove()}>
        Remove
      </Button>
    </ListRow>
  );
}

function MetricsBlock({ goal }: { goal: PlanningGoal }) {
  const { snapshot, addMetric, updateMetric, removeMetric } = usePlanning();
  const reading = useGoalReading(goal);
  const [asking, setAsking] = useState<string | null>(null);
  const [metric, setMetric] = useState<MetricKey>("net_worth");
  const [target, setTarget] = useState("");
  const [param, setParam] = useState("");
  const def = METRICS[metric];
  const used = new Set(goal.metrics.map((m) => `${m.metric}:${m.param ?? ""}`));
  const categories = categoriesOf(snapshot);
  const n = Number(target);
  const ready = target.trim() !== "" && Number.isFinite(n) && n > 0 && (!def.takesCategory || param.trim() !== "");

  return (
    <section aria-label="Metrics" className="flex flex-col gap-2">
      <Label>Metrics</Label>
      <div>
        {goal.metrics.map((m) => {
          const d = METRICS[m.metric];
          const r = reading?.metrics.find((x) => x.metricId === m.id);
          if (asking === m.id) {
            const name = `${d.label}${m.param ? ` · ${m.param}` : ""}`;
            return <ConfirmRemove key={m.id} data-metric-id={m.id} label={name} onKeep={() => setAsking(null)} onRemove={() => removeMetric(m.id)} />;
          }
          return (
            <ListRow key={m.id} data-metric-id={m.id}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {d.label}
                  {m.param ? ` · ${m.param}` : ""}
                </span>
                <Bar value={metricPercent(d, r?.value ?? null, m.target) / 100} className="mt-1.5" aria-label={`${d.label} progress`} />
              </span>
              <span className="flex flex-col items-end text-tag text-ink-3 tabular-nums">
                <span className="text-body text-ink">{formatMetric(d, r?.value ?? null)}</span>
                {r?.stub ? (
                  <HoverCard content="A sample figure. The live number arrives with its page." className="w-[220px] px-3 py-2">
                    <span tabIndex={0} className="cursor-help">
                      Sample
                    </span>
                  </HoverCard>
                ) : null}
              </span>
              <Input
                key={m.target}
                type="number"
                aria-label={`Target for ${d.label}`}
                defaultValue={m.target}
                className="w-24"
                onBlur={(e) => {
                  const t = Number(e.target.value);
                  if (Number.isFinite(t) && t > 0 && t !== m.target) void updateMetric(m.id, { target: t });
                  else e.target.value = String(m.target);
                }}
              />
              <RemoveX label={d.label} onAsk={() => setAsking(m.id)} />
            </ListRow>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-tint p-2">
        <Select aria-label="Metric" className="min-w-0 flex-1" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
          {METRIC_KEYS.map((k) => (
            <option key={k} value={k} disabled={!METRICS[k].takesCategory && used.has(`${k}:`)}>
              {METRICS[k].label}
            </option>
          ))}
        </Select>
        {def.takesCategory ? (
          <>
            <Combobox aria-label="Category to measure" suggestions={categories} placeholder="Category" className="w-32" value={param} onChange={(e) => setParam(e.target.value)} />
          </>
        ) : null}
        <Input
          type="number"
          aria-label="Target"
          placeholder={def.unit === "money" ? "Target $" : def.unit === "percent" ? "Target %" : "Target"}
          className="w-28"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={!ready || used.has(`${metric}:${def.takesCategory ? param.trim() : ""}`)}
          onClick={async () => {
            if (await addMetric(goal.id, { metric, target: n, param: def.takesCategory ? param.trim() : null })) {
              setTarget("");
              setParam("");
            }
          }}
        >
          Add metric
        </Button>
      </div>
    </section>
  );
}

function LinksBlock({ goal }: { goal: PlanningGoal }) {
  const { addLink, removeLink } = usePlanning();
  const [url, setUrl] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  return (
    <section aria-label="Links" className="flex flex-col gap-2">
      <Label>Links</Label>
      <div>
        {goal.links.map((l) =>
          asking === l.id ? (
            <ConfirmRemove key={l.id} label={`link ${l.title ?? l.url}`} onKeep={() => setAsking(null)} onRemove={() => removeLink(l.id)} />
          ) : (
          <ListRow key={l.id}>
            <a href={l.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">
              {l.title ?? l.url}
            </a>
            <RemoveX label={`link ${l.title ?? l.url}`} onAsk={() => setAsking(l.id)} />
          </ListRow>
          ),
        )}
      </div>
      <Input
        type="url"
        aria-label="Add a link"
        placeholder="+ https://, press Enter"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key !== "Enter" || !url.trim()) return;
          e.preventDefault();
          if (await addLink(goal.id, { url })) setUrl("");
        }}
      />
    </section>
  );
}

function GoalFields({ goal }: { goal: PlanningGoal }) {
  const { snapshot, updateGoal, deleteGoal, openGoal, openTask } = usePlanning();
  const uid = useId();
  const [confirming, setConfirming] = useState(false);
  const notes = useAutosave(goal.notes, (text) => updateGoal(goal.id, { notes: text }));
  const linked = snapshot.tasks.filter((t) => t.goalId === goal.id);
  const progress = goalTaskProgress(goal.id, snapshot.tasks, snapshot.statuses);
  const categories = categoriesOf(snapshot);

  return (
    <div className="flex flex-col gap-5" data-goal-panel={goal.id}>
      <DrawerHeader
        title={goal.title}
        schema={goalTitleSchema}
        label="Goal title"
        onSave={(title) => void updateGoal(goal.id, { title })}
        aside={<SaveLabel state={notes.state} />}
      />
      <div>
        <FieldRow label="Category" htmlFor={`${uid}-cat`}>
          <Combobox
            key={goal.category ?? ""}
            id={`${uid}-cat`}
            suggestions={categories}
            defaultValue={goal.category ?? ""}
            placeholder="None"
            maxLength={60}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              const next = e.target.value.trim() || null;
              if (next !== goal.category) void updateGoal(goal.id, { category: next });
            }}
          />
        </FieldRow>
        <FieldRow label="Starts" htmlFor={`${uid}-start`}>
          <DatePicker id={`${uid}-start`} timeZone={snapshot.timeZone} rangeEnd={goal.deadline} value={goal.startDate ?? ""} onChange={(e) => void updateGoal(goal.id, { startDate: e.target.value || null })} />
        </FieldRow>
        <FieldRow label="Deadline" htmlFor={`${uid}-deadline`}>
          <DatePicker id={`${uid}-deadline`} timeZone={snapshot.timeZone} rangeStart={goal.startDate} min={goal.startDate ?? undefined} value={goal.deadline ?? ""} onChange={(e) => void updateGoal(goal.id, { deadline: e.target.value || null })} />
        </FieldRow>
        <FieldRow label="Achieved" htmlFor={`${uid}-achieved`}>
          <Checkbox
            id={`${uid}-achieved`}
            checked={goal.achievedAt !== null}
            onChange={(e) => void updateGoal(goal.id, { achieved: e.target.checked })}
          />
        </FieldRow>
      </div>

      <MetricsBlock goal={goal} />

      <section aria-label="Linked tasks" className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <Label className="flex-1">Tasks</Label>
          <span className="text-tag text-ink-3 tabular-nums">
            {progress.done} of {progress.total} done
          </span>
        </div>
        <Bar value={progress.percent / 100} aria-label="Task progress" />
        <div>
          {linked.map((t) => (
            <ListRow key={t.id} as="button" type="button" onClick={() => openTask(t.id)} aria-label={`Open task ${t.title}`}>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <Pill tone={isDoneTask(t, snapshot.statuses) ? "default" : "soft"} className="gap-1.5">
                <ColorDot color={snapshot.statuses.find((s) => s.id === t.statusId)?.color} />
                {snapshot.statuses.find((s) => s.id === t.statusId)?.label}
              </Pill>
            </ListRow>
          ))}
        </div>
      </section>

      <LinksBlock goal={goal} />

      <label className="flex flex-col gap-1.5">
        <Label>Notes</Label>
        <textarea
          aria-label="Notes"
          rows={5}
          value={notes.draft}
          onChange={(e) => notes.edit(e.target.value)}
          onBlur={() => void notes.flush()}
          className="w-full resize-none rounded-lg border border-rule-2 bg-surface p-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
        />
      </label>

      <div className="flex items-center gap-2 border-t border-rule pt-4">
        <div className="flex-1" />
        {confirming ? (
          <>
            <span className="text-label text-ink-3">Delete this goal?</span>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (await deleteGoal(goal.id)) openGoal(null);
              }}
            >
              Delete
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="text-ink-3" onClick={() => setConfirming(true)}>
            Delete goal
          </Button>
        )}
      </div>
    </div>
  );
}

function GoalPanel({ id }: { id: string }) {
  const { snapshot } = usePlanning();
  const goal = snapshot.goals.find((g) => g.id === id);
  if (!goal) return <p className="text-label text-ink-3">This goal is gone.</p>;
  return <GoalFields key={goal.id} goal={goal} />;
}

/** The kit's slide-out for `?goal=<id>`. */
export function GoalDrawer() {
  return (
    <DetailDrawer param="goal" label="Goal">
      {(id) => <GoalPanel id={id} />}
    </DetailDrawer>
  );
}
