import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminArea, AdminProfile } from '@prisma/client';
import * as web from '../../web/lib/admin-areas';
import {
  BEGIN_MARKER,
  END_MARKER,
  areaMatrixBlock,
} from '../../scripts/test/generate-rls-area-matrix';
import {
  ADMIN_AREAS,
  PROFILE_DECIDES,
  PROFILE_WRITES,
  TABLE_WRITE_GATES,
  profileReadsHr,
  profileWritesTable,
  writersOf,
} from './admin-areas';

/*
 * Roller i skolan keeps one matrix in three places: the database
 * (app.admin_profile_writes, app.admin_profile_decides), this gateway
 * (admin-areas.ts) and the web (web/lib/admin-areas.ts). The list of areas is
 * the Prisma enum, which is the database's type. These tests hold the copies
 * to each other; the RLS suite's section 116 holds the database's behaviour
 * to TABLE_WRITE_GATES.
 */

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'prisma', 'migrations');

/** The newest migration whose SQL defines `marker`, as text. */
function latestDefining(marker: RegExp): string {
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs.reverse()) {
    const sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    if (marker.test(sql)) return sql;
  }
  throw new Error(`no migration defines ${marker}`);
}

describe('admin areas: one matrix, three copies', () => {
  it('reads the areas from the Prisma enum, which is the database type', () => {
    expect(ADMIN_AREAS).toEqual(Object.values(AdminArea));
    const sql = latestDefining(/CREATE TYPE "AdminArea"/);
    const declared = /CREATE TYPE "AdminArea" AS ENUM \(([^)]*)\)/.exec(sql)?.[1];
    expect(declared?.split(',').map((label) => label.trim().replace(/'/g, ''))).toEqual(ADMIN_AREAS);
  });

  it("states each profile's areas as app.admin_profile_writes() does", () => {
    const sql = latestDefining(/FUNCTION app\.admin_profile_writes\(/);
    const body = sql.slice(sql.indexOf('FUNCTION app.admin_profile_writes('));
    const fromSql: Record<string, string[]> = {};
    for (const match of body.matchAll(/WHEN '(\w+)'\s+THEN ARRAY\[([^\]]*)\]::"AdminArea"\[\]/g)) {
      if (match[1] in fromSql) break; // the next function's CASE, if any
      // ARRAY[] is a profile with no area: the läsare.
      fromSql[match[1]!] = match[2]!.trim() === '' ? [] : match[2]!.split(',').map((area) => area.trim().replace(/'/g, ''));
    }
    expect(Object.keys(fromSql).sort()).toEqual(Object.values(AdminProfile).sort());
    for (const profile of Object.values(AdminProfile)) {
      expect({ profile, writes: [...PROFILE_WRITES[profile]].sort() }).toEqual({
        profile,
        writes: [...fromSql[profile]!].sort(),
      });
    }
  });

  it('decides as app.admin_profile_decides() does', () => {
    const sql = latestDefining(/FUNCTION app\.admin_profile_decides\(/);
    const body = sql.slice(sql.indexOf('FUNCTION app.admin_profile_decides('));
    const deciders = /p_profile IN \(([^)]*)\)/.exec(body)?.[1]?.split(',').map((p) => p.trim().replace(/'/g, ''));
    expect(
      Object.values(AdminProfile)
        .filter((profile) => PROFILE_DECIDES[profile])
        .sort(),
    ).toEqual([...(deciders ?? [])].sort());
  });

  it("keeps the web's copy equal to the gateway's", () => {
    expect([...web.ADMIN_AREAS]).toEqual([...ADMIN_AREAS]);
    expect([...web.ADMIN_PROFILES].sort()).toEqual(Object.values(AdminProfile).sort());
    expect(web.PROFILE_WRITES).toEqual(PROFILE_WRITES);
    expect(web.PROFILE_DECIDES).toEqual(PROFILE_DECIDES);
    for (const profile of Object.values(AdminProfile)) {
      for (const hr of [true, false]) {
        expect(web.profileReadsHr(profile, hr)).toBe(profileReadsHr(profile, hr));
      }
    }
  });

  it("has the RLS suite's generated matrix block written from this file", () => {
    const suite = readFileSync(join(ROOT, 'scripts', 'test', 'rls-policies.sql'), 'utf8');
    const start = suite.indexOf(BEGIN_MARKER);
    const end = suite.indexOf(END_MARKER);
    expect(start).toBeGreaterThan(0);
    // Stale? Run: npx ts-node --transpile-only scripts/test/generate-rls-area-matrix.ts
    expect(suite.slice(start, end + END_MARKER.length)).toBe(areaMatrixBlock());
  });

  it("splits the arms by the same gates: the migration's VALUES list is TABLE_WRITE_GATES", () => {
    const sql = latestDefining(/ADMIN_ARM_UNEXPECTED/);
    const list = sql.slice(sql.indexOf('FROM (VALUES'), sql.indexOf(') AS v(tbl, ins, upd, del, rd)'));
    const set = (items: string): string[] => (items === '' ? [] : items.split(','));
    const fromSql: Record<string, unknown> = {};
    for (const row of list.matchAll(/\('(\w+)', '\{([^}]*)\}', '\{([^}]*)\}', '\{([^}]*)\}', '\{([^}]*)\}'\)/g)) {
      fromSql[row[1]!] = { insert: set(row[2]!), update: set(row[3]!), delete: set(row[4]!), read: set(row[5]!) };
    }
    // Every row the migration names, as admin-areas.ts states it. A table a
    // later migration adds is held by the RLS suite's sections 116 and 106.
    expect(Object.keys(fromSql).length).toBeGreaterThan(50);
    for (const [table, gates] of Object.entries(fromSql)) {
      const ts = TABLE_WRITE_GATES[table];
      expect({ table, gates }).toEqual({
        table,
        gates: ts && { insert: [...ts.insert], update: [...ts.update], delete: [...ts.delete], read: [...(ts.read ?? [])] },
      });
    }
  });

  it('gives the läsare no area, no decision and no table, and lets it be given HR-läs (Läsbehörighet)', () => {
    expect(PROFILE_WRITES.LASARE).toEqual([]);
    expect(PROFILE_DECIDES.LASARE).toBe(false);
    for (const table of Object.keys(TABLE_WRITE_GATES)) {
      for (const command of ['insert', 'update', 'delete'] as const) {
        expect({ table, command, writes: profileWritesTable('LASARE', table, command) }).toEqual({ table, command, writes: false });
      }
    }
    expect(profileReadsHr('LASARE', false)).toBe(false);
    expect(profileReadsHr('LASARE', true)).toBe(true);
  });

  it('names who writes each area, rektor first, as the refusals say it', () => {
    expect(writersOf('PLANERING')).toBe('rektor, en fullständig administratör eller en schemaläggare');
    expect(writersOf('PERSONAL')).toBe('rektor, en fullständig administratör eller expeditionen');
    expect(writersOf('INTEGRATIONER')).toBe('rektor eller en fullständig administratör');
    expect(writersOf('DRIFT')).toBe('rektor, en fullständig administratör, en schemaläggare eller expeditionen');
  });

  it('never lets a narrower profile write a table a wider one cannot', () => {
    for (const table of Object.keys(TABLE_WRITE_GATES)) {
      for (const command of ['insert', 'update', 'delete'] as const) {
        for (const profile of Object.values(AdminProfile)) {
          if (profileWritesTable(profile, table, command)) {
            expect({ table, command, full: profileWritesTable('FULL', table, command) }).toEqual({
              table,
              command,
              full: true,
            });
          }
        }
      }
    }
  });
});
