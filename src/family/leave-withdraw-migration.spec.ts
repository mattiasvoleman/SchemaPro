import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The migration of the taking-back door (K6) is applied once, in production, before the merge, and is not changed afterwards: what it says
 * of DEPLOYMENT must not be a number. The sections of parallel pull requests are renumbered when they meet, and a reader of the migration
 * in the middle of a rollback would be sent to another pull request's section. It names the section instead.
 *
 * Reads files and imports nothing from src/, so Stryker's sandbox needs none of them.
 */
const MIGRATIONS = join(__dirname, '../../prisma/migrations');

describe('the migration of the taking-back door points to DEPLOYMENT by the section\'s name', () => {
  const name = readdirSync(MIGRATIONS).find((entry) => entry.endsWith('_en_familj_drar_tillbaka_sin_ledighetsansokan_fore_beslutet'));
  if (name === undefined) throw new Error('the migration of the taking-back door is gone; read DEPLOYMENT "A family takes back a leave request" again');
  const migration = readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

  it('names the section "A family takes back a leave request" and cites no section number of DEPLOYMENT that a parallel section can take', () => {
    expect(migration).toContain('"A family takes back a leave request" i DEPLOYMENT');
    // 18.1 and 18.2 are old sections that nothing renumbers; a bare "avsnitt N" is the one that moves.
    expect(migration).not.toMatch(/DEPLOYMENT avsnitt \d+/);
  });
});
