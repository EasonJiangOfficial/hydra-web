"use client";

import { ArrowUpRight, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  DOC_KINDS,
  docKindLabel,
  fileSize,
  missingW9,
  shortDate,
  type DocKind,
  type TaxActions,
  type TaxDoc,
  type TaxesData,
} from "@/app/(app)/taxes/model";
import { offerUndo } from "@/components/activity/undo-bar";
import { Button, Card, InfoDot, Label, ListRow, Pill, Seg } from "@/components/kit";
import { Combobox } from "@/components/ui/combobox";

type Props = {
  data: TaxesData;
  actions: TaxActions;
  documents: TaxDoc[];
  onDocuments: Dispatch<SetStateAction<TaxDoc[]>>;
};

/** The file types the tax-docs bucket takes (migration 0110) and its size limit. */
export const DOC_ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
export const DOC_MAX_BYTES = 25 * 1024 * 1024;

/** W-9s, 1099s and other uploads for the entity and year, kept in the private tax-docs bucket. */
export function DocumentsCard({ data, actions, documents, onDocuments }: Props) {
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const missing = data.treatment === "personal" ? [] : missingW9(data.payers, documents);

  return (
    <Card aria-label="Documents">
      <div className="flex items-center gap-2">
        <Label>Documents</Label>
        <InfoDot label="About documents">Payers send 1099s by January 31. Files stay in a private bucket only you can open.</InfoDot>
        <div className="flex-1" />
        <Button variant="outline" size="default" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
          <Plus aria-hidden strokeWidth={1.5} />
          Upload
        </Button>
      </div>
      {adding && (
        <UploadForm
          data={data}
          actions={actions}
          onDone={(doc) => {
            onDocuments([doc, ...documents]);
            setAdding(false);
          }}
        />
      )}
      {message && (
        <p role="alert" className="text-tag text-ink">
          {message}
        </p>
      )}
      <ul>
        {missing.map((payer) => (
          <li key={`missing-${payer}`}>
            <ListRow>
              <span className="min-w-0 flex-1 truncate">{payer}</span>
              <Pill tone="strong">W-9 missing</Pill>
            </ListRow>
          </li>
        ))}
        {documents.map((d) => (
          <li key={d.id}>
            <DocRow
              doc={d}
              actions={actions}
              onError={setMessage}
              onRemoved={(activityId) => {
                onDocuments(documents.filter((x) => x.id !== d.id));
                // Undo puts back only this document, into the list as it is then.
                const at = documents.findIndex((x) => x.id === d.id);
                offerUndo(activityId, `"${d.name}"`, () =>
                  onDocuments((now) => (now.some((x) => x.id === d.id) ? now : [...now.slice(0, at), d, ...now.slice(at)])),
                );
              }}
            />
          </li>
        ))}
      </ul>
      {documents.length === 0 && missing.length === 0 && <p className="py-4 text-center text-body text-ink-3">No documents for {data.year}</p>}
    </Card>
  );
}

function DocRow({
  doc,
  actions,
  onError,
  onRemoved,
}: {
  doc: TaxDoc;
  actions: TaxActions;
  onError: (message: string | null) => void;
  onRemoved: (activityId: string | null | undefined) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    onError(null);
    const r = await actions.documentUrl({ id: doc.id });
    if (r.ok) window.open(r.data.url, "_blank", "noopener");
    else onError(r.error.message);
  };
  const remove = async () => {
    setBusy(true);
    onError(null);
    const r = await actions.removeDocument({ id: doc.id });
    if (r.ok) return onRemoved(r.activityId);
    onError(r.error.message);
    setBusy(false);
    setConfirming(false);
  };

  return (
    <ListRow className="flex-wrap">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{doc.name}</span>
        <span className="flex gap-2 text-tag text-ink-3">
          <span className="font-medium text-ink-2">{docKindLabel(doc.kind)}</span>
          {doc.payer && <span className="truncate">{doc.payer}</span>}
          <span>{shortDate(doc.addedOn)}</span>
          {doc.sizeBytes !== null && <span>{fileSize(doc.sizeBytes)}</span>}
        </span>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1" role="group" aria-label={`Delete ${doc.name}`}>
          <span className="text-tag text-ink">Delete this file?</span>
          <Button variant="outline" onClick={remove} disabled={busy} className="h-7 rounded-md px-2.5 text-label">
            Delete
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy} className="h-7 rounded-md px-2 text-label">
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex items-center">
          <Button variant="ghost" size="icon-sm" aria-label={`Open ${doc.name}`} onClick={open}>
            <ArrowUpRight aria-hidden strokeWidth={1.5} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${doc.name}`} onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden strokeWidth={1.5} />
          </Button>
        </div>
      )}
    </ListRow>
  );
}

/** Kind and payer first, then the file picker: the upload starts when a file is chosen. */
function UploadForm({ data, actions, onDone }: { data: TaxesData; actions: TaxActions; onDone: (doc: TaxDoc) => void }) {
  const [kind, setKind] = useState<DocKind>("w9");
  const [payer, setPayer] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const needsPayer = kind !== "other" && data.treatment !== "personal";

  const upload = async (file: File) => {
    setMessage(null);
    if (file.size > DOC_MAX_BYTES) return setMessage("That file is over 25 MB");
    setBusy(true);
    const r = await actions.uploadDocument({ entity: data.entity, year: data.year, kind, payer: payer.trim() || null, file });
    if (r.ok) return onDone(r.data);
    setMessage(r.error.message);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-tint p-3">
      <Seg
        aria-label="Document type"
        items={DOC_KINDS.map((k) => ({ value: k.value, label: k.label }))}
        value={kind}
        onValueChange={(v) => setKind(v as DocKind)}
        className="self-start bg-surface"
      />
      <label className="flex flex-col gap-1 text-label text-ink-3">
        Payer
        <Combobox
          suggestions={data.payers.map((p) => p.name)}
          placeholder={needsPayer ? "Who sent it" : "Optional"}
          className="bg-surface"
          value={payer}
          onChange={(e) => setPayer(e.target.value)}
        />
      </label>
      <input
        ref={picker}
        type="file"
        hidden
        aria-label="Choose a file"
        accept={DOC_ACCEPT}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload(file);
        }}
      />
      <Button
        variant="outline"
        className="self-start bg-surface"
        disabled={busy || (needsPayer && payer.trim() === "")}
        onClick={() => picker.current?.click()}
      >
        {busy ? "Uploading" : "Choose file"}
      </Button>
      {message && (
        <p role="alert" className="text-tag text-ink">
          {message}
        </p>
      )}
    </div>
  );
}
