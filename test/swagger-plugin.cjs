/*
 * ts-jest's way into the @nestjs/swagger CLI plugin, for the `openapi` Jest
 * project only (jest.base.js).
 *
 * `nest build` runs the plugin on the DTOs and controllers (nest-cli.json);
 * under Jest nothing does, so a DTO read there carries no
 * _OPENAPI_METADATA_FACTORY and the document would list every body as an
 * empty object. This hands ts-jest the same plugin, with the same options, read
 * from nest-cli.json so that the two cannot be configured apart.
 *
 * It needs a type checker (the plugin reads the types of the properties), so
 * the project's tsconfig leaves isolatedModules off and ts-jest compiles the
 * project through its language service. The other projects keep their
 * per-file transpile.
 */
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const transformer = require('@nestjs/swagger/plugin');

const nestCli = JSON.parse(readFileSync(path.join(__dirname, '..', 'nest-cli.json'), 'utf8'));
const entry = (nestCli.compilerOptions.plugins || []).find((plugin) => plugin.name === '@nestjs/swagger');
const options = entry ? entry.options || {} : {};

module.exports.name = 'nestjs-swagger-transformer';
// ts-jest keys its transform cache on this: it changes with the plugin's
// options, so editing nest-cli.json is seen, not served from a stale cache.
module.exports.version = createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 12);
// ts-jest builds the transformers again for every file it emits, and keeps
// `compiler.program` as the (empty) program of the moment its language service
// was created: asked about a file added since, its type checker answers `any`.
// The service's own current program is the one the file is being emitted from.
module.exports.factory = (compiler) =>
  transformer.before(
    JSON.parse(JSON.stringify(options)),
    compiler._languageService ? compiler._languageService.getProgram() : compiler.program,
  );
