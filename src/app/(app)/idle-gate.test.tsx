import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleGate } from "./idle-gate";

const signOut = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({ auth: { signOut } }) }));

const START = Date.UTC(2026, 10, 21, 12);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  localStorage.clear();
  signOut.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function mount(minutes: number | null | "unknown") {
  const promise = Promise.resolve(minutes);
  await act(async () => {
    render(
      <IdleGate minutes={promise}>
        <p>Net worth</p>
      </IdleGate>,
    );
  });
}

it("shows the app at once and keeps it when the lock is off", async () => {
  await mount(null);
  expect(screen.getByText("Net worth")).toBeTruthy();
  expect(screen.queryByTestId("idle-lock")).toBeNull();
});

it("unmounts the app and shows the lock screen when the limit passes", async () => {
  await mount(5);
  expect(screen.getByText("Net worth")).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(5 * 60_000 + 1000);
  });
  expect(screen.queryByText("Net worth")).toBeNull();
  expect(screen.getByTestId("idle-lock")).toBeTruthy();
  expect(signOut).toHaveBeenCalled();
});

it("starts locked when the stored state says so: the app never mounts its content", async () => {
  localStorage.setItem("hydra:locked", "1");
  await mount(5);
  expect(screen.queryByText("Net worth")).toBeNull();
  expect(screen.getByTestId("idle-lock")).toBeTruthy();
});

/** A router.refresh(): the layout hands IdleGate a fresh settings promise. */
async function refresh(rerender: (ui: React.ReactElement) => void, minutes: number | null | "unknown") {
  const promise = Promise.resolve(minutes);
  await act(async () => {
    rerender(
      <IdleGate minutes={promise}>
        <p>Net worth</p>
      </IdleGate>,
    );
  });
}

it("keeps the app when the lock is turned off (5 -> null) and when it is turned on again", async () => {
  const promise = Promise.resolve<number | null>(5);
  let rerender!: (ui: React.ReactElement) => void;
  await act(async () => {
    ({ rerender } = render(
      <IdleGate minutes={promise}>
        <p>Net worth</p>
      </IdleGate>,
    ));
  });
  expect(screen.getByText("Net worth")).toBeTruthy();
  await refresh(rerender, null); // turned off, or the settings read failed on a refresh
  expect(screen.getByText("Net worth")).toBeTruthy();
  await refresh(rerender, null);
  expect(screen.getByText("Net worth")).toBeTruthy();
  await refresh(rerender, 5);
  expect(screen.getByText("Net worth")).toBeTruthy();
  await refresh(rerender, 10);
  expect(screen.getByText("Net worth")).toBeTruthy();
});

it("lock off drops the stored limit and a pre-paint hide, so the app shows", async () => {
  localStorage.setItem("hydra:idle-limit", String(5 * 60_000));
  const style = document.createElement("style");
  style.id = "hydra-idle-prepaint";
  document.head.appendChild(style);
  await mount(null);
  expect(document.getElementById("hydra-idle-prepaint")).toBeNull();
  expect(localStorage.getItem("hydra:idle-limit")).toBeNull();
  expect(screen.getByText("Net worth")).toBeTruthy();
});

it("a failed settings read is not 'off': the stored limit and the pre-paint hide stay, and the lock still runs", async () => {
  localStorage.setItem("hydra:idle-limit", String(5 * 60_000));
  localStorage.setItem("hydra:locked", "1");
  const style = document.createElement("style");
  style.id = "hydra-idle-prepaint";
  document.head.appendChild(style);
  await mount("unknown");
  expect(localStorage.getItem("hydra:idle-limit")).toBe(String(5 * 60_000));
  expect(screen.queryByText("Net worth")).toBeNull();
  expect(screen.getByTestId("idle-lock")).toBeTruthy();
});

it("a failed read on a refresh keeps the lock's state: locked stays locked, unlocked keeps counting", async () => {
  let rerender!: (ui: React.ReactElement) => void;
  const promise = Promise.resolve<number | null>(5);
  await act(async () => {
    ({ rerender } = render(
      <IdleGate minutes={promise}>
        <p>Net worth</p>
      </IdleGate>,
    ));
  });
  await refresh(rerender, "unknown");
  expect(screen.getByText("Net worth")).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(5 * 60_000 + 1000);
  });
  expect(screen.queryByText("Net worth")).toBeNull();
  await refresh(rerender, "unknown");
  expect(screen.queryByText("Net worth")).toBeNull();
  expect(screen.getByTestId("idle-lock")).toBeTruthy();
  expect(localStorage.getItem("hydra:idle-limit")).toBe(String(5 * 60_000));
});

it("a failed read with nothing stored shows the app", async () => {
  await mount("unknown");
  expect(screen.getByText("Net worth")).toBeTruthy();
  expect(screen.queryByTestId("idle-lock")).toBeNull();
});

it("lock on stores its limit for the next hard load's pre-paint script", async () => {
  await mount(5);
  expect(localStorage.getItem("hydra:idle-limit")).toBe(String(5 * 60_000));
});

describe("static pre-paint script (before the settings read and any page data)", () => {
  /** Server-render the gate with a settings read that never resolves, and run the first script in the HTML. */
  function firstScript() {
    const html = renderToString(
      <IdleGate minutes={new Promise(() => {})}>
        <p>Net worth</p>
      </IdleGate>,
    );
    const at = html.indexOf("<script");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf("data-idle-app"));
    return html.slice(html.indexOf(">", at) + 1, html.indexOf("</script>", at));
  }
  const run = () => {
    document.getElementById("hydra-idle-prepaint")?.remove();
    new Function(firstScript())();
    return document.getElementById("hydra-idle-prepaint");
  };
  afterEach(() => document.getElementById("hydra-idle-prepaint")?.remove());

  it("hides the app only when a stored limit says locked", () => {
    expect(run()).toBeNull(); // nothing stored
    localStorage.setItem("hydra:locked", "1");
    expect(run()).toBeNull(); // lock off: no stored limit
    localStorage.setItem("hydra:idle-limit", String(5 * 60_000));
    expect(run()?.textContent).toBe("[data-idle-app]{visibility:hidden}");
    localStorage.removeItem("hydra:locked");
    localStorage.setItem("hydra:last-activity", String(START - 4 * 60_000));
    expect(run()).toBeNull(); // inside the limit
    localStorage.setItem("hydra:last-activity", String(START - 5 * 60_000));
    expect(run()).not.toBeNull(); // past the limit
  });

  it("adds the style once, so the lock's removal is not undone by a second script", () => {
    localStorage.setItem("hydra:idle-limit", String(5 * 60_000));
    localStorage.setItem("hydra:locked", "1");
    run();
    new Function(firstScript())();
    expect(document.querySelectorAll("#hydra-idle-prepaint")).toHaveLength(1);
  });
});
