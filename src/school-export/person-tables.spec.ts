import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';
import { ACCOUNT_KINDS, NOT_A_USER, SUBJECT_ACCESS, WITHOUT_KEY, WITHOUT_SCHOOL_COLUMN, cellOf, excludedTables, inventoriedTables, tableFiles, type CellRules } from './person-tables';

/**
 * "All your data" is only true while the extract knows every table that holds
 * a row about a person. The removal's inventory (src/common/removal-inventory.ts)
 * already tells them, key by key, and is held to the catalogue by a probe; the
 * extract's decisions (person-tables.ts) are held to it here, so a table added
 * with a key to Users fails a test until somebody has said what an extract does
 * with it.
 */
describe('the registerutdrag decides every table the removal inventory names', () => {
  const inventoried = inventoriedTables();

  it('leaves no table of the removal inventory undecided', () => {
    expect(inventoried.filter((table) => !(table in SUBJECT_ACCESS))).toEqual([]);
  });

  it('decides no table the removal inventory does not name, but the ones that keep a person without a key to Users', () => {
    expect(Object.keys(SUBJECT_ACCESS).filter((table) => !inventoried.includes(table) && !(table in WITHOUT_KEY))).toEqual([]);
  });

  it('decides every table that keeps a person without a key, and reads each such column of a table it dumps', () => {
    for (const [table, columns] of Object.entries(WITHOUT_KEY)) {
      const decision = SUBJECT_ACCESS[table];
      expect(decision).toBeDefined();
      if (!decision || !('dump' in decision)) {
        // Left out, with the reason the README states.
        expect(decision && 'excluded' in decision ? decision.excluded.length : 0).toBeGreaterThan(20);
        continue;
      }
      const read = [...decision.dump.columns, ...(decision.dump.inside ?? [])];
      expect(columns.filter((column) => !read.includes(column))).toEqual([]);
    }
  });

  it('names the reason of every table it leaves out, for the README', () => {
    const left = excludedTables();
    expect(left.map((item) => item.table)).toEqual(['IntegrationKeyWebhookSecrets', 'PublishedLessons', 'Ss12000SourceSecrets']);
    for (const item of left) expect(item.reason.endsWith('.')).toBe(true);
    expect(Object.keys(NOT_A_USER).every((key) => /^[A-Za-z0-9]+\.[A-Za-z]+$/.test(key))).toBe(true);
  });

  it("dumps every person column the removal names for a table it dumps (a key added to a table is a column here)", () => {
    const missing: string[] = [];
    for (const key of STUDENT_KEYS) {
      const decision = SUBJECT_ACCESS[key.table];
      if (!decision || !('dump' in decision)) continue;
      if (!decision.dump.columns.includes(key.columns[0]!)) missing.push(`${key.table}.${key.columns[0]}`);
    }
    expect(missing).toEqual([]);
  });

  it('calls an account table an account in the removal inventory too', () => {
    const accounts = STUDENT_KEYS.filter((key) => 'account' in key.tell).map((key) => key.table);
    for (const table of accounts) {
      const decision = SUBJECT_ACCESS[table];
      // Notifications are an account in the removal's dialog and an administrator reads them: they are the notices file.
      expect(decision && ('account' in decision || 'covered' in decision)).toBe(true);
    }
    for (const [table, decision] of Object.entries(SUBJECT_ACCESS)) {
      if ('account' in decision) expect(Object.keys(ACCOUNT_KINDS)).toContain(decision.account);
      void table;
    }
  });

  it('names the file of every covered table', () => {
    for (const [table, decision] of Object.entries(SUBJECT_ACCESS)) {
      if ('covered' in decision) expect(decision.covered).toMatch(/^data\/[a-z]+\.csv/);
      void table;
    }
  });

  it('dumps tables a level down through their parents', () => {
    for (const below of STUDENT_BELOW) {
      const decision = SUBJECT_ACCESS[below.table];
      expect(decision).toBeDefined();
      if (decision && 'dump' in decision && !below.columns.some((column) => decision.dump.columns.includes(column))) {
        // Not keyed by a person column of its own: it must say which parent it is read through.
        expect(decision.dump.through?.some(([column]) => below.columns.includes(column)) || decision.dump.columns.length > 0).toBe(true);
      }
    }
  });

  it('gives each dumped table a file of its own and a kind of läslogg record', () => {
    const files = tableFiles();
    expect(new Set(files.map((file) => file.path)).size).toBe(files.length);
    for (const file of files) {
      expect(file.path).toBe(`data/person/${file.table.toLowerCase()}.csv`);
      expect(file.dump.columns.length + (file.dump.through?.length ?? 0)).toBeGreaterThan(0);
    }
    expect([...WITHOUT_SCHOOL_COLUMN]).toEqual(['RoomLoans']);
  });
});

