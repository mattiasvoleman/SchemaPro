import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A GALLRING BRANCH IS NEVER DROPPED BY A LATER MIGRATION.
 *
 * app.gallring_due and app.gallring_purge are restated whole, with CREATE OR REPLACE, by every phase that gives gallring
 * a table to purge. Two phases that restate them from the same body, in separate pull requests, do not conflict in git
 * (the migrations are different files), and the one with the later stamp silently takes the other's branch away: that
 * pupil data is then never purged, and nothing fails. It happened once in review (Checklistor was built on the bodies
 * before Elevens lektion för dagen, whose LessonPupilMoves branch it would have removed), and the database sections of
 * the suite only fail once main carries both. This test reads the migrations in the order they are applied and fails, in
 * the pull request that is wrong and naming the migration, when a definition has fewer branches than the one before.
 *
 * A branch is the table it purges: `SELECT 'Table', ...` in gallring_due and `d."tbl" = 'Table'` in gallring_purge.
 * The history is strictly growing today (no phase has taken a branch away); a phase that drops a table on purpose has to
 * say so by removing it from the list here, where it can be argued.
 */

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'prisma', 'migrations');

interface Definition {
  migration: string;
  branches: ReadonlySet<string>;
}

const BRANCH = {
  'app.gallring_due': /\bSELECT\s+'([A-Za-z0-9]+)'\s*,/g,
  'app.gallring_purge': /\bd\."tbl"\s*=\s*'([A-Za-z0-9]+)'/g,
} as const;

/** Every definition of the function in the migrations, in migration order, with the tables it has a branch for. */
export function definitionsOf(name: keyof typeof BRANCH, migrations: ReadonlyArray<{ migration: string; sql: string }>): Definition[] {
  const create = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'gi');
  const found: Definition[] = [];
  for (const { migration, sql } of migrations) {
    for (const match of sql.matchAll(create)) {
      const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(match.index))?.[1];
      if (!tag) throw new Error(`${name} in ${migration} has no dollar-quoted body`);
      const open = sql.indexOf(tag, match.index) + tag.length;
      const body = sql.slice(open, sql.indexOf(tag, open)).replace(/--[^\n]*/g, '');
      found.push({ migration, branches: new Set([...body.matchAll(BRANCH[name])].map((hit) => hit[1]!)) });
    }
  }
  return found;
}

/** Each branch a definition lacks that the definition before it had, with the migration that lost it. */
export function droppedBranches(definitions: readonly Definition[]): string[] {
  const dropped: string[] = [];
  for (let i = 1; i < definitions.length; i++) {
    for (const table of definitions[i - 1]!.branches) {
      if (!definitions[i]!.branches.has(table)) dropped.push(`${definitions[i]!.migration} dropped the branch of ${table} that ${definitions[i - 1]!.migration} had`);
    }
  }
  return dropped;
}

const migrations = readdirSync(MIGRATIONS)
  .filter((dir) => /^\d{14}_/.test(dir))
  .sort()
  .map((dir) => ({ migration: dir, sql: readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8') }));

describe.each(Object.keys(BRANCH) as Array<keyof typeof BRANCH>)('%s across the migrations', (name) => {
  const definitions = definitionsOf(name, migrations);

  it('is restated by every phase that gives gallring a table, and each restatement keeps the branches of the one before', () => {
    expect(definitions.length).toBeGreaterThanOrEqual(9);
    expect(droppedBranches(definitions)).toEqual([]);
  });

  it('carries, in the last definition, the branches of the pupil moves (Elevens lektion för dagen) and of the checklists (Checklistor)', () => {
    const last = definitions[definitions.length - 1]!;
    for (const table of ['LessonPupilMoves', 'InstructionProofs', 'ConsentEntries', 'ConsentLists']) expect(last.branches).toContain(table);
  });
});

describe('the check itself', () => {
  const sql = (branches: string[]) =>
    `CREATE OR REPLACE FUNCTION app.gallring_due(a uuid) RETURNS TABLE (tbl text, id uuid) AS $$\n` +
    branches.map((table) => `  SELECT '${table}', x."id" FROM x`).join('\n  UNION ALL\n') +
    `\n$$ LANGUAGE sql;\n`;

  it('names the migration that restated the function from an older body and lost a branch', () => {
    const history = [
      { migration: '1_first', sql: sql(['Users']) },
      { migration: '2_pupil_moves', sql: sql(['Users', 'LessonPupilMoves']) },
      { migration: '3_checklists_built_on_the_first', sql: sql(['Users', 'InstructionProofs']) },
    ];
    expect(droppedBranches(definitionsOf('app.gallring_due', history))).toEqual([
      '3_checklists_built_on_the_first dropped the branch of LessonPupilMoves that 2_pupil_moves had',
    ]);
  });

  it('accepts a history that only grows, and ignores a branch named in a comment', () => {
    const history = [
      { migration: '1', sql: sql(['Users']) },
      { migration: '2', sql: sql(['Users', 'LessonPupilMoves']).replace('UNION ALL', "UNION ALL\n  -- SELECT 'Ghost', x FROM x") },
    ];
    expect(droppedBranches(definitionsOf('app.gallring_due', history))).toEqual([]);
    expect(definitionsOf('app.gallring_due', history)[1]!.branches.has('Ghost')).toBe(false);
  });
});
