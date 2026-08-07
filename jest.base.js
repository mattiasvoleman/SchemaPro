/**
 * Shared Jest project definitions for the API package.
 *
 * Kept separate from jest.config.js so the unit project can be consumed on its
 * own by jest.mutation.config.js. Stryker's jest runner works against a plain
 * single-project config; handing it a `projects` array is a known rough edge,
 * and mutation testing wants unit tests anyway (an e2e suite re-run per mutant
 * would make the run unaffordable).
 */
const path = require('node:path');

const ROOT = __dirname;

const common = {
  rootDir: ROOT,
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleNameMapper: { '^@app/(.*)$': '<rootDir>/src/$1' },
  transform: {
    // `isolatedModules` lives in test/tsconfig.json — passing it through the
    // transform options is deprecated in ts-jest and removed in v30.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }],
  },
};

/**
 * Options Jest only accepts at the TOP level of a config — placing them inside
 * a `projects` entry makes Jest warn and silently ignore them.
 */
const globals = {
  // jest-haste-map probes for watchman and hangs indefinitely when the binary
  // is absent (common on fresh macOS checkouts and in CI images). The default
  // crawler is fine without it — discovery takes under a second.
  watchman: false,
  // The full Nest graph compiles cold on the first e2e suite in CI; the 5s
  // default is not enough for the first request and produced spurious failures.
  testTimeout: 30_000,
};

const unit = {
  ...common,
  displayName: 'unit',
  roots: ['<rootDir>/src'],
  testRegex: '\\.spec\\.ts$',
};

const e2e = {
  ...common,
  displayName: 'e2e',
  roots: ['<rootDir>/test'],
  testRegex: '\\.e2e-spec\\.ts$',
};

/**
 * §2 mandates ≥95% coverage. **That remains the target.** The defaults below
 * are a ratchet, not the goal: each sits just under the figure the suite
 * actually achieves today, so the gate blocks regression while the suite is
 * built out. Raise them as coverage grows; never lower one to make a red build
 * green.
 *
 * Thresholds are per-metric because a single number cannot fit. At the time of
 * writing the suite covers 42% of lines but only 26% of functions — one shared
 * value would either be so low that line coverage could regress by 16 points
 * unnoticed, or so high that the build fails on functions regardless.
 *
 * `COVERAGE_MIN` overrides all four at once, and the per-metric variables
 * override individually, so CI can ratchet without editing this file.
 *
 *   measured 2026-08-06: lines 42.40  statements 43.25
 *                        branches 35.77  functions 25.90
 */
// An unset GitHub Actions variable arrives as an empty string, not undefined,
// and `Number('')` is 0 — which would silently disable the gate rather than
// fall through to the ratchet. Anything non-numeric is treated as unset.
const asNumber = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const floor = (name, ratchet) =>
  asNumber(process.env[name]) ?? asNumber(process.env.COVERAGE_MIN) ?? ratchet;

const coverageMin = {
  lines: floor('COVERAGE_MIN_LINES', 91),
  statements: floor('COVERAGE_MIN_STATEMENTS', 91),
  functions: floor('COVERAGE_MIN_FUNCTIONS', 83),
  branches: floor('COVERAGE_MIN_BRANCHES', 83),
};

const coverage = {
  collectCoverageFrom: [
    'src/**/*.ts',
    // Bootstrap: exercised by container healthchecks, not by the test suite.
    '!src/main.ts',
  ],
  coverageDirectory: path.join('<rootDir>', 'coverage'),
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: { global: coverageMin },
};

module.exports = { common, globals, unit, e2e, coverage };
