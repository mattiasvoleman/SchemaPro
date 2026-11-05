import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';
import { ACCOUNT_KINDS, SUBJECT_ACCESS, WITHOUT_SCHOOL_COLUMN, cellOf, inventoriedTables, tableFiles } from './person-tables';

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

  it('decides no table the removal inventory does not name', () => {
    expect(Object.keys(SUBJECT_ACCESS).filter((table) => !inventoried.includes(table))).toEqual([]);
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
  const marked = new Set(['11111111-1111-4111-8111-111111111111']);

  it('is empty for a marked person, and counted', () => {
    expect(cellOf('decidedById', '11111111-1111-4111-8111-111111111111', marked)).toEqual({ text: '', held: true });
    expect(cellOf('meta', { by: '11111111-1111-4111-8111-111111111111' }, marked)).toEqual({ text: '', held: true });
  });

  it('is kept for anyone else, and a number or a boolean is its text', () => {
    expect(cellOf('decidedById', '22222222-2222-4222-8222-222222222222', marked)).toEqual({ text: '22222222-2222-4222-8222-222222222222', held: false });
    expect(cellOf('minutes', 60, marked)).toEqual({ text: '60', held: false });
    expect(cellOf('active', false, marked)).toEqual({ text: 'false', held: false });
    expect(cellOf('note', null, marked)).toEqual({ text: '', held: false });
    expect(cellOf('meta', { a: 1 }, marked)).toEqual({ text: '{"a":1}', held: false });
  });

  it.each(['token', 'apiKeyHash', 'webhookSecret', 'passwordHash'])('hides the column %s', (column) => {
    expect(cellOf(column, 'abc', marked)).toEqual({ text: '(dold)', held: false });
  });
});
