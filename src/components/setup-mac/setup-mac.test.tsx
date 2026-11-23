import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBridge, SETUP_DONE } from "@/app/dev/agent/fake-bridge";
import type { HydraDesktopBridge } from "@/components/agent/types";
import { FIRST_ANSWER_MS, PAIR_SLOW_MS, SetupGate } from "./setup-mac";
import { pairMac, parseSetup, readSkipped, setupBridge, setupComplete, SKIP_KEY, stepStatus } from "./steps";

const NOT_SET = { paired: false, claude: "signed_out" as const, permissions: { mic: "not_determined" as const, accessibility: "not_determined" as const, screen: "not_determined" as const } };
const pairOk = () => vi.fn<typeof fetch>(async () => Response.json({ code: "ABCD-1234", expiresAt: "2026-11-22T00:00:00Z" }));

afterEach(() => {
  cleanup();
  delete window.hydraDesktop;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

async function mount(b: HydraDesktopBridge | undefined, f = pairOk()) {
  if (b) window.hydraDesktop = b;
  vi.stubGlobal("fetch", f);
  await act(async () => {
    render(
      <SetupGate>
        <p>The app</p>
      </SetupGate>,
    );
  });
  return f;
}
const state = (id: string) => screen.getByTestId(`setup-step-${id}`).getAttribute("data-state");

describe("steps", () => {
  it("reads each step from setup()", () => {
    expect(setupComplete(SETUP_DONE)).toBe(true);
    const s = { ...SETUP_DONE, claude: "signed_out" as const, permissions: { mic: "granted" as const, accessibility: "denied" as const, screen: "not_determined" as const } };
    expect(["pair", "claude", "mic", "accessibility", "screen"].map((id) => stepStatus(s, id as never))).toEqual(["done", "todo", "done", "denied", "todo"]);
    expect(setupComplete(s)).toBe(false);
  });

  it("only a v3 bridge has setup: v1 and v2 never get the gate", () => {
    expect(setupBridge(undefined)).toBeNull();
    expect(setupBridge(fakeBridge(1).bridge)).toBeNull();
    expect(setupBridge(fakeBridge(2).bridge)).toBeNull();
    expect(setupBridge(fakeBridge(3).bridge)).not.toBeNull();
  });

  it("pairMac asks the owner session for a code with the relay scope and hands it to the desktop", async () => {
    const fake = fakeBridge(3, { setup: NOT_SET });
    const f = pairOk();
    expect(await pairMac(setupBridge(fake.bridge)!, f)).toBe(true);
    expect(f).toHaveBeenCalledWith("/api/agent/devices/pair", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ name: "Hydra Desktop", scopes: ["agent", "mcp", "relay"] });
    expect(fake.calls).toContain("pair:ABCD-1234");
  });

  it("pairMac fails without calling the desktop when the server says no, and fails when the desktop says no", async () => {
    const fake = fakeBridge(3, { setup: NOT_SET });
    expect(await pairMac(setupBridge(fake.bridge)!, vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })))).toBe(false);
    expect(await pairMac(setupBridge(fake.bridge)!, vi.fn(async () => Response.json({ nope: 1 })))).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("pair:"))).toBe(false);
    const failing = fakeBridge(3, { failPair: true, setup: NOT_SET });
    expect(await pairMac(setupBridge(failing.bridge)!, pairOk())).toBe(false);
  });
});

describe("parseSetup", () => {
  it("takes only the setup() shape; a failed ask or anything else is null", () => {
    expect(parseSetup(SETUP_DONE)).toEqual(SETUP_DONE);
    expect(parseSetup({ ...SETUP_DONE, version: undefined })).toEqual({ ...SETUP_DONE, version: "" });
    for (const bad of [null, undefined, "x", { ok: false, error: "timeout" }, { ...SETUP_DONE, paired: "yes" }, { ...SETUP_DONE, claude: "maybe" }, { ...SETUP_DONE, permissions: null }, { ...SETUP_DONE, permissions: { mic: "granted" } }, { ...SETUP_DONE, permissions: { ...SETUP_DONE.permissions, screen: "on" } }]) {
      expect(parseSetup(bad)).toBeNull();
    }
  });
});

/** The app under the gate stays mounted; while the gate shows it is inert. */
const appCovered = () => screen.getByTestId("setup-app").hasAttribute("inert");

