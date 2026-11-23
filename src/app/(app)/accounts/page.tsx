import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/shell/page-header";
import { AccountsLoading } from "@/components/shell/skeletons";

import { loadAccountsData } from "./data";
import { AccountsLive } from "./live";

export const metadata = { title: "Accounts" };

async function AccountsBody() {
  // Dynamic before anything reads the environment, so a build with no Supabase env still prerenders the shell.
  await connection();
  const data = await loadAccountsData();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Accounts" />
      <AccountsLive data={data} />
    </div>
  );
}

/**
 * Accounts and Recurring. `?tab=connections` (now on Settings) is redirected by the proxy (lib/auth/gate movedPath).
 * The route skeleton is the fallback, so a click shows it at full strength and the page simply takes its place.
 */
export default function AccountsPage() {
  return (
    <Suspense fallback={<AccountsLoading />}>
      <AccountsBody />
    </Suspense>
  );
}
