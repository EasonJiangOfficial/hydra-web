"use server";

import { MissingEnvError } from "@/lib/bank/env";
import { NotOwnerError, requireOwner } from "@/lib/bank/server";

import { run, type InstagramResult } from "./client";
import { disconnect } from "./oauth";
import { syncInstagram, type SyncResult } from "./sync";

/** The owner's session, or the refusal as a result. */
async function owner(): Promise<InstagramResult<never> | null> {
  try {
    await requireOwner();
    return null;
  } catch (error) {
    if (error instanceof NotOwnerError) return { ok: false, error: { code: "not_owner", message: "Only the owner can do this" } };
    if (error instanceof MissingEnvError) return { ok: false, error: { code: "not_configured", message: error.message } };
    throw error;
  }
}

/** Sync now (Personal Brand header): the same run as the daily cron. */
export async function syncInstagramNow(): Promise<InstagramResult<SyncResult>> {
  return (await owner()) ?? run(() => syncInstagram());
}

/** Disconnect (Settings > Connections, after its confirm): delete the token. Saved posts and follower counts stay. */
export async function disconnectInstagram(): Promise<InstagramResult<{ disconnected: boolean }>> {
  return (await owner()) ?? run(() => disconnect());
}
