"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createIdleTimer, idleKeys, shouldStartLocked, type IdleStore, type IdleTimer } from "@/lib/auth/idle";
import { finishSignIn } from "@/lib/auth/session";
import { createBrowserClient } from "@/lib/supabase/client";
import { clearOfflineCache } from "@/components/pwa/register-sw";
import { InlineScript } from "@/components/shell/nav";
import { ErrorText, FilledButton, PlainButton } from "./controls";
import { HydraMark } from "./lockup";

const ACTIVITY = ["pointerdown", "pointermove", "keydown", "touchstart", "scroll", "wheel", "focusin"] as const;

const noStore: IdleStore = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/** The pre-paint script adds this style; the first read of the stored state removes it. */
export const PREPAINT_ID = "hydra-idle-prepaint";

/** The lock's limit in ms, stored so a static pre-paint script can decide before the settings read resolves. */
export const limitKey = (prefix: string) => `${prefix}:idle-limit`;

function localStore(): IdleStore {
  try {
    return window.localStorage;
  } catch {
    return noStore;
  }
}

/** Revokes this session (its refresh token), clears the auth cookies and the offline page cache. Unlock is a fresh sign-in. */
async function endSession() {
  void clearOfflineCache().catch(() => {});
  try {
    await createBrowserClient().auth.signOut({ scope: "local" });
  } catch {
    // No env or no network: the lock screen still covers the app.
  }
}

/** Inline, before first paint: hide the app when it is locked or the limit has passed. Adds the style once. */
function prepaintScript(prefix: string, limitMs: number | string) {
  const { locked, last } = idleKeys(prefix);
  const id = JSON.stringify(PREPAINT_ID);
  const args = [JSON.stringify(locked), JSON.stringify(last), limitMs].join(",");
  return `if(!document.getElementById(${id})&&(${shouldStartLocked.toString()})(${args},Date.now())){var s=document.createElement("style");s.id=${id};s.textContent="[data-idle-app]{visibility:hidden}";document.head.appendChild(s)}`;
}

/**
 * The same check with the limit IdleLock last stored, for a static script that runs before any streamed
 * page content. No stored limit (lock off, or never mounted) means nothing to hide.
 */
export function storedPrepaintScript(prefix: string) {
  const read = `(function(){try{return Number(localStorage.getItem(${JSON.stringify(limitKey(prefix))}))||0}catch(e){return 0}})()`;
  return `(function(l){if(l>0){${prepaintScript(prefix, "l")}}})(${read})`;
}

/** The lock is off: forget the stored limit and drop a pre-paint hide, so the app shows. */
export function clearPrepaint(prefix: string) {
  try {
    window.localStorage.removeItem(limitKey(prefix));
  } catch {
    // Storage blocked: nothing was stored.
  }
  document.getElementById(PREPAINT_ID)?.remove();
}

/**
 * Locks the app after `minutes` without pointer, key, touch, scroll or focus activity
 * Locking signs this session out and unmounts the app, so no page data and no portal
 * (sheet, drawer, popover) stays on screen or in the DOM. The app renders visible by default;
 * a pre-paint script hides it on a hard load only when the stored state says it is locked.
 * Not mounted today: the idle lock is an off-by-default setting (settings.idle_lock_minutes,
 * null = off). When it is set (Settings > General), mount this once in the (app) layout around the shell.
 */
export function IdleLock({
  minutes = 5,
  storagePrefix = "hydra",
  children,
}: {
  minutes?: number;
  storagePrefix?: string;
  children: ReactNode;
}) {
  const [locked, setLocked] = useState<boolean | null>(null);
  const timer = useRef<IdleTimer | null>(null);

  useEffect(() => {
    const t = createIdleTimer({
      limitMs: minutes * 60_000,
      store: localStore(),
      onChange: setLocked,
      prefix: storagePrefix,
    });
    timer.current = t;
    try {
      window.localStorage.setItem(limitKey(storagePrefix), String(minutes * 60_000));
    } catch {
      // Storage blocked: the in-render script still covers this load.
    }
    t.start();
    const onActivity = () => t.activity();
    const onStorage = () => t.sync();
    const onVisible = () => document.visibilityState === "visible" && t.tick();
    ACTIVITY.forEach((e) => window.addEventListener(e, onActivity, { capture: true, passive: true }));
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      t.stop();
      ACTIVITY.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [minutes, storagePrefix]);

  useEffect(() => {
    if (locked === null) return;
    // Runs after the commit: the app is already unmounted (locked) or meant to show (unlocked).
    document.getElementById(PREPAINT_ID)?.remove();
    if (locked) void endSession();
  }, [locked]);

  if (locked) return <LockScreen onUnlock={() => timer.current?.unlock()} />;
  return (
    <>
      <InlineScript html={prepaintScript(storagePrefix, minutes * 60_000)} />
      <div data-idle-app="">{children}</div>
    </>
  );
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.signInWithPasskey();
      if (error) return setError("Passkey failed.");
      if ((await finishSignIn(supabase)) !== "ok") return setError("Not allowed.");
      onUnlock();
    } catch {
      setError("Passkey failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Locked"
      data-testid="idle-lock"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-canvas px-6 pb-[10vh] animate-hy-fade"
    >
      <HydraMark className="mb-10 h-10 w-auto text-ink" />
      <div className="flex w-full max-w-[280px] flex-col items-center gap-3">
        <FilledButton type="button" onClick={unlock} disabled={busy} autoFocus>
          Unlock with passkey
        </FilledButton>
        <form method="post" action="/auth/signout">
          <PlainButton type="submit">Sign out</PlainButton>
        </form>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