describe('a cell of a dumped row', () => {
  const MARKED = '11111111-1111-4111-8111-111111111111';
  const STRANGER = '33333333-3333-4333-8333-333333333333';
  const SUBJECT = '22222222-2222-4222-8222-222222222222';
  const marked: CellRules = { markedOut: new Set([MARKED]), markedNames: ['anna ek'] };
  const protectedSubject: CellRules = { ...marked, strangers: new Set([STRANGER, MARKED]) };

  it('is empty for a marked person, in a column of its own, inside json and in free text, and counted', () => {
    expect(cellOf('decidedById', MARKED, marked)).toEqual({ text: '', held: true });
    expect(cellOf('meta', { by: MARKED }, marked)).toEqual({ text: '', held: true });
    expect(cellOf('note', `Ringde om ${MARKED}`, marked)).toEqual({ text: '', held: true });
    expect(cellOf('note', 'Syskon till Anna Ek.', marked)).toEqual({ text: '', held: true });
  });

  it('is kept for anyone else, and a number or a boolean is its text', () => {
    expect(cellOf('decidedById', SUBJECT, marked)).toEqual({ text: SUBJECT, held: false });
    expect(cellOf('minutes', 60, marked)).toEqual({ text: '60', held: false });
    expect(cellOf('active', false, marked)).toEqual({ text: 'false', held: false });
    expect(cellOf('note', null, marked)).toEqual({ text: '', held: false });
    expect(cellOf('meta', { a: 1 }, marked)).toEqual({ text: '{"a":1}', held: false });
    expect(cellOf('note', 'Anna kom sent.', marked)).toEqual({ text: 'Anna kom sent.', held: false });
  });

  it('is empty, in the extract of a protected person, wherever it carries another user of the school, whatever the column', () => {
    expect(cellOf('actorId', STRANGER, protectedSubject)).toEqual({ text: '', held: true });
    expect(cellOf('actorId', STRANGER.toUpperCase(), protectedSubject)).toEqual({ text: '', held: true });
    expect(cellOf('studentIds', [SUBJECT, STRANGER], protectedSubject)).toEqual({ text: '', held: true });
    expect(cellOf('removedTeachers', { ids: [STRANGER] }, protectedSubject)).toEqual({ text: '', held: true });
    expect(cellOf('note', `Överfört till ${STRANGER} i går`, protectedSubject)).toEqual({ text: '', held: true });
    // The person asked for, and ids that are no user's, stay.
    expect(cellOf('userId', SUBJECT, protectedSubject)).toEqual({ text: SUBJECT, held: false });
    expect(cellOf('lessonId', '44444444-4444-4444-8444-444444444444', protectedSubject)).toEqual({ text: '44444444-4444-4444-8444-444444444444', held: false });
    // Without the rule (an extract of anybody else) another user's id stays.
    expect(cellOf('actorId', STRANGER, marked)).toEqual({ text: STRANGER, held: false });
  });

  it.each(['token', 'apiKeyHash', 'webhookSecret', 'passwordHash'])('hides the column %s', (column) => {
    expect(cellOf(column, 'abc', marked)).toEqual({ text: '(dold)', held: false });
  });
});
