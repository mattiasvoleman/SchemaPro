import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  GROUP_BELOW,
  GROUP_BELOW_LINE,
  GROUP_BELOW_PARENTS,
  GROUP_KEYS,
  STUDENT_ACCOUNT_KINDS,
  STUDENT_BELOW,
  STUDENT_KEYS,
  countByKind,
  grownSince,
  type BelowKey,
  type InventoryKey,
} from './removal-inventory';

/**
 * The inventory of what hangs on a deleted group or person, held to
 * schema.prisma here (the API job) and to the database's own catalogue in
 * scripts/test/probe-massatgarder.ts (the Database job). schema.prisma does
 * not declare every key — 26 of the keys to Users and StudentGroups are
 * written in migrations alone — so this spec catches a key added the Prisma
 * way early, and the probe catches the rest.
 */

const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

interface Model {
  table: string;
  scalars: Set<string>;
  body: string;
}

/** Every model with its table name (@@map) and scalar fields. */
const models = new Map<string, Model>();
for (const [, name, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const table = /@@map\("([^"]+)"\)/.exec(body!)?.[1] ?? name!;
  const scalars = new Set<string>();
  for (const line of body!.split('\n')) {
    const field = /^\s*(\w+)\s+(\w+)(\?|\[\])?(\s|$)/.exec(line);
    if (field && !line.includes('@relation') && !/^\s*(\/\/|@@)/.test(line)) scalars.add(field[1]!);
  }
  models.set(name!, { table, scalars, body: body! });
}

const ON_DELETE: Record<string, string> = { Cascade: 'CASCADE', SetNull: 'SET NULL', Restrict: 'RESTRICT', NoAction: 'NO ACTION' };

/** Every key schema.prisma declares to `parent`, as table|columns|onDelete. */
function declaredKeys(parent: string): string[] {
  const keys: string[] = [];
  for (const { table, body } of models.values()) {
    for (const line of body.split('\n')) {
      const field = /^\s*\w+\s+(\w+)(\?|\[\])?\s.*@relation\((.*)\)/.exec(line);
      if (!field || field[1] !== parent || !field[3]!.includes('fields:')) continue;
      const columns = /fields:\s*\[([^\]]*)\]/.exec(field[3]!)![1]!.replace(/\s/g, '');
      const named = /onDelete:\s*(\w+)/.exec(field[3]!)?.[1];
      // Prisma's default for a relation that names none: SET NULL when optional.
      const onDelete = named ? ON_DELETE[named]! : field[2] === '?' ? 'SET NULL' : 'RESTRICT';
      keys.push(`${table}|${columns}|${onDelete}`);
    }
  }
  return keys.sort();
}

const asKey = (entry: InventoryKey<string> | BelowKey<string>) => `${entry.table}|${entry.columns.join(',')}|${entry.onDelete}`;

const modelOf = new Map([...models].map(([name, model]) => [model.table, name]));

/**
 * The tables a delete of `root` reaches through CASCADE keys, as the
 * inventory has them, other than `root` itself: the first level's, then
 * those below them, to the end.
 */
function cascadedTables(root: string, first: readonly InventoryKey<string>[], below: readonly BelowKey<string>[]): string[] {
  const reached = new Set(first.filter((entry) => entry.onDelete === 'CASCADE' && entry.table !== root).map((entry) => entry.table));
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of below) {
      if (entry.onDelete === 'CASCADE' && reached.has(entry.parent) && !reached.has(entry.table) && entry.table !== root) {
        reached.add(entry.table);
        grew = true;
      }
    }
  }
  return [...reached].sort();
}

/** The web's messages, sv and en: the dialog's lines the gateway's kinds are said by. */
const messages = (['sv', 'en'] as const).map(
  (locale) =>
    [locale, JSON.parse(readFileSync(join(__dirname, `../../web/messages/${locale}.json`), 'utf8')) as {
      bulk: Record<string, Record<string, string>>;
    }] as const,
);

