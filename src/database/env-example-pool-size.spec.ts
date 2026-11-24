import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.env.example` is the third place an operator copies the API's connection string from, beside DEPLOYMENT §3 and
 * the walkthrough (deployment-pool-size.spec.ts holds those two to 10). It said `connection_limit=1` after they
 * said 10, so whoever started from the example file got the one-lane pool that the real school's first Generera
 * (2026-11-23) showed is too small. Read as text, with no import of src/, so that it needs nothing in Stryker's
 * sandbox but the file itself.
 */
describe('.env.example', () => {
  it('gives the API\'s DATABASE_URL the pool size DEPLOYMENT §3.1 recommends', () => {
    const text = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    const line = text.split('\n').find((l) => /^DATABASE_URL=/.test(l));

    expect(line).toBeDefined();
    const query = line!.slice(line!.indexOf('?') + 1).replace(/"$/, '');
    expect(new URLSearchParams(query).get('connection_limit')).toBe('10');
  });
});
