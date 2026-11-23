"use client";

import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";

import { setFollowers } from "@/lib/brand/actions";
import type { BrandRaw } from "@/lib/brand/model";
import { syncInstagramNow } from "@/lib/instagram/actions";
import type { InstagramView } from "@/lib/instagram/model";

import { BrandPage, type SaveFollowers, type SyncInstagram } from "./brand-page";

/** The real page: the server rows, setFollowers and Sync now, each of which re-renders the rows once it is done. */
export function BrandApp({ raw, instagram }: { raw: BrandRaw; instagram: InstagramView }) {
  const router = useRouter();
  const [, start] = useTransition();
  const save = useCallback<SaveFollowers>(
    async (input) => {
      const res = await setFollowers(input);
      if (res.ok) start(() => router.refresh());
      return res;
    },
    [router],
  );
  const sync = useCallback<SyncInstagram>(async () => {
    const res = await syncInstagramNow();
    // A failed sync records its error on the connection too: refresh either way.
    start(() => router.refresh());
    return res.ok ? { ok: true } : res;
  }, [router]);
  return <BrandPage raw={raw} saveFollowers={save} instagram={instagram} syncInstagram={sync} />;
}