describe('the inventory of what hangs on a deleted row', () => {
  it.each([
    ['StudentGroup', GROUP_KEYS],
    ['User', STUDENT_KEYS],
  ] as const)('holds every key schema.prisma declares to %s, with its ON DELETE', (parent, inventory) => {
    const told = new Set(inventory.map(asKey));
    const declared = declaredKeys(parent);
    // The walk is real: it finds the keys every reader knows are there.
    expect(declared.length).toBeGreaterThan(10);
    expect(declared.filter((key) => !told.has(key))).toEqual([]);
  });

  it.each([
    ['GROUP_KEYS', GROUP_KEYS],
    ['STUDENT_KEYS', STUDENT_KEYS],
  ] as const)('%s names tables and columns schema.prisma has, each key once', (_name, inventory) => {
    const byTable = new Map([...models.values()].map((model) => [model.table, model]));
    const unknown = inventory.flatMap((entry) => {
      const model = byTable.get(entry.table);
      if (!model) return [`no table ${entry.table}`];
      return entry.columns.filter((column) => !model.scalars.has(column)).map((column) => `${entry.table}.${column}`);
    });
    expect(unknown).toEqual([]);
    const keys = inventory.map((entry) => `${entry.table}|${entry.columns.join(',')}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('tells every key: counted, an account the dialog names, uncounted or refusing, each with its reason', () => {
    for (const entry of [...GROUP_KEYS, ...STUDENT_KEYS] as InventoryKey<string>[]) {
      const tell = entry.tell as Record<string, string>;
      const [how] = Object.keys(tell);
      expect(['counted', 'account', 'uncounted', 'refuses']).toContain(how);
      expect(tell[how!]!.length).toBeGreaterThan(0);
      // A RESTRICT key is refused before the delete; it is never counted.
      if (entry.onDelete === 'RESTRICT') expect(how).toBe('refuses');
    }
  });

  it('counts every key to a group: an administrator reads them all', () => {
    expect(GROUP_KEYS.filter((entry) => !('counted' in entry.tell))).toEqual([]);
  });

  it.each([
    ['StudentGroups', GROUP_KEYS, GROUP_BELOW],
    ['Users', STUDENT_KEYS, STUDENT_BELOW],
  ] as const)('holds every key schema.prisma declares a level down from %s, to the end of the cascade', (root, first, below) => {
    const tables = cascadedTables(root, first as readonly InventoryKey<string>[], below as readonly BelowKey<string>[]);
    expect(tables.length).toBeGreaterThan(5);
    const told = new Set((below as readonly BelowKey<string>[]).map((entry) => `${entry.parent}>${asKey(entry)}`));
    const missing = tables.flatMap((table) =>
      declaredKeys(modelOf.get(table)!)
        .map((key) => `${table}>${key}`)
        .filter((key) => !told.has(key)),
    );
    expect(missing).toEqual([]);
    // And nothing below a table no delete reaches.
    expect((below as readonly BelowKey<string>[]).filter((entry) => !tables.includes(entry.parent))).toEqual([]);
  });

  it('tells every key a level down by the line of the dialog that says it', () => {
    const groupKindOf = new Map(GROUP_KEYS.filter((entry) => entry.onDelete === 'CASCADE').map((entry) => [entry.table, entry.tell]));
    for (const entry of GROUP_BELOW) {
      if (!('with' in entry.tell)) continue;
      expect(entry.tell.with).toBe(GROUP_BELOW_LINE);
      const parent = groupKindOf.get(entry.parent) as { counted: string } | undefined;
      // The line is said whenever the rows it hangs on are counted.
      expect(GROUP_BELOW_PARENTS).toContain(parent?.counted);
    }
    // Each parent the line is said for has something below it.
    const parents = new Set(GROUP_BELOW.filter((entry) => 'with' in entry.tell).map((entry) => (groupKindOf.get(entry.parent) as { counted: string }).counted));
    expect([...parents].sort()).toEqual([...GROUP_BELOW_PARENTS].sort());

    const pupilTellOf = new Map(STUDENT_KEYS.filter((entry) => entry.onDelete === 'CASCADE').map((entry) => [entry.table, entry.tell]));
    for (const entry of STUDENT_BELOW) {
      const parent = pupilTellOf.get(entry.parent) as { counted?: string; account?: string } | undefined;
      expect(entry.tell).toEqual({ with: parent?.counted ?? (parent?.account ? 'accounts' : undefined) });
    }
  });

  it.each(messages)('has a line in the web’s %s messages for every kind a dry run answers', (_locale, { bulk }) => {
    const groupKinds = new Set([
      ...GROUP_KEYS.flatMap((entry) => ('counted' in entry.tell ? [entry.tell.counted] : [])),
      ...GROUP_BELOW.flatMap((entry) => ('counted' in entry.tell ? [entry.tell.counted] : [])),
      GROUP_BELOW_LINE,
    ]);
    expect([...groupKinds].filter((kind) => !bulk.groupConsequences?.[kind])).toEqual([]);
    const pupilKinds = new Set([
      ...STUDENT_KEYS.flatMap((entry) => ('counted' in entry.tell ? [entry.tell.counted] : [])),
      'logins',
      'accounts',
    ]);
    expect([...pupilKinds].filter((kind) => !bulk.studentConsequences?.[kind])).toEqual([]);
  });

  it('says the line a level down for the same kinds the web dialog does', () => {
    const dialog = readFileSync(join(__dirname, '../../web/app/[locale]/(app)/admin/groups/groups-bulk-dialogs.tsx'), 'utf8');
    const literal = /GROUP_BELOW_PARENTS\s*=\s*\[([^\]]*)\]/.exec(dialog)?.[1];
    expect(literal).toBeDefined();
    const kinds = [...literal!.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    expect(kinds.sort()).toEqual([...GROUP_BELOW_PARENTS].sort());
  });

  it("names a pupil's account kinds as the dialog says them, each of them used", () => {
    const used = new Set(STUDENT_KEYS.flatMap((entry) => ('account' in entry.tell ? [entry.tell.account] : [])));
    expect([...used].sort()).toEqual([...STUDENT_ACCOUNT_KINDS].sort());
  });
});

describe('countByKind', () => {
  /** A transaction that answers each count with `n` and keeps the SQL it was sent. */
  const counting = (n: number) => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const tx = {
      $queryRaw: jest.fn((query: { text: string; values: unknown[] }) => {
        statements.push({ sql: query.text, values: query.values });
        return Promise.resolve([{ n }]);
      }),
    } as unknown as PrismaClient;
    return { tx, statements };
  };

  it('counts each table of a kind once, matching any of its keys, and sums the tables', async () => {
    const { tx, statements } = counting(2);
    const counts = await countByKind(tx, STUDENT_KEYS, ['p1', 'p2']);
    const absence = statements.filter((statement) => statement.sql.includes('"AbsenceReports"'));
    expect(absence).toHaveLength(1);
    expect(absence[0]!.sql).toBe(
      'SELECT count(*)::int AS n FROM "AbsenceReports" WHERE "studentId" = ANY($1::uuid[]) OR "reportedById" = ANY($2::uuid[])',
    );
    expect(absence[0]!.values).toEqual([['p1', 'p2'], ['p1', 'p2']]);
    // Two tables, two each.
    expect(counts.lessonParticipations).toBe(4);
    expect(counts.absenceReports).toBe(2);
  });

  it('counts by the key column the catalogue names, never by the tenant beside it', async () => {
    const { tx, statements } = counting(0);
    await countByKind(tx, GROUP_KEYS, ['g1']);
    expect(statements.map((statement) => statement.sql).find((sql) => sql.includes('"PublicTimetableLinks"'))).toBe(
      'SELECT count(*)::int AS n FROM "PublicTimetableLinks" WHERE "targetGroupId" = ANY($1::uuid[])',
    );
    expect(statements.some((statement) => statement.sql.includes('"schoolId"'))).toBe(false);
  });

  it('leaves the kinds its caller counts at 0 and sends nothing for them, and nothing at all for no rows', async () => {
    const { tx, statements } = counting(5);
    const counts = await countByKind(tx, GROUP_KEYS, ['g1'], ['halves', 'successors']);
    expect(counts.halves).toBe(0);
    expect(counts.successors).toBe(0);
    expect(statements.some((statement) => /"StudentGroups"/.test(statement.sql))).toBe(false);
    const none = counting(5);
    expect(await countByKind(none.tx, GROUP_KEYS, [])).toMatchObject({ requirements: 0, homePupils: 0 });
    expect(none.statements).toEqual([]);
  });

  it('counts no key that is not counted: an account, an uncounted key or a refusal sends nothing', async () => {
    const { tx, statements } = counting(1);
    await countByKind(tx, STUDENT_KEYS, ['p1']);
    for (const table of ['Notifications', 'DevicePushTokens', 'CalendarFeeds', 'PersonalDataAccess', 'LocalTimplans']) {
      expect(statements.some((statement) => statement.sql.includes(`"${table}"`))).toBe(false);
    }
  });
});

describe('grownSince', () => {
  it('names the kinds that grew since the confirmed dry run, in order', () => {
    expect(grownSince({ halves: 1, requirements: 4 }, { halves: 2, requirements: 4, calendarLessons: 9 })).toEqual(['halves']);
    expect(grownSince({ b: 0, a: 0 }, { a: 1, b: 1 })).toEqual(['a', 'b']);
  });

  it('asks nothing again for a count that fell, a kind the dry run did not name, or no dry run at all', () => {
    expect(grownSince({ halves: 3 }, { halves: 1 })).toEqual([]);
    expect(grownSince({}, { halves: 1 })).toEqual([]);
    expect(grownSince({ halves: 'many' }, { halves: 1 })).toEqual([]);
    expect(grownSince(undefined, { halves: 1 })).toEqual([]);
  });
});
