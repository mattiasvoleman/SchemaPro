/**
 * Jest configuration for the OpenAPI document's own tests (`npm run test:openapi`).
 *
 * A config of its own, not a third project of jest.config.js: the project compiles every
 * file through ts-jest's language service with the @nestjs/swagger plugin as an AST
 * transformer, and under `--coverage` Istanbul would merge the plugin's generated
 * metadata functions and branches into the per-file figures of the DTOs and controllers,
 * so the combined coverage the gate reads (jest.config.js) would drop by more than ten
 * points of branches without a line of production code being less tested. CI runs this
 * as a step of its own, without coverage (.github/workflows/ci.yml).
 */
const { globals, openapi } = require('./jest.base');

module.exports = {
  rootDir: __dirname,
  ...globals,
  projects: [openapi],
};
