"use client";

import Script from "next/script";
import { useCallback, useRef, useState, type ReactNode } from "react";

import type { AccountsActions } from "./types";

/**
 * Plaid Link (DESIGN.md section 6, item 7). The script comes from cdn.plaid.com through next/script and loads
 * only when the owner first asks to link or reconnect. The current CSP blocks it: the integrator adds
 * `https://cdn.plaid.com` to script-src and a new `frame-src https://cdn.plaid.com` in next.config.ts. Until then the
 * script fails to load and the page says so instead of doing nothing.
 */

export const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export const NOT_SET_UP = "Plaid is not set up yet. Add the Plaid keys on the host, then link a bank.";
export const BLOCKED = "Plaid Link could not load. The page's security policy has to allow cdn.plaid.com (script-src and frame-src).";

type Handler = { open(): void };
type PlaidGlobal = {
  create(config: { token: string; onSuccess(publicToken: string, metadata: unknown): void; onExit(error: unknown, metadata: unknown): void }): Handler;
};
const plaid = () => (window as unknown as { Plaid?: PlaidGlobal }).Plaid;

export interface PlaidControl {
  /** Start Link for a new bank login, or in update mode for one existing login. */
  start(itemId?: string): void;
  busy: boolean;
  /** The `<Script>`; render it once. Null until the owner first starts Link. */
  script: ReactNode;
}

export function usePlaidLink(actions: AccountsActions, configured: boolean, say: (message: string | null) => void): PlaidControl {
  const [wanted, setWanted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const waiting = useRef<(() => void) | null>(null);

  const run = useCallback(
    async (itemId?: string) => {
      const link = plaid();
      if (!link) {
        setBusy(false);
        say(BLOCKED);
        return;
      }
      const token = itemId ? await actions.startUpdateMode({ itemId }) : await actions.createLinkToken();
      if (!token.ok) {
        setBusy(false);
        say(token.error.code === "not_configured" ? NOT_SET_UP : token.error.message);
        return;
      }
      link
        .create({
          token: token.data.linkToken,
          onSuccess: async (publicToken) => {
            // Update mode repairs the same login: no new token to exchange, just pull fresh data.
            const done = itemId ? await actions.syncBankItem({ itemId }) : await actions.exchangePublicToken({ publicToken });
            setBusy(false);
            if (!done.ok) say(done.error.code === "duplicate_institution" ? "This bank is already linked. Use Reconnect on it." : done.error.message);
            else say(itemId ? "Reconnected. Syncing now." : "Bank linked. The first sync is running.");
          },
          onExit: () => setBusy(false),
        })
        .open();
    },
    [actions, say],
  );

  const start = useCallback(
    (itemId?: string) => {
      say(null);
      if (!configured) return say(NOT_SET_UP);
      if (plaid()) {
        setBusy(true);
        return void run(itemId);
      }
      if (failed) return say(BLOCKED);
      setBusy(true);
      waiting.current = () => void run(itemId);
      setWanted(true);
    },
    [configured, failed, run, say],
  );

  const script =
    configured && wanted ? (
      <Script
        id="plaid-link"
        src={PLAID_SCRIPT}
        strategy="afterInteractive"
        onReady={() => {
          const next = waiting.current;
          waiting.current = null;
          next?.();
        }}
        onError={() => {
          waiting.current = null;
          setFailed(true);
          setBusy(false);
          say(BLOCKED);
        }}
      />
    ) : null;

  return { start, busy, script };
}
