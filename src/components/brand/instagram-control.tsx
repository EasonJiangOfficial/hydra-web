"use client";

import { RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { ago } from "@/components/accounts/format";
import { Button, InfoDot } from "@/components/kit";
import { INSTAGRAM_SIGN_IN, instagramEnvNote, instagramErrorNote, instagramState, type InstagramView } from "@/lib/instagram/model";

export type SyncInstagram = () => Promise<{ ok: true } | { ok: false; error: { message: string } }>;

const START = "/api/instagram/start?from=brand";

/**
 * The Instagram problem line: a failed Sync now, or how the sign-in came back (?instagram=). The page shows it under
 * the header. Once Sync now has answered, its answer replaces the sign-in note (undefined: no sync yet).
 */
export function useInstagramNote() {
  const back = useSearchParams().get("instagram");
  const [error, setError] = useState<string | null | undefined>(undefined);
  return { note: error === undefined ? (INSTAGRAM_SIGN_IN[back ?? ""] ?? null) : error, setError };
}

/**
 * The Personal Brand header's Instagram control, one row at every width. Not connected: Connect Instagram (off,
 * with the missing variables in an InfoDot, until the host has the app keys). Connected: the handle, when it last
 * synced (hover), and Sync now. A token Instagram refused: Reconnect. Disconnect lives in Settings > Connections.
 */
export function InstagramControl({ view, now, sync, setError }: { view: InstagramView; now: string; sync: SyncInstagram; setError: (e: string | null) => void }) {
  const [pending, start] = useTransition();
  const state = instagramState(view);

  if (state === "off" || state === "none") {
    return (
      <div data-instagram={state} className="flex shrink-0 items-center gap-2">
        {state === "off" ? (
          <>
            {/* Phone: "Connect" keeps the title on one line; the dot says it is Instagram. */}
            <Button disabled aria-label="Connect Instagram">
              <span className="sm:hidden">Connect</span>
              <span className="max-sm:hidden">Connect Instagram</span>
            </Button>
            <InfoDot label="Why Instagram is off">{instagramEnvNote(view.missing)}</InfoDot>
          </>
        ) : (
          <Button asChild>
            <a href={START}>Connect Instagram</a>
          </Button>
        )}
      </div>
    );
  }

  const synced = view.lastSyncedAt ? `Synced ${ago(view.lastSyncedAt, now)}.` : "Not synced yet.";
  const failed = instagramErrorNote(view.lastError);
  return (
    <div data-instagram={state} className="flex shrink-0 items-center gap-2">
      {/* The phone keeps the title on one line: the handle shows in the range bar there. */}
      <span className="text-label text-ink-2 max-sm:hidden">@{view.username}</span>
      <InfoDot label="Instagram sync">
        {[`@${view.username}.`, synced, failed, state === "reconnect" ? null : "It syncs daily."].filter(Boolean).join(" ")}
      </InfoDot>
      {state === "reconnect" ? (
        <Button asChild>
          <a href={START}>Reconnect</a>
        </Button>
      ) : (
        <Button
          size="icon"
          aria-label="Sync now"
          title="Sync now"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await sync();
              setError(r.ok ? null : r.error.message);
            })
          }
        >
          <RefreshCw strokeWidth={1.5} className={pending ? "motion-safe:animate-spin" : undefined} />
        </Button>
      )}
    </div>
  );
}
