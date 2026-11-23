import type { AccountWithBalance, AccountsData, BankItemView, RecurringSeriesRow } from "@/components/accounts/types";

/** A fixed clock: Saturday, November 21, 2026, 15:00 UTC. The fixture's dates and the e2e never drift. */
export const NOW = "2026-11-21T15:00:00.000Z";
export const TODAY = "2026-11-21";

const uid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const IDS = {
  personal: uid(1),
  ugc: uid(2),
  ugm: uid(3),
  chaseItem: uid(10),
  amexItem: uid(11),
  checking: uid(20),
  savings: uid(21),
  amexGold: uid(22),
  sapphire: uid(23),
  car: uid(24),
  canvasly: uid(25),
} as const;

const ITEMS: BankItemView[] = [
  { id: IDS.chaseItem, institution_name: "Chase", status: "active", last_synced_at: "2026-11-21T13:00:00.000Z", last_error: null },
  { id: IDS.amexItem, institution_name: "American Express", status: "login_required", last_synced_at: "2026-11-19T15:00:00.000Z", last_error: "ITEM_LOGIN_REQUIRED" },
];

type Base = Pick<AccountWithBalance, "id" | "kind" | "name" | "mask"> &
  Partial<AccountWithBalance> & { owed: number; limit?: number; asOf?: string };

function account(a: Base): AccountWithBalance {
  const { owed, limit, asOf, ...rest } = a;
  const manual = rest.bank_item_id === undefined || rest.bank_item_id === null;
  const full: AccountWithBalance = {
    bank_item_id: null,
    entity_id: IDS.personal,
    nickname: null,
    institution: manual ? null : "Chase",
    in_net_worth: true,
    is_manual: manual,
    statement_balance_cents: null,
    statement_due_on: null,
    statement_balance_override_cents: null,
    statement_due_on_override: null,
    closed_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    balance: { as_of: asOf ?? TODAY, current_cents: owed, available_cents: null, limit_cents: limit ?? null },
    statement_balance_effective_cents: null,
    statement_due_effective_on: null,
    ...rest,
  };
  full.statement_balance_effective_cents = full.statement_balance_override_cents ?? full.statement_balance_cents;
  full.statement_due_effective_on = full.statement_due_on_override ?? full.statement_due_on;
  return full;
}

const ACCOUNTS: AccountWithBalance[] = [
  account({ id: IDS.checking, kind: "cash", name: "Chase Checking", mask: "4471", bank_item_id: IDS.chaseItem, owed: 942_055 }),
  account({ id: IDS.savings, kind: "cash", name: "Chase Savings", mask: "9020", bank_item_id: IDS.chaseItem, owed: 2_241_957 }),
  account({
    id: IDS.amexGold,
    kind: "card",
    name: "Amex Gold",
    mask: "1008",
    bank_item_id: IDS.amexItem,
    institution: "American Express",
    owed: 160_410,
    limit: 1_000_000,
    statement_balance_cents: 160_410,
    statement_due_on: "2026-11-27",
  }),
  account({
    id: IDS.sapphire,
    kind: "card",
    name: "Chase Sapphire",
    mask: "3316",
    bank_item_id: IDS.chaseItem,
    owed: 71_462,
    limit: 1_000_000,
    statement_balance_cents: 64_000,
    statement_due_on: "2026-12-08",
  }),
  account({ id: IDS.car, kind: "asset", name: "Car", mask: null, owed: 1_750_000, asOf: "2026-10-01" }),
  account({ id: IDS.canvasly, kind: "asset", name: "Canvasly owes you", mask: null, owed: 119_100, entity_id: IDS.ugc, asOf: "2026-11-20" }),
];

type Series = [name: string, gap: number, next: string, cents: number, status?: RecurringSeriesRow["status"], priceFrom?: number];

