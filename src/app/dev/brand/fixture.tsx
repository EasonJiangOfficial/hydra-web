"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

import { BrandPage, type SaveFollowers, type SyncInstagram } from "@/components/brand/brand-page";
import { brandFixture } from "@/components/brand/fixture-data";
import type { BrandRaw } from "@/lib/brand/model";
import type { InstagramView } from "@/lib/instagram/model";
import { dayKeyInZone } from "@/lib/ugc/days";

/**
 * The Instagram states: `?ig=none` (not connected), `off` (no app keys on the host), `error` (token refused),
 * `partial` (synced, some insights refused and the page cap hit), `nogrant` (synced, insights not granted), else
 * connected.
 */
function igFixture(ig: string | null, nowIso: string): InstagramView {
  if (ig === "none") return { missing: [], username: null, lastSyncedAt: null, lastError: null };
  if (ig === "off") return { missing: ["META_APP_ID", "META_APP_SECRET", "INSTAGRAM_CONFIG_ID", "HYDRA_TOKEN_KEY"], username: null, lastSyncedAt: null, lastError: null };
  const lastSyncedAt = new Date(Date.parse(nowIso) - 2 * 3_600_000).toISOString();
  return { missing: [], username: "studio.notes", lastSyncedAt, lastError: ({ error: "reauth_required", partial: "insights_partial,media_cut", nogrant: "insights_not_granted" } as Record<string, string>)[ig ?? ""] ?? null };
}

/** `?empty=1` shows the page with no flagged deal and no counts. `?ig=` picks the Instagram state. */
export function BrandFixture() {
  const search = useSearchParams();
  const empty = search.get("empty") === "1";
  const [raw, setRaw] = useState<BrandRaw>(() => {
    const full = brandFixture();
    return empty ? { ...full, deals: [], handle: null, posts: [], views: [], engagement: [], followers: [], thumbs: {} } : full;
  });
  const [instagram, setInstagram] = useState<InstagramView>(() => igFixture(search.get("ig"), raw.nowIso));
  const save = useCallback<SaveFollowers>(
    async ({ followers }) => {
      const day = dayKeyInZone(new Date(raw.nowIso), raw.zone);
      setRaw((r) => ({
        ...r,
        followers: [...r.followers.filter((f) => f.day !== day), { day, followers, source: "manual" as const }].sort((a, b) => (a.day < b.day ? -1 : 1)),
      }));
      return { ok: true, data: { day, followers } };
    },
    [raw.nowIso, raw.zone],
  );
  const sync = useCallback<SyncInstagram>(async () => {
    await new Promise((r) => setTimeout(r, 400));
    setInstagram((v) => ({ ...v, lastSyncedAt: raw.nowIso, lastError: null }));
    return { ok: true };
  }, [raw.nowIso]);
  return <BrandPage raw={raw} saveFollowers={save} instagram={instagram} syncInstagram={sync} />;
}
