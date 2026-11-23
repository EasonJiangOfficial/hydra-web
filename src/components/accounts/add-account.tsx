"use client";

import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";

import { Button, Input, ListRow, Money, Pill } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FieldRow } from "@/components/planning/controls";
import { Select } from "@/components/ui/select";

import { AddOptions } from "./accounts-tab";
import { accountLabel, dollarsToCents, KIND_LABEL } from "./format";
import { Switch } from "./switch";
import { useAccounts, type AddStep } from "./store";
import { ACCOUNT_KINDS, type AccountWithBalance } from "./types";
import type { ImportSummary } from "@/lib/bank/actions";

const TITLES: Record<AddStep, string> = { choose: "Add an account", import: "Import a file", manual: "Add a manual account" };

export function AddAccountDialog() {
  const { add, openAdd, closeAdd } = useAccounts();
  return (
    <Dialog open={add !== null} onOpenChange={(o) => !o && closeAdd()}>
      <DialogContent aria-describedby={undefined} className="max-h-[88dvh] gap-5 overflow-y-auto p-6 text-body sm:max-w-lg" data-testid="add-account">
        {add && (
          <>
            <div className="flex items-center gap-2 pr-8">
              {add !== "choose" && (
                <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => openAdd("choose")}>
                  <ArrowLeft aria-hidden strokeWidth={1.5} />
                </Button>
              )}
              <DialogTitle className="text-section">{TITLES[add]}</DialogTitle>
            </div>
            <DialogDescription className="sr-only">Add an account to Hydra</DialogDescription>
            {add === "choose" && <AddOptions onPicked={() => undefined} />}
            {add === "import" && <ImportStep />}
            {add === "manual" && <ManualStep />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Import: pick a file, see a dry run, then commit.
// ---------------------------------------------------------------------------

type Format = "csv" | "ofx" | "qfx";
/** Under the 4 MB server-action body cap, with room for JSON escaping. */
const MAX_IMPORT_BYTES = 3_500_000;

function formatOf(name: string): Format | null {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "csv" || ext === "ofx" || ext === "qfx" ? ext : null;
}

type Summary = ImportSummary;

function ImportStep() {
  const { data, actions, say, closeAdd } = useAccounts();
  const targets = data.accounts.filter((a) => !a.closed_at);
  const uid = useId();
  const [accountId, setAccountId] = useState(targets[0]?.id ?? "");
  const [invertSign, setInvertSign] = useState(false);
  const [file, setFile] = useState<{ name: string; format: Format; content: string } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<number | null>(null);

  async function preview(next: { accountId: string; invertSign: boolean; file: NonNullable<typeof file> }) {
    setBusy(true);
    setError("");
    setSummary(null);
    try {
      const r = await actions.importFile({ accountId: next.accountId, format: next.file.format, content: next.file.content, dryRun: true, invertSign: next.invertSign });
      if (r.ok) setSummary(r.data);
      else setError(r.error.message);
    } catch {
      setError("Import failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    setDone(null);
    const format = formatOf(f.name);
    if (!format) return setError("Use a CSV, OFX or QFX file.");
    if (f.size > MAX_IMPORT_BYTES) return setError("File too big. Max 3.5 MB.");
    const next = { name: f.name, format, content: await f.text() };
    setFile(next);
    if (accountId) await preview({ accountId, invertSign, file: next });
    else setError("Add an account first, then import into it.");
  }

  async function commit() {
    if (!file || !accountId) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof actions.importFile>>;
    try {
      r = await actions.importFile({ accountId, format: file.format, content: file.content, dryRun: false, invertSign });
    } catch {
      return setError("Import failed. Try again.");
    } finally {
      setBusy(false);
    }
    if (!r.ok) return setError(r.error.message);
    setDone(r.data.inserted);
    setSummary(null);
    say(`Imported ${r.data.inserted} transaction${r.data.inserted === 1 ? "" : "s"}.`);
  }

  if (!targets.length) return <p className="text-ink-3">There is no account to import into yet. Add a manual account first.</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <FieldRow label="Into" htmlFor={`${uid}-account`}>
          <Select
            id={`${uid}-account`}
            className="flex-1"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              if (file) void preview({ accountId: e.target.value, invertSign, file });
            }}
          >
            {targets.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="File" htmlFor={`${uid}-file`}>
          <Input id={`${uid}-file`} type="file" accept=".csv,.ofx,.qfx" className="h-auto flex-1 py-1.5" onChange={(e) => void pick(e.target.files?.[0])} />
        </FieldRow>
        <FieldRow label="Purchases are positive">
          <Switch
            label="Purchases are positive in this file"
            checked={invertSign}
            onChange={(next) => {
              setInvertSign(next);
              if (file && accountId) void preview({ accountId, invertSign: next, file });
            }}
          />
        </FieldRow>
      </div>

      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
      {busy && !summary && <p className="text-label text-ink-3">Reading the file</p>}

      {summary && (
        <section aria-label="Dry run" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-medium">
              {summary.new} new
            </span>
            <span className="text-ink-3">{summary.duplicates} already here</span>
            {summary.errors.length > 0 && <span className="text-ink-3">{summary.errors.length} skipped</span>}
            <Pill className="ml-auto">Preview, nothing saved yet</Pill>
          </div>
          {summary.preview.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-rule px-3">
              {summary.preview.map((r) => (
                <ListRow key={r.row} className="gap-3 text-label">
                  <span className="w-12 flex-none text-ink-3 tabular-nums">{r.postedOn.slice(5)}</span>
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <Money cents={r.amountCents} signed />
                </ListRow>
              ))}
            </div>
          )}
          {summary.errors.length > 0 && (
            <ul className="text-tag text-ink-3">
              {summary.errors.slice(0, 5).map((e) => (
                <li key={e.row}>
                  Row {e.row}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="primary" disabled={busy || summary.new === 0} onClick={() => void commit()}>
              {summary.new === 0 ? "Nothing new to import" : `Import ${summary.new} transaction${summary.new === 1 ? "" : "s"}`}
            </Button>
          </div>
        </section>
      )}

      {done !== null && (
        <div role="status" className="flex items-center gap-3">
          <span className="font-medium">
            Imported {done} transaction{done === 1 ? "" : "s"}
          </span>
          <div className="flex-1" />
          <Button onClick={closeAdd}>Done</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual account or asset.
// ---------------------------------------------------------------------------

const BALANCE_LABEL: Record<AccountWithBalance["kind"], string> = { cash: "Balance", card: "Amount owed", loan: "Amount owed", asset: "Value" };

function ManualStep() {
  const { data, actions, say, closeAdd } = useAccounts();
  const uid = useId();
  const entities = data.entities.filter((e) => !e.closed);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountWithBalance["kind"]>("cash");
  const [entityId, setEntityId] = useState(entities.find((e) => e.slug === "personal")?.id ?? entities[0]?.id ?? "");
  const [balance, setBalance] = useState("");
  const [inNetWorth, setInNetWorth] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const cents = balance.trim() === "" ? undefined : dollarsToCents(balance);
    if (!name.trim()) return setError("Give the account a name.");
    if (cents === null) return setError("Type the amount as dollars, like 1,250.00.");
    setBusy(true);
    setError("");
    const r = await actions.addManualAccount({ name, kind, entityId: entityId || undefined, inNetWorth, balanceCents: cents });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    say(`Added ${name.trim()}.`);
    closeAdd();
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <FieldRow label="Name" htmlFor={`${uid}-name`}>
          <Input id={`${uid}-name`} value={name} maxLength={100} placeholder="Car" onChange={(e) => setName(e.target.value)} />
        </FieldRow>
        <FieldRow label="Type" htmlFor={`${uid}-kind`}>
          <Select id={`${uid}-kind`} className="flex-1" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Business" htmlFor={`${uid}-entity`}>
          <Select id={`${uid}-entity`} className="flex-1" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label={BALANCE_LABEL[kind]} htmlFor={`${uid}-balance`}>
          <Input id={`${uid}-balance`} inputMode="decimal" value={balance} placeholder="0.00" onChange={(e) => setBalance(e.target.value)} />
        </FieldRow>
        <FieldRow label="In net worth">
          <Switch label="Count this in net worth" checked={inNetWorth} onChange={setInNetWorth} />
        </FieldRow>
      </div>
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          Add account
        </Button>
      </div>
    </form>
  );
}
