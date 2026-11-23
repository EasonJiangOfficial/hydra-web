"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Turns phone and browser notifications on or off for this device. Goes in Settings, Connections.
 * iPhone and iPad only allow web push from an app installed to the Home Screen (iOS 16.4 or later);
 * in a Safari tab there is no PushManager, so the button explains that instead.
 */

type State = "checking" | "unsupported" | "install" | "denied" | "off" | "on";

const HINT: Record<Exclude<State, "checking" | "off" | "on">, string> = {
  unsupported: "This browser cannot receive notifications",
  install: "On iPhone, add Hydra to the Home Screen first: Share, then Add to Home Screen",
  denied: "Notifications are blocked. Allow them in the browser or phone settings",
};

function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function keyBytes(base64Url: string) {
  const raw = atob(base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { ok: boolean; data?: T };
  if (!response.ok || !json.ok) throw new Error(url);
  return json.data as T;
}

export function PushButton() {
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!supported) return live && setState(isIos() ? "install" : "unsupported");
      if (Notification.permission === "denied") return live && setState("denied");
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      if (live) setState(existing ? "on" : "off");
    })().catch(() => live && setState("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  async function turnOn() {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);
    if ((await Notification.requestPermission()) !== "granted") return setState(Notification.permission === "denied" ? "denied" : "off");
    const { publicKey } = await call<{ publicKey: string }>("/api/push/key");
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    try {
      await call("/api/push/subscribe", subscription.toJSON());
    } catch (error) {
      await subscription.unsubscribe(); // do not keep a browser subscription the server never stored
      throw error;
    }
    setState("on");
  }

  async function turnOff() {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await call("/api/push/unsubscribe", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    setState("off");
  }

  async function toggle() {
    setBusy(true);
    setFailed(false);
    try {
      await (state === "on" ? turnOff() : turnOn());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const blocked = state === "unsupported" || state === "install" || state === "denied";
  const button = (
    <Button onClick={toggle} disabled={busy || blocked || state === "checking"} aria-busy={busy}>
      {state === "on" ? "Turn off notifications" : "Turn on notifications"}
    </Button>
  );

  return (
    <div className="flex items-center gap-3">
      {blocked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{button}</span>
          </TooltipTrigger>
          <TooltipContent>{HINT[state]}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {failed && (
        <span role="status" className="text-body text-ink">
          Could not change notifications
        </span>
      )}
    </div>
  );
}
