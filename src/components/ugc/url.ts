"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { setDrawerUrl } from "@/components/kit/drawer";
import { useCallback } from "react";

/**
 * One URL search param as state: `?tab=videos`, `?flow=new`. Setting replaces the history entry and keeps the
 * other params; null removes it. Needs a Suspense boundary above it (it reads the search params).
 *
 * The page renders every param on the client from rows it already holds, so a change goes through the native
 * `history.replaceState`, which Next folds into `useSearchParams` with no server round trip (a tab or period
 * switch paints at once instead of waiting for the page's data to load again).
 */
export function useQueryParam(key: string) {
  const params = useSearchParams();
  const value = params.get(key);
  const set = useCallback(
    (next: string | null, extra?: Record<string, string | null>) => {
      // The live URL, not this render's params: two sets before a re-render (From, then To) must both stay.
      const q = new URLSearchParams(window.location.search);
      if (next === null) q.delete(key);
      else q.set(key, next);
      for (const [k, v] of Object.entries(extra ?? {})) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      const s = q.toString();
      setDrawerUrl(s ? `${window.location.pathname}?${s}` : window.location.pathname);
    },
    [key],
  );
  return [value, set] as const;
}

/** `?day=...` href that keeps the other params (the posting calendar and rows link to the day panel). */
export function useHrefWith() {
  const params = useSearchParams();
  const pathname = usePathname();
  return useCallback(
    (key: string, value: string, extra?: Record<string, string>) => {
      const q = new URLSearchParams(params.toString());
      q.set(key, value);
      for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
      return `${pathname}?${q.toString()}`;
    },
    [params, pathname],
  );
}
