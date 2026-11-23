import type { deleteManualTransaction, editTransaction } from "@/lib/bank/actions";
import type { TransactionRow } from "@/lib/bank/queries";
import type { Rule } from "@/lib/rules/model";
import type {
  applyRules,
  confirmRecurring,
  createRule,
  deleteRule,
  dismissRecurring,
  mapCategoryTaxLine,
  pairTransfers,
  previewRule,
  rejectTransferSuggestion,
  reorderRules,
  setTransactionCategory,
  unpairTransfer,
  updateCategory,
  updateRule,
} from "@/lib/rules/actions";
import type { CategoryRow, RecurringSeriesRow, TaxLineRow } from "@/lib/rules/queries";
import type { matchPayment, unmatchPayment } from "@/lib/ugc/actions";

/** One transaction row, with the database's column names (see src/lib/bank/queries.ts). */
export type TxRow = Pick<
  TransactionRow,
  | "id"
  | "account_id"
  | "pending"
  | "posted_on"
  | "amount_cents"
  | "name"
  | "renamed"
  | "merchant"
  | "raw_description"
  | "note"
  | "entity_id"
  | "category_id"
  | "category_source"
  | "tax_line_id"
  | "is_transfer"
  | "transfer_pair_id"
  | "hidden"
  | "recurring_id"
  | "source"
>;

export const TX_COLUMNS =
  "id, account_id, pending, posted_on, amount_cents, name, renamed, merchant, raw_description, note, entity_id, " +
  "category_id, category_source, tax_line_id, is_transfer, transfer_pair_id, hidden, recurring_id, source";

/** A possible transfer between two cash accounts: the outflow and the inflow. */
export interface TransferSuggestion {
  out: TxRow;
  into: TxRow;
}

export type StoredRule = Rule & { created_at: string; updated_at: string };

export interface AccountOption {
  id: string;
  name: string;
  nickname: string | null;
  mask: string | null;
  institution: string | null;
  entity_id: string;
}

export interface EntityOption {
  id: string;
  slug: string;
  name: string;
  kind: "personal" | "business";
  /** A closed business stays on old rows but leaves the pickers. */
  status?: "active" | "closed";
}

export interface DealOption {
  id: string;
  name: string;
  /** The Personal Brand deal (0140): named on a linked deposit, never offered in the picker. */
  personal?: boolean;
}

/** What the pickers and the hover cards need. Small: loaded once with the page. */
export interface Lookups {
  accounts: AccountOption[];
  entities: EntityOption[];
  categories: CategoryRow[];
  taxLines: TaxLineRow[];
  categoryTaxLines: { category_id: string; entity_id: string; tax_line_id: string }[];
  recurring: RecurringSeriesRow[];
  deals: DealOption[];
}

export interface RowFilters {
  q?: string;
  accountId?: string;
  entityId?: string;
  /** A category and its subcategories. */
  categoryIds?: string[];
  /** Inclusive YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Needs review: no category, not a transfer, not hidden. */
  review?: boolean;
  /** Only rows hidden from reports (the way back for "Hide from reports"). */
  hidden?: boolean;
}

export const PAGE_SIZE = 200;

/**
 * Everything the Transactions page does, as one object. The live page fills it with the money
 * engines' server actions (src/lib/rules/actions, src/lib/bank/actions, src/lib/ugc/actions) and a
 * few reads; the /dev/transactions fixture fills it from memory. Writes are the engines' own.
 */
export interface TxApi {
  /** `PAGE_SIZE` rows from `offset`, newest first. */
  listRows(filters: RowFilters, offset: number): Promise<{ rows: TxRow[]; total: number }>;
  getRow(id: string): Promise<TxRow | null>;
  reviewCount(entityId?: string): Promise<number>;
  /** Rows this one could be paired with as a transfer or card payment. */
  pairCandidates(id: string): Promise<TxRow[]>;
  /** The deal a deposit is matched to, or null. */
  dealPayment(id: string): Promise<{ deal_id: string } | null>;
  /** Possible transfers between cash accounts, waiting for the owner. */
  transferSuggestions(): Promise<TransferSuggestion[]>;

  setCategory: typeof setTransactionCategory;
  editTransaction: typeof editTransaction;
  deleteManualTransaction: typeof deleteManualTransaction;
  mapCategoryTaxLine: typeof mapCategoryTaxLine;
  /** Recolor a category from the panel's color picker. */
  updateCategory: typeof updateCategory;
  pairTransfers: typeof pairTransfers;
  rejectTransfer: typeof rejectTransferSuggestion;
  unpairTransfer: typeof unpairTransfer;
  confirmRecurring: typeof confirmRecurring;
  dismissRecurring: typeof dismissRecurring;
  matchPayment: typeof matchPayment;
  unmatchPayment: typeof unmatchPayment;

  previewRule: typeof previewRule;
  createRule: typeof createRule;
  updateRule: typeof updateRule;
  deleteRule: typeof deleteRule;
  reorderRules: typeof reorderRules;
  applyRules: typeof applyRules;
}
