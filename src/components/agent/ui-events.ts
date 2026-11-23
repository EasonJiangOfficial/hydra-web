import type { UiEvent } from "./types";

/** What the interface steps need from the app: the Next router, as plain functions. */
export type Nav = {
  push(href: string): void;
  replace(href: string): void;
};

/** `href` with one search param set, keeping the rest of the current URL. */
export function withParam(current: { pathname: string; search: string }, key: string, value: string | null) {
  const q = new URLSearchParams(current.search);
  if (value === null) q.delete(key);
  else q.set(key, value);
  const s = q.toString();
  return s ? `${current.pathname}?${s}` : current.pathname;
}

/** Runs the agent's interface steps: navigate, open a panel through its search param, set the scope, highlight an element. */
export function runUi(ev: UiEvent, nav: Nav, here: () => { pathname: string; search: string } = () => window.location) {
  switch (ev.kind) {
    case "navigate":
      return nav.push(ev.href);
    case "openPanel":
      return nav.push(withParam(here(), ev.param, ev.value));
    case "setScope":
      return nav.replace(withParam(here(), "scope", ev.scope === "all" ? null : ev.scope));
    case "highlight":
      return highlight(ev.selector);
  }
}

const HIGHLIGHT_MS = 2400;

/**
 * Rings the first element matching the CSS `selector` for 2.4 s and scrolls it into view. After a navigation the
 * element may not exist yet, so it looks for up to 2 s. A selector that does not parse is ignored.
 */
export function highlight(selector: string, doc: Document = document) {
  const started = Date.now();
  const find = () => {
    let found: HTMLElement | null;
    try {
      found = doc.querySelector<HTMLElement>(selector);
    } catch {
      return;
    }
    const el = found;
    if (!el) {
      if (Date.now() - started < 2000) setTimeout(find, 100);
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    const prev = { outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = "2px solid var(--ink, #1d1d1f)";
    el.style.outlineOffset = "2px";
    el.setAttribute("data-agent-highlighted", "");
    setTimeout(() => {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.offset;
      el.removeAttribute("data-agent-highlighted");
    }, HIGHLIGHT_MS);
  };
  find();
}
