import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Next's own empty server-only module (what a server bundle gets), so a jsdom test can render against a real route handler.
  resolve: { tsconfigPaths: true, alias: { "server-only": "next/dist/compiled/server-only/empty.js" } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "supabase/**/*.test.ts", "scripts/**/*.test.{ts,mjs}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
