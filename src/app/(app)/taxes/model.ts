/**
 * Taxes page model (DESIGN.md section 6 item 6): types and the pure rules for the set-aside, the
 * estimated payment timeline and the document list. No I/O here, so the page, the fixture and the
 * tests all share it. Money is integer cents. Dates are YYYY-MM-DD. Hydra gives estimates from the
 * rate the owner types; it does not file and it is not tax advice.
 */

import { SLUG_RE, filesScheduleC, type Entity } from "@/lib/entities/model";

/** An entity's slug (public.entities): personal, ugc, ugm, or a business the owner added. */
export type EntitySlug = string;

/**
 * How Taxes reads an entity. personal: income only, no Schedule C. schedule_c: sole proprietors and
 * single-member LLCs, like UGC (lines, set-aside, quarterly payments). summary: S corps, partnerships and
 * other shapes: income and expenses only, the return is not computed.
 */
export type Treatment = "personal" | "schedule_c" | "summary";

export interface TaxSection {
  slug: EntitySlug;
  label: string;
  closed: boolean;
  treatment: Treatment;
}

export const treatmentOf = (e: Pick<Entity, "kind" | "taxShape">): Treatment =>
  e.kind === "personal" ? "personal" : filesScheduleC(e.taxShape) ? "schedule_c" : "summary";

/**
 * The sections the switch offers: the active businesses, Personal, then closed businesses that still have
 * data (closed ones keep their history). `inUse`: entity id to "anything points at it".
 */
export function taxSections(entities: readonly Entity[], inUse: (id: string) => boolean): TaxSection[] {
  const section = (e: Entity): TaxSection => ({ slug: e.slug, label: e.name, closed: e.status === "closed", treatment: treatmentOf(e) });
  return [
    ...entities.filter((e) => e.kind === "business" && e.status === "active"),
    ...entities.filter((e) => e.kind === "personal"),
    ...entities.filter((e) => e.kind === "business" && e.status === "closed" && inUse(e.id)),
  ].map(section);
}

/** UGC, Personal and the closed UGM LLC, as seeded. */
export const SEEDED_SECTIONS: readonly TaxSection[] = [
  { slug: "ugc", label: "UGC", closed: false, treatment: "schedule_c" },
  { slug: "personal", label: "Personal", closed: false, treatment: "personal" },
  { slug: "ugm", label: "UGM LLC", closed: true, treatment: "schedule_c" },
];

export const DEFAULT_ENTITY: EntitySlug = "ugc";
/** The rate shown until the owner types one. */
export const DEFAULT_RATE_BPS = 2500;

export const isEntitySlug = (v: unknown): v is EntitySlug => typeof v === "string" && v !== "all" && SLUG_RE.test(v);

/** The asked section if the switch offers it, else UGC, else the first one. */
export function pickSection(sections: readonly TaxSection[], asked: unknown): TaxSection {
  return sections.find((s) => s.slug === asked) ?? sections.find((s) => s.slug === DEFAULT_ENTITY) ?? sections[0]!;
}

export type Quarter = 1 | 2 | 3 | 4;
export const QUARTERS: readonly Quarter[] = [1, 2, 3, 4];

export interface Payment {
  quarter: Quarter;
  amountCents: number;
  paidOn: string;
}

export type DocKind = "w9" | "1099" | "other";
export const DOC_KINDS: readonly { value: DocKind; label: string }[] = [
  { value: "w9", label: "W-9" },
  { value: "1099", label: "1099" },
  { value: "other", label: "Other" },
];
export const docKindLabel = (k: DocKind) => DOC_KINDS.find((d) => d.value === k)?.label ?? k;

export interface TaxDoc {
  id: string;
  kind: DocKind;
  name: string;
  payer: string | null;
  sizeBytes: number | null;
  /** YYYY-MM-DD the file was added. */
  addedOn: string;
}

/** One Schedule C line with money on it. */
export interface TaxLineRow {
  id: string;
  code: string;
  name: string;
  cents: number;
  count: number;
  /** Names of the categories mapped to this line for the entity. */
  categories: string[];
}

