import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke suite: boots the Next.js dev server and exercises the public,
 * unauthenticated surface (locale routing, auth gating, login form).
 * Authenticated flows require a Supabase project and are exercised manually
 * or in a dedicated staging pipeline.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/sv/login",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
