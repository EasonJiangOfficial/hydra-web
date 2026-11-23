"use client";

import { X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useSearchParams } from "next/navigation";
import { Dialog } from "radix-ui";
import { Suspense, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EASE } from "./seg";

/** The search params that open the shared panel (DESIGN.md section 7). */
export type DrawerParam = "tx" | "day" | "account" | "task" | "goal" | "deal" | "category" | "routine" | "taxline" | "business" | "avatar";

export type DetailDrawerProps = {
  /** Opens while this search param is present. */
  param: DrawerParam;
  /** Header label, also the dialog's accessible name. */
  label: ReactNode;
  /** Body. A function gets the param's value (the open item's id). */
  children: ReactNode | ((value: string) => ReactNode);
};

const PHONE = "(max-width: 767px)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const usePhone = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

/** The exit: 200 ms, the house ease (reduced motion keeps only the fade). */
export const EXIT = { duration: 0.2, ease: EASE } as const;

/** Builds the href for opening a drawer item, keeping the other params. */
export function drawerHref(pathname: string, search: URLSearchParams | string, param: DrawerParam, value: string) {
  const next = new URLSearchParams(search);
  next.set(param, value);
  return `${pathname}?${next.toString()}`;
}

/** Every drawer param. The drawers read their data on the client, so changing only these needs no server render. */
const PARAMS: readonly string[] = ["tx", "day", "account", "task", "goal", "deal", "category", "routine", "taxline", "avatar"] satisfies DrawerParam[];

/**
 * Changes the URL at once with native history, which Next feeds to useSearchParams: no server render, so a
 * drawer opens or closes on the click. `push` adds a history entry (Back closes the drawer). The state must
 * be null: Next skips (as its own) any call whose state carries its __NA flag.
 */
export function setDrawerUrl(href: string | URL, push = false) {
  if (push) window.history.pushState(null, "", href);
  else window.history.replaceState(null, "", href);
}

/**
 * The URL a plain click on an in-page link goes to when it only opens this drawer (sets `param`, may drop the
 * other drawer params), else null. Such a link must not wait for a server render of the whole page.
 */
export function drawerClickTarget(e: MouseEvent, param: DrawerParam): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const now = new URL(location.href);
  const to = new URL(a.href, now);
  if (to.origin !== now.origin || to.pathname !== now.pathname || !to.searchParams.has(param) || to.search === now.search) return null;
  const keys = new Set([...to.searchParams.keys(), ...now.searchParams.keys()]);
  for (const k of keys) if (!PARAMS.includes(k) && to.searchParams.getAll(k).join() !== now.searchParams.getAll(k).join()) return null;
  return to.pathname + to.search + to.hash;
}

/**
 * The one shared slide-out. URL-driven: open while `?<param>=` is present; closing removes the
 * param with `history.replaceState` (no history entry, no server render, scroll kept), and the panel
 * slides back out (200 ms, scrim fades) before it unmounts. Desktop: 420 px from the right,
 * full height, hairline left edge. Phone: bottom sheet. Esc or a click outside closes; focus is
 * trapped inside and returned on close. Carries its own Suspense boundary for `useSearchParams`.
 */
export function DetailDrawer(props: DetailDrawerProps) {
  return (
    <Suspense fallback={null}>
      <DrawerInner {...props} />
    </Suspense>
  );
}

function DrawerInner({ param, label, children }: DetailDrawerProps) {
  const search = useSearchParams();
  const phone = usePhone();
  const value = search.get(param);
  const open = value !== null;
  // The opener is often a link that changes the URL, so Radix has no trigger to return focus to. Keep it ourselves.
  const opener = useRef<HTMLElement | null>(null);

  // Native history, not router.replace: the router waits for a server render of the whole page before the
  // URL changes, so the panel sat still and then left.
  const close = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    setDrawerUrl(url);
  };

  // A link that opens this drawer opens it on the click. Window capture runs before the nav bar's document
  // listener and before Next's Link, and both skip a click whose default is prevented.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const to = drawerClickTarget(e, param);
      if (!to) return;
      e.preventDefault();
      setDrawerUrl(to, true);
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [param]);

  // Reduced motion: a fade only. MotionConfig alone would snap the panel 28 px and then fade it.
  const still = useReducedMotion();
  const from = still ? { opacity: 0 } : phone ? { y: 28, opacity: 0 } : { x: 28, opacity: 0 };
  const at = phone ? { y: 0, opacity: 1 } : { x: 0, opacity: 1 };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      {/* MotionConfig must sit outside Dialog.Portal: the Portal's asChild Slot hands its child a ref, and a
          ref given to MotionConfig leaks into the motion config context. Every layoutId element inside
          (Tabs underline, Seg thumb) then passed that Radix Presence ref to motion's MeasureLayout class,
          and Presence called getComputedStyle on a class instance: "parameter 1 is not of type Element". */}
      <MotionConfig reducedMotion="user">
        <AnimatePresence>
          {value !== null && (
            <Dialog.Portal forceMount>
              {/* While it leaves, the scrim and the panel let clicks through to the page. The ! beats the
                  pointer-events: auto that Radix writes inline on the overlay. */}
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  data-slot="detail-drawer-overlay"
                  className="fixed inset-0 z-40 bg-obsidian/20 data-[state=closed]:pointer-events-none!"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.28, ease: EASE } }}
                  exit={{ opacity: 0, transition: EXIT }}
                />
              </Dialog.Overlay>
              <Dialog.Content
                asChild
                forceMount
                aria-describedby={undefined}
                // Focus the panel itself, not the close button, so opening shows no focus ring.
                onOpenAutoFocus={(e) => {
                  e.preventDefault();
                  opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  (e.currentTarget as HTMLElement | null)?.focus();
                }}
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  const el = opener.current?.isConnected ? opener.current : document.body;
                  opener.current = null;
                  el.focus({ preventScroll: true });
                }}
              >
                <motion.div
                  data-slot="detail-drawer"
                  className={cn(
                    "fixed z-50 flex flex-col gap-4 overflow-y-auto bg-surface p-7 outline-none data-[state=closed]:pointer-events-none!",
                    phone
                      ? "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-xl border-t border-rule pb-[max(28px,env(safe-area-inset-bottom))]"
                      : "inset-y-0 right-0 w-(--drawer-w) border-l border-rule",
                  )}
                  initial={from}
                  animate={{ ...at, transition: { duration: 0.28, ease: EASE } }}
                  exit={{ ...from, transition: EXIT }}
                >
                  <div className="flex items-center gap-3">
                    <Dialog.Title className="flex-1 text-label font-normal text-ink-3">{label}</Dialog.Title>
                    <Dialog.Close
                      aria-label="Close"
                      className="-mr-2 inline-grid size-[34px] place-items-center rounded-lg text-ink-3 transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
                    >
                      <X aria-hidden className="size-4" strokeWidth={1.5} />
                    </Dialog.Close>
                  </div>
                  {typeof children === "function" ? children(value) : children}
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </MotionConfig>
    </Dialog.Root>
  );
}
