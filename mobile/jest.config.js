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
    // Floors set just under what the suite measures today: 12.83 statements,
    // 12.86 lines, 17.07 functions, 11.80 branches.
    //
    // They are low because they are honest. This runner exists as of today and
    // covers three things — the roster union, the queue's owner filter and
    // Swedish ordering — all of which were shipped untested and all of which
    // decide what a teacher sees about a child. Auth, the sync worker, the
    // network guard and the hooks are still uncovered, and that is what the gap
    // between this number and a good one means. Raise these as tests land;
    // never lower one to green a build.
    global: { statements: 12, lines: 12, functions: 16, branches: 11 },
  },
};
