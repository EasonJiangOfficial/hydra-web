import { devices, type Page } from "@playwright/test";

/*
 * Hydra Desktop's window: WKWebView (so WebKit, with the user agent Tauri sends) and the bridge script the app injects
 * before the page runs. BRIDGE_JS below is Hydra Desktop's own script, copied from showcase/tauri/src-tauri/src/hydra.rs
 * (version 2, the shipped build; docs/BRIDGE.md there). Only two things change: it runs on this server's origin
 * instead of https://your-hydra.example.com, and its native transport (a hydra-desktop:// navigation the app
 * cancels) records the call instead.
 */
export const BRIDGE_JS = String.raw`(() => {
  if (location.origin !== 'https://your-hydra.example.com' || window.hydraDesktop || window.top !== window) return;
  const T = '__HYDRA_TOKEN__';
  let snap = { state: 'Asleep', micLevel: 0, outputLevel: 0, detached: false };
  const subs = new Set();
  const call = (cmd, extra = '') => { location.href = 'hydra-desktop://' + cmd + '?t=' + T + extra; };
  Object.defineProperty(window, 'hydraDesktop', { value: Object.freeze({
    version: 2,
    get state() { return snap.state; },
    get detached() { return snap.detached; },
    get micLevel() { return snap.micLevel; },
    get outputLevel() { return snap.outputLevel; },
    snapshot: () => ({ ...snap }),
    subscribe(fn) { subs.add(fn); try { fn({ ...snap }); } catch {} return () => subs.delete(fn); },
    wake: () => call('wake'),
    sleep: () => call('sleep'),
    detach: () => call('detach'),
    attach: () => call('attach'),
  }) });
  Object.defineProperty(window, '__hydraDesktopPush', { value: (m) => {
    snap = { ...snap, ...m };
    for (const fn of subs) { try { fn({ ...snap }); } catch {} }
    window.dispatchEvent(new CustomEvent('hydradesktop', { detail: { ...snap } }));
  } });
})();`;

/** Tauri's WKWebView on macOS sends WebKit's default user agent: no "Version/" and no "Safari/". */
export const WKWEBVIEW_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/** The Hydra Desktop window for test.use(): WebKit, 1440 x 900, the WKWebView user agent. */
export const DESKTOP_WINDOW = { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 }, userAgent: WKWEBVIEW_UA, launchOptions: {} };

/** Injects the real bridge on `origin` before any page script runs; page errors go to `errors`. */
export async function installBridge(page: Page, origin: string, errors: string[]) {
  const script = BRIDGE_JS.replace("https://your-hydra.example.com", origin)
    .replace("__HYDRA_TOKEN__", "t0ken")
    .replace("location.href = ", "(window.__calls = window.__calls || []).push(");
  await page.addInitScript(script.replace("+ extra; };", "+ extra); };"));
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
}
