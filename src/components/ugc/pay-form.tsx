"use client";

/**
 * The pay structure editor, reskinned from Ripple's PayStructureForm (components/campaigns/PayStructureForm.tsx).
 * Same fields, lanes, checks and clearing rules: base pay and its minimum views; bonus lanes (view bonus tiers,
 * CPM) that toggle on and off and clear when off; Advanced CPM (mode, rate tiers, how tiers are read); view
 * counting and the freeze window; a retainer and a one-time flat rate. Ripple's form posts dollars; Hydra stores
 * cents, so the patch it hands back is in `DealInput` terms (cents) and goes straight to `createDeal` / `updateDeal`.
 * The form owns its drafts and checks; the server's zod schema stays the authority.
 */
import { ChevronRight, Eye, Plus, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button, InfoDot, Input, Label, cn } from "@/components/kit";
import { formatCompactCount } from "@/lib/ugc/format-views";
import { seedViewBonusTiers } from "@/lib/ugc/pay-tier-seeds";
import { MAX_PAY_RATE, MAX_PAY_VIEWS } from "@/lib/ugc/pay-validation";
import { DEFAULT_VIEW_FREEZE_DAYS } from "@/lib/ugc/view-freeze";
import type { DealInput } from "@/lib/ugc/schemas";

import { DollarInput, ErrorText, PlainSeg, Toggle } from "./controls";

export type PayValues = Pick<
  DealInput,
  | "basePayCents"
  | "baseMinViews"
  | "viewBonuses"
  | "viewBonusMode"
  | "cpmRate"
  | "cpmViewUnit"
  | "cpmCapViews"
  | "cpmMinViews"
  | "cpmTiers"
  | "cpmMode"
  | "cpmTierMode"
  | "viewAggregationMode"
  | "viewFreezeDays"
  | "retainerCents"
  | "flatRateCents"
>;

export function payValuesOf(d: DealInput): PayValues {
  return {
    basePayCents: d.basePayCents,
    baseMinViews: d.baseMinViews,
    viewBonuses: d.viewBonuses,
    viewBonusMode: d.viewBonusMode,
    cpmRate: d.cpmRate,
    cpmViewUnit: d.cpmViewUnit,
    cpmCapViews: d.cpmCapViews,
    cpmMinViews: d.cpmMinViews,
    cpmTiers: d.cpmTiers,
    cpmMode: d.cpmMode,
    cpmTierMode: d.cpmTierMode,
    viewAggregationMode: d.viewAggregationMode,
    viewFreezeDays: d.viewFreezeDays,
    retainerCents: d.retainerCents,
    flatRateCents: d.flatRateCents,
  };
}

/** True when the CPM lane is active: a positive flat rate or any rate tier. */
export function hasCpmValues(v: Pick<PayValues, "cpmRate" | "cpmTiers">): boolean {
  return (v.cpmRate !== null && v.cpmRate > 0) || v.cpmTiers.length > 0;
}

const compact = (n: number) => formatCompactCount(n).replace(/\.0(?=[KMB]$)/, "");
const dollarsText = (cents: number | null) => (cents === null ? "" : String(Math.round(cents) / 100));
const toCents = (s: string) => {
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 100);
};

// ─── Client-side checks (the server schema is the authority) ────────────────

function checkMoney(raw: string, label: string): string | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return `${label} must be a non-negative number`;
  if (n > MAX_PAY_RATE) return `${label} can't exceed $${MAX_PAY_RATE.toLocaleString("en-US")}`;
  return null;
}

function checkViews(raw: string, label: string): string | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return `${label} must be a non-negative number`;
  if (n > MAX_PAY_VIEWS) return `${label} can't exceed ${MAX_PAY_VIEWS.toLocaleString("en-US")} views`;
  return null;
}

function checkTiers(tiers: readonly { views: number; bonus: number }[]): string | null {
  const filled = tiers.filter((t) => t.views > 0);
  for (const t of filled) {
    if (!Number.isFinite(t.bonus) || t.bonus < 0) return "View bonus tiers must use non-negative numbers";
    if (t.views > MAX_PAY_VIEWS) return `Bonus tier views can't exceed ${MAX_PAY_VIEWS.toLocaleString("en-US")}`;
    if (t.bonus > MAX_PAY_RATE) return `Bonus tier pay can't exceed $${MAX_PAY_RATE.toLocaleString("en-US")}`;
  }
  if (new Set(filled.map((t) => t.views)).size !== filled.length) return "Each bonus tier needs a different views threshold";
  return null;
}

