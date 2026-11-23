/* Hydra service worker (U20). Read-only offline shell plus web push.
 *
 * Offline: static assets are cached for good (their names carry a content hash). Pages are
 * network first; the last good copy of a page you opened is served only when the network is down,
 * and an unseen page gets a small "offline" document. A page that has not answered after
 * NAV_TIMEOUT_MS gets a "taking long" document instead; both retry by themselves, and each retry of a slow page
 * waits longer, so a page that is slow but sound still arrives. Nothing under /api or /auth is ever cached,
 * and no write (non-GET) is touched, so offline is read-only.
 *
 * Session end: cached pages hold the owner's data, so they must not outlive the session. Landing on
 * /login (the gate sends a signed-out visitor there) wipes the pages cache, and the page can send
 * {type: "clear-cache"} (src/components/pwa/register-sw.tsx clearOfflineCache) at sign-out.
 */

const STATIC = "hydra-static-v1";
const PAGES = "hydra-pages-v1";
const ICON = "/icons/icon-192.png";
const MAX_PAGES = 30;

// ponytail: 12 s covers a cold server start on a slow phone network; a shorter wait would show the
// notice on loads that were about to arrive. Raise it if real loads ever take longer.
const NAV_TIMEOUT_MS = 12000;
const RETRY_MS = 5000;
// ponytail: retry n of a slow page waits n+1 timeouts, up to 5 (60 s). The count lives in memory, so a
// restarted worker starts again at 12 s; that only costs one more retry.
const MAX_WAIT_STEPS = 5;
const slowTries = new Map();

// A small page in the app's style. 5 s after it shows (once the tab is visible) it reloads once; the
// reload's own answer, page or notice, takes over. One shot, not an interval: a second reload would
// cancel a retry that is still on its way.
const notice = (title, heading, attr) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} · Hydra</title>
<style>
html{background:#fff;color:#1d1d1f;font:16px/1.4 system-ui,-apple-system,sans-serif}
body{min-height:100vh;margin:0;display:grid;place-content:center;justify-items:center;gap:20px;text-align:center}
h1{margin:0;font:500 28px/1.2 ui-serif,Georgia,serif}
button{font:inherit;height:34px;padding:0 14px;border:1px solid #1d1d1f;border-radius:8px;background:#1d1d1f;color:#fff}
</style></head><body ${attr}>
<h1>${heading}</h1>
<button onclick="location.reload()">Try again</button>
<script>(function go(){setTimeout(function(){if(document.visibilityState==="visible")location.reload();else document.addEventListener("visibilitychange",go,{once:true})},${RETRY_MS})})()</script>
</body></html>`;

const OFFLINE_HTML = notice("Offline", "You are offline", "data-offline-shell");
const SLOW_HTML = notice("Slow", "Hydra is taking long to load", "data-slow-shell");

const noticeResponse = (html) =>
  new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
const offlineResponse = () => noticeResponse(OFFLINE_HTML);

// Tests shorten the wait with ?sw-nav-timeout=<ms>, honoured only on a local build, never on the hosted app.
function navTimeout(url) {
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const wanted = Number(url.searchParams.get("sw-nav-timeout"));
  return local && wanted > 0 ? wanted : NAV_TIMEOUT_MS;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((cache) => cache.add(ICON))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC && k !== PAGES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-cache") event.waitUntil(caches.delete(PAGES));
});

const isStatic = (path) => path.startsWith("/_next/static/") || path.startsWith("/icons/") || path === "/manifest.webmanifest";
const isNever = (path) => path.startsWith("/api/") || path.startsWith("/auth/") || path === "/sw.js";

async function pageRequest(event) {
  const { request } = event;
  const url = new URL(request.url);
  const key = url.origin + url.pathname + url.search;
  // A stalled fetch must not hold the navigation forever: after the timeout the page gets a notice
  // that retries. A cached copy is only for a real network failure, never for a slow answer (it may
  // be stale or a partial shell).
  const tries = slowTries.get(key) || 0;
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(resolve, navTimeout(url) * Math.min(tries + 1, MAX_WAIT_STEPS), null);
  });
  let response;
  try {
    // No init (so no AbortSignal): any init turns the mode from navigate to same-origin, and the server
    // would see Sec-Fetch-Mode: same-origin. A fetch that lost the race settles by itself and is ignored.
    response = await Promise.race([fetch(request), timedOut]);
  } catch {
    const cache = await caches.open(PAGES);
    return (await cache.match(key)) || offlineResponse();
  } finally {
    clearTimeout(timer);
  }
  if (!response) {
    slowTries.set(key, tries + 1);
    return noticeResponse(SLOW_HTML);
  }
  slowTries.delete(key);
  const landed = new URL(response.url || request.url);
  if (landed.pathname === "/login") await caches.delete(PAGES);
  if (response.ok && !response.redirected && response.type === "basic" && response.headers.get("content-type")?.includes("text/html")) {
    // Store in the background: awaiting the copy would hold the page until its whole stream ends.
    // cache.put fails on a body cut short, so only a complete page is kept.
    const copy = response.clone();
    event.waitUntil(
      (async () => {
        const cache = await caches.open(PAGES);
        await cache.put(key, copy);
        const keys = await cache.keys();
        if (keys.length > MAX_PAGES) await cache.delete(keys[0]);
      })().catch(() => {}),
    );
  }
  return response;
}

async function staticRequest(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isNever(url.pathname)) return;
  if (request.mode === "navigate") event.respondWith(pageRequest(event));
  else if (isStatic(url.pathname)) event.respondWith(staticRequest(request));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // Safari and Chrome require every push to show a notification (userVisibleOnly), so always show one.
  event.waitUntil(
    self.registration.showNotification(data.title || "Hydra", {
      body: data.body || "",
      icon: ICON,
      tag: data.tag,
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL("/", self.location.origin);
  try {
    const wanted = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
    if (wanted.origin === self.location.origin) target = wanted;
  } catch {
    /* keep the Dashboard */
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target.href);
      await open.focus();
      if (open.url !== target.href && "navigate" in open) await open.navigate(target.href);
    }),
  );
});
