/**
 * UGC Tracker data shapes. `UgcRaw` is exactly what the page loads (server) or the fixture holds
 * (memory): plain rows, nothing computed. The model (model.ts) turns it into money with the ledger.
 */
import type * as A from "@/lib/ugc/actions";
import type { PostRow } from "@/lib/ugc/ledger";
import type { ActionResult, DealDbRow, Platform } from "@/lib/ugc/schemas";
import type { ViewGapDay } from "@/lib/ugc/view-gaps";

export interface AccountRaw {
  id: string;
  deal_id: string;
  platform: Platform;
  handle: string;
}

/** A `public.posts` row: the ledger columns (rate snapshot included) plus what the tables show. */
export type PostRaw = Omit<PostRow, "payable_views"> & {
  account_id: string | null;
  url: string;
  platform: Platform;
  title: string | null;
  /** The owner linked or unlinked this post by hand; the matcher leaves it alone. */
  video_group_manual?: boolean;
};

/** One row of the `ugc_post_views` view. */
export interface PostViewRaw {
  post_id: string;
  payable_views: number | null;
  latest_views: number | null;
  last_captured_at: string | null;
  last_captured_day: string | null;
  latest_held: boolean;
}

/** A view reading (the recent ones: the sparkline needs the last weeks, not all history). */
export interface SnapshotRaw {
  post_id: string;
  captured_day: string;
  captured_at: string;
  views: number;
  held: boolean;
}

export interface PaymentRaw {
  id: string;
  deal_id: string;
  transaction_id: string;
  amount_cents: number;
  paid_on: string;
  /** The bank transaction's name, when the bank layer has it. */
  name: string | null;
}

export interface DayTargetRaw {
  deal_id: string;
  day: string;
  target: number;
}

/** A bank deposit not yet matched to a deal (candidates for payment matching). */
export interface DepositRaw {
  id: string;
  name: string;
  amount_cents: number;
  posted_on: string;
}

/** A "Not this" answer to a suggested payout (public.payout_match_rejections). */
export interface PayoutRejectionRaw {
  deal_id: string;
  transaction_id: string;
}

/** A learned payout rule (public.payout_rules). */
export interface PayoutRuleRaw {
  deal_id: string;
  payer_key: string;
  day_of_month: number | null;
  day_window: number;
  decision: "accepted" | "declined";
}

/** `deal_templates`: Ripple's master deals, the "already created" ones Add existing starts from. */
export type TemplateRaw = Omit<DealDbRow, "entity_id" | "status" | "start_date" | "end_date"> & {
  archived: boolean;
};

export interface UgcRaw {
  /** The clock the page was built at. The fixture fixes it. */
  nowIso: string;
  zone: string;
  deals: DealDbRow[];
  accounts: AccountRaw[];
  posts: PostRaw[];
  views: PostViewRaw[];
  snapshots: SnapshotRaw[];
  payments: PaymentRaw[];
  dayTargets: DayTargetRaw[];
  templates: TemplateRaw[];
  deposits: DepositRaw[];
  payoutRejections: PayoutRejectionRaw[];
  payoutRules: PayoutRuleRaw[];
  /** Storage object path -> signed URL (bucket `deal-logos`, private). */
  logos: Record<string, string>;
  /** Days of the last week with open posts left unread (public.ugc_missed_view_days). */
  missedViewDays: ViewGapDay[];
}

/** What the pages call: the functions of `src/lib/ugc/actions.ts`, plus the logo upload (owner session to Storage). */
export type UgcActions = UploadLogo &
  Pick<
  typeof A,
  | "createDeal"
  | "updateDeal"
  | "pauseDeal"
  | "resumeDeal"
  | "endDeal"
  | "deleteDeal"
  | "addPost"
  | "editPost"
  | "excludePost"
  | "unexcludePost"
  | "deletePost"
  | "linkPosts"
  | "unlinkPost"
  | "setDayTarget"
  | "matchPayment"
  | "unmatchPayment"
  | "rejectPayoutMatch"
  | "decidePayoutRule"
  | "undoRejectPayoutMatch"
  | "removePayoutRule"
  | "setViews"
>;

/** Store a logo file in the private deal-logos bucket and set it on the deal. */
type UploadLogo = { uploadDealLogo: (input: { dealId: string; file: File }) => Promise<ActionResult<DealDbRow>> };
