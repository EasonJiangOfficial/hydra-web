import Decimal from "decimal.js";

/**
 * BankProvider: the one seam between Hydra and a bank feed (DESIGN.md section 5). Plaid is the only
 * adapter today (./plaid.ts); SimpleFIN would be a second file. Everything here is provider-neutral
 * and in Hydra's conventions: integer cents, money in positive / money out negative, ISO dates.
 */

/** Dollars (number or decimal string) to integer cents, exact, half up. Never `-0`. */
export function toCents(value: number | string): number {
  return new Decimal(value).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber() || 0;
}

export type AccountKind = "cash" | "card" | "loan" | "asset";
export type ItemStatus = "active" | "login_required" | "pending_expiration" | "revoked" | "error";

export interface ProviderAccount {
  providerAccountId: string;
  name: string;
  mask: string | null;
  kind: AccountKind;
  /** For card and loan accounts: the amount owed, positive. */
  currentCents: number | null;
  availableCents: number | null;
  limitCents: number | null;
}

export interface ProviderTransaction {
  providerAccountId: string;
  providerTransactionId: string;
  pending: boolean;
  /** On a posted row: the id of the pending row it replaces. */
  pendingTransactionId: string | null;
  postedOn: string;
  authorizedOn: string | null;
  /** Money into the account positive, money out negative. */
  amountCents: number;
  name: string;
  merchant: string | null;
  rawDescription: string | null;
}

export interface SyncPage {
  accounts: ProviderAccount[];
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: { providerTransactionId: string }[];
  nextCursor: string;
  hasMore: boolean;
}

export interface CardStatement {
  providerAccountId: string;
  statementBalanceCents: number | null;
  dueOn: string | null;
}

export interface LinkedItem {
  accessToken: string;
  providerItemId: string;
  institutionId: string | null;
  institutionName: string | null;
}

export type WebhookEvent =
  | { kind: "sync"; providerItemId: string }
  | { kind: "status"; providerItemId: string; status: ItemStatus; errorCode: string | null }
  | { kind: "ignored"; providerItemId: string | null; code: string };

export interface BankProvider {
  readonly name: "plaid";
  /** New link; with `accessToken`, a link token for update mode (repair the same item, no new slot). */
  createLinkToken(input: { userId: string; webhookUrl?: string; accessToken?: string }): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<LinkedItem>;
  /** One page. `cursor` null or "" = from the start. */
  syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage>;
  getBalances(accessToken: string): Promise<ProviderAccount[]>;
  /** Card statement balance and due date. [] when the institution has no liabilities data. */
  getCardStatements(accessToken: string): Promise<CardStatement[]>;
  /** Throws WebhookVerifyError unless the body is signed by the provider and fresh. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookEvent>;
  removeItem(accessToken: string): Promise<void>;
}

/** A provider API error, by code only (never a token or a full body). */
export class BankProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Bank provider error ${code}`);
    this.name = "BankProviderError";
  }
}

export class WebhookVerifyError extends Error {
  constructor(reason: string) {
    super(`Webhook rejected: ${reason}`);
    this.name = "WebhookVerifyError";
  }
}

/** The owner must sign in again through update mode. */
export const ITEM_LOGIN_REQUIRED = "ITEM_LOGIN_REQUIRED";
export const MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
