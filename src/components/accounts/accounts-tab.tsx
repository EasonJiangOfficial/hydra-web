"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Bar, Card, InfoDot, Label, ListRow, Money, Pill, cn, drawerHref, formatMoney } from "@/components/kit";

import { HEALTH_LABEL, accountLabel, ago, balanceCents, initials, itemHealth, shortDate, total, usedPercent } from "./format";
import { useAccounts } from "./store";
import { PLAID_LOGIN_LIMIT, type AccountWithBalance } from "./types";

function sublineOf(a: AccountWithBalance, syncedAgo: string | null): string {
  const parts: string[] = [];
  if (a.kind === "card" && a.statement_balance_effective_cents != null) {
    parts.push(`Statement ${formatMoney(a.statement_balance_effective_cents)}${a.statement_due_effective_on ? ` · due ${shortDate(a.statement_due_effective_on)}` : ""}`);
  } else if (a.is_manual) {
    parts.push(a.balance ? `You typed this value · updated ${shortDate(a.balance.as_of)}` : "You typed this value");
  } else if (syncedAgo) parts.push(`Synced ${syncedAgo}`);
  if (!a.in_net_worth) parts.push("Not in net worth");
  return parts.join(" · ");
}

function AccountRow({ account }: { account: AccountWithBalance }) {
  const { data } = useAccounts();
  const pathname = usePathname();
  const search = useSearchParams();
  const item = data.items.find((i) => i.id === account.bank_item_id);
  const health = itemHealth(item);
  const used = usedPercent(account);
  const cents = balanceCents(account);
  return (
    <ListRow
      as={Link}
      href={drawerHref(pathname, search, "account", account.id)}
      scroll={false}
      prefetch={false}
      data-account-id={account.id}
      className="gap-3 px-0"
    >
      <span aria-hidden className="grid size-8 flex-none place-items-center rounded-md border border-rule text-tag font-medium text-ink-3">
        {initials(account.nickname || account.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{accountLabel(account)}</span>
        <span className="block truncate text-tag text-ink-3">{sublineOf(account, item?.last_synced_at ? ago(item.last_synced_at, data.now) : null)}</span>
      </span>
      {used != null && (
        <>
          <Bar value={used / 100} className="hidden w-[120px] md:block" aria-label={`${used}% of the limit used`} />
          <span className="hidden w-16 text-tag text-ink-3 tabular-nums md:block">{used}% used</span>
        </>
      )}
      {health !== "manual" && (
        <Pill tone={health === "healthy" ? "default" : "strong"} className={health === "healthy" ? "max-md:hidden" : undefined}>
          {HEALTH_LABEL[health]}
        </Pill>
      )}
      <span className="text-right tabular-nums md:w-[100px]">{cents == null ? <span className="text-ink-3">No balance</span> : <Money cents={cents} />}</span>
    </ListRow>
  );
}

function Group({ label, accounts, owed }: { label: string; accounts: AccountWithBalance[]; owed?: boolean }) {
  const sum = total(accounts);
  return (
    <Card aria-label={label} data-group={label}>
      <div className="flex items-baseline gap-3">
        <Label>{label}</Label>
        <div className="flex-1" />
        <span className="text-figure-s tabular-nums">
          <Money cents={owed ? -sum : sum} />
        </span>
      </div>
      <div>
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} />
        ))}
      </div>
    </Card>
  );
}

/** The three ways to add an account. Plaid Link shows its state instead of failing when the keys are not set. */
export function AddOptions({ onPicked }: { onPicked?: () => void }) {
  const { data, plaid, openAdd } = useAccounts();
  const configured = data.plaidConfigured;
  const option = "w-full gap-1 p-3.5";
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Card
          as="button"
          type="button"
          disabled={!configured || plaid.busy}
          onClick={() => {
            onPicked?.();
            plaid.start();
          }}
          className={cn(option, "disabled:cursor-not-allowed disabled:hover:bg-tint")}
        >
          <span className="pr-8 font-medium">Connect a bank or card</span>
          {configured ? (
            <Pill className="self-start">
              {data.plaidLoginsUsed} of {PLAID_LOGIN_LIMIT} logins used
            </Pill>
          ) : (
            <Pill className="self-start">Not set up</Pill>
          )}
        </Card>
        <InfoDot className="absolute top-3.5 right-3.5" label="About connecting a bank">
          {configured
            ? `Secure bank login through Plaid. Balances and transactions update daily. Plaid Trial allows ${PLAID_LOGIN_LIMIT} logins for life; a repair uses Reconnect, not a new login.`
            : "Plaid is not set up yet. Add PLAID_CLIENT_ID, PLAID_SECRET and HYDRA_TOKEN_KEY on the host and this button starts the bank login. Until then, import a file or add an account by hand."}
        </InfoDot>
      </div>
      <div className="relative">
        <Card as="button" type="button" onClick={() => (onPicked?.(), openAdd("import"))} className={option}>
          <span className="pr-8 font-medium">Import a file</span>
        </Card>
        <InfoDot className="absolute top-3.5 right-3.5" label="About importing a file">
          CSV, OFX or QFX from your bank. Hydra shows a preview first and skips rows it already has.
        </InfoDot>
      </div>
      <div className="relative">
        <Card as="button" type="button" onClick={() => (onPicked?.(), openAdd("manual"))} className={option}>
          <span className="pr-8 font-medium">Add a manual account</span>
        </Card>
        <InfoDot className="absolute top-3.5 right-3.5" label="About manual accounts">
          Cash, a car, money someone owes you. You type the value and update it yourself.
        </InfoDot>
      </div>
    </div>
  );
}

function AddCard() {
  return (
    <Card aria-label="Add an account" className="md:col-span-4 md:self-start">
      <div className="flex items-center gap-2">
        <Label>Add an account</Label>
        <InfoDot label="About bank access">
          Hydra never sees your bank password. The bank login token is stored encrypted. Hydra can read balances and transactions only. It cannot move money.
        </InfoDot>
      </div>
      <AddOptions />
    </Card>
  );
}

export function AccountsTab() {
  const { data, openAdd } = useAccounts();
  const of = (kind: AccountWithBalance["kind"]) => data.accounts.filter((a) => a.kind === kind);
  const groups = [
    { label: "Cash", accounts: of("cash") },
    { label: "Credit cards", accounts: of("card"), owed: true },
    { label: "Loans", accounts: of("loan"), owed: true },
    { label: "Manual assets", accounts: of("asset") },
  ].filter((g) => g.accounts.length);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:gap-5">
      <div className="flex flex-col gap-3 md:col-span-8 md:gap-4">
        {groups.length ? (
          groups.map((g) => <Group key={g.label} {...g} />)
        ) : (
          <Card>
            <span className="font-medium">No accounts yet</span>
            <button type="button" onClick={() => openAdd("choose")} className="self-start text-label text-ink-3 underline underline-offset-2 hover:text-ink">
              Add the first one
            </button>
          </Card>
        )}
      </div>
      <AddCard />
    </div>
  );
}
