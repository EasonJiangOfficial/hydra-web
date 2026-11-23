import { afterEach, expect, it } from "vitest";
import { drawerClickTarget, type DrawerParam } from "./drawer";

/** Clicks the first link in `html` with the page at `at`, and returns what the drawer would open. */
function clickOn(at: string, html: string, param: DrawerParam, init: MouseEventInit = {}) {
  window.history.replaceState(null, "", at);
  document.body.innerHTML = html;
  let target: string | null = "unset";
  const grab = (e: MouseEvent) => (target = drawerClickTarget(e, param));
  window.addEventListener("click", grab, true);
  document.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  window.removeEventListener("click", grab, true);
  return target;
}

afterEach(() => window.history.replaceState(null, "", "/"));

it("opens on the click a link that only sets this drawer's param on this page", () => {
  expect(clickOn("/ugc?tab=deals", '<a href="/ugc?tab=deals&deal=d1"><span>Open</span></a>', "deal")).toBe("/ugc?tab=deals&deal=d1");
  // One panel at a time: dropping another drawer's param is still only a drawer change.
  expect(clickOn("/planning?task=t1", '<a href="/planning?goal=g1">Goal</a>', "goal")).toBe("/planning?goal=g1");
});

it("leaves every other click to the router", () => {
  expect(clickOn("/ugc", '<a href="/accounts?account=a1">x</a>', "account")).toBeNull(); // another page
  expect(clickOn("/taxes?year=2025", '<a href="/taxes?year=2026&taxline=l1">x</a>', "taxline")).toBeNull(); // a server param changes
  expect(clickOn("/ugc", '<a href="/ugc?deal=d1">x</a>', "day")).toBeNull(); // another drawer's link
  expect(clickOn("/ugc?deal=d1", '<a href="/ugc?deal=d1">x</a>', "deal")).toBeNull(); // already open
  expect(clickOn("/ugc", '<a href="/ugc?deal=d1">x</a>', "deal", { metaKey: true })).toBeNull(); // new tab
  expect(clickOn("/ugc", '<a href="/ugc?deal=d1" target="_blank">x</a>', "deal")).toBeNull();
});