function checkCpmTiers(tiers: readonly { views: number; ratePerUnit: number }[]): string | null {
  const filled = tiers.filter((t) => t.views > 0);
  for (const t of filled) {
    if (!Number.isFinite(t.ratePerUnit) || t.ratePerUnit < 0) return "CPM rate tiers must use non-negative numbers";
    if (t.views > MAX_PAY_VIEWS) return `CPM tier views can't exceed ${MAX_PAY_VIEWS.toLocaleString("en-US")}`;
    if (t.ratePerUnit > MAX_PAY_RATE) return `CPM tier rate can't exceed $${MAX_PAY_RATE.toLocaleString("en-US")}`;
  }
  if (new Set(filled.map((t) => t.views)).size !== filled.length) return "Each CPM tier needs a different views threshold";
  return null;
}

/** An armed retainer or flat rate must carry a real amount, or the lane would read as on while paying $0. */
function checkArmed(raw: string, label: string): string | null {
  const n = Number(raw);
  return raw.trim() === "" || !Number.isFinite(n) || n <= 0 ? `${label} must be more than $0 while its lane is on` : null;
}

function checkFreezeDays(raw: string): string | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return !Number.isInteger(n) || n < 1 || n > 365 ? "View freeze must be a whole number of days between 1 and 365" : null;
}

// ─── Layout bits ─────────────────────────────────────────────────────────────

function Row({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[40px] flex-wrap items-center gap-x-3 gap-y-1.5">
      <Label as="label" htmlFor={htmlFor} className="w-36 shrink-0">
        {label}
      </Label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-rule pt-4 first:border-t-0 first:pt-0">
      <Label>{title}</Label>
      {children}
    </section>
  );
}

const num = "w-[120px] tabular-nums";

export type PayFormProps = {
  initial: PayValues;
  saving?: boolean;
  /** Gets the patch once the checks pass. */
  onSubmit: (patch: PayValues) => void | Promise<void>;
  /** Replaces the default Save row (the wizard's Back and Continue). */
  renderActions?: (ctx: { submit: () => void; saving: boolean; invalid: boolean }) => ReactNode;
  /** The label of the default Save button. */
  saveLabel?: string;
  /** Surface for a refusal from the server. */
  error?: string | null;
};

