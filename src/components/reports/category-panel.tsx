"use client";

import { useEffect, useState } from "react";
import { offerUndo } from "@/components/activity/undo-bar";
import { Bars, Button, Input, Label, ListRow, Money, Skeleton, SkeletonRows, formatMoney } from "@/components/kit";
import { Select } from "@/components/ui/select";
import type { ReportScope } from "@/lib/reports/queries";
import { ColorPicker } from "@/components/ui/color-picker";
import { colorName } from "@/lib/label-colors";
import { PANEL_ROWS, dayLabel, monthLabel, percent, type CategoryPanelData, type PanelResult, type ReportsActions } from "./model";

type State = { status: "loading" } | { status: "ready"; data: CategoryPanelData } | { status: "error"; message: string };
type Ask = { kind: "merge"; intoId: string } | { kind: "delete" } | null;

const SELECT = "w-full";

/**
 * The category panel (DESIGN.md section 7): the category's transactions for the period, its trend, and
 * rename, color, merge and tax line map. Fields save by themselves. Merge and delete ask first.
 * Mount with a `key` of the category, scope and month so it starts fresh when any of them change.
 */
export function CategoryPanel({
  categoryKey,
  scope,
  month,
  actions,
  onChanged,
  onClose,
}: {
  categoryKey: string;
  scope: ReportScope;
  month: string;
  actions: ReportsActions;
  /** Something was edited: the page refreshes its figures. */
  onChanged: () => void;
  /** The category is gone (merged or deleted). */
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);

  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    actions
      .loadCategory({ key: categoryKey, scope, month })
      .catch(() => null)
      .then((r) => {
        if (live) setState(r?.ok ? { status: "ready", data: r.data } : { status: "error", message: r && !r.ok ? r.error.message : "Could not load this category" });
      });
    return () => {
      live = false;
    };
  }, [actions, categoryKey, scope, month, reload]);

  /** Runs one edit. On success the page refreshes; a merge or delete closes the panel, any other edit reloads it. */
  const run = async (edit: () => Promise<PanelResult<unknown>>, gone = false) => {
    setBusy(true);
    setError(null);
    const r = await edit().catch(() => ({ ok: false as const, error: { code: "internal", message: "Something went wrong" } }));
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setAsk(null);
    onChanged();
    if (gone) onClose();
    else setReload((n) => n + 1);
  };

  if (state.status === "loading") return <SkeletonCategory />;
  if (state.status === "error") return <p className="py-10 text-label text-ink-3">{state.message}</p>;
  const d = state.data;
  const base = d.kind === "income" ? "income" : "spending";

  return (
    <div className="flex flex-col gap-6 animate-in fade-in-0 duration-150" data-testid="category-panel">
      {d.editable ? <NameField key={d.name} name={d.name} disabled={busy} onSave={(name) => run(() => actions.rename({ id: d.key, name }))} /> : <h2 className="text-section">{d.name}</h2>}

      <div className="flex flex-col gap-1.5">
        <span className="text-figure-s tabular-nums" data-testid="panel-total" data-row-ids={d.rowIds.join(" ")}>
          <Money cents={d.cents} />
        </span>
        <Label>
          {d.count} {d.count === 1 ? "transaction" : "transactions"} · {percent(d.share)} of {base} in {monthLabel(month)}
        </Label>
      </div>

      <Bars data={d.trend.map((t) => ({ label: t.label, values: [t.value] }))} series={[d.kind === "income" ? "Income" : "Spent"]} colors={[d.color]} money={{ whole: true }} height={120} label={`${d.name} by month`} />

      {d.editable && (
        <>
          <section className="flex flex-col gap-2" aria-label="Color">
            <Label>Color</Label>
            <span className="flex items-center gap-2 text-body text-ink-2">
              <ColorPicker value={d.color} allowNone disabled={busy} label={d.name} onChange={(c) => run(() => actions.setColor({ id: d.key, color: c }))} />
              {colorName(d.color)}
            </span>
          </section>

          {d.kind === "expense" && d.entities.length > 0 && (
            <section className="flex flex-col gap-2" aria-label="Tax line">
              <Label>Schedule C line</Label>
              {d.entities.map((e) => (
                <label key={e.id} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-body text-ink-2">{e.name}</span>
                  <Select
                    className={SELECT}
                    disabled={busy}
                    aria-label={`${e.name} Schedule C line`}
                    value={d.taxMap[e.id] ?? ""}
                    onChange={(ev) => run(() => actions.mapTaxLine({ categoryId: d.key, entityId: e.id, taxLineId: ev.target.value || null }))}
                  >
                    <option value="">None</option>
                    {d.taxLines.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </section>
          )}

          <section className="flex flex-col gap-2" aria-label="Merge or delete">
            <Label>Merge into</Label>
            <MergeRow d={d} busy={busy} onAsk={(intoId) => setAsk({ kind: "merge", intoId })} />
            {ask?.kind === "merge" && (
              <AskFirst
                text={`Move every transaction in ${d.name} into ${d.mergeTargets.find((t) => t.id === ask.intoId)?.name ?? "the other category"} and delete ${d.name}?`}
                confirm="Merge"
                busy={busy}
                onConfirm={() => run(() => actions.merge({ fromId: d.key, intoId: ask.intoId }), true)}
                onCancel={() => setAsk(null)}
              />
            )}
            <div>
              <Button variant="outline" disabled={busy} onClick={() => setAsk({ kind: "delete" })}>
                Delete category
              </Button>
            </div>
            {ask?.kind === "delete" && (
              <AskFirst
                text={`Delete ${d.name}? A category with transactions is refused: merge it instead.`}
                confirm="Delete"
                busy={busy}
                onConfirm={() =>
                  run(async () => {
                    const r = await actions.remove({ id: d.key });
                    if (r.ok) offerUndo(r.activityId, `category "${d.name}"`);
                    return r;
                  }, true)
                }
                onCancel={() => setAsk(null)}
              />
            )}
          </section>
        </>
      )}

      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}

      <section aria-label="Transactions" className="flex flex-col">
        <Label className="mb-1">Transactions in {monthLabel(month)}</Label>
        <div data-testid="panel-transactions" data-row-ids={d.rowIds.join(" ")}>
          {d.transactions.map((t) => (
            <ListRow key={t.id} data-tx-id={t.id}>
              <span className="w-14 shrink-0 text-ink-3 tabular-nums">{dayLabel(t.day)}</span>
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="tabular-nums" title={formatMoney(t.cents)}>
                <Money cents={t.cents} signed />
              </span>
            </ListRow>
          ))}
        </div>
        {d.count > PANEL_ROWS && <Label className="pt-2">Showing the newest {PANEL_ROWS} of {d.count}</Label>}
      </section>
    </div>
  );
}

/** The name, saved when the field loses focus or Enter is pressed. */
function NameField({ name, disabled, onSave }: { name: string; disabled: boolean; onSave: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const commit = () => {
    const next = value.trim();
    if (!next) return setValue(name);
    if (next !== name) onSave(next);
  };
  return (
    <Input
      aria-label="Category name"
      value={value}
      disabled={disabled}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-10 border-transparent px-2 text-section hover:border-rule-2 focus:border-ink -ml-2 w-[calc(100%+8px)]"
    />
  );
}

function MergeRow({ d, busy, onAsk }: { d: CategoryPanelData; busy: boolean; onAsk: (intoId: string) => void }) {
  const [into, setInto] = useState("");
  return (
    <div className="flex gap-2">
      <Select className={SELECT} aria-label="Merge into" value={into} disabled={busy || !d.mergeTargets.length} onChange={(e) => setInto(e.target.value)}>
        <option value="">Pick a category</option>
        {d.mergeTargets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      <Button variant="outline" disabled={busy || !into} onClick={() => onAsk(into)}>
        Merge
      </Button>
    </div>
  );
}

/** The question before a merge or a delete. Nothing changes until Confirm. */
function AskFirst({ text, confirm, busy, onConfirm, onCancel }: { text: string; confirm: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-label={`Confirm ${confirm.toLowerCase()}`} className="flex flex-col gap-3 rounded-lg bg-tint p-3.5">
      <p className="text-body">{text}</p>
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {confirm}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The panel's shape while the category loads: name, total and count, the 120 px chart, the rows. */
function SkeletonCategory() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-6">
      <Skeleton className="h-[22px] w-40 rounded-sm" />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-[26px] w-28 rounded-sm" />
        <Skeleton className="h-[17px] w-56 rounded-sm" />
      </div>
      <Skeleton className="h-[120px] w-full" />
      <SkeletonRows n={5} />
    </div>
  );
}
