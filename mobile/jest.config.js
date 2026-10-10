/**
 * Jest for the React Native app.
 *
 * `jest-expo` is the preset because it is the only one that knows how to load
 * this project's actual runtime: it transforms the Expo and React Native
 * packages that ship untranspiled ESM, and provides the native-module shims
 * that make `expo-sqlite`, `expo-secure-store` and friends importable outside a
 * device. A plain jest configuration gets as far as the first import.
 *
 * The app went untested for longer than it should have, and it is the package
 * where being untested costs most: its offline queue holds attendance for real
 * children, on a tablet several teachers share, and there is no way to observe
 * a mistake there until the register is already wrong.
 */
module.exports = {
  preset: 'jest-expo',
  // Node, not jsdom: what is worth pinning here is logic — the roster union,
  // the queue's owner filter, Swedish ordering. Screens are React Native
  // components that jsdom cannot render meaningfully anyway, and pretending
  // otherwise buys confidence that is not there.
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  clearMocks: true,
  // Measured over the layers where a mistake is invisible until the data is
  // already wrong: data access, sync and pure logic. Screens and React context
  // are wiring around them, and counting a component nobody renders in this
  // environment would only make the number look better than the testing is.
  collectCoverageFrom: [
    'src/services/**/*.ts',
    'src/utils/**/*.ts',
    'src/hooks/**/*.ts',
    'src/i18n/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    // Floors set just under what the suite measures: 61.94 statements, 62.84
    // lines, 63.05 functions, 66.66 branches (2026-10-10, with src/i18n
    // counted). They were 12/12/16/11 when this runner arrived; the step is the
    // gateway client, the family schedule, push registration, the catalogue and
    // its formats, notice wording and the auth codes, all tested where they
    // live. Auth storage, the WebSocket client and the hooks are still
    // uncovered, and that is the gap that remains. Raise these as tests land;
    // never lower one to green a build.
    global: { statements: 61, lines: 62, functions: 62, branches: 66 },
  },
};
