/**
 * Root Jest configuration for the API package.
 *
 * Two projects run under one config so a single `npm run test:cov` reports
 * *combined* unit + integration coverage — the figure §2 of the engineering
 * spec gates on ("Unit & Integration Test Coverage ≥ 95% line coverage").
 * Splitting them across separate runs would understate both.
 *
 *   unit  — `src/**\/*.spec.ts`, services exercised against the Prisma mock
 *   e2e   — `test/**\/*.e2e-spec.ts`, full Nest app over supertest
 *
 * Project definitions and the coverage gate live in jest.base.js, which
 * jest.mutation.config.js reuses.
 */
const { globals, unit, e2e, coverage } = require('./jest.base');

module.exports = {
  rootDir: __dirname,
  ...globals,
  ...coverage,
  projects: [unit, e2e],
};
