import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * DEPLOYMENT 43 (the optimization profile is the school's, omgång 15 P5 part 3) held to what the table, the page and the suites hold.
 * It reads one document and imports nothing from src/, so Stryker's sandbox needs none of them (as docs-say-what-the-code-does.spec.ts).
 */

const flat = (text: string): string => text.replace(/\s+/g, ' ');
const deployment = flat(readFileSync(join(__dirname, '..', 'docs', 'DEPLOYMENT.md'), 'utf8'));
const section = deployment.slice(deployment.indexOf('## 43. The optimization profile'));

describe('DEPLOYMENT 43 says who reaches the profile table and what a page does with it', () => {
  it('names the roles by what they hold: anon and authenticated nothing, service_role the SELECT it has on every table', () => {
    expect(section).toContain('`anon` and `authenticated` (PostgREST\'s roles) hold no right on it');
    expect(section).toContain('`service_role` keeps the SELECT it has on every table and no write');
    expect(section).not.toContain("PostgREST's roles reach nothing");
  });

  it('says a save puts only what its reader moved over the school\'s profile, and the sliders are locked until it is read', () => {
    expect(section).toContain('puts only the weights the reader moved over it');
    expect(section).toContain('the sliders are locked until the profile has been read');
    expect(section).toContain('the page says the school\'s profile could not be read and locks the sliders');
    expect(section).not.toContain('save nowhere');
  });

  it('says the row has no version and the last save of one weight wins', () => {
    expect(section).toContain('The row has no version');
  });
});
