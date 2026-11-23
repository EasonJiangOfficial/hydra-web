"use client";

import { createBrowserClient as createSsrBrowserClient } from "@supabase/ssr";
import { publicEnv } from "./env";

/** Browser client. Throws MissingEnvError when the public env is absent. */
export function createBrowserClient() {
  const { url, publishableKey } = publicEnv();
  // Passkeys: the docs ask for this opt-in; supabase-js 2.119 enables them by default and ignores it.
  return createSsrBrowserClient(url, publishableKey, { auth: { experimental: { passkey: true } } });
}
