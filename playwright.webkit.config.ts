import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

/**
 * The Planning specs in WebKit: the Mac app's window is WKWebView and the phone is iPhone Safari,
 * both WebKit. Same server and specs as playwright.config.ts.
 * Run: `E2E_PORT=<port> pnpm exec playwright test -c playwright.webkit.config.ts`.
 */
export default defineConfig({
  ...base,
  testMatch: /planning(-page)?\.spec\.ts/,
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["iPhone 15"], viewport: { width: 390, height: 844 } } },
  ],
});
