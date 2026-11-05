import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpenApiService } from '../src/openapi/openapi.service';
import { createTestApp, type TestHarness } from './utils/test-app';

/**
 * docs/api/openapi.json is the OpenAPI document of /api/v1, committed so that
 * it can be read, diffed in review and handed to an IT department without a
 * running gateway. This holds it to what the code generates.
 *
 * `npm run openapi:generate` runs this file with OPENAPI_WRITE=1, which writes
 * the file instead of comparing with it. It is a test and not a script because
 * the document is only as good as the compile that made the DTO classes (the
 * @nestjs/swagger plugin, see jest.base.js): the one that checks the file is
 * the one that writes it, so they cannot disagree about how the classes were
 * built.
 */
const FILE = join(__dirname, '..', 'docs', 'api', 'openapi.json');

/** Where two texts first differ, for a failure that can be read. */
function firstDifference(committed: string, generated: string): string {
  const a = committed.split('\n');
  const b = generated.split('\n');
  const line = a.findIndex((text, index) => text !== b[index]);
  const at = line === -1 ? Math.min(a.length, b.length) : line;
  return [`line ${at + 1}:`, `  committed: ${a[at] ?? '(end of file)'}`, `  generated: ${b[at] ?? '(end of file)'}`].join('\n');
}

describe('docs/api/openapi.json (openapi)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is the document the code generates', () => {
    const generated = harness.app.get(OpenApiService).text();
    if (process.env['OPENAPI_WRITE'] === '1') {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, generated);
      return;
    }
    const committed = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
    if (committed !== generated) {
      throw new Error(
        `docs/api/openapi.json is not what the code generates. Run \`npm run openapi:generate\` and commit the result.\n${firstDifference(committed, generated)}`,
      );
    }
  });
});
