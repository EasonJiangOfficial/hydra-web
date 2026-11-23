"use client";

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import { useId, useState } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button, cn } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";

import { ConfirmButton } from "./confirm";
import { describeActions, describeConditions } from "./describe";
import { useTx } from "./store";
import { Switch } from "./switch";
import type { Lookups, StoredRule } from "./types";

/** `Name contains "Uber" → Transport`, short enough for the undo bar. */
function ruleName(rule: StoredRule, l: Lookups): string {
  const text = `${describeConditions(rule.conditions, l)} → ${describeActions(rule.actions, l)}`;
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** The Rules tab: the ordered list (first match wins), drag to reorder, bulk edit, and the editor. */
export function RulesTab() {
  const s = useTx();
  const { api, rules, setRules, notify, lookups } = s;
  const dndId = useId();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ordered = [...rules].sort((a, b) => a.position - b.position);

  async function reorder(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ordered.findIndex((r) => r.id === e.active.id);
    const to = ordered.findIndex((r) => r.id === e.over!.id);
    if (from < 0 || to < 0) return;
    const before = rules;
    const next = arrayMove(ordered, from, to).map((r, position) => ({ ...r, position }));
    setRules(next);
    const res = await api.reorderRules({ ids: next.map((r) => r.id) });
    if (!res.ok) {
      setRules(before);
      notify(res.error.message);
    }
  }

  async function toggle(rule: StoredRule, enabled: boolean) {
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
    const res = await api.updateRule({ id: rule.id, enabled });
    if (!res.ok) {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)));
      notify(res.error.message);
    }
  }

  async function remove(ids: string[]) {
    const gone: string[] = [];
    const undoIds: (string | null | undefined)[] = [];
    for (const id of ids) {
      const res = await api.deleteRule({ id });
      if (res.ok) {
        gone.push(id);
        undoIds.push(res.activityId);
      } else notify(res.error.message);
    }
    const removed = rules.filter((r) => gone.includes(r.id));
    setRules((prev) => prev.filter((r) => !gone.includes(r.id)));
    setPicked((p) => new Set([...p].filter((id) => !gone.includes(id))));
    if (!gone.length) return;
    if (undoIds.some(Boolean))
      offerUndo(undoIds, gone.length === 1 && removed[0] ? `rule "${ruleName(removed[0], lookups)}"` : `${gone.length} rules`, () =>
        setRules((prev) => [...prev, ...removed.filter((r) => !prev.some((p) => p.id === r.id))]),
      );
    else notify(gone.length === 1 ? "Rule deleted" : `${gone.length} rules deleted`);
  }

  const allPicked = ordered.length > 0 && ordered.every((r) => picked.has(r.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-label text-ink-3">
          <Checkbox
            aria-label="Select all rules"
            checked={allPicked}
            onChange={() => setPicked(allPicked ? new Set() : new Set(ordered.map((r) => r.id)))}
          />
          <span className="tabular-nums">
            {picked.size ? `${picked.size} selected` : `${ordered.length} ${ordered.length === 1 ? "rule" : "rules"}`}
          </span>
        </label>
        <div className="flex flex-1 flex-wrap items-center gap-2 max-md:order-last max-md:basis-full">
          {picked.size > 0 && (
            <ConfirmButton
              label={`Delete ${picked.size}`}
              question={`Delete ${picked.size} ${picked.size === 1 ? "rule" : "rules"}? Rows they categorized keep their category.`}
              confirmLabel="Delete"
              variant="outline"
              className="text-ink"
              onConfirm={() => remove([...picked])}
            />
          )}
        </div>
        <ConfirmButton
          label="Run all rules"
          question="Run every rule over all rows? Rows you set by hand stay as they are."
          confirmLabel="Run"
          variant="outline"
          className="text-ink"
          onConfirm={async () => {
            const res = await api.applyRules({});
            if (!res.ok) return notify(res.error.message);
            notify(`Checked ${res.data.checked} rows, changed ${res.data.changed}`);
            s.reload();
            s.refreshReviewCount();
          }}
        />
        <Button variant="primary" onClick={() => s.openRuleEditor({ kind: "new" })}>
          <Plus strokeWidth={1.5} /> New rule
        </Button>
      </div>

      {ordered.length === 0 ? (
        <p role="status" className="rounded-xl border border-rule py-12 text-center text-label text-ink-3">
          No rules yet
        </p>
      ) : (
        <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
          <SortableContext items={ordered.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <ol aria-label="Rules, first match wins" className="overflow-hidden rounded-xl border border-rule" data-testid="rules-list">
              {ordered.map((rule, i) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  index={i}
                  picked={picked.has(rule.id)}
                  onPick={() =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (!next.delete(rule.id)) next.add(rule.id);
                      return next;
                    })
                  }
                  onToggle={(enabled) => void toggle(rule, enabled)}
                  onEdit={() => s.openRuleEditor({ kind: "edit", rule })}
                  onDelete={() => remove([rule.id])}
                  when={describeConditions(rule.conditions, lookups)}
                  then={describeActions(rule.actions, lookups)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  index,
  picked,
  onPick,
  onToggle,
  onEdit,
  onDelete,
  when,
  then,
}: {
  rule: StoredRule;
  index: number;
  picked: boolean;
  onPick: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void | Promise<void>;
  when: string;
  then: string;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id });
  return (
    <li
      ref={setNodeRef}
      data-rule-id={rule.id}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative flex flex-wrap items-center gap-3 border-t border-rule bg-surface px-4 py-3 first:border-t-0 max-md:gap-2",
        isDragging && "z-10 border-rule-2 bg-surface",
        picked && "bg-tint",
      )}
    >
      <Checkbox aria-label={`Select rule ${index + 1}`} checked={picked} onChange={onPick} />
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reorder rule ${index + 1}: ${when}`}
        className="inline-grid size-8 cursor-grab touch-none place-items-center rounded-md text-ink-3 outline-none transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden strokeWidth={1.5} className="size-4" />
      </button>
      <span className="w-5 text-label text-ink-3 tabular-nums max-md:hidden">{index + 1}</span>
      <button type="button" onClick={onEdit} aria-label={`Edit rule ${index + 1}`} className={cn("flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none focus-visible:underline max-md:order-last max-md:basis-full", !rule.enabled && "text-ink-3")}>
        <span className="text-body md:truncate">{when}</span>
        <span className="text-label text-ink-3 md:truncate">{then}</span>
      </button>
      <Switch label={`Rule ${index + 1} on`} checked={rule.enabled} onChange={onToggle} className="max-md:ml-auto" />
      <ConfirmButton label="Delete" question="Delete this rule? Rows it categorized keep their category." confirmLabel="Delete" onConfirm={onDelete} />
    </li>
  );
}
