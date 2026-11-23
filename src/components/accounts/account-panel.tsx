"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { Button, DetailDrawer, Input, Label, Pill, Skeleton, TrendLine, setDrawerUrl, type TrendPoint } from "@/components/kit";
import { FieldRow, SaveLabel, useAutosave } from "@/components/planning/controls";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { formatDay } from "@/lib/planning/dates";
import { ESTIMATED } from "@/lib/reports/estimated";

import { HEALTH_LABEL, KIND_LABEL, accountLabel, accountTitle, centsToDollars, dollarsToCents, itemHealth } from "./format";
import { Switch, useSynced } from "./switch";
import { useAccounts } from "./store";
import { ACCOUNT_KINDS, type AccountWithBalance } from "./types";

/** The shared slide-out for `?account=`: nickname, type, business, net worth, statement overrides, reconnect, history, close. */
export function AccountPanel() {
  return (
    <DetailDrawer param="account" label="Account">
      {(id) => <PanelBody id={id} />}
    </DetailDrawer>
  );
}

function History({ account }: { account: AccountWithBalance }) {
  const { data, actions } = useAccounts();
  const { today } = data;
  const [points, setPoints] = useState<TrendPoint[] | null>(null);
  const current = account.balance?.current_cents;
  useEffect(() => {
    let live = true;
    void actions.balanceHistory({ accountId: account.id }).then((r) => {
      if (live) setPoints(r.ok ? r.data.map((b) => ({ label: formatDay(b.as_of, today), value: b.current_cents ?? 0, note: b.estimated ? ESTIMATED : undefined })) : []);
    });
    return () => {
      live = false;
    };
  }, [actions, account.id, current, today]);

  return (
    <section aria-label="Balance history" className="flex flex-col gap-2">
      <Label>Balance history</Label>
      {points === null ? (
        <Skeleton className="h-[130px] w-full" />
      ) : points.length < 2 ? (
        <p className="text-label text-ink-3">History fills in as the days pass.</p>
      ) : (
        <TrendLine data={points} label={`Balance history of ${accountTitle(account)}`} />
      )}
    </section>
  );
}

function PanelBody({ id }: { id: string }) {
  const { data } = useAccounts();
  const account = data.accounts.find((a) => a.id === id);
  if (!account) return <p className="text-ink-3">This account is closed or gone.</p>;
  return <Panel account={account} />;
}

