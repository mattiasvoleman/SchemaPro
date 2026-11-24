import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What DEPLOYMENT §3.1 says it knows. Three sentences claimed more than anyone read or measured:
 *
 *  - that the real school ran on "a pool of 1" on 2026-11-23: the production DATABASE_URL is a secret, nobody
 *    has read it, and a pool of 10 would not have failed that way at all (probe-anslutningar, pool 10, before the
 *    change: nothing refused), so the guide must not name the cause as a fact;
 *  - that 7 connections was "the worst case measured": it is what the measurement's own load of three page loads
 *    and a job tick a second used, not a school's busiest minute;
 *  - that the CI probe "runs the same": its pool-1 case is lighter (a page load every 1.2 s, four ticks) and
 *    refuses nothing, where the table above it refuses 19 of 36.
 *
 * Read as text and imports nothing from src/, so Stryker's sandbox does not need the guide for it.
 */
describe('DEPLOYMENT §3.1 does not claim more than was read or measured', () => {
  const text = readFileSync(join(__dirname, '../../docs/DEPLOYMENT.md'), 'utf8');
  const section = text
    .slice(text.indexOf('### 3.1 '), text.indexOf('## 4. Deploy the AI engine'))
    .replace(/\s+/g, ' ');

  it('does not say what pool size the real school ran on', () => {
    expect(section).not.toMatch(/ran both at once on a pool of 1/);
    expect(section).toContain('was not read when this was written');
  });

  it('does not call 7 connections the worst case', () => {
    expect(section).not.toContain('the worst case measured');
    expect(section).toContain('used 7 connections');
  });

  it('does not say the CI probe runs the same load as the table', () => {
    expect(section).not.toContain('runs the same at 50 ms in CI');
    expect(section).toContain('runs a lighter version at 50 ms in CI');
  });
});
