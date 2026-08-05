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
 * §2 mandates ≥95% line coverage. `COVERAGE_MIN` exists so the gate can be
 * ratcheted deliberately — and visibly, from CI config — while the suite is
 * built out, rather than by quietly editing this file.
 */
const coverageMin = Number(process.env.COVERAGE_MIN ?? 95);

const coverage = {
  collectCoverageFrom: [
    'src/**/*.ts',
    // Bootstrap: exercised by container healthchecks, not by the test suite.
    '!src/main.ts',
  ],
  coverageDirectory: path.join('<rootDir>', 'coverage'),
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      lines: coverageMin,
      statements: coverageMin,
      functions: coverageMin,
      branches: coverageMin,
    },
  },
};

module.exports = { common, globals, unit, e2e, coverage };
