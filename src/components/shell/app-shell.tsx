"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentCard } from "@/components/agent/agent-card";
import { AgentProvider } from "@/components/agent/provider";
import { SetupGate } from "@/components/setup-mac/setup-mac";
import { HydraMark, Icon, InlineScript, NAV, SIGN_OUT_ICON, SignOutForm, Wordmark, isActive } from "./nav";
import { MAX_MS, navTarget } from "./nav-progress";
import { PhoneHeader, PhoneNav } from "./phone-nav";
import { WithScope, scopedHref } from "./scope";

/* Sidebar open/closed, kept per device in localStorage. */
const KEY = "hydra:sidebar";
const EVENT = "hydra:sidebar";
let closedNow: boolean | null = null;

function readClosed() {
  if (closedNow === null) {
    try {
      closedNow = localStorage.getItem(KEY) === "closed";
    } catch {
      closedNow = false;
    }
  }
  return closedNow;
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    closedNow = e.newValue === "closed";
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onChange);
  };
}

export function setSidebarClosed(closed: boolean) {
  closedNow = closed;
  try {
    localStorage.setItem(KEY, closed ? "closed" : "open");
  } catch {
    /* private mode: the state still holds for this page */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** True when the desktop sidebar is collapsed. Server render and hydration see `false`. */
export function useSidebarClosed() {
  return useSyncExternalStore(subscribe, readClosed, () => false);
}

/**
 * Runs while the HTML parses, before first paint: marks the shell root closed, so the CSS below draws the
 * 64 px sidebar from the first frame. React then hydrates with `suppressHydrationWarning` on that root.
 */
const NO_FLASH = `try{if(localStorage.getItem("${KEY}")==="closed")document.currentScript.parentElement.setAttribute("data-sidebar","closed")}catch(e){}`;

/*
 * Closed-state styles key off `data-sidebar` on the shell root (class strings stay literal for Tailwind).
 * Motion is opacity only (DESIGN.md section 7): width, padding and rows change at once; the words fade over 200 ms.
 * `visibility` rides along so hidden controls leave the tab order; it flips at the end of a fade-out, not tweened.
 */
const fade =
  "transition-[opacity,visibility] duration-200 ease-hydra group-data-[sidebar=closed]/shell:invisible group-data-[sidebar=closed]/shell:opacity-0";

function Chevron({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A nav label is a tooltip (role=tooltip), not a hover card; it uses the kit hover-card look: ink, 12 px, 8 px corners, 140 ms.
function NavTip({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {show && (
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="right"
            sideOffset={10}
            className="z-50 rounded-lg bg-ink px-2.5 py-1.5 text-tag text-white data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-100 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:slide-in-from-left-1 data-[state=delayed-open]:duration-140"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      )}
    </Tooltip>
  );
}

const row =
  "flex h-9 flex-none items-center gap-2.5 rounded-md px-2.5 whitespace-nowrap transition-colors duration-200 ease-hydra group-data-[sidebar=closed]/shell:pl-[11px]";

/** The chevrons fade over 200 ms (`fade`, `duration-200`); visibility only turns visible once that fade starts. */
const FADE_MS = 200;

/**
 * Toggle from a button, then hand focus to the button that shows next (the clicked one hides itself).
 * Waits for the fade, because a button that is still `visibility: hidden` cannot take focus, and only
 * moves focus if it is still on the clicked button or has fallen to the body, so it never steals it.
 */
function toggleFrom(closed: boolean, self: RefObject<HTMLButtonElement | null>, next: RefObject<HTMLButtonElement | null>) {
  setSidebarClosed(closed);
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active === self.current || active === document.body || active === null) next.current?.focus();
  }, FADE_MS + 20);
}

function Sidebar({ active, closed }: { active: string; closed: boolean }) {
  const collapseRef = useRef<HTMLButtonElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select"))) return;
      e.preventDefault();
      setSidebarClosed(!readClosed());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <nav
      aria-label="Main"
      data-testid="sidebar"
      className={"sticky top-0 hidden h-dvh w-(--sidebar-open) flex-none flex-col gap-0.5 overflow-hidden border-r border-rule bg-surface px-3 pt-7 pb-5 md:flex group-data-[sidebar=closed]/shell:w-(--sidebar-closed)"}
    >
      <div className="mb-6 flex h-8 flex-none items-center gap-2 px-2.5 group-data-[sidebar=closed]/shell:pl-[8px]">
        <HydraMark />
        <Wordmark className={`flex-1 whitespace-nowrap ${fade}`} />
        <button
          type="button"
          ref={collapseRef}
          aria-label="Collapse sidebar"
          aria-keyshortcuts="["
          onClick={() => toggleFrom(true, collapseRef, expandRef)}
          className={`grid size-7 flex-none place-items-center rounded-lg text-ink-3 hover:bg-tint hover:text-ink ${fade}`}
        >
          <Chevron d="M10 3L5 8l5 5" />
        </button>
      </div>

      <div className="grid flex-none grid-rows-[0fr] group-data-[sidebar=closed]/shell:grid-rows-[1fr]">
        <div className="min-h-0 overflow-hidden">
          <button
            type="button"
            ref={expandRef}
            aria-label="Expand sidebar"
            aria-keyshortcuts="["
            onClick={() => toggleFrom(false, expandRef, collapseRef)}
            className={"invisible mb-2 grid h-9 w-full place-items-center rounded-lg text-ink-3 opacity-0 transition-[opacity,visibility,background-color,color] duration-200 ease-hydra hover:bg-tint hover:text-ink group-data-[sidebar=closed]/shell:visible group-data-[sidebar=closed]/shell:opacity-100"}
          >
            <Chevron d="M6 3l5 5-5 5" />
          </button>
        </div>
      </div>

      <WithScope>
        {(scope) =>
          NAV.map((item) => {
            const on = isActive(item.href, active);
            return (
              <NavTip key={item.href} label={item.label} show={closed}>
                <Link
                  href={scopedHref(item.href, scope)}
                  aria-label={item.label}
                  aria-current={on ? "page" : undefined}
                  data-nav={item.href}
                  className={`${row} ${on ? "bg-tint font-medium text-ink" : "font-normal text-ink-3 hover:bg-tint active:bg-hover"}`}
                >
                  <Icon d={item.icon} />
                  <span className={fade}>{item.label}</span>
                </Link>
              </NavTip>
            );
          })
        }
      </WithScope>

      <AgentCard />

      <SignOutForm className="mt-2 flex-none">
        <NavTip label="Sign out" show={closed}>
          <button type="submit" aria-label="Sign out" data-testid="sign-out" className={`${row} w-full font-normal text-ink-3 hover:bg-tint hover:text-ink`}>
            <Icon d={SIGN_OUT_ICON} />
            <span className={fade}>Sign out</span>
          </button>
        </NavTip>
      </SignOutForm>
    </nav>
  );
}

