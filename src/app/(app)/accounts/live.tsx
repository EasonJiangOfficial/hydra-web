"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { AccountsWorkspace } from "@/components/accounts/accounts-workspace";
import type { AccountsActions, AccountsData, ActionResult } from "@/components/accounts/types";
import {
  addManualAccount,
  closeAccount,
  createLinkToken,
  editAccount,
  exchangePublicToken,
  importFile,
  startUpdateMode,
  syncBankItem,
} from "@/lib/bank/actions";
import { disconnectInstagram } from "@/lib/instagram/actions";
import { createApiKey, revokeApiKey } from "@/lib/keys/actions";
import { confirmRecurring, detectRecurringNow, dismissRecurring } from "@/lib/rules/actions";

import { loadBalanceHistory, setIdleLock } from "./actions";

/** POST JSON to an owner route (Google disconnect, device pairing and revoke) as an ActionResult. */
async function post<T>(url: string, body: unknown = {}): Promise<ActionResult<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { error?: string | { code?: string; message?: string } } | null;
    if (res.ok) return { ok: true, data: json as T };
    const error = typeof json?.error === "object" ? json.error : { code: json?.error };
    return { ok: false, error: { code: error.code ?? "internal", message: error.message ?? "Something went wrong. Try again." } };
  } catch {
    return { ok: false, error: { code: "network", message: "Could not reach Hydra. Try again." } };
  }
}

const nothing = <T,>(r: ActionResult<T>): ActionResult<null> => (r.ok ? { ok: true, data: null } : r);

/** The U2, U3 and page actions, each followed by a server refresh when it changed something. Accounts and Settings use them. */
export function useLiveAccountsActions(): AccountsActions {
  const router = useRouter();
  return useMemo<AccountsActions>(() => {
    // The server returns fresh data on refresh; the workspace follows its props.
    const writes =
      <A extends unknown[], T>(run: (...args: A) => Promise<ActionResult<T>>) =>
      async (...args: A) => {
        const result = await run(...args);
        if (result.ok) router.refresh();
        return result;
      };
    return {
      createLinkToken,
      startUpdateMode,
      exchangePublicToken: writes(exchangePublicToken),
      syncBankItem: writes(syncBankItem),
      // A dry run changes nothing: only the commit refreshes.
      importFile: async (input) => {
        const result = await importFile(input);
        if (result.ok && input.dryRun === false) router.refresh();
        return result;
      },
      addManualAccount: writes(addManualAccount),
      editAccount: writes(editAccount),
      closeAccount: writes(closeAccount),
      confirmRecurring: writes(confirmRecurring),
      dismissRecurring: writes(dismissRecurring),
      detectRecurringNow: writes(detectRecurringNow),
      setIdleLock: writes(setIdleLock),
      balanceHistory: loadBalanceHistory,
      disconnectGoogle: writes(async () => nothing(await post("/api/google/disconnect"))),
      disconnectInstagram: writes(async () => nothing(await disconnectInstagram())),
      createApiKey: writes(createApiKey),
      revokeApiKey: writes(async (input: { id: string }) => nothing(await revokeApiKey(input))),
      // A code changes nothing on the page; the Mac shows up after it trades the code (refresh to see it).
      pairDevice: (input) =>
        post<{ code: string; expiresAt: string }>(
          "/api/agent/devices/pair",
          input?.kind === "claude-code"
            ? { name: "Claude Code", scopes: ["mcp"] }
            : input?.kind === "server"
              ? { name: "Hydra server", role: "brain" }
              : { name: "Hydra Desktop" },
        ),
      revokeDevice: writes(async (input: { id: string }) => nothing(await post("/api/agent/devices/revoke", input))),
    };
  }, [router]);
}

/** The Accounts page on real data. */
export function AccountsLive({ data }: { data: AccountsData }) {
  return <AccountsWorkspace data={data} actions={useLiveAccountsActions()} />;
}
