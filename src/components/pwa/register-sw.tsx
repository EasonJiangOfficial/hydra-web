"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js (the offline shell and push handler). Mount once in the root layout.
 * Production only: in dev the worker would cache unhashed chunks and fight hot reload.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // No offline shell and no push: the app itself still works.
    });
  }, []);
  return null;
}

/** Drop the cached pages (they hold the owner's data). Call at sign-out. */
export async function clearOfflineCache(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.active?.postMessage({ type: "clear-cache" });
}