export interface TaxesData {
  entity: EntitySlug;
  year: number;
  /** The owner's today, YYYY-MM-DD (the clock for "due in 55 days"). */
  today: string;
  entityClosed: boolean;
  /** The switch's sections, and how this entity is read. */
  sections: TaxSection[];
  treatment: Treatment;
  incomeCents: number;
  /** All spending in the year (every category, not only Schedule C lines): the summary treatment shows it. */
  spendingCents: number;
  /** Payers with income in the year (net above zero), largest first. */
  payers: { name: string; cents: number }[];
  lines: TaxLineRow[];
  rateBps: number;
  payments: Payment[];
  documents: TaxDoc[];
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface LineTx {
  id: string;
  postedOn: string;
  payer: string;
  cents: number;
}

/** Everything the page can change. The live page and the fixture each bring one. */
export interface TaxActions {
  saveRate(input: { entity: EntitySlug; year: number; rateBps: number }): Promise<ActionResult<{ rateBps: number }>>;
  savePayment(input: { entity: EntitySlug; year: number } & Payment): Promise<ActionResult<Payment>>;
  removePayment(input: { entity: EntitySlug; year: number; quarter: Quarter }): Promise<ActionResult<null> & { activityId?: string | null }>;
  lineTransactions(input: {
    entity: EntitySlug;
    year: number;
    taxLineId: string;
  }): Promise<ActionResult<{ rows: LineTx[]; truncated: boolean }>>;
  uploadDocument(input: {
    entity: EntitySlug;
    year: number;
    kind: DocKind;
    payer: string | null;
    file: File;
  }): Promise<ActionResult<TaxDoc>>;
  documentUrl(input: { id: string }): Promise<ActionResult<{ url: string }>>;
  removeDocument(input: { id: string }): Promise<ActionResult<null> & { activityId?: string | null }>;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);

export const daysBetween = (from: string, to: string) => Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);

/** A weekend due date moves to Monday. ponytail: federal holidays are not shifted; the IRS notice wins. */
function nextBusinessDay(s: string): string {
  const d = utc(s);
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

/** IRS estimated tax due dates for a tax year: Apr 15, Jun 15, Sep 15, and Jan 15 of the next year. */
export function dueDate(year: number, quarter: Quarter): string {
  const raw = [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`][quarter - 1];
  return nextBusinessDay(raw);
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export const sumCents = (xs: readonly { cents: number }[]) => xs.reduce((a, x) => a + x.cents, 0);

/** Net profit: income minus deductible expenses. */
export const netProfit = (incomeCents: number, expenseCents: number) => incomeCents - expenseCents;

/** Net profit times the rate, in whole cents (half rounds up). A loss sets nothing aside. */
export function setAsideCents(netCents: number, rateBps: number): number {
  if (netCents <= 0) return 0;
  return Math.round((netCents * rateBps) / 10_000);
}

export const paidCents = (payments: readonly Payment[]) => payments.reduce((a, p) => a + p.amountCents, 0);

/** What is still short of the set-aside, never below zero. */
export const shortCents = (setAside: number, payments: readonly Payment[]) => Math.max(0, setAside - paidCents(payments));

/** "25", "25%", "7.5" to basis points; null when it is not a rate from 0 to 100. */
export function parseRate(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$/.exec(text);
  if (!m) return null;
  const bps = Math.round(Number(m[1]) * 100);
  return bps >= 0 && bps <= 10_000 ? bps : null;
}

export const rateText = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** "1,234.56" or "1234" to integer cents; null when it is not a positive amount. */
export function parseDollars(text: string): number | null {
  const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const cents = Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface QuarterView {
  quarter: Quarter;
  due: string;
  payment: Payment | null;
  status: "paid" | "overdue" | "unpaid" | "due-soon" | "upcoming";
  /** Days until the due date; negative once past. */
  daysLeft: number;
  /** For an unpaid quarter: what is left to pay, split over the unpaid quarters. */
  suggestedCents: number;
}

/** A quarter within this many days shows "Due in N days" (every other future one shows its date). */
const SOON_DAYS = 60;

export function timeline(year: number, today: string, payments: readonly Payment[], setAside: number): QuarterView[] {
  const byQuarter = new Map(payments.map((p) => [p.quarter, p]));
  const open = QUARTERS.filter((q) => !byQuarter.has(q));
  const left = shortCents(setAside, payments);
  const share = open.length ? Math.floor(left / open.length) : 0;
  const extra = open.length ? left - share * open.length : 0;
  return QUARTERS.map((quarter) => {
    const due = dueDate(year, quarter);
    const payment = byQuarter.get(quarter) ?? null;
    const daysLeft = daysBetween(today, due);
    const slot = open.indexOf(quarter);
    return {
      quarter,
      due,
      payment,
      daysLeft,
      suggestedCents: payment ? 0 : share + (slot === 0 ? extra : 0),
      status: payment ? "paid" : daysLeft < 0 ? "overdue" : daysLeft <= SOON_DAYS ? "due-soon" : "upcoming",
    } satisfies QuarterView;
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const key = (s: string) => s.trim().toLowerCase();

/** Payers with income this year and no W-9 on file under their name. */
export function missingW9(payers: readonly { name: string }[], documents: readonly TaxDoc[]): string[] {
  const have = new Set(documents.filter((d) => d.kind === "w9" && d.payer).map((d) => key(d.payer!)));
  return payers.filter((p) => !have.has(key(p.name))).map((p) => p.name);
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "Apr 15" from YYYY-MM-DD. */
export function shortDate(s: string): string {
  return utc(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The years the switch offers: this year and the two before it. */
export const yearChoices = (today: string) => {
  const y = Number(today.slice(0, 4));
  return [y - 2, y - 1, y];
};
