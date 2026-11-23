"use client";

import { TransactionsWorkspace, type TransactionsWorkspaceProps } from "@/components/transactions/workspace";
import type { TxApi } from "@/components/transactions/types";
import { deleteManualTransaction, editTransaction } from "@/lib/bank/actions";
import {
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
import { matchPayment, unmatchPayment } from "@/lib/ugc/actions";

import { dealPayment, getRow, listRows, pairCandidates, reviewCount, transferSuggestions } from "./reads";

/** The live page's api: the money engines' own server actions, plus the reads in ./reads. */
const api: TxApi = {
  listRows,
  getRow,
  reviewCount,
  pairCandidates,
  dealPayment,
  transferSuggestions,
  setCategory: setTransactionCategory,
  editTransaction,
  deleteManualTransaction,
  mapCategoryTaxLine,
  updateCategory,
  pairTransfers,
  rejectTransfer: rejectTransferSuggestion,
  unpairTransfer,
  confirmRecurring,
  dismissRecurring,
  matchPayment,
  unmatchPayment,
  previewRule,
  createRule,
  updateRule,
  deleteRule,
  reorderRules,
  applyRules,
};

export function TransactionsLive(props: Omit<TransactionsWorkspaceProps, "api">) {
  return <TransactionsWorkspace api={api} {...props} />;
}
