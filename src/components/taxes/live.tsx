"use client";

import {
  documentUrl,
  lineTransactions,
  registerDocument,
  removeDocument,
  removePayment,
  savePayment,
  saveRate,
} from "@/app/(app)/taxes/actions";
import type { TaxActions, TaxesData } from "@/app/(app)/taxes/model";
import { createBrowserClient } from "@/lib/supabase/client";
import { DOC_ACCEPT } from "./documents-card";
import { TaxesWorkspace } from "./taxes-workspace";

const BUCKET = "tax-docs";
const TYPES = DOC_ACCEPT.split(",");

/** A storage-safe file name: letters, digits, dot, dash and underscore only. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-120) || "file";

/**
 * The real actions: the server actions above, plus the upload. The browser puts the file in the
 * private tax-docs bucket as the owner (storage RLS), then the server records it.
 */
const live: TaxActions = {
  saveRate,
  savePayment,
  removePayment,
  lineTransactions,
  documentUrl,
  removeDocument,
  async uploadDocument({ entity, year, kind, payer, file }) {
    const bad = (message: string) => ({ ok: false as const, error: { code: "invalid_input", message } });
    if (!TYPES.includes(file.type)) return bad("Use a PDF, PNG, JPEG or WebP file");
    const path = `${entity}/${year}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const storage = createBrowserClient().storage.from(BUCKET);
    const { error } = await storage.upload(path, file, { contentType: file.type, upsert: false });
    if (error) return { ok: false as const, error: { code: "upload_failed", message: "The upload did not work. Try again" } };
    const saved = await registerDocument({
      entity,
      year,
      kind,
      payer,
      name: file.name,
      storagePath: path,
      mimeType: file.type,
      sizeBytes: file.size,
    });
    if (!saved.ok) await storage.remove([path]); // do not leave a file nothing points at
    return saved;
  },
};

export function LiveTaxes({ data }: { data: TaxesData }) {
  return <TaxesWorkspace data={data} actions={live} />;
}
