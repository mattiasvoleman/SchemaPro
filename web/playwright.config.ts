import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level verification for the web package, split into suites that map
 * onto the engineering spec's gates:
 *
 *   smoke         — functional: locale routing, auth gating, login form
 *   a11y          — axe-core WCAG 2.1 AA, zero violations (§2)
 *   visual        — pixel diff vs committed baselines, ≤0.1% variance (§2)
 *   visual-mobile — the same baselines at a phone viewport
 *
 * All suites exercise the public, unauthenticated surface. Authenticated flows
 * need a live Supabase project and belong in the staging pipeline.
 *
 * Run one suite with `--project=visual`.
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  // CI must never write a missing baseline on the fly — that would turn a
  // failed visual gate into a silent pass.
  updateSnapshots: isCI ? "none" : "missing",

  expect: {
    toHaveScreenshot: {
      // §2: Visual Regression Diff Threshold ≤ 0.1% pixel variance.
      maxDiffPixelRatio: 0.001,
      // Per-channel antialiasing tolerance — unrelated to the ratio above,
      // which is the share of the page allowed to differ at all.
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // Pin both so date/number rendering is byte-stable across machines.
    timezoneId: "Europe/Stockholm",
    locale: "sv-SE",
  },

  projects: [
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "a11y",
      testMatch: /a11y\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "visual-mobile",
      testMatch: /visual\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],

  webServer: {
    // Visual diffs run against the production renderer: `next dev` ships
    // dev-only overlays and unminified CSS that shift layout by a pixel or two.
    command: isCI ? "npm run build && npm run start" : "npm run dev",
    url: "http://localhost:3000/sv/login",
    reuseExistingServer: !isCI,
    timeout: 300_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL:
        process.env.NEXT_PUBLIC_SUPABASE_URL ??
        "https://placeholder.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        "placeholder-publishable-key",
      NEXT_PUBLIC_API_BASE_URL:
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    },
  },
});
