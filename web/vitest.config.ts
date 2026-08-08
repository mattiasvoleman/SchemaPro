import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit/component test harness. Playwright owns `e2e/*.spec.ts` (smoke, a11y,
 * visual); this harness owns `**\/*.test.{ts,tsx}` — the extension split is
 * what keeps the two runners out of each other's files.
 *
 * Coverage is measured over the code unit tests can meaningfully reach:
 * lib/, components/, utils/ and i18n/. App-router routes (app/**) are mostly
 * server components exercised end-to-end by the Playwright suites; counting
 * them here would understate real coverage with lines no unit test can
 * execute honestly.
 */

// Ratchet floors, overridable per-metric the same way jest.base.js does it.
// An empty string must NOT read as zero — Number('') === 0 would silently
// disable the gate.
const asNumber = (value: string | undefined) => {
  if (value === undefined || value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const floor = (name: string, ratchet: number) =>
  asNumber(process.env[name]) ?? asNumber(process.env.WEB_COVERAGE_MIN) ?? ratchet;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // `import "server-only"` is a virtual module provided by the Next.js
      // compiler, not an installed package — Vite's import analysis fails on
      // it before vi.mock can intercept, making any server-only module (e.g.
      // lib/auth.ts) unimportable in tests. Map it to an empty stub.
      "server-only": path.resolve(__dirname, "vitest.server-only-stub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    // Worker processes start fresh, so TZ set here is read before the first
    // Date call — wall-clock rendering is byte-stable across machines, the
    // same reason playwright.config.ts pins a timezone.
    env: { TZ: "UTC" },
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "e2e/**", ".next/**"],
    coverage: {
      provider: "v8",
      include: ["lib/**", "components/**", "utils/**", "i18n/**"],
      exclude: ["**/*.test.*", "lib/types.ts"],
      reporter: ["text-summary", "lcov", "json-summary"],
      thresholds: {
        // Ratchet floors just under what the suite measures (87.07 / 85.33 /
        // 83.28 / 79.87). §2's 95% remains the target; raise via the
        // WEB_COVERAGE_MIN* variables as coverage grows, never lower to green
        // a build.
        lines: floor("WEB_COVERAGE_MIN_LINES", 87),
        statements: floor("WEB_COVERAGE_MIN_STATEMENTS", 85),
        functions: floor("WEB_COVERAGE_MIN_FUNCTIONS", 83),
        branches: floor("WEB_COVERAGE_MIN_BRANCHES", 79),
      },
    },
  },
});
