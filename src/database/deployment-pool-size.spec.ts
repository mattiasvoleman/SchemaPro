import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pgAdapterSettings } from './pool-config';

/**
 * The size of the API's pool is a decision (docs/DEPLOYMENT.md §3.1): 10, where it said 1 until the real school's
 * first Generera (2026-11-23) made every other request and ten background jobs' ticks fail behind one connection.
 * It is written in two places an operator copies the URL from, and a reader of one should not meet 1 in the other.
 * scripts/test/probe-anslutningar.ts runs 10 as "the size DEPLOYMENT recommends" and says what 1 and 3 do.
 */
const RECOMMENDED = 10;

const DOCS = ['docs/DEPLOYMENT.md', 'docs/deployment-walkthrough.md'] as const;

describe('the pool size the deployment guides give', () => {
  it.each(DOCS)('%s gives every connection string the recommended pool size', (file) => {
    const text = readFileSync(join(__dirname, '../..', file), 'utf8');
    const urls = text.match(/postgresql:\/\/app_authenticated\.[^\s`]*/g) ?? [];

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(pgAdapterSettings(url.replace('<ref>', 'abcdefgh').replace('<PROJECT_REF>', 'abcdefgh')).pool.max).toBe(RECOMMENDED);
    }
  });

  it('says why in DEPLOYMENT §3.1, with the numbers and the pooler it sits behind', () => {
    const text = readFileSync(join(__dirname, '../../docs/DEPLOYMENT.md'), 'utf8');
    const section = text.slice(text.indexOf('### 3.1 '), text.indexOf('## 4. Deploy the AI engine'));

    expect(section).toContain('### 3.1 The size of the API\'s pool: 10, not 1');
    for (const part of ['Pool Size', 'DATABASE_BUSY', 'CONNECTION_WAIT_MS', 'probe-anslutningar', '2026-11-23']) {
      expect(section).toContain(part);
    }
  });
});
