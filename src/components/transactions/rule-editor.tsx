"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, InfoDot, Input, Money, Seg, cn } from "@/components/kit";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { addDays } from "@/lib/planning/dates";
import type { PreviewRow } from "@/lib/rules/actions";

import { dateLabel, describePatch } from "./describe";
import { AccountSelect, CategorySelect, EntitySelect } from "./pickers";
import {
  ACTION_TYPES,
  FIELDS,
  OPS_BY_FIELD,
  OP_LABEL,
  blankCondition,
  buildRule,
  draftFromAction,
  draftFromCondition,
  newKey,
  type DraftAction,
  type DraftCondition,
  type Field,
} from "./rule-draft";
import { useTx, type RuleEditorTarget } from "./store";
import { Switch } from "./switch";

/** The rule editor: a dialog with the conditions and actions on the left and a live preview on the right. */
export function RuleEditorDialog() {
  const { ruleEditor, openRuleEditor } = useTx();
  return (
    <Dialog open={ruleEditor !== null} onOpenChange={(o) => !o && openRuleEditor(null)}>
      {ruleEditor && (
        <DialogContent
          className={cn(
            "max-h-[92dvh] gap-5 overflow-y-auto p-6 sm:max-w-[920px]",
            "max-md:inset-0 max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:p-4",
          )}
        >
          <RuleForm target={ruleEditor} />
        </DialogContent>
      )}
    </Dialog>
  );
}

const DAYS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

