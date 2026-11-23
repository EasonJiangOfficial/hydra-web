import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PushButton } from "./push-button";

const ui = () => (
  <TooltipProvider>
    <PushButton />
  </TooltipProvider>
);

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

/** A browser with push: a worker registration whose pushManager starts with `existing`. */
function pushBrowser(existing: { endpoint: string; unsubscribe: () => Promise<boolean> } | null) {
  const created = {
    endpoint: "https://push.example/new",
    toJSON: () => ({ endpoint: "https://push.example/new", keys: { p256dh: "pk", auth: "ak" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const pushManager = { getSubscription: vi.fn().mockResolvedValue(existing), subscribe: vi.fn().mockResolvedValue(created) };
  const registration = { pushManager };
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission: vi.fn().mockResolvedValue("granted") }));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(registration), register: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) },
  });
  return { pushManager, created };
}

beforeEach(() => {
  setUserAgent("Mozilla/5.0 (Macintosh)");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("PushButton", () => {
  it("is disabled in Safari on an iPhone, where web push needs the Home Screen app", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    render(ui());
    const button = await screen.findByRole("button", { name: "Turn on notifications" });
    await waitFor(() => expect(button).toBeDisabled());
  });

  it("subscribes: asks permission, fetches the public key, stores the subscription", async () => {
    const { pushManager } = pushBrowser(null);
    const fetchMock = vi.fn(async (url: string) =>
      Response.json({ ok: true, data: url.endsWith("/key") ? { publicKey: "BAUE" } : { saved: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(ui());
    const button = await screen.findByRole("button", { name: "Turn on notifications" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByRole("button", { name: "Turn off notifications" })).toBeInTheDocument();
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) });
    const save = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url === "/api/push/subscribe")!;
    expect(JSON.parse(save[1].body as string)).toEqual({ endpoint: "https://push.example/new", keys: { p256dh: "pk", auth: "ak" } });
  });

  it("rolls the browser subscription back when the server does not store it", async () => {
    const { created } = pushBrowser(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/key") ? Response.json({ ok: true, data: { publicKey: "BAUE" } }) : Response.json({ ok: false }, { status: 500 }),
      ),
    );
    render(ui());
    const button = await screen.findByRole("button", { name: "Turn on notifications" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("Could not change notifications");
    expect(created.unsubscribe).toHaveBeenCalled();
  });

  it("unsubscribes: tells the server, then the browser", async () => {
    const existing = { endpoint: "https://push.example/old", unsubscribe: vi.fn().mockResolvedValue(true) };
    pushBrowser(existing);
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { removed: true } }));
    vi.stubGlobal("fetch", fetchMock);
    render(ui());
    await userEvent.click(await screen.findByRole("button", { name: "Turn off notifications" }));
    expect(await screen.findByRole("button", { name: "Turn on notifications" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/push/unsubscribe", expect.objectContaining({ body: JSON.stringify({ endpoint: "https://push.example/old" }) }));
    expect(existing.unsubscribe).toHaveBeenCalled();
  });
});
