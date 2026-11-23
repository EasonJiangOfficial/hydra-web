"use client";

import { Check, Minus, Plus, X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { Button, Card, EASE, InfoDot, Input, Label, Money, cn, formatMoney } from "@/components/kit";
import { DatePicker } from "@/components/ui/date-picker";
import { logoFileProblem } from "@/lib/ugc/logo";
import { dealRowToInput, type DealDbRow, type DealInput } from "@/lib/ugc/schemas";

import { DealLogo, ErrorText, Field, LogoPicker, useAct } from "./controls";
import { paySummary } from "./model";
import { PayStructureForm, payValuesOf } from "./pay-form";
import { PayoutForm, cycleText, payoutValuesOf } from "./payout-form";
import { useUgc } from "./store";
import {
  STEPS,
  basicsProblem,
  clampStep,
  clearDraft,
  emptyDraft,
  isDirty,
  readDraft,
  writeDraft,
  type WizardDraft,
  type WizardMode,
  landed,
} from "./wizard-core";

const TITLE: Record<WizardMode, string> = { new: "New deal", existing: "Add existing deal" };

/** The deal's fields as a draft starts from a source: same structure, today as the start, no end. */
function seedFrom(row: DealDbRow, today: string): Partial<DealInput> {
  return { ...dealRowToInput({ ...row, start_date: today, end_date: null }) };
}

/**
 * Back on the left, the one filled button on the right. On the phone the filled button is full width on top
 * and Back sits under it: the bottom-right corner of a phone page is where the tab bar and the agent button float.
 */
function StepActions({
  onBack,
  primary,
  onPrimary,
  disabled,
  loading,
}: {
  onBack?: () => void;
  primary: string;
  onPrimary: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-rule pt-5 max-md:flex-col-reverse max-md:items-stretch">
      {onBack && (
        <Button variant="ghost" onClick={onBack} disabled={loading}>
          Back
        </Button>
      )}
      <div className="flex-1 max-md:hidden" />
      <Button variant="primary" onClick={onPrimary} disabled={disabled || loading}>
        {loading ? "Working" : primary}
      </Button>
    </div>
  );
}

export function DealWizard({ mode, onExit, onCreated }: { mode: WizardMode; onExit: () => void; onCreated: (id: string, logoFailed: boolean) => void }) {
  const { model } = useUgc();
  const steps = STEPS[mode];
  const [draft, setDraft] = useState<WizardDraft>(() => emptyDraft(model.today));
  const [ready, setReady] = useState(false);
  const [asking, setAsking] = useState(false);
  // A picked logo file waits here (a draft in storage cannot hold a file) and uploads once the deal exists.
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const logoPreview = useMemo(() => (logoFile ? URL.createObjectURL(logoFile) : null), [logoFile]);
  useEffect(() => () => void (logoPreview && URL.revokeObjectURL(logoPreview)), [logoPreview]);

  // Resume a saved draft after hydration (reading storage during render would not match the server).
  useEffect(() => {
    const saved = readDraft(mode);
    // Hydration finished: adopt the browser's saved draft, if any. Setting state here is the point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setDraft({ ...saved, deal: { ...emptyDraft(model.today).deal, ...saved.deal } });
    setReady(true);
  }, [mode, model.today]);
  useEffect(() => {
    if (ready) writeDraft(mode, draft);
  }, [ready, mode, draft]);

  const update = (fields: Partial<DealInput>) => setDraft((d) => ({ ...d, deal: { ...d.deal, ...fields } }));
  const go = (step: number) => setDraft((d) => ({ ...d, step: clampStep(mode, step) }));
  const current = steps[draft.step - 1];
  const leave = () => {
    if (isDirty(draft)) setAsking(true);
    else {
      clearDraft(mode);
      onExit();
    }
  };

  return (
    <Card className="mx-auto w-full max-w-[760px] gap-6 max-md:mb-6" aria-label={TITLE[mode]} data-wizard={mode}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={leave}
          aria-label="Cancel"
          className="-ml-2 inline-flex h-[34px] items-center gap-1.5 rounded-lg px-2 text-label text-ink-3 transition-colors duration-200 outline-none hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <X aria-hidden strokeWidth={1.5} className="size-4" />
          <span className="max-sm:hidden">Cancel</span>
        </button>
        <ol className="flex flex-1 items-center gap-1.5" aria-label="Steps">
          {steps.map((s, i) => {
            const n = i + 1;
            const done = n < draft.step;
            return (
              <li key={s.id} className="flex-1" aria-current={n === draft.step ? "step" : undefined}>
                <button
                  type="button"
                  disabled={!done}
                  onClick={() => go(n)}
                  aria-label={`${done ? "Back to " : ""}Step ${n}, ${s.label}`}
                  className="group block h-4 w-full outline-none disabled:cursor-default"
                >
                  <span
                    className={cn(
                      "mt-1.5 block h-1 rounded-[2px] transition-colors duration-200",
                      n <= draft.step ? "bg-ink" : "bg-rule",
                      done && "group-hover:bg-ink-3",
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ol>
        <span className="text-tag whitespace-nowrap text-ink-3 tabular-nums" data-testid="wizard-step">
          {`${draft.step}/${steps.length} · ${current.label}`}
        </span>
      </div>

      {asking && (
        <div role="alertdialog" aria-label="Discard this draft" className="flex flex-wrap items-center gap-2 rounded-lg bg-tint px-3 py-2">
          <span className="flex-1 text-label text-ink-2">Discard this draft?</span>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            Keep editing
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              clearDraft(mode);
              onExit();
            }}
          >
            Discard
          </Button>
        </div>
      )}

      <MotionConfig reducedMotion="user">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.2, ease: EASE } }}
            exit={{ opacity: 0, x: -16, transition: { duration: 0.12, ease: EASE } }}
            className="flex flex-col gap-5"
          >
            <h2 className="text-section text-ink">{mode === "new" && current.id === "basics" ? TITLE[mode] : current.label}</h2>
            {!ready ? null : current.id === "pick" ? (
              <PickStep draft={draft} onPick={(source, deal) => setDraft((d) => ({ ...d, source, deal }))} onNext={() => go(draft.step + 1)} />
            ) : current.id === "basics" ? (
              <BasicsStep
                draft={draft}
                update={update}
                logo={{ preview: logoPreview, onFile: setLogoFile }}
                onBack={mode === "existing" ? () => go(draft.step - 1) : undefined}
                onNext={() => go(draft.step + 1)}
              />
            ) : current.id === "daily" ? (
              <DailyStep draft={draft} update={update} onBack={() => go(draft.step - 1)} onNext={() => go(draft.step + 1)} />
            ) : current.id === "pay" ? (
              <PayStep draft={draft} update={update} onBack={() => go(draft.step - 1)} onNext={() => go(draft.step + 1)} />
            ) : current.id === "payout" ? (
              <PayoutStep draft={draft} update={update} onBack={() => go(draft.step - 1)} onNext={() => go(draft.step + 1)} />
            ) : (
              <ReviewStep
                draft={draft}
                logoFile={logoFile}
                logoPreview={logoPreview}
                onBack={() => go(draft.step - 1)}
                onCreated={(id, logoFailed) => {
                  clearDraft(mode);
                  onCreated(id, logoFailed);
                }}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </MotionConfig>
    </Card>
  );
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type StepProps = {
  draft: WizardDraft;
  update: (f: Partial<DealInput>) => void;
  onBack?: () => void;
  onNext: () => void;
};

/** Add existing, step 1: pick a deal or brand already in Hydra (added before, or imported from Ripple). */
function PickStep({ draft, onPick, onNext }: { draft: WizardDraft; onPick: (source: string, deal: Partial<DealInput>) => void; onNext: () => void }) {
  const { model, raw } = useUgc();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const options = [
    ...model.deals.map((d) => ({
      key: `deal:${d.deal.id}`,
      name: d.deal.brand_name,
      note: `${paySummary(d.deal)} · in Hydra`,
      logo: d.logoUrl,
      row: d.deal,
    })),
    ...raw.templates
      .filter((t) => !t.archived)
      .map((t) => ({
        key: `template:${t.id}`,
        name: t.brand_name,
        note: `${paySummary(t)} · from Ripple`,
        logo: t.logo_path ? (raw.logos[t.logo_path] ?? null) : null,
        row: { ...t, entity_id: "", status: "active" as const, start_date: model.today, end_date: null } as DealDbRow,
      })),
  ].filter((o) => !needle || o.name.toLowerCase().includes(needle));
  return (
    <>
      <Input aria-label="Search deals" placeholder="Search deals and brands" value={q} onChange={(e) => setQ(e.target.value)} />
      <div role="radiogroup" aria-label="Deal to copy" className="flex max-h-[420px] flex-col overflow-y-auto">
        {options.length === 0 && <p className="py-4 text-body text-ink-3">No deal matches.</p>}
        {options.map((o) => {
          const on = draft.source === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              data-option={o.key}
              onClick={() => onPick(o.key, seedFrom(o.row, model.today))}
              className={cn(
                "flex w-full items-center gap-3.5 border-t border-rule px-2 py-3 text-left transition-colors duration-200 outline-none first:border-t-0 hover:bg-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink",
                on && "bg-tint",
              )}
            >
              <DealLogo name={o.name} url={o.logo} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium">{o.name}</span>
                <span className="block truncate text-tag text-ink-3">{o.note}</span>
              </span>
              <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-ink bg-ink text-white" : "border-rule-2")}>
                {on && <Check className="size-3" strokeWidth={2} />}
              </span>
            </button>
          );
        })}
      </div>
      <StepActions primary="Continue" onPrimary={onNext} disabled={!draft.source} />
    </>
  );
}

function BasicsStep({
  draft,
  update,
  logo: picked,
  onBack,
  onNext,
}: StepProps & { logo: { preview: string | null; onFile: (f: File) => void } }) {
  const id = useId();
  const { raw } = useUgc();
  const [problem, setProblem] = useState<string | null>(null);
  const d = draft.deal;
  const logo = picked.preview ?? (d.logoPath ? (raw.logos[d.logoPath] ?? null) : null);
  const next = () => {
    const p = basicsProblem(d);
    setProblem(p);
    if (!p) onNext();
  };
  return (
    <>
      <div className="flex items-end gap-3">
        <DealLogo name={d.brandName?.trim() || "?"} url={logo} size={40} />
        <Field label="Deal name" htmlFor={`${id}-name`} className="flex-1">
          <Input
            id={`${id}-name`}
            autoFocus
            maxLength={200}
            placeholder="e.g. Wordwise"
            value={d.brandName ?? ""}
            onChange={(e) => {
              update({ brandName: e.target.value });
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") next();
            }}
          />
        </Field>
      </div>
      <div className="-mt-3 -ml-2">
        <LogoPicker
          hasLogo={Boolean(logo)}
          onFile={(f) => {
            const p = logoFileProblem(f);
            setProblem(p);
            if (!p) picked.onFile(f);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" htmlFor={`${id}-start`}>
          <DatePicker id={`${id}-start`} rangeEnd={d.endDate} value={d.startDate ?? ""} onChange={(e) => update({ startDate: e.target.value })} />
        </Field>
        <Field label="End date" htmlFor={`${id}-end`}>
          <DatePicker id={`${id}-end`} rangeStart={d.startDate} min={d.startDate ?? undefined} value={d.endDate ?? ""} onChange={(e) => update({ endDate: e.target.value || null })} />
        </Field>
      </div>
      <ErrorText>{problem}</ErrorText>
      <StepActions onBack={onBack} primary="Continue" onPrimary={next} disabled={!d.brandName?.trim()} />
    </>
  );
}

function DailyStep({ draft, update, onBack, onNext }: StepProps) {
  const id = useId();
  const n = draft.deal.dailyTargetPosts ?? 1;
  const set = (v: number) => update({ dailyTargetPosts: Math.max(0, Math.min(30, Math.floor(v) || 0)) });
  return (
    <>
      <div className="flex items-center gap-2">
        <Label as="label" htmlFor={`${id}-n`}>
          Posts per day
        </Label>
        <InfoDot>The target for every day of the deal. Days under it count as missed money: missed videos x base pay. A day off can be set on the posting calendar.</InfoDot>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label="One fewer post per day" onClick={() => set(n - 1)} disabled={n <= 0}>
          <Minus strokeWidth={1.5} />
        </Button>
        <Input
          id={`${id}-n`}
          type="number"
          min={0}
          max={30}
          inputMode="numeric"
          value={n}
          onChange={(e) => set(Number(e.target.value))}
          className="w-20 text-center text-section tabular-nums"
        />
        <Button variant="outline" size="icon" aria-label="One more post per day" onClick={() => set(n + 1)} disabled={n >= 30}>
          <Plus strokeWidth={1.5} />
        </Button>
      </div>
      <StepActions onBack={onBack} primary="Continue" onPrimary={onNext} />
    </>
  );
}

function PayStep({ draft, update, onBack, onNext }: StepProps) {
  return (
    <PayStructureForm
      key={draft.source ?? "new"}
      initial={payValuesOf({ ...emptyDraft("").deal, ...draft.deal } as DealInput)}
      onSubmit={(patch) => {
        update(patch);
        onNext();
      }}
      renderActions={({ submit, invalid }) => <StepActions onBack={onBack} primary="Continue" onPrimary={submit} disabled={invalid} />}
    />
  );
}

function PayoutStep({ draft, update, onBack, onNext }: StepProps) {
  return (
    <PayoutForm
      key={draft.source ?? "new"}
      initial={payoutValuesOf({ ...emptyDraft("").deal, ...draft.deal } as DealInput)}
      onSubmit={(patch) => {
        update(patch);
        onNext();
      }}
      renderActions={({ submit }) => <StepActions onBack={onBack} primary="Continue" onPrimary={submit} />}
    />
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 border-t border-rule py-3 first:border-t-0">
      <Label className="w-32 shrink-0">{label}</Label>
      <div className="min-w-0 flex-1 text-body">{children}</div>
    </div>
  );
}

function ReviewStep({
  draft,
  logoFile,
  logoPreview,
  onBack,
  onCreated,
}: {
  draft: WizardDraft;
  logoFile: File | null;
  logoPreview: string | null;
  onBack: () => void;
  onCreated: (id: string, logoFailed: boolean) => void;
}) {
  const { actions, raw } = useUgc();
  const { busy, error, act } = useAct();
  const d = { ...emptyDraft("").deal, ...draft.deal } as DealInput;
  const logo = logoPreview ?? (d.logoPath ? (raw.logos[d.logoPath] ?? null) : null);
  const problem = basicsProblem(d);

  async function create() {
    const made = await act(() => actions.createDeal({ ...draft.deal, brandName: (d.brandName ?? "").trim(), startDate: d.startDate, source: "hydra" }));
    if (!made) return;
    // The deal exists now, so a second Create would make a duplicate: a failed upload opens the deal
    // anyway and its panel says the logo was not saved, where the owner picks it again.
    const logoSaved = logoFile ? await landed(() => actions.uploadDealLogo({ dealId: made.id, file: logoFile })) : true;
    onCreated(made.id, !logoSaved);
  }

  const pay = paySummary({
    base_pay_cents: d.basePayCents,
    cpm_rate: d.cpmRate,
    cpm_view_unit: d.cpmViewUnit,
    cpm_tiers: d.cpmTiers,
    view_bonuses: d.viewBonuses,
    retainer_cents: d.retainerCents,
    flat_rate_cents: d.flatRateCents,
  });
  const rule = d.payoutRule;
  return (
    <>
      <div>
        <ReviewRow label="Deal">
          <span className="flex items-center gap-2.5">
            <DealLogo name={d.brandName} url={logo} size={28} />
            <span className="font-medium">{d.brandName}</span>
          </span>
        </ReviewRow>
        <ReviewRow label="Dates">
          {d.startDate}
          {d.endDate ? ` to ${d.endDate}` : " onward"}
        </ReviewRow>
        <ReviewRow label="Posts per day">{d.dailyTargetPosts === 1 ? "1 video a day" : `${d.dailyTargetPosts} videos a day`}</ReviewRow>
        <ReviewRow label="Pay structure">{pay}</ReviewRow>
        <ReviewRow label="Payout">
          {rule.payerContains ? `Deposits containing "${rule.payerContains}"` : "No deposit rule"}
          {rule.minCents !== undefined && (
            <>
              {", from "}
              <Money cents={rule.minCents} whole />
            </>
          )}
          {rule.maxCents !== undefined && (
            <>
              {", up to "}
              <Money cents={rule.maxCents} whole />
            </>
          )}
          <span className="block text-ink-3">{cycleText(d)}</span>
        </ReviewRow>
        {d.basePayCents ? (
          <ReviewRow label="30 days">
            <span className="tabular-nums">{formatMoney(d.dailyTargetPosts * 30 * d.basePayCents, { whole: true })}</span>
            <span className="text-ink-3"> projected</span>
          </ReviewRow>
        ) : null}
      </div>
      <ErrorText>{problem ?? error}</ErrorText>
      <StepActions onBack={onBack} primary="Create deal" onPrimary={() => void create()} disabled={Boolean(problem)} loading={busy} />
    </>
  );
}