function RuleForm({ target }: { target: RuleEditorTarget }) {
  const s = useTx();
  const { api, lookups, today } = s;
  const uid = useId();
  const editing = target.kind === "edit" ? target.rule : null;
  const start = editing ?? ("seed" in target ? target.seed : undefined);

  const [conditions, setConditions] = useState<DraftCondition[]>(() => (start?.conditions.length ? start.conditions.map(draftFromCondition) : [blankCondition()]));
  const [actions, setActions] = useState<DraftAction[]>(() => (start?.actions.length ? start.actions.map(draftFromAction) : []));
  const [first, setFirst] = useState(false);
  const [applyPast, setApplyPast] = useState(false);
  const [applyFrom, setApplyFrom] = useState(() => addDays(today, -90));
  const [days, setDays] = useState("90");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const built = useMemo(() => buildRule(conditions, actions), [conditions, actions]);

  // --- live preview: 300 ms after the last change, newest answer wins ---------------------------
  const [preview, setPreview] = useState<{ checked: number; matched: number; rows: PreviewRow[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const ask = useRef(0);
  const builtKey = built.ok ? JSON.stringify([built.conditions, built.actions, days]) : "";
  useEffect(() => {
    if (!built.ok) {
      ask.current++;
      return;
    }
    const mine = ++ask.current;
    const t = window.setTimeout(() => {
      setPreviewing(true);
      api.previewRule({ conditions: built.conditions, actions: built.actions, days: Number(days) }).then(
        (res) => {
          if (mine !== ask.current) return;
          setPreviewing(false);
          if (res.ok) {
            setPreview(res.data);
            setPreviewError(null);
          } else setPreviewError(res.error.message);
        },
        () => {
          if (mine !== ask.current) return;
          setPreviewing(false);
          setPreviewError("Could not load the preview");
        },
      );
    }, 300);
    return () => window.clearTimeout(t);
    // builtKey stands for built and days: the effect reruns only when the rule's content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, builtKey]);

  const patchCondition = (key: string, patch: Partial<DraftCondition>) => setConditions((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const patchAction = (key: string, patch: Partial<DraftAction>) => setActions((as) => as.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  async function save() {
    if (!built.ok) return setProblem(built.message);
    setSaving(true);
    setProblem(null);
    const from = applyPast ? applyFrom : undefined;
    const res = editing
      ? await api.updateRule({ id: editing.id, conditions: built.conditions, actions: built.actions, applyFrom: from })
      : await api.createRule({ conditions: built.conditions, actions: built.actions, first, applyFrom: from });
    setSaving(false);
    if (!res.ok) return setProblem(res.error.message);
    const rule = res.data.rule;
    s.setRules((prev) => [...prev.filter((r) => r.id !== rule.id), rule].sort((a, b) => a.position - b.position));
    s.openRuleEditor(null);
    s.setOffer(null);
    if (res.data.applied) {
      s.notify(`Rule saved. Applied to ${res.data.applied.changed} of ${res.data.applied.checked} rows`);
      s.reload();
      s.refreshReviewCount();
    } else s.notify("Rule saved");
  }

  const conditionRow = (c: DraftCondition, i: number) => {
    const ops = OPS_BY_FIELD[c.field];
    const multi = c.op === "contains_any" || c.op === "one_of";
    return (
      <li key={c.key} className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch" data-condition={i}>
        <Select
          className="w-[120px] max-md:w-full"
          aria-label={`Condition ${i + 1} field`}
          value={c.field}
          onChange={(e) => {
            const field = e.target.value as Field;
            patchCondition(c.key, { field, op: OPS_BY_FIELD[field][0], text: "", text2: "", ids: [] });
          }}
        >
          {FIELDS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Select
          className="w-[160px] max-md:w-full"
          aria-label={`Condition ${i + 1} operator`}
          value={c.op}
          onChange={(e) => patchCondition(c.key, { op: e.target.value as DraftCondition["op"], text2: "", ids: c.ids.slice(0, 1) })}
        >
          {ops.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </Select>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {c.field === "account" ? (
            multi ? (
              <Select
                multiple
                aria-label={`Condition ${i + 1} accounts`}
                value={c.ids}
                placeholder="Pick accounts"
                onChange={(e) => patchCondition(c.key, { ids: Array.from(e.target.selectedOptions, (o) => o.value) })}
                className="w-full"
              >
                {lookups.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {(a.nickname ?? a.name) + (a.mask ? ` ${a.mask}` : "")}
                  </option>
                ))}
              </Select>
            ) : (
              <AccountSelect
                aria-label={`Condition ${i + 1} account`}
                className="w-full"
                lookups={lookups}
                value={c.ids[0] ?? null}
                placeholder="Pick an account"
                onChange={(id) => patchCondition(c.key, { ids: id ? [id] : [] })}
              />
            )
          ) : (
            <>
              <Input
                aria-label={`Condition ${i + 1} value`}
                value={c.text}
                inputMode={c.field === "amount" ? "decimal" : undefined}
                placeholder={c.field === "amount" ? (c.op === "between" ? "-50" : "-12.50") : multi ? "adobe, capcut" : c.op === "regex" ? "^uber.*trip" : "adobe"}
                onChange={(e) => patchCondition(c.key, { text: e.target.value })}
              />
              {c.op === "between" && (
                <>
                  <span className="text-label text-ink-3">and</span>
                  <Input aria-label={`Condition ${i + 1} upper value`} value={c.text2} inputMode="decimal" placeholder="-10" onChange={(e) => patchCondition(c.key, { text2: e.target.value })} />
                </>
              )}
              {c.field === "amount" && <InfoDot label="About amounts">Money out is negative: a $12.50 purchase is -12.50. Money in is positive.</InfoDot>}
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove condition ${i + 1}`}
          disabled={conditions.length === 1}
          onClick={() => setConditions((cs) => cs.filter((x) => x.key !== c.key))}
        >
          <X strokeWidth={1.5} />
        </Button>
      </li>
    );
  };

  const actionRow = (a: DraftAction, i: number) => (
    <li key={a.key} className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch" data-action={i}>
      <Select
        className="w-[180px] max-md:w-full"
        aria-label={`Action ${i + 1} type`}
        value={a.type}
        onChange={(e) => patchAction(a.key, { type: e.target.value as DraftAction["type"], ref: "" })}
      >
        {ACTION_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {a.type === "set_category" && (
          <CategorySelect aria-label={`Action ${i + 1} category`} className="w-full" lookups={lookups} value={a.ref || null} placeholder="Pick a category" onChange={(id) => patchAction(a.key, { ref: id ?? "" })} />
        )}
        {a.type === "set_entity" && (
          <EntitySelect aria-label={`Action ${i + 1} business`} className="w-full" lookups={lookups} value={a.ref || null} placeholder="Pick a business" onChange={(id) => patchAction(a.key, { ref: id ?? "" })} />
        )}
        {a.type === "rename" && <Input aria-label={`Action ${i + 1} name`} value={a.ref} placeholder="New name" onChange={(e) => patchAction(a.key, { ref: e.target.value })} />}
        {a.type === "set_tax_line" && (
          <Select aria-label={`Action ${i + 1} tax line`} className="w-full" value={a.ref} onChange={(e) => patchAction(a.key, { ref: e.target.value })}>
            <option value="">Pick a tax line</option>
            {lookups.taxLines.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} {t.name}
              </option>
            ))}
          </Select>
        )}
        {a.type === "mark_recurring" && (
          <Select aria-label={`Action ${i + 1} recurring series`} className="w-full" value={a.ref} onChange={(e) => patchAction(a.key, { ref: e.target.value })}>
            <option value="">Pick a series</option>
            {lookups.recurring.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove action ${i + 1}`} onClick={() => setActions((as) => as.filter((x) => x.key !== a.key))}>
        <X strokeWidth={1.5} />
      </Button>
    </li>
  );

  return (
    <>
      <DialogTitle className="text-section">{editing ? "Edit rule" : "New rule"}</DialogTitle>
      <DialogDescription className="sr-only">Conditions, actions and a preview against recent transactions.</DialogDescription>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <section aria-label="Conditions" className="flex flex-col gap-2.5">
            <h3 className="text-label text-ink-3">When all of these match</h3>
            <ul className="flex flex-col gap-2.5">{conditions.map(conditionRow)}</ul>
            <Button variant="ghost" className="self-start" onClick={() => setConditions((cs) => [...cs, blankCondition()])}>
              <Plus strokeWidth={1.5} /> Add condition
            </Button>
          </section>
          <section aria-label="Actions" className="flex flex-col gap-2.5">
            <h3 className="text-label text-ink-3">Then</h3>
            <ul className="flex flex-col gap-2.5">{actions.map(actionRow)}</ul>
            <Button
              variant="ghost"
              className="self-start"
              onClick={() => {
                const used = new Set(actions.map((a) => a.type));
                const type = ACTION_TYPES.find((t) => !used.has(t.value))?.value ?? "set_category";
                setActions((as) => [...as, { key: newKey(), type, ref: "" }]);
              }}
            >
              <Plus strokeWidth={1.5} /> Add action
            </Button>
          </section>
          <section aria-label="Options" className="flex flex-col gap-2 border-t border-rule pt-4">
            {!editing && (
              <div className="flex items-center gap-3">
                <Switch label="Run before the other rules" checked={first} onChange={setFirst} />
                <span className="text-body">Run first</span>
                <InfoDot label="About order">Rules run in order and the first match wins. A new rule goes last unless you run it first.</InfoDot>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Switch label="Apply to past transactions" checked={applyPast} onChange={setApplyPast} />
              <label htmlFor={`${uid}-from`} className="text-body">
                Apply to past rows from
              </label>
              <DatePicker id={`${uid}-from`} clearable={false} value={applyFrom} disabled={!applyPast} max={today} onChange={(e) => e.target.value && setApplyFrom(e.target.value)} className="w-[160px]" />
              <InfoDot label="About applying">Runs every rule over rows posted on or after this day. Rows you categorized by hand are never changed.</InfoDot>
            </div>
          </section>
        </div>

        <section aria-label="Preview" className="flex min-w-0 flex-col gap-3 rounded-xl bg-tint p-4" data-testid="rule-preview">
          <div className="flex items-center gap-3">
            <h3 className="flex-1 text-label text-ink-3">Preview</h3>
            <Seg aria-label="Preview window" size="default" value={days} onValueChange={setDays} items={DAYS} />
          </div>
          <PreviewBody built={built} preview={preview} previewing={previewing} error={previewError} />
        </section>
      </div>
      {problem && (
        <p role="alert" className="text-label text-ink">
          {problem}
        </p>
      )}
      <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex items-center justify-end gap-2 border-t border-rule bg-popover px-6 py-4 max-md:-mx-4 max-md:-mb-4 max-md:px-4">
        {!built.ok && <span className="mr-auto text-label text-ink-3">{built.message}</span>}
        <Button variant="ghost" onClick={() => s.openRuleEditor(null)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!built.ok || saving} onClick={() => void save()}>
          {saving ? "Saving" : "Save rule"}
        </Button>
      </div>
    </>
  );
}

function PreviewBody({
  built,
  preview,
  previewing,
  error,
}: {
  built: ReturnType<typeof buildRule>;
  preview: { checked: number; matched: number; rows: PreviewRow[] } | null;
  previewing: boolean;
  error: string | null;
}) {
  const { lookups } = useTx();
  if (!built.ok) return <p className="py-6 text-center text-label text-ink-3">{built.message}</p>;
  if (error) return <p role="status" className="py-6 text-center text-label text-ink-3">{error}</p>;
  if (!preview) return <p className="py-6 text-center text-label text-ink-3">{previewing ? "Checking" : ""}</p>;
  const changes = preview.rows.filter((r) => r.patch).length;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 transition-opacity duration-200", previewing && "opacity-60")}>
      <p role="status" aria-live="polite" className="text-body" data-testid="preview-summary">
        <span className="font-medium tabular-nums">{preview.matched}</span> of <span className="tabular-nums">{preview.checked}</span> recent rows match
        {preview.rows.length > 0 && <span className="text-ink-3">, {changes} would change</span>}
      </p>
      <ul className="flex max-h-[340px] flex-col overflow-y-auto" aria-label="Matching rows">
        {preview.rows.slice(0, 40).map((r) => (
          <li key={r.id} className="flex items-center gap-3 border-t border-rule py-2 first:border-t-0" data-preview-row={r.id}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-body">{r.name}</span>
              <span className="truncate text-label text-ink-3">
                {dateLabel(r.posted_on)}
                {" · "}
                {r.manual ? "Set by you, kept" : r.patch ? describePatch(r.patch, r, lookups) : "No change"}
              </span>
            </div>
            <span className="text-body tabular-nums">
              <Money cents={r.amount_cents} signed />
            </span>
          </li>
        ))}
      </ul>
      {preview.matched > 40 && <p className="text-label text-ink-3 tabular-nums">and {preview.matched - 40} more</p>}
    </div>
  );
}
