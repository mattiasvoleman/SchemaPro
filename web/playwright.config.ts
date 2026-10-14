import { defineConfig, devices } from "@playwright/test";
import { STUB_ORIGIN } from "./e2e/stub/sessions";

/**
 * Browser-level verification for the web package, split into suites that map
 * onto the engineering spec's gates:
 *
 *   smoke         — functional: locale routing, auth gating, login form
 *   a11y          — axe-core WCAG 2.1 AA, zero violations (§2), on the public
 *                   pages and on every signed-in route for its role(s), plus
 *                   the accessibility-tree baselines of the key screens
 *   visual        — pixel diff vs committed baselines, ≤0.1% variance (§2)
 *   visual-mobile — the same baselines at a phone viewport
 *
 * The app is built against a local stub of its two backends (e2e/stub/),
 * started in globalSetup: Supabase Auth and PostgREST, and the gateway, all
 * answered from the made-up school in e2e/stub/fixtures/. The signed-in
 * suites sign in by cookie as one of four people. Flows that need the real
 * database and gateway still belong in a staging pipeline.
 *
 * Run one suite with `--project=visual`. E2E_WEB_PORT moves the app off 3000
 * (and E2E_STUB_PORT the stub off 54329) when another run holds the port.
 */

const isCI = !!process.env.CI;
const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const baseURL = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/stub/global-setup.ts",
  timeout: 60_000,
  fullyParallel: true,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  // CI must never write a missing baseline on the fly — that would turn a
  // failed visual gate into a silent pass.
  updateSnapshots: isCI ? "none" : "missing",

  // Platform + architecture in the filename, so baselines from different
  // machines cannot silently collide. This is hygiene, not the thing that
  // makes the gate work — see below.
  //
  // What actually determines whether a baseline matches is **which fonts are
  // installed**. globals.css asks for `"Inter", ui-sans-serif, system-ui,
  // -apple-system, "Segoe UI", …`, and Chromium resolves that stack to
  // whatever the machine happens to have. The Playwright Docker image carries
  // 29 font families; a bare ubuntu runner has 3. Same OS, same architecture,
  // same browser build — different glyphs, and a uniform ~1-2% diff on every
  // screenshot that looks exactly like a real regression.
  //
  // Baselines must therefore be generated on the machine that verifies them:
  // run the "Regenerate visual baselines" job in quality-gates.yml, which uses
  // ubuntu-latest and `npx playwright install --with-deps` exactly as the web
  // job does. Generating locally — in any container, on any architecture —
  // produces files that fail on CI.
  snapshotPathTemplate: `{testDir}/{testFileName}-snapshots/{arg}{-projectName}-{platform}-${process.arch}{ext}`,

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
    baseURL,
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
      testMatch: /(a11y|a11y-app|aria)\.spec\.ts/,
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
    command: isCI ? `npm run build && npm run start -- -p ${webPort}` : `npm run dev -- -p ${webPort}`,
    url: `${baseURL}/sv/login`,
    reuseExistingServer: !isCI,
    timeout: 300_000,
    env: {
      // Both backends are the stub, whatever the job's environment says: the
      // build inlines NEXT_PUBLIC_*, so these decide what the browser calls
      // as well as what the server does. The CI job's own placeholder values
      // stay what its Build step and the bundle gate measure.
      NEXT_PUBLIC_SUPABASE_URL: STUB_ORIGIN,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "stub-publishable-key",
      NEXT_PUBLIC_API_BASE_URL: STUB_ORIGIN,
      // "Logga in med skolkonto" is off unless a deployment turns it on; the
      // browser suites check /login with the button, as staff will see it.
      NEXT_PUBLIC_SCHOOL_ACCOUNTS:
        process.env.NEXT_PUBLIC_SCHOOL_ACCOUNTS ?? "on",
    },
  },
});
