"use client";

import { Suspense, use, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { IdleLock, clearPrepaint, limitKey, storedPrepaintScript } from "@/components/auth/idle-lock";
import { InlineScript } from "@/components/shell/nav";

const PREFIX = "hydra";

/** Minutes (on), null (off, from a read that worked), or "unknown" (the settings read failed). */
export type IdleLimit = number | null | "unknown";

const noSubscribe = () => () => {};
/** The limit IdleLock last stored, in whole minutes; null when none (or storage is blocked). */
function storedMinutes(): number | null {
  try {
    const ms = Number(window.localStorage.getItem(limitKey(PREFIX)));
    return ms > 0 ? ms / 60_000 : null;
  } catch {
    return null;
  }
}

/**
 * The app sits outside the settings read, so each page's static shell keeps the sidebar and its own
 * loading.tsx skeleton. Only the lock waits for settings.idle_lock_minutes, in its own small Suspense.
 * The pre-paint script is static and comes first in the document, so on a hard load in the locked state
 * it hides [data-idle-app] before any streamed page data can paint; it uses the limit IdleLock last stored.
 * IdleLock unmounts its children when it locks; a probe child tells the gate, which then unmounts the app.
 * With the lock off a probe mounts directly, so the app always shows. A failed settings read ("unknown")
 * is not "off": the lock keeps the limit it last stored (and its state), and nothing stored is cleared.
 */
export function IdleGate({ minutes, children }: { minutes: Promise<IdleLimit>; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <InlineScript html={storedPrepaintScript(PREFIX)} />
      <Suspense fallback={null}>
        <Lock minutes={minutes} onOpen={setOpen} />
      </Suspense>
      <div data-idle-app="" className="contents">
        {open ? children : null}
      </div>
    </>
  );
}

function Lock({ minutes, onOpen }: { minutes: Promise<IdleLimit>; onOpen: (open: boolean) => void }) {
  const read = use(minutes);
  // Server render and hydration see no stored limit; the client's first commit after it does.
  const stored = useSyncExternalStore(noSubscribe, storedMinutes, () => null);
  if (read === "unknown") {
    return stored ? (
      <IdleLock minutes={stored} storagePrefix={PREFIX}>
        <Open onOpen={onOpen} />
      </IdleLock>
    ) : (
      <Open onOpen={onOpen} />
    );
  }
  const limit = read;
  return limit ? (
    <IdleLock minutes={limit} storagePrefix={PREFIX}>
      <Open onOpen={onOpen} />
    </IdleLock>
  ) : (
    <Open onOpen={onOpen} off />
  );
}

/**
 * Mounted while the app may show: inside IdleLock while unlocked, or alone when the lock is off.
 * A layout effect, so the app unmounts before the next paint; a probe swap in one commit nets to open.
 */
function Open({ onOpen, off = false }: { onOpen: (open: boolean) => void; off?: boolean }) {
  useLayoutEffect(() => {
    if (off) clearPrepaint(PREFIX);
    onOpen(true);
    return () => onOpen(false);
  }, [onOpen, off]);
  return null;
}
