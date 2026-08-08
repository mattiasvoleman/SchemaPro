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
    alias: { "@": path.resolve(__dirname) },
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
        // Placeholder floors until the first measured run; raised in the same
        // commit that lands the test suite.
        lines: floor("WEB_COVERAGE_MIN_LINES", 0),
        statements: floor("WEB_COVERAGE_MIN_STATEMENTS", 0),
        functions: floor("WEB_COVERAGE_MIN_FUNCTIONS", 0),
        branches: floor("WEB_COVERAGE_MIN_BRANCHES", 0),
      },
    },
  },
});
