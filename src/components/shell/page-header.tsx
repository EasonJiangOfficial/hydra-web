"use client";

import { usePathname } from "next/navigation";
import { useId, useSyncExternalStore, type ReactNode } from "react";
import { InlineScript } from "./nav";
import { ScopeSwitch, scopeApplies } from "./scope";

const FORMAT = `{weekday:"long",month:"long",day:"numeric"}`;
const noop = () => () => {};
const today = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

/** "Saturday, November 21" in the browser's time zone. An inline script fills it before first paint. */
function TodayLabel() {
  const id = useId();
  const text = useSyncExternalStore(noop, today, () => "");
  return (
    <>
      <time id={id} suppressHydrationWarning className="text-label text-ink-3">
        {text}
      </time>
      <InlineScript
        html={`{var n=document.getElementById(${JSON.stringify(id)});if(n)n.textContent=new Date().toLocaleDateString("en-US",${FORMAT})}`}
      />
    </>
  );
}

/**
 * The desktop top bar (min 40 px): the page title on the left, or today's date on the Dashboard (no `title`),
 * and the scope switch on the right, only on pages the scope filters. On phone the scope switch lives in the shell
 * header, so only the title shows. `actions` (a page's own controls) sit on the right, on phone too.
 */
export function PageHeader({ title, actions }: { title?: string; actions?: ReactNode }) {
  const scoped = scopeApplies(usePathname());
  return (
    <>
      {/* Outside the bar: the bar is display:none on the phone Dashboard, and the h1 must stay in the a11y tree. */}
      {!title && <h1 className="sr-only">Dashboard</h1>}
      <div className={`min-h-10 items-center gap-2 ${title ? "flex" : "hidden md:flex"}`}>
        {title ? <h1 className="mr-2 text-title text-ink">{title}</h1> : <TodayLabel />}
        <div className="flex-1" />
        {actions}
        {scoped && (
          <div className="hidden md:block">
            <ScopeSwitch />
          </div>
        )}
      </div>
    </>
  );
}