describe("SetupGate", () => {
  it("is the app, untouched, without a bridge (the website, the phone) and under a v1 or v2 desktop", async () => {
    const f = await mount(undefined);
    expect(screen.getByText("The app")).toBeInTheDocument();
    expect(appCovered()).toBe(false);
    cleanup();
    await mount(fakeBridge(2).bridge, f);
    expect(screen.getByText("The app")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-mac")).toBeNull();
    expect(appCovered()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("is the app when setup() reports nothing missing", async () => {
    await mount(fakeBridge(3).bridge);
    expect(screen.queryByTestId("setup-mac")).toBeNull();
    expect(appCovered()).toBe(false);
  });

  it("covers the app (blank) until the first answer, so it never flashes; the app is mounted once, never again", async () => {
    let answer: (v: unknown) => void = () => {};
    const fake = fakeBridge(3);
    Object.defineProperty(fake.bridge, "setup", { value: () => new Promise((r) => (answer = r)) });
    let mounts = 0;
    function App() {
      useEffect(() => void mounts++, []);
      return <p>The app</p>;
    }
    window.hydraDesktop = fake.bridge;
    await act(async () => {
      render(
        <SetupGate>
          <App />
        </SetupGate>,
      );
    });
    expect(screen.getByTestId("setup-wait")).toBeInTheDocument();
    expect(appCovered()).toBe(true);
    await act(async () => answer(SETUP_DONE));
    expect(screen.queryByTestId("setup-wait")).toBeNull();
    expect(appCovered()).toBe(false);
    expect(mounts).toBe(1);
  });

  it("a desktop that never answers setup() gets the app after the wait, with nothing paired", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeBridge(3);
    Object.defineProperty(fake.bridge, "setup", { value: () => new Promise(() => {}) });
    const f = await mount(fake.bridge);
    expect(appCovered()).toBe(true);
    await act(async () => void vi.advanceTimersByTime(FIRST_ANSWER_MS));
    expect(appCovered()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("an answer of the wrong shape (a failed ask) opens nothing and never pairs", async () => {
    const fake = fakeBridge(3);
    Object.defineProperty(fake.bridge, "setup", { value: async () => ({ ok: false, error: "keychain" }) });
    const f = await mount(fake.bridge);
    expect(screen.queryByTestId("setup-mac")).toBeNull();
    expect(appCovered()).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.startsWith("pair:"))).toBe(false);
  });

  it("never auto-pairs a Mac that is already paired", async () => {
    const fake = fakeBridge(3, { setup: { claude: "signed_out" } });
    const f = await mount(fake.bridge);
    expect(state("pair")).toBe("done");
    expect(state("claude")).toBe("todo");
    expect(f).not.toHaveBeenCalled();
  });

  it("pairs on load with no click and the code never shows, then each step to the app", async () => {
    const fake = fakeBridge(3, { setup: NOT_SET });
    const f = await mount(fake.bridge);
    await waitFor(() => expect(state("pair")).toBe("done"));
    expect(f).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/ABCD-1234/)).toBeNull();
    expect(appCovered()).toBe(true);
    expect(state("claude")).toBe("todo");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(state("claude")).toBe("done"));
    for (const id of ["mic", "accessibility", "screen"]) {
      fireEvent.click(screen.getByTestId(`setup-step-${id}`).querySelector("button:not([data-slot=info-dot])")!);
      await waitFor(() => expect(state(id)).toBe("done"));
    }
    expect(fake.calls).toEqual(expect.arrayContaining(["signInClaude", "permission:mic", "permission:accessibility", "permission:screen"]));
    await waitFor(() => expect(screen.queryByTestId("setup-mac")).toBeNull());
    expect(appCovered()).toBe(false);
  });

  it("a failed pair leaves a Retry button and does not loop", async () => {
    const fake = fakeBridge(3, { failPair: true, setup: NOT_SET });
    const f = await mount(fake.bridge);
    await waitFor(() => expect(state("pair")).toBe("failed"));
    expect(f).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(state("pair")).toBe("failed"));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("pair() says ok but setup() still says unpaired: Failed with Retry, never stuck on Pairing", async () => {
    const fake = fakeBridge(3, { setup: NOT_SET });
    Object.defineProperty(fake.bridge, "pair", { value: async () => ({ ok: true }) });
    await mount(fake.bridge);
    await waitFor(() => expect(state("pair")).toBe("failed"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("pairing with no answer for 20 s shows Retry; a retry that works wins over the old try", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeBridge(3, { setup: NOT_SET });
    let tries = 0; // the first try never answers, the retry works
    Object.defineProperty(fake.bridge, "pair", { value: () => (++tries === 1 ? new Promise(() => {}) : ((fake.setup.paired = true), Promise.resolve({ ok: true }))) });
    const f = await mount(fake.bridge);
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(state("pair")).toBe("working");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(PAIR_SLOW_MS)));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(state("pair")).toBe("done");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("Claude sign-in can be cancelled; its late answer changes nothing on screen", async () => {
    let finish: () => void = () => {};
    const fake = fakeBridge(3, { setup: { claude: "signed_out" } });
    Object.defineProperty(fake.bridge, "signInClaude", { value: () => new Promise((r) => (finish = () => r({ ok: false, error: "closed" }))) });
    await mount(fake.bridge);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(state("claude")).toBe("working"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state("claude")).toBe("todo");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    await act(async () => finish());
    expect(state("claude")).toBe("todo"); // the cancelled try's failure is not shown
  });

  it("a refused permission can be skipped, and the skip is remembered on this Mac", async () => {
    const fake = fakeBridge(3, { deny: ["screen"], setup: { permissions: { screen: "denied" } } });
    await mount(fake.bridge);
    expect(state("screen")).toBe("denied");
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(readSkipped()).toEqual(["screen"]);
    expect(JSON.parse(localStorage.getItem(SKIP_KEY)!)).toEqual(["screen"]);
    await waitFor(() => expect(screen.queryByTestId("setup-mac")).toBeNull());
    cleanup();
    await mount(fakeBridge(3, { setup: { permissions: { screen: "denied" } } }).bridge);
    expect(screen.queryByTestId("setup-mac")).toBeNull(); // the next launch: no gate
    expect(setupComplete({ ...SETUP_DONE, paired: false }, ["mic", "accessibility", "screen"])).toBe(false); // pair can never be skipped
  });

  it("Later shows the app", async () => {
    await mount(fakeBridge(3, { setup: { permissions: { screen: "denied" } } }).bridge);
    fireEvent.click(screen.getByTestId("setup-later"));
    expect(screen.queryByTestId("setup-mac")).toBeNull();
    expect(appCovered()).toBe(false);
  });
});

