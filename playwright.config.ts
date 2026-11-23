import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // Tests never make sound: the agent's fixture speaks, and macOS would say it out loud.
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", launchOptions: { args: ["--mute-audio"] } },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["iPhone 15"], viewport: { width: 390, height: 844 }, browserName: "chromium" } },
  ],
  webServer: {
    command: `pnpm build && pnpm start --port ${PORT}`,
    // /login is public and always exists; the app root redirects there without a session.
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { HYDRA_DEV_ROUTES: "1" },
  },
});