/**
 * The app frame: desktop sidebar (>= 768 px), phone header, bottom tabs and Ask button (< 768 px).
 * Mount it once in a layout so it stays still across navigations. `activeHref` overrides the pathname
 * for fixture pages that are not real routes.
 */
export function AppShell({ children, activeHref }: { children: ReactNode; activeHref?: string }) {
  const pathname = usePathname();
  // A nav item shows as current on the click, not when the new page commits (UGM's sidebar marks the pending
  // link at once). It holds only while the page it was clicked from still shows.
  const [clicked, setClicked] = useState<{ href: string; from: string } | null>(null);
  if (clicked && clicked.from !== pathname) setClicked(null);
  // A navigation that fails or is abandoned never changes the pathname: drop the mark when the bar gives up too.
  useEffect(() => {
    if (!clicked) return;
    const t = window.setTimeout(() => setClicked(null), MAX_MS);
    return () => window.clearTimeout(t);
  }, [clicked]);
  const active = (clicked?.from === pathname ? clicked.href : null) ?? activeHref ?? pathname;
  const closed = useSidebarClosed();
  const onClickCapture = (e: MouseEvent) => {
    const href = (e.target as Element).closest<HTMLElement>("[data-nav]")?.dataset.nav;
    if (href && navTarget(e.nativeEvent)) setClicked({ href, from: pathname });
  };
  return (
    <AgentProvider>
      {/* Inside Hydra Desktop with setup missing, "Set up this Mac" takes the window until it is done. */}
      <SetupGate>
        <div data-sidebar={closed ? "closed" : "open"} suppressHydrationWarning className="group/shell flex min-h-dvh" onClickCapture={onClickCapture}>
          <InlineScript html={NO_FLASH} />
          <Sidebar active={active} closed={closed} />
          <div className="flex min-w-0 flex-1 flex-col">
            <PhoneHeader />
            {/* Phone: room for the tabs (68) and the agent float above them (12 gap + 58 tall) plus 16, so the float never covers the page's last row or button. */}
            <main className="flex-1 px-4 pt-4 pb-[calc(154px+env(safe-area-inset-bottom))] md:px-10 md:py-6">{children}</main>
          </div>
          <PhoneNav active={active} />
        </div>
      </SetupGate>
    </AgentProvider>
  );
}
