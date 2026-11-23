import type { ActionResult as BankResult } from "@/lib/bank/actions";
import type { AccountWithBalance, BalanceRow } from "@/lib/bank/queries";
import type { InstagramView } from "@/lib/instagram/model";
import type { RecurringSeriesRow } from "@/lib/rules/queries";

export type { AccountWithBalance, BalanceRow, InstagramView, RecurringSeriesRow };
export type ActionResult<T> = BankResult<T>;

type Bank = typeof import("@/lib/bank/actions");
type Rules = typeof import("@/lib/rules/actions");

export type ItemStatus = "active" | "login_required" | "pending_expiration" | "revoked" | "error";

/** One bank login (a Plaid Item). Only the columns the owner may read: never the token. */
export interface BankItemView {
  id: string;
  institution_name: string | null;
  status: ItemStatus;
  last_synced_at: string | null;
  /** A provider error code, never a token or a body. */
  last_error: string | null;
}

export interface EntityView {
  id: string;
  name: string;
  slug: string;
  /** A closed entity (UGM LLC) is not offered for new accounts. */
  closed: boolean;
}

/** Google sign-in (Gmail and Calendar). `configured`: the OAuth client env is set, so Connect can start. */
export interface GoogleView {
  configured: boolean;
  email: string | null;
  /** google_accounts.status: active, or reauth_required when Google refused the refresh token. */
  status: string | null;
}

/** A Grokbot connector key (ugc:write). Never the secret or its hash. */
export interface ConnectorKeyView {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

/** A paired Hydra Desktop, Hydra server or Claude Code device. Never its key hash. */
export interface DeviceView {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  /** "mcp" only: Claude Code. Hydra Desktop and the server have "agent" too. */
  scopes: string[];
  /** "brain": Hydra's server (paired with a Server code); "mac": Hydra Desktop. Older rows may lack it. */
  role?: "mac" | "brain";
  /** The device's relay loop last ran (it takes Hydra Agent turns). */
  relay_seen_at?: string | null;
}

export interface AccountsData {
  /** The clock for "2 h ago" labels, as an ISO instant. Passed in so the server and the browser agree. */
  now: string;
  /** The owner's calendar day (settings.time_zone), YYYY-MM-DD: day math uses this, never the UTC date. */
  today: string;
  accounts: AccountWithBalance[];
  items: BankItemView[];
  recurring: RecurringSeriesRow[];
  entities: EntityView[];
  /** settings.idle_lock_minutes: null = off (the default), else 1 to 60. */
  idleLockMinutes: number | null;
  /** False while the Plaid keys are not set: the Link button then shows its state instead of failing. */
  plaidConfigured: boolean;
  /** Bank logins ever made (Plaid Trial has ten for life). */
  plaidLoginsUsed: number;
  google: GoogleView;
  /** The owner's Instagram for Personal Brand (never the token). */
  instagram: InstagramView;
  /** Active Grokbot keys (revoked ones are left out). */
  apiKeys: ConnectorKeyView[];
  /** Paired devices that are not revoked. */
  devices: DeviceView[];
  /** Phones and browsers with notifications on. */
  pushDevices: number;
}

/** Everything the page writes, typed like the U2 and U3 actions the Hydra Agent also calls. */
export type AccountsActions = Pick<
  Bank,
  "createLinkToken" | "startUpdateMode" | "exchangePublicToken" | "syncBankItem" | "importFile" | "addManualAccount" | "editAccount" | "closeAccount"
> &
  Pick<Rules, "confirmRecurring" | "dismissRecurring" | "detectRecurringNow"> & {
    /** null turns the idle lock off. */
    setIdleLock(input: { minutes: number | null }): Promise<ActionResult<{ minutes: number | null }>>;
    balanceHistory(input: { accountId: string }): Promise<ActionResult<BalanceRow[]>>;
    /** Connections. Connect Google is a link to /api/google/start, not an action. */
    disconnectGoogle(): Promise<ActionResult<null>>;
    /** Deletes the Instagram token. Connect is a link to /api/instagram/start. */
    disconnectInstagram(): Promise<ActionResult<null>>;
    /** The secret is in this reply only. */
    createApiKey(input: { name: string }): Promise<ActionResult<{ key: ConnectorKeyView; secret: string }>>;
    revokeApiKey(input: { id: string }): Promise<ActionResult<null>>;
    /** A one-time code (10 minutes) the Mac (or Claude Code, MCP only) trades for its key. */
    pairDevice(input?: { kind?: PairKind }): Promise<ActionResult<{ code: string; expiresAt: string }>>;
    revokeDevice(input: { id: string }): Promise<ActionResult<null>>;
  };

export type PairKind = "desktop" | "server" | "claude-code";

export const PLAID_LOGIN_LIMIT = 10;
export const ACCOUNT_KINDS = ["cash", "card", "loan", "asset"] as const;