export function PayStructureForm({ initial, saving = false, onSubmit, renderActions, saveLabel = "Save pay structure", error }: PayFormProps) {
  const uid = useId();
  const [cpmOn, setCpmOn] = useState(hasCpmValues(initial));
  const [bonusOn, setBonusOn] = useState(initial.viewBonuses.length > 0 || !hasCpmValues(initial));
  const [basePay, setBasePay] = useState(dollarsText(initial.basePayCents));
  const [minViews, setMinViews] = useState(initial.baseMinViews > 0 ? String(initial.baseMinViews) : "");
  const [tiers, setTiers] = useState<{ views: number; bonus: number }[]>(
    initial.viewBonuses.length > 0
      ? initial.viewBonuses.map((t) => ({ views: t.views, bonus: t.bonusCents / 100 }))
      : seedViewBonusTiers(),
  );
  const [bonusMode, setBonusMode] = useState<"REPLACE" | "ADD">(initial.viewBonusMode);
  const [cpmRate, setCpmRate] = useState(initial.cpmRate !== null ? String(initial.cpmRate) : "");
  const [cpmUnit, setCpmUnit] = useState(String(initial.cpmViewUnit || 1000));
  const [cpmCap, setCpmCap] = useState(initial.cpmCapViews !== null ? String(initial.cpmCapViews) : "");
  const [cpmMin, setCpmMin] = useState(initial.cpmMinViews !== null ? String(initial.cpmMinViews) : "");
  const [cpmMode, setCpmMode] = useState(initial.cpmMode);
  const [tierMode, setTierMode] = useState(initial.cpmTierMode);
  const [cpmTiers, setCpmTiers] = useState(initial.cpmTiers.map((t) => ({ ...t })));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [aggMode, setAggMode] = useState(initial.viewAggregationMode);
  const [freeze, setFreeze] = useState(initial.viewFreezeDays !== null ? String(initial.viewFreezeDays) : String(DEFAULT_VIEW_FREEZE_DAYS));
  const [retainerOn, setRetainerOn] = useState(initial.retainerCents !== null && initial.retainerCents > 0);
  const [retainer, setRetainer] = useState(dollarsText(initial.retainerCents));
  const [flatOn, setFlatOn] = useState(initial.flatRateCents !== null && initial.flatRateCents > 0);
  const [flat, setFlat] = useState(dollarsText(initial.flatRateCents));

  // Only active lanes are checked: a lane toggled off is cleared on submit.
  const invalidMessage =
    checkMoney(basePay, "Base pay") ??
    checkViews(minViews, "Minimum views for base pay") ??
    checkFreezeDays(freeze) ??
    (retainerOn ? (checkMoney(retainer, "Retainer amount") ?? checkArmed(retainer, "Retainer amount")) : null) ??
    (flatOn ? (checkMoney(flat, "Flat rate amount") ?? checkArmed(flat, "Flat rate amount")) : null) ??
    (cpmOn
      ? (checkMoney(cpmRate, "CPM rate") ??
        checkViews(cpmUnit, "CPM view unit") ??
        checkViews(cpmCap, "CPM cap views") ??
        checkViews(cpmMin, "CPM minimum views") ??
        checkCpmTiers(cpmTiers))
      : null) ??
    (bonusOn ? checkTiers(tiers) : null);
  const invalid = invalidMessage !== null;
  // The Advanced block opens by itself when one of its fields is what blocks the save.
  const advancedShown = advancedOpen || (cpmOn && checkCpmTiers(cpmTiers) !== null);
  const advancedSummary = [
    cpmTiers.filter((t) => t.views > 0).length > 0 ? `${cpmTiers.filter((t) => t.views > 0).length} rate tiers` : "",
    cpmMode === "REPLACE" ? "higher of the two" : "",
    tierMode === "COMBINED_BRACKETED" ? "combined brackets" : tierMode === "COMBINED_FLAT" ? "combined flat" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const submit = () => {
    if (saving || invalid) return;
    const int = (s: string) => (s.trim() === "" ? null : Math.round(Number(s)));
    const patch: PayValues = {
      basePayCents: toCents(basePay),
      baseMinViews: Math.max(0, Math.round(Number(minViews) || 0)),
      viewBonuses: bonusOn
        ? tiers.filter((t) => t.views > 0 && t.bonus > 0).map((t) => ({ views: Math.round(t.views), bonusCents: Math.round(t.bonus * 100) }))
        : [],
      viewBonusMode: bonusMode,
      // Lane off clears the whole lane: rate, tiers, cap, floor, and the tier reading resets so COMBINED_FLAT cannot linger.
      cpmRate: cpmOn ? (Number.isNaN(parseFloat(cpmRate)) ? null : parseFloat(cpmRate)) : null,
      cpmViewUnit: cpmOn ? Math.max(1, Math.round(Number(cpmUnit) || 1000)) : 1000,
      cpmCapViews: cpmOn ? int(cpmCap) : null,
      cpmMinViews: cpmOn ? int(cpmMin) : null,
      cpmTiers: cpmOn ? cpmTiers.filter((t) => t.views > 0).map((t) => ({ views: Math.round(t.views), ratePerUnit: t.ratePerUnit })) : [],
      cpmMode,
      cpmTierMode: cpmOn ? tierMode : "PER_VIDEO",
      viewAggregationMode: aggMode,
      viewFreezeDays: freeze.trim() === "" ? null : Math.round(Number(freeze)),
      retainerCents: retainerOn ? toCents(retainer) : null,
      flatRateCents: flatOn ? toCents(flat) : null,
    };
    void onSubmit(patch);
  };

  return (
    <div className="@container flex flex-col gap-5" data-slot="pay-form">
      <div className="grid gap-x-10 gap-y-5 @2xl:grid-cols-2 @2xl:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <Group title="Base pay">
            <Row label="Base pay / video" htmlFor={`${uid}-base`}>
              <DollarInput id={`${uid}-base`} aria-label="Base pay per video" placeholder="0.00" value={basePay} onChange={(e) => setBasePay(e.target.value)} className={num} />
            </Row>
            <Row label="Min views for base" htmlFor={`${uid}-min`}>
              <Input id={`${uid}-min`} inputMode="numeric" aria-label="Minimum views for base pay" placeholder="0 (none)" value={minViews} onChange={(e) => setMinViews(e.target.value)} className={num} />
            </Row>
            <Row label="Bonus lanes">
              <Toggle pressed={bonusOn} onPressedChange={setBonusOn}>
                View bonuses
              </Toggle>
              <Toggle pressed={cpmOn} onPressedChange={setCpmOn}>
                CPM
              </Toggle>
            </Row>
          </Group>

          {bonusOn && (
            <Group
              title={
                <span className="flex items-center gap-2">
                  <span>View bonuses per video</span>
                  <InfoDot label="About view bonuses">The highest tier a video passes is paid. A blank pay skips a tier.</InfoDot>
                  <span className="flex-1" />
                  <Button variant="ghost" className="-my-1 h-7 px-2 text-tag" onClick={() => setTiers((t) => [...t, { views: 0, bonus: 0 }])}>
                    <Plus strokeWidth={1.5} />
                    Add tier
                  </Button>
                </span>
              }
            >
              <PlainSeg
                aria-label="View bonus mode"
                value={bonusMode}
                onValueChange={(v) => setBonusMode(v as "REPLACE" | "ADD")}
                items={[
                  { value: "REPLACE", label: "Replace base pay" },
                  { value: "ADD", label: "Add onto base pay" },
                ]}
              />
              <div className="flex flex-col gap-2">
                {tiers.map((tier, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="relative min-w-0 flex-1">
                      <Eye aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-3" />
                      <Input
                        inputMode="numeric"
                        placeholder="Views"
                        aria-label="Bonus tier views"
                        className="pl-8 tabular-nums"
                        value={tier.views || ""}
                        onChange={(e) => setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, views: parseInt(e.target.value) || 0 } : t)))}
                      />
                    </span>
                    <span aria-hidden className="text-ink-3">
                      →
                    </span>
                    <DollarInput
                      placeholder="Pay"
                      aria-label="Bonus tier amount"
                      className="flex-1"
                      value={tier.bonus || ""}
                      onChange={(e) => setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, bonus: parseFloat(e.target.value) || 0 } : t)))}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${compact(tier.views)} views tier`}
                      onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}
                    >
                      <X strokeWidth={1.5} />
                    </Button>
                  </div>
                ))}
              </div>
            </Group>
          )}

          {cpmOn && (
            <Group title="CPM">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label as="label" htmlFor={`${uid}-cpm`}>
                    Rate per unit
                  </Label>
                  <DollarInput id={`${uid}-cpm`} aria-label="CPM rate" placeholder="1.00" value={cpmRate} onChange={(e) => setCpmRate(e.target.value)} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label as="label" htmlFor={`${uid}-unit`}>
                    Per views
                  </Label>
                  <Input id={`${uid}-unit`} inputMode="numeric" aria-label="CPM view unit" placeholder="1000" className="tabular-nums" value={cpmUnit} onChange={(e) => setCpmUnit(e.target.value)} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label as="label" htmlFor={`${uid}-cap`}>
                    Cap views
                  </Label>
                  <Input id={`${uid}-cap`} inputMode="numeric" aria-label="CPM cap views" placeholder="No cap" className="tabular-nums" value={cpmCap} onChange={(e) => setCpmCap(e.target.value)} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label as="label" htmlFor={`${uid}-cmin`}>
                    Min views
                  </Label>
                  <Input id={`${uid}-cmin`} inputMode="numeric" aria-label="CPM minimum views" placeholder="None" className="tabular-nums" value={cpmMin} onChange={(e) => setCpmMin(e.target.value)} />
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-rule">
                <button
                  type="button"
                  aria-expanded={advancedShown}
                  aria-controls={`${uid}-adv`}
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-label text-ink-2 transition-colors duration-200 outline-none hover:bg-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
                >
                  <ChevronRight aria-hidden strokeWidth={1.5} className={cn("size-4 shrink-0 transition-transform duration-200", advancedShown && "rotate-90")} />
                  Advanced CPM
                  {advancedSummary && <span className="ml-auto truncate text-tag text-ink-3">{advancedSummary}</span>}
                </button>
                {advancedShown && (
                  <div id={`${uid}-adv`} className="flex flex-col gap-4 border-t border-rule p-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>How CPM combines with base pay</Label>
                      <PlainSeg
                        aria-label="CPM mode"
                        value={cpmMode}
                        onValueChange={(v) => setCpmMode(v as "ADD" | "REPLACE")}
                        items={[
                          { value: "ADD", label: "Adds on top" },
                          { value: "REPLACE", label: "Higher of the two" },
                        ]}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <Label>Rate tiers</Label>
                        <InfoDot label="About rate tiers">Each tier pays its rate on the views above it. With no tiers, every view pays the CPM rate.</InfoDot>
                        <span className="flex-1" />
                        <Button variant="ghost" className="-my-1 h-7 px-2 text-tag" onClick={() => setCpmTiers((t) => [...t, { views: 0, ratePerUnit: 0 }])}>
                          <Plus strokeWidth={1.5} />
                          Add CPM tier
                        </Button>
                      </div>
                      {cpmTiers.map((tier, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            inputMode="numeric"
                            placeholder="Views"
                            aria-label="CPM tier views threshold"
                            className="min-w-0 flex-1 tabular-nums"
                            value={tier.views || ""}
                            onChange={(e) => setCpmTiers((ts) => ts.map((t, j) => (j === i ? { ...t, views: parseInt(e.target.value) || 0 } : t)))}
                          />
                          <span aria-hidden className="text-ink-3">
                            →
                          </span>
                          <DollarInput
                            placeholder="Rate"
                            aria-label="CPM tier rate per unit"
                            className="flex-1"
                            value={tier.ratePerUnit || ""}
                            onChange={(e) => setCpmTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ratePerUnit: parseFloat(e.target.value) || 0 } : t)))}
                          />
                          <Button variant="ghost" size="icon-sm" aria-label="Remove CPM tier" onClick={() => setCpmTiers((ts) => ts.filter((_, j) => j !== i))}>
                            <X strokeWidth={1.5} />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="How rate tiers are read">
                      <span className="flex items-center gap-2">
                        <Label>How rate tiers are read</Label>
                        <InfoDot label="About reading rate tiers">
                          {"Per video: each video's own views walk the tiers.\nCombined, brackets: the deal's total views walk the tiers like tax brackets.\nCombined, flat: crossing a tier reprices all views at its rate.\nBase pay and bonuses stay per video."}
                        </InfoDot>
                      </span>
                      {(
                        [
                          ["PER_VIDEO", "Per video"],
                          ["COMBINED_BRACKETED", "Combined, brackets"],
                          ["COMBINED_FLAT", "Combined, flat"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={tierMode === value}
                          onClick={() => setTierMode(value)}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                            tierMode === value ? "border-ink bg-tint" : "border-rule hover:bg-tint",
                          )}
                        >
                          <span className={cn("block text-body", tierMode === value && "font-medium")}>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Group>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Group title="Counting">
            <div className="flex flex-col gap-1.5">
              <Label>View counting</Label>
              <PlainSeg
                aria-label="View counting"
                value={aggMode}
                onValueChange={(v) => setAggMode(v as "HIGHEST" | "COMBINED")}
                items={[
                  { value: "HIGHEST", label: "Highest platform" },
                  { value: "COMBINED", label: "Combine platforms" },
                ]}
              />
            </div>
            <Row label="Freeze after (days)" htmlFor={`${uid}-freeze`}>
              <Input id={`${uid}-freeze`} inputMode="numeric" aria-label="View freeze days" placeholder="Default" value={freeze} onChange={(e) => setFreeze(e.target.value)} className={num} />
            </Row>
          </Group>

          <Group title="Per-cycle pay">
            <Row label="Retainer">
              <Toggle pressed={retainerOn} onPressedChange={setRetainerOn}>
                Retainer
              </Toggle>
              {retainerOn && <DollarInput aria-label="Retainer amount" placeholder="0.00" value={retainer} onChange={(e) => setRetainer(e.target.value)} className={num} />}
            </Row>
          </Group>

          <Group title="One-time pay">
            <Row label="Flat rate">
              <Toggle pressed={flatOn} onPressedChange={setFlatOn}>
                Flat rate
              </Toggle>
              {flatOn && <DollarInput aria-label="Flat rate amount" placeholder="0.00" value={flat} onChange={(e) => setFlat(e.target.value)} className={num} />}
            </Row>
          </Group>
        </div>
      </div>

      <ErrorText>{invalidMessage ?? error}</ErrorText>

      {renderActions ? (
        renderActions({ submit, saving, invalid })
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button variant="primary" onClick={submit} disabled={saving || invalid}>
            {saving ? "Saving" : saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
