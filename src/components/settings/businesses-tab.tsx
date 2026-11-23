"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useId, useState } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { useSynced } from "@/components/accounts/switch";
import { Button, Card, DetailDrawer, HoverCard, Input, Label, ListRow, Pill, cn, drawerHref } from "@/components/kit";
import { FieldRow, SaveLabel, type SaveState } from "@/components/planning/controls";
import { Select } from "@/components/ui/select";
import { TAX_SHAPES, TAX_SHAPE_LABEL, type TaxShape } from "@/lib/entities/model";

import { useSettings } from "./store";
import type { BusinessRow } from "./types";

const SHAPES = TAX_SHAPES.map((s) => ({ value: s, label: TAX_SHAPE_LABEL[s] }));
const typeOf = (b: BusinessRow) => (b.kind === "personal" ? "Personal" : b.taxShape ? TAX_SHAPE_LABEL[b.taxShape] : "Business");
const accountsText = (n: number) => `${n} account${n === 1 ? "" : "s"}`;

/** Closes the `?business=` slide-out the way the drawer does: replaceState, no history entry. */
function closePanel() {
  const url = new URL(window.location.href);
  url.searchParams.delete("business");
  window.history.replaceState(null, "", url);
}

function Row({ b }: { b: BusinessRow }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const closed = b.status === "closed";
  return (
    <ListRow
      as={Link}
      href={drawerHref(pathname, search, "business", b.id)}
      scroll={false}
      prefetch={false}
      data-business={b.slug}
      className="gap-3 px-0"
    >
      <span className={cn("min-w-0 flex-1 truncate font-medium", closed && "text-ink-3")}>{b.name}</span>
      <span className="w-32 truncate text-label text-ink-3 max-md:hidden">{typeOf(b)}</span>
      <span className="w-24 text-right text-label text-ink-3 tabular-nums max-md:hidden">{accountsText(b.accounts)}</span>
      <span className="w-16 text-right">{closed ? <Pill>Closed</Pill> : <span className="text-label text-ink-3">Active</span>}</span>
    </ListRow>
  );
}

export function BusinessesTab() {
  const { data } = useSettings();
  const pathname = usePathname();
  const search = useSearchParams();
  return (
    <>
      <Card aria-label="Businesses">
        <div className="flex items-center gap-2">
          <Label>Businesses</Label>
          <div className="flex-1" />
          <Button variant="primary" asChild>
            <Link href={drawerHref(pathname, search, "business", "new")} scroll={false} prefetch={false}>
              <Plus aria-hidden strokeWidth={1.5} />
              Add business
            </Link>
          </Button>
        </div>
        <div>
          {data.businesses.map((b) => (
            <Row key={b.id} b={b} />
          ))}
        </div>
      </Card>
      <DetailDrawer param="business" label={search.get("business") === "new" ? "Add business" : "Business"}>
        {(id) => (id === "new" ? <AddForm /> : <EditPanel id={id} />)}
      </DetailDrawer>
    </>
  );
}

function AddForm() {
  const { actions, say } = useSettings();
  const uid = useId();
  const [name, setName] = useState("");
  const [shape, setShape] = useState<TaxShape>("sole_prop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setBusy(true);
    setError("");
    const r = await actions.addBusiness({ name, taxShape: shape });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    say(`Added ${r.data.name}.`);
    closePanel();
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <h2 className="text-title text-ink">New business</h2>
      <div>
        <FieldRow label="Name" htmlFor={`${uid}-name`}>
          <Input id={`${uid}-name`} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} className="flex-1" />
        </FieldRow>
        <FieldRow label="Type" htmlFor={`${uid}-type`}>
          <Select id={`${uid}-type`} aria-label="Type" options={SHAPES} value={shape} onValueChange={(v) => setShape(v as TaxShape)} className="flex-1" />
        </FieldRow>
      </div>
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Add business
        </Button>
        <Button type="button" variant="ghost" onClick={closePanel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditPanel({ id }: { id: string }) {
  const { data } = useSettings();
  const b = data.businesses.find((x) => x.id === id);
  if (!b) return <p className="text-ink-3">This business is gone.</p>;
  return <Edit key={b.id} b={b} />;
}

function Edit({ b }: { b: BusinessRow }) {
  const { actions, say } = useSettings();
  const uid = useId();
  const [name, setName] = useSynced(b.name);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const personal = b.kind === "personal";
  const closed = b.status === "closed";

  async function save(patch: { name?: string; taxShape?: TaxShape }) {
    setState("saving");
    setError("");
    const r = await actions.updateBusiness({ id: b.id, ...patch });
    setState(r.ok ? "saved" : "error");
    if (!r.ok) {
      setError(r.error.message);
      if (patch.name !== undefined) setName(b.name);
    }
  }

  async function run(what: "close" | "reopen" | "delete") {
    setBusy(true);
    setError("");
    const r = what === "close" ? await actions.closeBusiness({ id: b.id }) : what === "reopen" ? await actions.reopenBusiness({ id: b.id }) : await actions.deleteBusiness({ id: b.id });
    setBusy(false);
    setSure(false);
    if (!r.ok) return setError(r.error.message);
    if (what === "delete") {
      say(`Deleted ${b.name}.`);
      offerUndo(r.activityId, b.name);
      closePanel();
    } else say(what === "close" ? `Closed ${b.name}. Its history stays.` : `Reopened ${b.name}.`);
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-title text-ink">{b.name}</h2>
        {closed && <Pill>Closed</Pill>}
      </div>
      <div>
        <FieldRow label="Name" htmlFor={`${uid}-name`}>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() !== b.name && void save({ name })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="flex-1"
          />
        </FieldRow>
        {!personal && (
          <FieldRow label="Type" htmlFor={`${uid}-type`}>
            <Select
              id={`${uid}-type`}
              aria-label="Type"
              options={SHAPES}
              value={b.taxShape ?? "other"}
              onValueChange={(v) => v !== b.taxShape && void save({ taxShape: v as TaxShape })}
              className="flex-1"
            />
          </FieldRow>
        )}
        <FieldRow label="Accounts">
          <span className="flex-1 tabular-nums">{accountsText(b.accounts)}</span>
          <SaveLabel state={state} />
        </FieldRow>
      </div>
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
      {!personal && (
        <div className="mt-auto border-t border-rule pt-4">
          {sure ? (
            <div role="alertdialog" aria-label="Delete business" className="flex flex-col gap-3 rounded-lg bg-tint px-3.5 py-3">
              <p>Delete {b.name}?</p>
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void run("delete")}>
                  Delete
                </Button>
                <Button variant="ghost" onClick={() => setSure(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void run(closed ? "reopen" : "close")}>
                {closed ? "Reopen" : "Close business"}
              </Button>
              {b.inUse ? (
                <HoverCard content="In use: close it instead" className="px-3 py-2">
                  <span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-ink">
                    <Button variant="ghost" disabled aria-label="Delete (in use: close it instead)">
                      Delete
                    </Button>
                  </span>
                </HoverCard>
              ) : (
                <Button variant="ghost" disabled={busy} onClick={() => setSure(true)}>
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