const day = (iso: string, delta: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

const RECURRING: RecurringSeriesRow[] = (
  [
    ["Rent", 30, "2026-12-01", -145_000],
    ["Adobe Creative Cloud", 30, "2026-12-20", -5999, "confirmed", -5499],
    ["Adobe Stock", 30, "2026-12-18", -2999],
    ["CapCut Pro", 30, "2026-12-19", -999],
    ["Phone plan", 30, "2026-12-03", -6500],
    ["Gym", 30, "2026-12-05", -4900],
    ["Claude", 30, "2026-12-11", -10_000],
    ["Car insurance", 182, "2027-02-02", -59_400],
    ["Notion", 30, "2026-12-14", -1000, "suggested"],
  ] as Series[]
).map(([name, gap, next, cents, status, priceFrom], i) => {
  const last = day(next, -gap);
  return {
    id: uid(100 + i),
    name_key: name.toLowerCase(),
    name,
    average_amount_cents: cents,
    gap_days: gap,
    last_seen_on: last,
    next_expected_on: next,
    status: status ?? "confirmed",
    last_price_change: priceFrom ? { from_cents: priceFrom, to_cents: cents, on: last } : null,
    price_change_flagged: !!priceFrom,
  };
});

/** `ig`: `off` (no app keys on the host), `error` (Instagram refused the token) or `nogrant` (insights not granted); connected only but `off`. */
const igData = (connected: boolean, ig?: string | null): AccountsData["instagram"] => ({
  missing: ig === "off" ? ["META_APP_ID", "META_APP_SECRET", "INSTAGRAM_CONFIG_ID", "HYDRA_TOKEN_KEY"] : [],
  username: connected ? "studio.notes" : null,
  lastSyncedAt: connected ? "2026-11-21T13:00:00.000Z" : null,
  lastError: connected && ig === "error" ? "reauth_required" : connected && ig === "nogrant" ? "insights_not_granted" : null,
});

/** `connected`: Google and Instagram signed in, one Grokbot key, one paired Mac, notifications on one phone. */
function connectorData(connected: boolean, ig?: string | null): Pick<AccountsData, "google" | "instagram" | "apiKeys" | "devices" | "pushDevices"> {
  if (!connected) {
    return { google: { configured: true, email: null, status: null }, instagram: igData(false, ig), apiKeys: [], devices: [], pushDevices: 0 };
  }
  return {
    google: { configured: true, email: "owner@example.test", status: "active" },
    instagram: igData(true, ig),
    apiKeys: [{ id: uid(40), name: "Grokbot", prefix: "hyd_ugc_Ab3x", created_at: "2026-11-02T10:00:00.000Z", last_used_at: "2026-11-21T14:10:00.000Z" }],
    devices: [
      { id: uid(43), name: "Hydra server", last_seen_at: "2026-11-21T14:59:50.000Z", created_at: "2026-11-20T09:00:00.000Z", scopes: ["agent", "mcp", "relay"], role: "brain", relay_seen_at: "2026-11-21T14:59:50.000Z" },
      { id: uid(41), name: "Studio Mac", last_seen_at: "2026-11-21T14:58:00.000Z", created_at: "2026-11-10T09:00:00.000Z", scopes: ["agent", "mcp", "relay"], role: "mac", relay_seen_at: "2026-11-21T14:52:00.000Z" },
      { id: uid(42), name: "Claude Code", last_seen_at: "2026-11-21T13:10:00.000Z", created_at: "2026-11-18T09:00:00.000Z", scopes: ["mcp"] },
    ],
    pushDevices: 1,
  };
}

export function fixtureData(options: { plaidConfigured: boolean; connected?: boolean; ig?: string | null }): AccountsData {
  return {
    now: NOW,
    today: NOW.slice(0, 10),
    accounts: ACCOUNTS,
    items: ITEMS,
    recurring: RECURRING,
    entities: [
      { id: IDS.personal, name: "Personal", slug: "personal", closed: false },
      { id: IDS.ugc, name: "UGC", slug: "ugc", closed: false },
      { id: IDS.ugm, name: "UGM LLC", slug: "ugm", closed: true },
    ],
    idleLockMinutes: null,
    plaidConfigured: options.plaidConfigured,
    plaidLoginsUsed: 2,
    ...connectorData(options.connected ?? false, options.ig),
  };
}
