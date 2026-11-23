import { act, cleanup, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldStartLocked } from "@/lib/auth/idle";
import { IdleLock } from "./idle-lock";

const signOut = vi.fn(async (opts: { scope: string }) => ({ error: null, opts }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({ auth: { signOut } }) }));

const MIN = 60_000;
const START = Date.UTC(2026, 10, 21, 12);

function App() {
  return (
    <>
      <p>Net worth</p>
      {createPortal(
        <div data-testid="sheet">
          <button type="button" autoFocus>
            In the sheet
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  localStorage.clear();
  document.getElementById("hydra-idle-prepaint")?.remove();
  signOut.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IdleLock", () => {
  it("renders the app visible before the stored state is read", () => {
    // No effects: this is what the server renders and what hydration must match.
    const { container } = render(
      <IdleLock storagePrefix="t">
        <p>Net worth</p>
      </IdleLock>,
    );
    const app = container.querySelector("[data-idle-app]");
    expect(app?.textContent).toBe("Net worth");
    expect(app?.getAttribute("class")).toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("locking unmounts the app and its portals, focuses Unlock, and signs the session out", async () => {
    render(
      <IdleLock minutes={1} storagePrefix="t">
        <App />
      </IdleLock>,
    );
    expect(screen.getByTestId("sheet")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(screen.queryByTestId("idle-lock")).toBeNull();
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(screen.getByTestId("idle-lock")).toBeTruthy();
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(screen.queryByText("Net worth")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Unlock with passkey" }));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(localStorage.getItem("t:locked")).toBe("1");
    expect(localStorage.getItem("hydra:locked")).toBeNull();
  });

  it("a stored lock from another prefix does not lock this one", async () => {
    localStorage.setItem("hydra-dev-lock:locked", "1");
    render(
      <IdleLock>
        <p>Net worth</p>
      </IdleLock>,
    );
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(screen.queryByTestId("idle-lock")).toBeNull();
    expect(screen.getByText("Net worth")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("starts locked from storage and removes the pre-paint style once read", async () => {
    localStorage.setItem("t:locked", "1");
    const style = Object.assign(document.createElement("style"), { id: "hydra-idle-prepaint" });
    document.head.appendChild(style);
    render(
      <IdleLock storagePrefix="t">
        <p>Net worth</p>
      </IdleLock>,
    );
    await act(async () => {});
    expect(screen.getByTestId("idle-lock")).toBeTruthy();
    expect(screen.queryByText("Net worth")).toBeNull();
    expect(document.getElementById("hydra-idle-prepaint")).toBeNull();
  });
});

describe("pre-paint script", () => {
  /** The script exactly as rendered; rendering runs the timer, so storage is set aside meanwhile. */
  function runScript(prefix: string, minutes: number) {
    const saved = { ...localStorage };
    localStorage.clear();
    const { container, unmount } = render(
      <IdleLock storagePrefix={prefix} minutes={minutes}>
        <p>x</p>
      </IdleLock>,
    );
    const code = container.querySelector("script")?.innerHTML ?? "";
    unmount();
    localStorage.clear();
    Object.entries(saved).forEach(([k, v]) => localStorage.setItem(k, v));
    document.getElementById("hydra-idle-prepaint")?.remove();
    new Function(code)();
    return document.getElementById("hydra-idle-prepaint");
  }

  it("hides the app when locked or past the limit, and only then", () => {
    expect(runScript("t", 5)).toBeNull(); // nothing stored: first visit
    localStorage.setItem("t:last-activity", String(START - 4 * MIN));
    expect(runScript("t", 5)).toBeNull(); // inside the limit
    localStorage.setItem("t:last-activity", String(START - 5 * MIN));
    expect(runScript("t", 5)?.textContent).toBe("[data-idle-app]{visibility:hidden}");
    localStorage.clear();
    localStorage.setItem("t:locked", "1");
    expect(runScript("t", 5)).not.toBeNull();
    expect(runScript("other", 5)).toBeNull(); // another prefix
  });

  it("agrees with the timer's start rule for an injected clock", () => {
    localStorage.setItem("k:last-activity", "1000");
    expect(shouldStartLocked("k:locked", "k:last-activity", 500, 1499)).toBe(false);
    expect(shouldStartLocked("k:locked", "k:last-activity", 500, 1500)).toBe(true);
    localStorage.setItem("k:locked", "1");
    expect(shouldStartLocked("k:locked", "k:last-activity", 500, 1000)).toBe(true);
  });
});
