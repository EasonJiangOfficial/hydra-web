/**
 * Pure helpers for the two deal wizards, mirrored from Ripple's create-wizard-core.ts and join-wizard-core.ts:
 * the step registry, the draft (kept in localStorage so a refresh resumes), the step checks and the review lines.
 * Ripple's hashtag and connect-accounts steps are gone (Hydra has no hashtags; the owner left account
 * connection out of this flow). Nothing is written to the database before the review step's Create.
 */
import { DEAL_DEFAULTS, type DealInput } from "@/lib/ugc/schemas";

export type WizardMode = "new" | "existing";
export type StepId = "pick" | "basics" | "daily" | "pay" | "payout" | "review";

export interface StepDef {
  id: StepId;
  label: string;
}

/** New deal: Ripple's create steps. Add existing: Ripple's join steps, with a first step to pick the source. */
export const STEPS: Record<WizardMode, readonly StepDef[]> = {
  new: [
    { id: "basics", label: "Name and dates" },
    { id: "daily", label: "Daily target" },
    { id: "pay", label: "Pay structure" },
    { id: "payout", label: "Payout" },
    { id: "review", label: "Review" },
  ],
  existing: [
    { id: "pick", label: "Pick a deal" },
    { id: "basics", label: "Name and dates" },
    { id: "daily", label: "Daily target" },
    { id: "pay", label: "Pay structure" },
    { id: "payout", label: "Payout" },
    { id: "review", label: "Review" },
  ],
};

export const clampStep = (mode: WizardMode, step: number): number =>
  Number.isFinite(step) ? Math.min(Math.max(Math.round(step), 1), STEPS[mode].length) : 1;

/** What the wizard holds until Create: the deal's fields, plus where an Add existing deal came from. */
export interface WizardDraft {
  step: number;
  deal: Partial<DealInput>;
  /** "deal:<id>" or "template:<id>"; null for a new deal or before a pick. */
  source: string | null;
}

export const emptyDraft = (today: string): WizardDraft => ({
  step: 1,
  deal: { ...DEAL_DEFAULTS, brandName: "", startDate: today },
  source: null,
});

const key = (mode: WizardMode) => `hydra:ugc:wizard:${mode}`;

/** The saved draft, or null. Anything that does not look like a draft is ignored. */
export function readDraft(mode: WizardMode): WizardDraft | null {
  try {
    const raw = localStorage.getItem(key(mode));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<WizardDraft>;
    if (typeof v.step !== "number" || typeof v.deal !== "object" || v.deal === null || Array.isArray(v.deal)) return null;
    return {
      step: clampStep(mode, v.step),
      deal: v.deal,
      source: typeof v.source === "string" ? v.source : null,
    };
  } catch {
    return null;
  }
}

export function writeDraft(mode: WizardMode, draft: WizardDraft): void {
  try {
    localStorage.setItem(key(mode), JSON.stringify(draft));
  } catch {
    // Storage blocked (private mode): the wizard still works, it just cannot resume.
  }
}

export function clearDraft(mode: WizardMode): void {
  try {
    localStorage.removeItem(key(mode));
  } catch {
    // nothing to clear
  }
}

/** The basics step's check: a name, a start date, an end date that is not before it. */
export function basicsProblem(d: Partial<DealInput>): string | null {
  if (!d.brandName?.trim()) return "Give the deal a name";
  if (!d.startDate) return "Pick a start date";
  if (d.endDate && d.endDate < d.startDate) return "The end date is before the start date";
  return null;
}

/** True once the owner has typed or picked anything worth asking about before leaving. */
export function isDirty(draft: WizardDraft): boolean {
  return draft.step > 1 || Boolean(draft.deal.brandName?.trim()) || draft.source !== null;
}

/** A follow-up write after the deal exists (the logo upload): true when it landed, false when refused or thrown (RM-07). */
export async function landed(run: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await run()).ok;
  } catch {
    return false;
  }
}
