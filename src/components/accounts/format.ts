import type { AccountWithBalance, BankItemView } from "./types";

/* Pure helpers for the Accounts page. Dates are YYYY-MM-DD strings read as UTC, so the server and the browser print the same text. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-27" to "Nov 27". Anything else comes back unchanged. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}

/** "5 min ago", "2 h ago", "3 d ago". `now` is injected. */
export function ago(iso: string, now: string): string {
  const s = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** Typed dollars to integer cents, exact: "1,234.5" gives 123450. null when it is not money. */
export function dollarsToCents(input: string): number | null {
  const m = /^(-)?\$?(\d[\d,]*|\d*)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/\s/g, ""));
  if (!m || (!m[2] && !m[3])) return null;
  const whole = Number((m[2] || "0").replace(/,/g, ""));
  const cents = whole * 100 + Number((m[3] ?? "").padEnd(2, "0") || 0);
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] ? -cents || 0 : cents;
}

/** Integer cents to the text a money input holds: 123450 gives "1234.50". */
export function centsToDollars(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "Every" column: 7 is a week, 28 to 31 a month, and so on. */
export function everyLabel(gapDays: number): string {
  const near = (days: number, slack: number) => Math.abs(gapDays - days) <= slack;
  if (near(7, 1)) return "Week";
  if (near(14, 1)) return "2 weeks";
  if (near(30.4, 3)) return "Month";
  if (near(91, 5)) return "3 months";
  if (near(182, 6)) return "6 months";
  if (near(365, 8)) return "Year";
  return `${gapDays} days`;
}

/** What one series costs (or pays) in a year and in an average month, in cents (the "Every" buckets). */
export { perMonthCents, perYearCents } from "@/lib/recurring/period";

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

export const accountTitle = (a: Pick<AccountWithBalance, "name" | "nickname">) => a.nickname || a.name;

/** "Chase Checking ··4471". */
export const accountLabel = (a: Pick<AccountWithBalance, "name" | "nickname" | "mask">) =>
  a.mask ? `${accountTitle(a)} ··${a.mask}` : accountTitle(a);

export const KIND_LABEL = { cash: "Cash", card: "Credit card", loan: "Loan", asset: "Asset" } as const;

/** The amount owed on a card or loan, or the balance of cash or an asset. null before the first balance. */
export const balanceCents = (a: AccountWithBalance) => a.balance?.current_cents ?? null;

/** Share of the limit in use, 0 to 100, or null without a limit. */
export function usedPercent(a: AccountWithBalance): number | null {
  const { current_cents: owed, limit_cents: limit } = a.balance ?? {};
  if (owed == null || !limit || limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((owed / limit) * 100)));
}

export type Health = "manual" | "healthy" | "reconnect" | "error" | "revoked";

export const HEALTH_LABEL: Record<Health, string> = {
  manual: "",
  healthy: "Healthy",
  reconnect: "Reconnect",
  error: "Error",
  revoked: "Disconnected",
};

export function itemHealth(item: Pick<BankItemView, "status"> | undefined): Health {
  if (!item) return "manual";
  if (item.status === "active") return "healthy";
  if (item.status === "login_required" || item.status === "pending_expiration") return "reconnect";
  return item.status === "revoked" ? "revoked" : "error";
}

/** Sum of the balances of these accounts, in cents. */
export const total = (accounts: readonly AccountWithBalance[]) => accounts.reduce((s, a) => s + (balanceCents(a) ?? 0), 0);

/** The idle lock field: "" is off. A whole number of minutes from 1 to 60, else "invalid". */
export function parseIdleMinutes(text: string): number | null | "invalid" {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d{1,2}$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= 1 && n <= 60 ? n : "invalid";
}
