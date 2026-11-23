import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavProgress, SHOW_MS, navTarget } from "./nav-progress";

function clickOn(html: string, init: MouseEventInit = {}) {
  document.body.innerHTML = html;
  let target: string | null = "unset";
  const grab = (e: MouseEvent) => (target = navTarget(e));
  document.addEventListener("click", grab, true);
  document.querySelector("a, span")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  document.removeEventListener("click", grab, true);
  return target;
}

/** Lets the DOM observer run, then moves the clock (timers and animation frames) on by `ms`. */
async function later(ms: number, change?: () => void) {
  await act(async () => {
    change?.();
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
  });
}

function mount(reduced = false) {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const { getByTestId, container } = render(
    <>
      <NavProgress />
      <main />
      <a href="/planning">Planning</a>
    </>,
  );
  const main = container.querySelector("main")!;
  const click = () => container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  return { bar: getByTestId("nav-progress"), main, click };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

it("starts only for a plain click on an in-app link to another page", () => {
  expect(clickOn('<a href="/planning"><span>Planning</span></a>')).toBe("/planning");
  expect(clickOn('<a href="/reports?month=2026-10">R</a>')).toBe("/reports?month=2026-10");
  expect(clickOn('<a href="/">Home</a>')).toBeNull(); // already here
  expect(clickOn('<a href="https://example.com/x">x</a>')).toBeNull();
  expect(clickOn('<a href="/taxes" target="_blank">t</a>')).toBeNull();
  expect(clickOn('<a href="/export.csv" download>d</a>')).toBeNull();
  expect(clickOn('<a href="/taxes">t</a>', { metaKey: true })).toBeNull();
  expect(clickOn("<span>no link</span>")).toBeNull();
});

it("shows after a short wait, runs while the skeleton is up, and finishes once the page shows", async () => {
  const { bar, main, click } = mount();
  click();
  expect(bar.style.opacity).toBe("0");

  // The new URL with the route skeleton, slower than the show delay: the bar comes on and crawls.
  await later(SHOW_MS + 20, () => {
    window.history.pushState(null, "", "/planning");
    main.innerHTML = '<div role="status" aria-label="Loading Planning"></div>';
  });
  expect(bar.style.opacity).toBe("1");
  expect(bar.style.transform).toBe("scaleX(0.9)");

  // The content replaces the skeleton: the bar fills, then fades.
  await later(20, () => (main.innerHTML = "<h1>Planning</h1>"));
  expect(bar.style.transform).toBe("scaleX(1)");
  await later(200);
  expect(bar.style.opacity).toBe("0");
});

it("never shows for a page that is there at once", async () => {
  const { bar, main, click } = mount();
  click();
  await later(20, () => {
    window.history.pushState(null, "", "/planning");
    main.innerHTML = "<h1>Planning</h1>";
  });
  for (let t = 0; t < 1000; t += 20) {
    await later(20);
    expect(bar.style.opacity).toBe("0");
  }
});

it("does not wait for a skeleton that waits for a scroll", async () => {
  const { bar, main, click } = mount();
  click();
  await later(SHOW_MS + 20, () => {
    window.history.pushState(null, "", "/planning");
    main.innerHTML = '<div role="status" aria-label="Loading UGC"></div>';
  });
  expect(bar.style.transform).toBe("scaleX(0.9)");
  await later(20, () => (main.innerHTML = '<h1>UGC</h1><div data-lazy><div data-slot="skeleton"></div></div>'));
  expect(bar.style.transform).toBe("scaleX(1)");
  await later(200);
  expect(bar.style.opacity).toBe("0");
});

it("on Back, waits for the page React restores, not the one it replaces", async () => {
  const { bar, main } = mount();
  main.innerHTML = "<h1>Taxes</h1>";
  window.history.pushState(null, "", "/reports");
  // The old page (no skeleton) is still up when popstate fires.
  await later(SHOW_MS + 20, () => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(bar.style.opacity).toBe("1");
  expect(bar.style.transform).toBe("scaleX(0.9)");
  // The restored page needs its data: its skeleton keeps the bar running.
  await later(100, () => (main.innerHTML = '<div role="status" aria-label="Loading Reports"></div>'));
  expect(bar.style.transform).toBe("scaleX(0.9)");
  await later(20, () => (main.innerHTML = "<h1>Reports</h1>"));
  expect(bar.style.transform).toBe("scaleX(1)");
});

it("with reduced motion the bar is still and full, then gone", async () => {
  const { bar, main, click } = mount(true);
  click();
  await later(SHOW_MS + 20, () => {
    window.history.pushState(null, "", "/planning");
    main.innerHTML = '<div role="status" aria-label="Loading Planning"></div>';
  });
  expect(bar.style.transition).toBe("none");
  expect(bar.style.opacity).toBe("1");
  expect(bar.style.transform).toBe("scaleX(1)");
  await later(20, () => (main.innerHTML = "<h1>Planning</h1>"));
  expect(bar.style.opacity).toBe("0");
});
