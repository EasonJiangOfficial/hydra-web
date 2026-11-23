import { expect, test, type Page } from "@playwright/test";

/* Phone install (U20): the manifest and its icons, the service worker, and the offline shell.
   Runs on /login, the one page that is public and needs no session. */

type Manifest = { name: string; display: string; start_url: string; theme_color: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] };

test("the manifest is served with installable icons", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const manifest = (await res.json()) as Manifest;
  expect(manifest).toMatchObject({ name: "Hydra", display: "standalone", start_url: "/", theme_color: "#FFFFFF" });
  const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
  for (const src of [...manifest.icons.map((icon) => icon.src), "/icons/apple-touch-icon.png"]) {
    const icon = await request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()["content-type"], src).toContain("image/png");
  }
});

async function installed(page: Page) {
  await page.goto("/login");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null); // the worker claims the open page
}

test("the service worker registers and takes control", async ({ page, request }) => {
  const res = await request.get("/sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("javascript");
  await installed(page);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  expect(scope).toBe(new URL("/", page.url()).href);
});

test("the offline shell shows the last page you opened, and a small notice for the rest", async ({ page, context }) => {
  await installed(page);
  await page.reload(); // now under the worker, so the page is cached
  await page.waitForFunction(async () => (await (await caches.open("hydra-pages-v1")).keys()).length > 0);

  await context.setOffline(true);
  try {
    await page.goto("/login");
    await expect(page.locator("[data-offline-shell]")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("img", { name: "Hydra" })).toBeVisible(); // the cached login page

    await page.goto("/never-opened");
    await expect(page.locator("[data-offline-shell]")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }

  // Read-only and session-bound: no API or auth response is ever stored.
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  expect(cached.filter((path) => path.startsWith("/api/") || path.startsWith("/auth/"))).toEqual([]);
});

test("a page the network never answers gets a 'taking long' notice that retries by itself", async ({ page, context }) => {
  await installed(page);
  let hits = 0;
  await context.route("**/slow-test*", () => {
    hits += 1; // never answered: the server has stalled
  });

  // ?sw-nav-timeout shortens the 12 s wait; the worker honours it only on localhost.
  await page.goto("/slow-test?sw-nav-timeout=500");
  await expect(page.getByRole("heading", { name: "Hydra is taking long to load" })).toBeVisible();
  await expect(page.locator("[data-offline-shell]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect.poll(() => hits, { timeout: 9_000 }).toBeGreaterThanOrEqual(2); // the 5 s auto-retry

  // A normal navigation is untouched: the root still redirects to the real login page.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.locator("[data-slow-shell], [data-offline-shell]")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("img", { name: "Hydra" })).toBeVisible();
});

test("a page slower than the wait still arrives: each retry of a slow page waits longer", async ({ page, context }) => {
  await installed(page);
  let hits = 0;
  await context.route("**/late-test*", async (route) => {
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // always slower than the first 1 s wait
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Late page</h1>" });
  });

  await page.goto("/late-test?sw-nav-timeout=1000");
  await expect(page.getByRole("heading", { name: "Hydra is taking long to load" })).toBeVisible();
  // The retry waits 2 s, so the 1.5 s answer lands, and the page stays (no reload loop).
  await expect(page.getByRole("heading", { name: "Late page" })).toBeVisible({ timeout: 12_000 });
  await page.waitForTimeout(6_000);
  await expect(page.getByRole("heading", { name: "Late page" })).toBeVisible();
  expect(hits).toBe(2);
});
