"use server";

import { z } from "zod";
import { SLUG_RE } from "@/lib/entities/model";
import { isMonth, type CategoryPanelData, type PanelResult } from "@/components/reports/model";
import { createServerClient } from "@/lib/supabase/server";
import { loadPanel } from "./load";

const input = z.object({
  key: z.string().max(40),
  scope: z.string().refine((s) => s === "all" || SLUG_RE.test(s), "not a scope"),
  month: z.string().refine(isMonth, "not a month"),
});

/** The category panel's data. Owner only; the edits themselves are the typed actions in src/lib/rules. */
export async function loadCategoryPanel(raw: { key: string; scope: string; month: string }): Promise<PanelResult<CategoryPanelData>> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "That category link is not valid" } };
  try {
    const db = await createServerClient();
    const { data: owner, error } = await db.rpc("is_owner");
    if (error || owner !== true) return { ok: false, error: { code: "not_owner", message: "Sign in as the owner" } };
    const { key, scope, month } = parsed.data;
    const data = await loadPanel(db, scope, month, key);
    return data ? { ok: true, data } : { ok: false, error: { code: "not_found", message: "That category is gone" } };
  } catch (e) {
    console.error(`[reports] ${(e as Error).message}`);
    return { ok: false, error: { code: "internal", message: "Something went wrong" } };
  }
}
