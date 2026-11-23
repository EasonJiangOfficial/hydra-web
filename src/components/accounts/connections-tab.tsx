"use client";

import { useState } from "react";

import { Button, Card, InfoDot, Input, Label, ListRow, Pill, Seg } from "@/components/kit";

import { ConnectorsCard } from "./connectors-card";
import { HEALTH_LABEL, ago, itemHealth, parseIdleMinutes } from "./format";
import { useAccounts } from "./store";
import type { BankItemView } from "./types";

function ItemRow({ item }: { item: BankItemView }) {
  const { data, actions, plaid, say } = useAccounts();
  const [syncing, setSyncing] = useState(false);
  const health = itemHealth(item);
  const count = data.accounts.filter((a) => a.bank_item_id === item.id).length;
  const broken = health === "reconnect" || health === "error";
  return (
    <ListRow data-item-id={item.id} className="gap-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.institution_name ?? "Bank login"}</span>
        <span className="block text-tag text-ink-3">
          {count} account{count === 1 ? "" : "s"}
          {item.last_synced_at ? ` · synced ${ago(item.last_synced_at, data.now)}` : " · never synced"}
        </span>
        {item.last_error && broken && (
          <span role="alert" className="mt-1 block text-tag text-ink">
            Error: {item.last_error}
          </span>
        )}
      </span>
      <Pill tone={health === "healthy" ? "default" : "strong"}>{health === "reconnect" ? "Login needed" : HEALTH_LABEL[health]}</Pill>
      {broken && (
        <Button disabled={plaid.busy} onClick={() => plaid.start(item.id)}>
          Reconnect
        </Button>
      )}
      {health === "healthy" && (
        <Button
          variant="ghost"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            const r = await actions.syncBankItem({ itemId: item.id });
            setSyncing(false);
            say(r.ok ? `Synced ${item.institution_name ?? "the bank login"}.` : r.error.message);
          }}
        >
          Sync now
        </Button>
      )}
    </ListRow>
  );
}

function BankFeed() {
  const { data, plaid } = useAccounts();
  const live = data.items.filter((i) => i.status !== "revoked");
  const needs = live.filter((i) => ["reconnect", "error"].includes(itemHealth(i))).length;
  return (
    <Card aria-label="Bank feed" className="md:col-span-2">
      <div className="flex items-center gap-2">
        <Label>Bank feed</Label>
        <InfoDot label="About the bank feed">
          Plaid. Hydra reads balances and transactions only; it cannot move money. Each login syncs daily. A repair opens the bank login again and does not use a new login slot.
        </InfoDot>
        <div className="flex-1" />
        <Pill tone={needs ? "strong" : "default"}>
          {needs ? `${needs} need${needs === 1 ? "s" : ""} reconnect` : live.length ? "Connected" : data.plaidConfigured ? "No logins" : "Not set up"}
        </Pill>
      </div>
      {live.length ? (
        <div>
          {live.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </div>
      ) : (
        <p className="text-ink-3">No bank logins yet.</p>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={!data.plaidConfigured || plaid.busy} onClick={() => plaid.start()}>
          Connect a bank
        </Button>
        {!data.plaidConfigured && (
          <InfoDot label="Why Plaid is off">Plaid is not set up yet. Add PLAID_CLIENT_ID, PLAID_SECRET and HYDRA_TOKEN_KEY on the host.</InfoDot>
        )}
      </div>
    </Card>
  );
}

function Backups() {
  return (
    <Card aria-label="Backups" className="md:self-start">
      <div className="flex items-center gap-2">
        <Label>Backups</Label>
        <InfoDot label="About backups">Nightly at 09:17 UTC. Each copy of the database is encrypted, and the last 30 are kept.</InfoDot>
        <div className="flex-1" />
        <Pill>Nightly</Pill>
      </div>
    </Card>
  );
}

/** The idle lock (Settings > General). Reads and writes through the Accounts store. */
export function IdleLock() {
  const { data, actions } = useAccounts();
  const saved = data.idleLockMinutes;
  const [on, setOn] = useState(saved !== null);
  const [text, setText] = useState(String(saved ?? 5));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  async function save(minutes: number | null) {
    setState("saving");
    setError("");
    const r = await actions.setIdleLock({ minutes });
    setState(r.ok ? "saved" : "error");
    if (!r.ok) setError(r.error.message);
  }

  return (
    <Card aria-label="Security">
      <div className="flex items-center gap-2">
        <Label>Security</Label>
        <InfoDot label="About the idle lock">
          Hydra stays signed in until you sign out. The idle lock signs you out after the minutes you pick with no activity. It is off by default. One user only.
        </InfoDot>
        <div className="flex-1" />
        <Pill>{saved === null ? "Idle lock off" : `Locks after ${saved} min`}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-body">Idle lock</span>
        <Seg
          aria-label="Idle lock"
          value={on ? "on" : "off"}
          items={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
          onValueChange={(v) => {
            setOn(v === "on");
            if (v === "off") void save(null);
            else {
              const m = parseIdleMinutes(text);
              void save(typeof m === "number" ? m : 5);
              if (typeof m !== "number") setText("5");
            }
          }}
        />
        {on && (
          <label className="flex items-center gap-2 text-label text-ink-3">
            <Input
              type="text"
              inputMode="numeric"
              aria-label="Idle lock minutes"
              value={text}
              className="w-16 text-center tabular-nums"
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                const m = parseIdleMinutes(text);
                if (typeof m !== "number") {
                  setError("Enter a whole number from 1 to 60.");
                  setState("error");
                  setText(String(saved ?? 5));
                  return;
                }
                if (m !== saved) void save(m);
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            minutes
          </label>
        )}
        <span role="status" aria-live="polite" data-save-state={state} className="ml-auto min-w-14 text-right text-tag text-ink-3">
          {state === "saving" ? "Saving" : state === "saved" ? "Saved" : state === "error" ? "Not saved" : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
    </Card>
  );
}

/** Settings > Connections: bank feed, backups, and the connectors (Google, Grokbot keys, devices, notifications). */
export function ConnectionsTab() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-5">
      <BankFeed />
      <Backups />
      <ConnectorsCard />
    </div>
  );
}
