/**
 * Single-project Jest config used only by Stryker (see stryker.conf.json).
 *
 * Deliberately unit-tests-only and free of any `projects` array or coverage
 * thresholds: Stryker drives coverage itself, and a failing global threshold
 * would abort every mutant run.
 */
const { globals, unit } = require('./jest.base');

module.exports = {
  ...globals,
  ...unit,
  rootDir: __dirname,
  // Stryker reports its own progress; per-mutant jest output is noise.
  reporters: ['default'],
};
