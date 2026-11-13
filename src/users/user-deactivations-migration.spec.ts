import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 20270210090000, En avaktiverad person minns sina perioder: the three facts the migration states about other files, held to those
 * files so that a later edit of either side is not silent.
 *
 *   - its guard names the md5 of the body of app.absence_stats_lessons it replaces, and that is the body 20270122091000 wrote;
 *   - the INSERT that carries the inactive people over is the one the owner's checks (481o) run, word for word;
 *   - it takes every lock at once, NOWAIT, and its own name is the one it tells whoever must roll it back to use.
 */
const ROOT = join(__dirname, '..', '..');
const NAME = '20270210090000_en_avaktiverad_person_minns_sina_perioder';
const migration = readFileSync(join(ROOT, 'prisma', 'migrations', NAME, 'migration.sql'), 'utf8');
const compact = (text: string): string => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/** The text between the dollar quotes of the function's CREATE in a migration, as the catalogue keeps it (prosrc). */
function bodyIn(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  if (start < 0) throw new Error(`${signature} is not defined here`);
  const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(start))?.[1];
  if (!tag) throw new Error(`${signature} has no dollar-quoted body`);
  const open = sql.indexOf(tag, start) + tag.length;
  return sql.slice(open, sql.indexOf(tag, open));
}

describe(NAME, () => {
  it('replaces app.absence_stats_lessons only if it is the body 20270122091000 wrote, and says so by its md5', () => {
    const previous = readFileSync(
      join(ROOT, 'prisma', 'migrations', '20270122091000_en_elev_byter_till_en_parallell_lektion_for_en_dag', 'migration.sql'),
      'utf8',
    );
    const wrote = createHash('md5')
      .update(bodyIn(previous, 'CREATE OR REPLACE FUNCTION app.absence_stats_lessons('), 'utf8')
      .digest('hex');
    expect(migration).toContain(`'${wrote}'`);
    expect(migration).toContain(`expected ${wrote}`);
  });

  it('writes the same body but for the one line about the teacher', () => {
    const previous = readFileSync(
      join(ROOT, 'prisma', 'migrations', '20270122091000_en_elev_byter_till_en_parallell_lektion_for_en_dag', 'migration.sql'),
      'utf8',
    );
    const was = compact(bodyIn(previous, 'CREATE OR REPLACE FUNCTION app.absence_stats_lessons('));
    const now = compact(bodyIn(migration, 'CREATE OR REPLACE FUNCTION app.absence_stats_lessons('));
    const before = `AND u."role" = 'TEACHER' AND (u."deactivatedAt" IS NULL OR cl."endsAt" <= u."deactivatedAt")`;
    const after = `AND u."role" = 'TEACHER' AND NOT EXISTS (SELECT 1 FROM "public"."UserDeactivations" d WHERE d."userId" = u."id" AND d."startsAt" < cl."endsAt" AND (d."endsAt" IS NULL OR cl."endsAt" < d."endsAt"))`;
    expect(was.split(before)).toHaveLength(2);
    expect(now.split(after)).toHaveLength(2);
    expect(now).toBe(was.replace(before, after));
  });

  it('carries the inactive people over with the statement the owner\'s checks run (481o)', () => {
    const statement = (sql: string): string => {
      const start = sql.search(/INSERT INTO "UserDeactivations" \("schoolId", "userId", "startsAt", "recordedAt"\)\s+SELECT u\."schoolId"/);
      if (start < 0) throw new Error('no backfill INSERT');
      return compact(sql.slice(start, sql.indexOf(';', start) + 1));
    };
    const owner = readFileSync(join(ROOT, 'scripts', 'test', 'rls-owner-checks.sql'), 'utf8');
    const text = statement(migration);
    expect(text).toContain('WHERE NOT u."isActive" AND u."deactivatedAt" IS NOT NULL');
    expect(text).toContain('greatest(clock_timestamp(), u."deactivatedAt")');
    expect(statement(owner.slice(owner.indexOf('-- 481o:')))).toBe(text);
  });

  it('takes Schools and Users at once, NOWAIT, in a loop, and names itself in the way back', () => {
    const loop = migration.slice(migration.indexOf('LOCK TABLE "Schools"'), migration.indexOf('LOOP', migration.indexOf('LOCK TABLE "Schools"')) + 4);
    expect(migration).toContain('LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    expect(migration).toContain('LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    expect(loop.length).toBeGreaterThan(0);
    expect(migration).toContain("PERFORM set_config('lock_timeout', '5s', true);");
    expect(migration).toContain('EXCEPTION WHEN lock_not_available THEN');
    expect(migration).toContain('interval \'30 seconds\'');
    // No other table is locked, and no LOCK without NOWAIT.
    const locks = migration.match(/LOCK TABLE [^;]*;/g) ?? [];
    expect(locks).toHaveLength(2);
    expect(locks.every((lock) => lock.endsWith('NOWAIT;'))).toBe(true);
    // The way back names this migration, by the folder's own name.
    expect(migration.split(`prisma migrate resolve --rolled-back ${NAME}`).length).toBeGreaterThanOrEqual(3);
  });

  it('writes only what it creates: a table, a function, a trigger, a policy pair and the one function it replaces', () => {
    const created = [...migration.matchAll(/^\s*(CREATE (?:OR REPLACE )?(?:TABLE|FUNCTION|TRIGGER|POLICY|INDEX)[^\n(]*)/gm)].map((match) => match[1]!.replace(/\s+/g, ' ').trim());
    expect(created).toEqual([
      'CREATE TABLE "UserDeactivations"',
      'CREATE INDEX "UserDeactivations_schoolId_userId_idx" ON "UserDeactivations"',
      'CREATE INDEX "UserDeactivations_userId_schoolId_startsAt_idx" ON "UserDeactivations"',
      'CREATE FUNCTION app.users_deactivations_are_kept',
      'CREATE TRIGGER "Users_deactivations_are_kept"',
      'CREATE POLICY "user_deactivations_admin_select" ON "UserDeactivations"',
      'CREATE POLICY "user_deactivations_admin_update" ON "UserDeactivations"',
      'CREATE OR REPLACE FUNCTION app.absence_stats_lessons',
    ]);
    // And touches no existing table's columns or rows but by the backfill's read.
    expect(migration).not.toMatch(/ALTER TABLE "(?!UserDeactivations")/);
    expect(migration).not.toMatch(/\bUPDATE "Users"|\bDELETE FROM "Users"/);
  });
});
