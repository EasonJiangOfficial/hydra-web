"use client";

import { useEffect, useRef } from "react";

/**
 * The route skeleton (loading.tsx) and any skeleton block inside the new page. A block marked `data-lazy`
 * (the UGC analytics) keeps its skeleton until it scrolls near the viewport: that is not loading.
 */
const LOADING = '[role="status"][aria-label^="Loading"], [data-slot="skeleton"]';
const LOADING_NOW = `main :is(${LOADING}):not([data-lazy] *)`;
/** A page that shows within this long gets no bar at all (a cached page, a slide-out opening). */
export const SHOW_MS = 120;
/** Never run longer than this: a page that keeps a skeleton for good must not keep the bar. */
export const MAX_MS = 10_000;

const here = () => location.pathname + location.search;

/** The in-app path a click goes to, or null when the click is not a client navigation to another page. */
export function navTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return null;
  const to = url.pathname + url.search;
  return to === here() ? null : to;
}

/**
 * A thin ink bar along the top of the content area. It shows when an in-app page change (a link click, or
 * Back and Forward) takes longer than SHOW_MS, creeps while the new page loads, and finishes once the page
 * shows with no skeleton left. The check runs a frame after the DOM changes, so on Back it sees the page
 * React restored, not the one it replaces.
 * Motion is transform and opacity only; with reduced motion it is a still, full bar until the page shows.
 */
export function NavProgress() {
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    let target: string | null = null;
    let shown = false;
    let observer: MutationObserver | null = null;
    let frame = 0;
    let show = 0;
    let timer = 0;
    let hide = 0;

    const set = (scale: number, opacity: number, transition: string) => {
      el.style.transition = still.matches ? "none" : transition;
      el.style.transform = `scaleX(${scale})`;
      el.style.opacity = String(opacity);
    };

    const stop = () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(show);
      window.clearTimeout(timer);
    };

    const finish = () => {
      if (target === null) return;
      target = null;
      stop();
      if (!shown || still.matches) return set(0, 0, "none");
      set(1, 1, "transform 150ms ease");
      hide = window.setTimeout(() => set(1, 0, "opacity 200ms ease"), 150);
    };

    const check = () => {
      if (target !== null && here() === target && !document.querySelector(LOADING_NOW)) finish();
    };
    const checkNextFrame = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };

    const start = (to: string) => {
      window.clearTimeout(hide);
      stop();
      target = to;
      shown = false;
      set(0, 0, "none");
      show = window.setTimeout(() => {
        shown = true;
        // From zero, then a quick first stretch and a slow crawl toward 90 %.
        set(0, 1, "none");
        void el.offsetWidth;
        set(still.matches ? 1 : 0.9, 1, "transform 8s cubic-bezier(0.08, 0.7, 0.2, 1)");
      }, SHOW_MS);
      observer = new MutationObserver(checkNextFrame);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-slot", "aria-label", "data-lazy"],
      });
      timer = window.setTimeout(finish, MAX_MS);
    };

    // Capture phase: runs before Next's Link handles (and prevents) the click.
    const onClick = (e: MouseEvent) => {
      const to = navTarget(e);
      if (to) start(to);
    };
    // The URL has already changed; the restored page renders later, and the observer checks it then.
    const onPop = () => start(here());

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      stop();
      window.clearTimeout(hide);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 md:left-(--sidebar-open) md:group-data-[sidebar=closed]/shell:left-(--sidebar-closed)"
    >
      <div ref={bar} data-testid="nav-progress" className="h-full origin-left bg-ink" style={{ transform: "scaleX(0)", opacity: 0 }} />
    </div>
  );
}
