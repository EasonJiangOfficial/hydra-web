import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/shell/page-header";
import { TransactionsLoading } from "@/components/shell/skeletons";
import type { DealOption, EntityOption } from "@/components/transactions/types";
import { listAccounts } from "@/lib/bank/queries";
import { ownerToday } from "@/lib/rules/engine";
import { listCategories, listCategoryTaxLines, listRecurring, listRules, listTaxLines, reviewQueue } from "@/lib/rules/queries";
import { createServerClient } from "@/lib/supabase/server";

import { TransactionsLive } from "./live";

export const metadata = { title: "Transactions" };

/** The route skeleton is the fallback, so a click shows it at full strength and the page simply takes its place. */
export default function TransactionsPage() {
  return (
    <Suspense fallback={<TransactionsLoading />}>
      <TransactionsData />
    </Suspense>
  );
}

/** Loads what the pickers and hover cards need (small); the rows themselves load as the table scrolls. */
async function TransactionsData() {
  await connection(); // the owner's data: never prerendered at build time
  const db = await createServerClient();
  const [accounts, entities, categories, taxLines, categoryTaxLines, recurring, rules, deals, review, today] = await Promise.all([
    listAccounts(db, { includeClosed: true }),
    db.from("entities").select("id, slug, name, kind, status").order("created_at"),
    listCategories(db, { includeArchived: true }),
    listTaxLines(db),
    listCategoryTaxLines(db),
    listRecurring(db),
    listRules(db),
    // `*`: a database from before 0140 has no personal_brand column.
    db.from("deals").select("*").order("brand_name"),
    reviewQueue(db, { pageSize: 1 }),
    ownerToday(db),
  ]);
  if (entities.error) throw new Error(`entities: ${entities.error.message}`);
  if (deals.error) throw new Error(`deals: ${deals.error.message}`);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Transactions" />
      <TransactionsLive
        lookups={{
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, nickname: a.nickname, mask: a.mask, institution: a.institution, entity_id: a.entity_id })),
          entities: (entities.data ?? []) as EntityOption[],
          categories,
          taxLines,
          categoryTaxLines,
          recurring,
          deals: ((deals.data ?? []) as { id: string; brand_name: string; personal_brand?: boolean | null }[]).map(
            (d): DealOption => ({ id: d.id, name: d.brand_name, personal: d.personal_brand === true }),
          ),
        }}
        rules={rules}
        reviewCount={review.total}
        today={today}
      />
    </div>
  );
}
