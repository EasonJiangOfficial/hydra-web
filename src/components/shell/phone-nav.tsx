"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { AgentFloat } from "@/components/agent/agent-card";
import { HydraMark, Icon, MORE, MORE_ICON, SIGN_OUT_ICON, SignOutForm, TABS, Wordmark, isActive } from "./nav";
import { ScopeMenu, WithScope, scopeApplies, scopedHref, type Scope } from "./scope";

/**
 * Phone (< 768 px) top row: mark, wordmark, and the scope menu on pages the scope filters. The min height
 * (20 px top pad + the menu button's 36 px) keeps the row still on pages without it.
 */
export function PhoneHeader() {
  const scoped = scopeApplies(usePathname());
  return (
    <header className="flex min-h-[56px] items-center gap-2 px-4 pt-5 md:hidden">
      <HydraMark />
      <Wordmark className="flex-1" />
      {scoped && <ScopeMenu />}
      {/* A page portals one control here (the Dashboard's Edit). */}
      <div id="phone-header-slot" className="contents" />
    </header>
  );
}

const tab =
  "relative flex flex-col items-center justify-center gap-1 text-micro leading-none transition-colors duration-200 ease-hydra";

function TabMarker({ on }: { on: boolean }) {
  return on ? <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-ink" /> : null;
}

// The More sheet is navigation, not a detail panel, so it stays a plain Radix Dialog rather than the URL-driven DetailDrawer.
function MoreSheet({ active, scope }: { active: string; scope: Scope }) {
  const [open, setOpen] = useState(false);
  const on = MORE.some((m) => isActive(m.href, active));
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={`${tab} ${on ? "text-ink" : "text-ink-3"}`}>
        <TabMarker on={on} />
        <Icon d={MORE_ICON} size={20} stroke={1.5} />
        More
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/20 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:pointer-events-none! data-[state=closed]:duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-280" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 rounded-t-xl border-t border-rule bg-surface px-4 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-7 data-[state=closed]:pointer-events-none! data-[state=closed]:duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-7 data-[state=open]:duration-280"
        >
          <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-sm bg-rule-2" />
          <Dialog.Title className="sr-only">More</Dialog.Title>
          <nav aria-label="More">
            {MORE.map((m) => {
              const here = isActive(m.href, active);
              return (
                <Link
                  key={m.href}
                  href={scopedHref(m.href, scope)}
                  aria-current={here ? "page" : undefined}
                  data-nav={m.href}
                  onClick={() => setOpen(false)}
                  className={`flex h-12 items-center gap-3 border-t border-rule text-tab first:border-t-0 ${here ? "font-medium text-ink" : "text-ink-2"}`}
                >
                  <Icon d={m.icon} />
                  {m.label}
                </Link>
              );
            })}
          </nav>
          <SignOutForm>
            <button type="submit" data-testid="sign-out-phone" className="flex h-12 w-full items-center gap-3 border-t border-rule text-left text-tab text-ink-2">
              <Icon d={SIGN_OUT_ICON} />
              Sign out
            </button>
          </SignOutForm>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Phone bottom tabs (68 px + safe area), with the Hydra Agent orb floating above them. */
export function PhoneNav({ active }: { active: string }) {
  return (
    <>
      <AgentFloat />
      <nav
        aria-label="Tabs"
        className="fixed inset-x-0 bottom-0 z-40 grid h-[calc(68px+env(safe-area-inset-bottom))] grid-cols-5 border-t border-rule bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <WithScope>
          {(scope) => (
            <>
              {TABS.map((t) => {
                const on = isActive(t.href, active);
                return (
                  <Link
                    key={t.href}
                    href={scopedHref(t.href, scope)}
                    aria-current={on ? "page" : undefined}
                    data-nav={t.href}
                    className={`${tab} ${on ? "text-ink" : "text-ink-3 active:opacity-60"}`}
                  >
                    <TabMarker on={on} />
                    <Icon d={t.icon} size={20} stroke={1.5} />
                    {t.label}
                  </Link>
                );
              })}
              <MoreSheet active={active} scope={scope} />
            </>
          )}
        </WithScope>
      </nav>
    </>
  );
}
