import type { EntitySlug, TaxLineRow, TaxSection, TaxesData } from "@/app/(app)/taxes/model";
import { SEEDED_SECTIONS, pickSection } from "@/app/(app)/taxes/model";

/** `?added=on`: a business added in Settings (Studio Co, sole proprietor) with a year of data, and a partnership. */
export const ADDED_SECTIONS: readonly TaxSection[] = [
  { slug: "ugc", label: "UGC", closed: false, treatment: "schedule_c" },
  { slug: "studio-co", label: "Studio Co", closed: false, treatment: "schedule_c" },
  { slug: "north-partners", label: "North Partners", closed: false, treatment: "summary" },
  ...SEEDED_SECTIONS.slice(1),
];

/** The fixed clock for /dev/taxes: Saturday, November 21, 2026 (Toronto). The e2e never drifts. */
export const TODAY = "2026-11-21";

const line = (code: string, name: string, count: number, cents: number, categories: string[]): TaxLineRow => ({
  // 8 -> ...000080, 24a -> ...000241, 27b -> ...000272: one valid, unique id per line code.
  id: `00000000-0000-4000-8000-${String(parseInt(code) * 10 + (code.endsWith("a") ? 1 : code.endsWith("b") ? 2 : 0)).padStart(12, "0")}`,
  code,
  name,
  cents,
  count,
  categories,
});

const UGC_2026: TaxLineRow[] = [
  line("8", "Advertising", 6, 41_200, ["Ads", "Promo"]),
  line("11", "Contract labor", 9, 135_000, ["Editors"]),
  line("18", "Office expense", 38, 128_440, ["Software", "Subscriptions"]),
  line("22", "Supplies (not included in Part III)", 41, 110_692, ["Props", "Gear under $2,500"]),
  line("24a", "Travel", 5, 89_030, ["Flights", "Hotels"]),
  line("25", "Utilities", 22, 66_000, ["Phone", "Internet share"]),
  line("27b", "Other expenses", 91, 53_656, ["Bank fees", "Misc"]),
];

const doc = (id: number, kind: "w9" | "1099", payer: string, addedOn: string, name: string, sizeBytes: number) => ({
  id: `00000000-0000-4000-8000-0000000002${String(id).padStart(2, "0")}`,
  kind,
  name,
  payer,
  sizeBytes,
  addedOn,
});

const pay = (quarter: 1 | 2 | 3 | 4, amountCents: number, paidOn: string) => ({ quarter, amountCents, paidOn });

type Seed = Omit<TaxesData, "entity" | "year" | "today" | "entityClosed" | "sections" | "treatment" | "spendingCents"> & { spendingCents?: number };
const EMPTY: Seed = { incomeCents: 0, payers: [], lines: [], rateBps: 2500, payments: [], documents: [] };

const SEEDS: Partial<Record<string, Seed>> = {
  "ugc-2026": {
    incomeCents: 4_515_500,
    payers: [
      { name: "Wordwise", cents: 2_846_000 },
      { name: "Brightleaf", cents: 1_120_000 },
      { name: "Canvasly", cents: 549_500 },
    ],
    lines: UGC_2026,
    rateBps: 2500,
    payments: [pay(1, 210_000, "2026-04-14"), pay(2, 290_000, "2026-06-12"), pay(3, 340_000, "2026-09-14")],
    documents: [
      doc(1, "w9", "Wordwise", "2026-01-12", "w9-wordwise.pdf", 84_300),
      doc(2, "w9", "Brightleaf", "2026-02-03", "w9-brightleaf.pdf", 79_100),
    ],
  },
  "ugc-2025": {
    incomeCents: 3_180_000,
    payers: [
      { name: "Wordwise", cents: 2_100_000 },
      { name: "Brightleaf", cents: 1_080_000 },
    ],
    lines: [line("18", "Office expense", 30, 96_000, ["Software"]), line("22", "Supplies (not included in Part III)", 20, 414_000, ["Props"])],
    rateBps: 2200,
    payments: [pay(1, 100_000, "2025-04-15"), pay(2, 100_000, "2025-06-16"), pay(3, 100_000, "2025-09-15"), pay(4, 100_000, "2026-01-14")],
    documents: [doc(3, "1099", "Wordwise", "2026-01-28", "1099-nec-wordwise-2025.pdf", 61_000)],
  },
  "studio-co-2026": {
    incomeCents: 1_860_000,
    payers: [
      { name: "Lumen Labs", cents: 1_240_000 },
      { name: "Glow Co", cents: 620_000 },
    ],
    lines: [line("18", "Office expense", 12, 48_200, ["Software"]), line("22", "Supplies (not included in Part III)", 7, 96_400, ["Props"])],
    rateBps: 2500,
    payments: [pay(3, 120_000, "2026-09-14")],
    documents: [],
  },
  "north-partners-2026": {
    ...EMPTY,
    incomeCents: 940_000,
    payers: [{ name: "Harbor Media", cents: 940_000 }],
    spendingCents: 312_500,
  },
  "personal-2026": {
    ...EMPTY,
    incomeCents: 5_200_000,
    payers: [{ name: "Northside Studio", cents: 5_200_000 }],
  },
  "ugm-2025": {
    incomeCents: 1_240_000,
    payers: [{ name: "Brand Partners", cents: 1_240_000 }],
    lines: [line("17", "Legal and professional services", 4, 180_000, ["Legal"]), line("18", "Office expense", 12, 60_000, ["Software"])],
    rateBps: 2500,
    payments: [],
    documents: [],
  },
};

/** One entity and year of fixture data. Combinations without a seed are empty. */
export function fixtureData(asked: EntitySlug, year: number, sections: readonly TaxSection[] = SEEDED_SECTIONS): TaxesData {
  const section = pickSection(sections, asked);
  const entity = section.slug;
  const seed = structuredClone(SEEDS[`${entity}-${year}`] ?? EMPTY);
  return {
    entity,
    year,
    today: TODAY,
    entityClosed: section.closed,
    sections: [...sections],
    treatment: section.treatment,
    ...seed,
    spendingCents: seed.spendingCents ?? seed.lines.reduce((a, l) => a + l.cents, 0),
  };
}

const NAMES: Record<string, string[]> = {
  "8": ["Meta Ads", "TikTok Ads", "Canva promo"],
  "11": ["Editor: Maya", "Editor: Dev", "Editor: Jo"],
  "17": ["Law office", "Registered agent"],
  "18": ["Adobe", "CapCut", "Notion", "Google Workspace", "Dropbox"],
  "22": ["B&H Photo", "Amazon", "Home Depot"],
  "24a": ["Air Canada", "Hotel", "Uber"],
  "25": ["Rogers", "Bell", "Hydro"],
  "27b": ["Bank fee", "Wise", "Misc"],
};

/** Deterministic transactions for a line: they always add up to the line's total. */
export function fixtureLineTransactions(l: TaxLineRow, limit = 40) {
  const names = NAMES[l.code] ?? ["Expense"];
  const n = Math.min(l.count, limit);
  const share = Math.floor(l.cents / l.count);
  const rows = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 18 - i * 6));
    const last = n === l.count && i === n - 1;
    return {
      id: `00000000-0000-4000-8000-${l.id.slice(-6)}${String(i).padStart(6, "0")}`,
      postedOn: d.toISOString().slice(0, 10),
      payer: names[i % names.length],
      cents: last ? l.cents - share * (l.count - 1) : share,
    };
  });
  return { rows, truncated: l.count > n };
}