function Panel({ account }: { account: AccountWithBalance }) {
  const { data, actions, plaid } = useAccounts();
  const uid = useId();
  const pathname = usePathname();
  const search = useSearchParams();
  const item = data.items.find((i) => i.id === account.bank_item_id);
  const health = itemHealth(item);
  const owed = account.kind === "card" || account.kind === "loan";

  const [error, setError] = useState("");
  const [sure, setSure] = useState(false);
  const [entity, setEntity] = useSynced(account.entity_id);
  const [kind, setKind] = useSynced(account.kind);
  const [inNet, setInNet] = useSynced(account.in_net_worth);
  const [due, setDue] = useSynced(account.statement_due_effective_on ?? "");
  const [statement, setStatement] = useSynced(account.statement_balance_effective_cents == null ? "" : centsToDollars(account.statement_balance_effective_cents));
  const [balance, setBalance] = useSynced(account.balance?.current_cents == null ? "" : centsToDollars(account.balance.current_cents));

  /** Run an edit; on a refusal, say why and let the caller put the field back. */
  async function edit(patch: Omit<Parameters<typeof actions.editAccount>[0], "accountId">): Promise<boolean> {
    const r = await actions.editAccount({ accountId: account.id, ...patch });
    setError(r.ok ? "" : r.error.message);
    return r.ok;
  }

  const nickname = useAutosave(account.nickname ?? "", (next) => edit({ nickname: next }));

  async function saveMoney(text: string, current: number | null | undefined, patch: (cents: number) => Parameters<typeof edit>[0], revert: () => void) {
    const cents = dollarsToCents(text);
    if (cents === null) {
      setError("Type the amount as dollars, like 1,250.00.");
      return revert();
    }
    if (cents === current) return setError("");
    if (!(await edit(patch(cents)))) revert();
  }

  function closeDrawer() {
    const next = new URLSearchParams(search.toString());
    next.delete("account");
    const qs = next.toString();
    setDrawerUrl(qs ? `${pathname}?${qs}` : pathname);
  }

  async function close() {
    const r = await actions.closeAccount({ accountId: account.id });
    if (!r.ok) return setError(r.error.message);
    closeDrawer();
  }

  return (
    <div className="flex flex-col gap-5" data-testid="account-panel">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Nickname"
            value={nickname.draft}
            placeholder={account.name}
            maxLength={100}
            className="h-10 flex-1 border-transparent px-2 text-section hover:border-rule-2"
            onChange={(e) => nickname.edit(e.target.value)}
            onBlur={() => void nickname.flush()}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <SaveLabel state={nickname.state} />
        </div>
        <p className="px-2 text-label text-ink-3">
          {accountLabel({ ...account, nickname: null })}
          {account.institution ? ` · ${account.institution}` : ""}
        </p>
      </div>

      <div>
        <FieldRow label="Type" htmlFor={`${uid}-kind`}>
          {account.is_manual ? (
            <Select
              id={`${uid}-kind`}
              className="flex-1"
              value={kind}
              onChange={async (e) => {
                const next = e.target.value as typeof kind;
                const before = kind;
                setKind(next);
                if (!(await edit({ kind: next }))) setKind(before);
              }}
            >
              {ACCOUNT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          ) : (
            <>
              <span>{KIND_LABEL[account.kind]}</span>
              <Pill>Linked through Plaid</Pill>
            </>
          )}
        </FieldRow>
        <FieldRow label="Business" htmlFor={`${uid}-entity`}>
          <Select
            id={`${uid}-entity`}
            className="flex-1"
            value={entity}
            onChange={async (e) => {
              const before = entity;
              setEntity(e.target.value);
              if (!(await edit({ entityId: e.target.value }))) setEntity(before);
            }}
          >
            {data.entities.filter((e) => !e.closed || e.id === entity).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="In net worth">
          <Switch
            label="Count this account in net worth"
            checked={inNet}
            onChange={async (next) => {
              setInNet(next);
              if (!(await edit({ inNetWorth: next }))) setInNet(!next);
            }}
          />
        </FieldRow>
        {account.is_manual && (
          <FieldRow label={owed ? "Amount owed" : kind === "asset" ? "Value" : "Balance"} htmlFor={`${uid}-balance`}>
            <Input
              id={`${uid}-balance`}
              inputMode="decimal"
              value={balance}
              placeholder="0.00"
              onChange={(e) => setBalance(e.target.value)}
              onBlur={() =>
                void saveMoney(balance, account.balance?.current_cents, (balanceCents) => ({ balanceCents }), () => setBalance(account.balance?.current_cents == null ? "" : centsToDollars(account.balance.current_cents)))
              }
            />
          </FieldRow>
        )}
        {account.kind === "card" && (
          <>
            <FieldRow label="Statement balance" htmlFor={`${uid}-statement`}>
              <Input
                id={`${uid}-statement`}
                inputMode="decimal"
                value={statement}
                placeholder={account.statement_balance_cents == null ? "From the bank" : centsToDollars(account.statement_balance_cents)}
                onChange={(e) => setStatement(e.target.value)}
                onBlur={() => {
                  if (statement.trim() === "") return;
                  void saveMoney(
                    statement,
                    account.statement_balance_effective_cents,
                    (statementBalanceOverrideCents) => ({ statementBalanceOverrideCents }),
                    () => setStatement(account.statement_balance_effective_cents == null ? "" : centsToDollars(account.statement_balance_effective_cents)),
                  );
                }}
              />
              {account.statement_balance_override_cents != null && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await edit({ statementBalanceOverrideCents: null })) setStatement(account.statement_balance_cents == null ? "" : centsToDollars(account.statement_balance_cents));
                  }}
                >
                  Use bank
                </Button>
              )}
            </FieldRow>
            <FieldRow label="Due date" htmlFor={`${uid}-due`}>
              <DatePicker
                id={`${uid}-due`}
                value={due}
                onChange={async (e) => {
                  const before = due;
                  setDue(e.target.value);
                  if (e.target.value && !(await edit({ statementDueOnOverride: e.target.value }))) setDue(before);
                }}
              />
              {account.statement_due_on_override != null && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await edit({ statementDueOnOverride: null })) setDue(account.statement_due_on ?? "");
                  }}
                >
                  Use bank
                </Button>
              )}
            </FieldRow>
          </>
        )}
        {item && (
          <FieldRow label="Bank login">
            <span className="min-w-0 flex-1">
              {HEALTH_LABEL[health]}
              {item.last_error && health !== "healthy" ? <span className="block text-tag text-ink-3">{item.last_error}</span> : null}
            </span>
            {(health === "reconnect" || health === "error") && (
              <Button disabled={plaid.busy} onClick={() => plaid.start(item.id)}>
                Reconnect
              </Button>
            )}
          </FieldRow>
        )}
      </div>

      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}

      <History account={account} />

      <div className="mt-auto border-t border-rule pt-4">
        {sure ? (
          <div role="alertdialog" aria-label="Close this account" className="flex flex-col gap-3">
            <p>Close {accountTitle(account)}? It leaves your lists. Its history stays.</p>
            <div className="flex gap-2">
              <Button onClick={() => void close()}>
                Close account
              </Button>
              <Button onClick={() => setSure(false)}>Keep it</Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setSure(true)}>Close account</Button>
        )}
      </div>
    </div>
  );
}
