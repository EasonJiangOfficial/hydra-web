"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { SettingsWorkspace } from "@/components/settings/settings-workspace";
import type { SettingsActions, SettingsData } from "@/components/settings/types";
import { avatarsClient } from "@/lib/agent/avatars-client";
import { getAgentSettings, modelKeysClient, patchAgentSettings } from "@/lib/agent/settings-client";

import { setTimeZone } from "../accounts/actions";
import { useLiveAccountsActions } from "../accounts/live";
import { addBusiness, closeBusiness, deleteBusiness, reopenBusiness, updateBusiness } from "./actions";

/** The Settings page on real data: each write refreshes the server data (and the layout's scope switch). */
export function SettingsLive({ data }: { data: SettingsData }) {
  const router = useRouter();
  const accounts = useLiveAccountsActions();
  const actions = useMemo<SettingsActions>(() => {
    const writes =
      <A extends unknown[], R extends { ok: boolean }>(run: (...args: A) => Promise<R>) =>
      async (...args: A) => {
        const result = await run(...args);
        if (result.ok) router.refresh();
        return result;
      };
    return {
      addBusiness: writes(addBusiness),
      updateBusiness: writes(updateBusiness),
      closeBusiness: writes(closeBusiness),
      reopenBusiness: writes(reopenBusiness),
      deleteBusiness: writes(deleteBusiness),
      setTimeZone: writes(setTimeZone),
      agentSettings: () => getAgentSettings(),
      saveAgentSettings: (patch) => patchAgentSettings(patch),
      avatars: avatarsClient(),
      modelKeys: modelKeysClient(),
      accounts,
    };
  }, [router, accounts]);
  return <SettingsWorkspace data={data} actions={actions} />;
}
