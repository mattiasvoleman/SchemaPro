import type { Prisma } from '@prisma/client';
import { DATA_FILES, FRANVARO, KOPPLINGAR, LASLOGG, LEDIGHETER, NARVARO, NOTISER, PERSONER, type DataEnv, type DataFile } from './data-files';

/**
 * The seven data files with the database scripted: what each turns a row into,
 * what it holds out and blanks for a protected identity, and what it hands the
 * läslogg. The queries themselves are proved against Postgres by
 * scripts/test/probe-school-export.ts (two schools, a marked pupil and teacher);
 * here the SQL is only checked for what it is given.
 */

const SCHOOL = '99999999-9999-4999-8999-999999999999';
const MARKED = '11111111-1111-4111-8111-111111111111';
const PUPIL = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

interface Harness {
  env: DataEnv;
  calls: Prisma.Sql[];
  named: Array<[string, string[]]>;
  held: Array<[string, string, number]>;
}

/** An env whose database answers `answers` in turn, one per statement. */
function harness(answers: unknown[][], over: Partial<DataEnv> = {}): Harness {
  const calls: Prisma.Sql[] = [];
  const named: Harness['named'] = [];
  const held: Harness['held'] = [];
  const queue = [...answers];
  const tx = {
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      calls.push(sql);
      if (queue.length === 0) throw new Error(`unexpected statement ${calls.length}`);
      return queue.shift();
    }),
  };
  const env: DataEnv = {
    schoolId: SCHOOL,
    scope: { ids: null },
    markedOut: [],
    markedTerms: [],
    isolate: false,
    read: (fn) => fn(tx as never),
    named: (kind, ids) => void named.push([kind, [...ids].filter((id): id is string => typeof id === 'string')]),
    held: (file, what, count) => void held.push([file, what, count]),
    checkpoint: async () => undefined,
    ...over,
  };
  return { env, calls, named, held };
}

async function rowsOf(file: DataFile, env: DataEnv): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of file.rows(env)) out.push(row);
  return out;
}

const valuesOf = (sql: Prisma.Sql): unknown[] => sql.values;
const textOf = (sql: Prisma.Sql): string => sql.strings.join('?').replace(/\s+/g, ' ');

describe('the data files', () => {
  it('have a column for every cell a row yields, in the order the header names them', async () => {
    const p = harness([[{ id: PUPIL, role: 'STUDENT', first: 'A', last: 'B', email: 'a@x', phone: null, active: true, klass: '7A', created: 'c', deactivated: null, pseudonymised: null, profile: null, hr: false }]]);
    expect((await rowsOf(PERSONER, p.env))[0]).toHaveLength(PERSONER.columns.length);
    for (const file of DATA_FILES) {
      expect(file.columns.length).toBeGreaterThan(3);
      expect(new Set(file.columns.map((c) => c.name)).size).toBe(file.columns.length);
      for (const column of file.columns) expect(column.name).toMatch(/^[a-z_]+$/);
    }
    expect(DATA_FILES.map((f) => f.path)).toEqual([
      'data/personer.csv', 'data/kopplingar.csv', 'data/narvaro.csv', 'data/franvaroanmalningar.csv', 'data/ledigheter.csv', 'data/notiser.csv', 'data/laslogg.csv',
    ]);
  });

  describe('personer.csv', () => {
    it('writes yes and no, empty for nothing, and names the persons it lists for the läslogg', async () => {
      const h = harness([[
        { id: PUPIL, role: 'STUDENT', first: 'Alma', last: 'Sjö', email: 'alma@x', phone: null, active: false, klass: null, created: '2026-01-01T00:00:00Z', deactivated: '2026-06-01T00:00:00Z', pseudonymised: null, profile: null, hr: false },
        { id: OTHER, role: 'SCHOOL_ADMIN', first: 'Rek', last: 'Tor', email: 'r@x', phone: '070', active: true, klass: null, created: '2026-01-01T00:00:00Z', deactivated: null, pseudonymised: null, profile: 'REKTOR', hr: true },
      ]]);
      expect(await rowsOf(PERSONER, h.env)).toEqual([
        [PUPIL, 'STUDENT', 'Alma', 'Sjö', 'alma@x', '', 'nej', '', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', '', '', 'nej'],
        [OTHER, 'SCHOOL_ADMIN', 'Rek', 'Tor', 'r@x', '070', 'ja', '', '2026-01-01T00:00:00Z', '', '', 'REKTOR', 'ja'],
      ]);
      expect(h.named).toEqual([['PEOPLE', [PUPIL, OTHER]]]);
    });

    it('asks for the marked to be left out and the scope to be kept to', async () => {
      const h = harness([[]], { markedOut: [MARKED], scope: { ids: [PUPIL] } });
      await rowsOf(PERSONER, h.env);
      expect(valuesOf(h.calls[0]!)).toEqual(expect.arrayContaining([[MARKED], [PUPIL]]));
    });

    it('goes on from the last id when a batch is full, and stops at a short one', async () => {
      const full = Array.from({ length: 5000 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, role: 'STUDENT', first: 'a', last: 'b', email: `${i}@x`, phone: null, active: true, klass: null, created: 'c', deactivated: null, pseudonymised: null, profile: null, hr: false,
      }));
      const h = harness([full, [full[0]!]]);
      expect(await rowsOf(PERSONER, h.env)).toHaveLength(5001);
      expect(valuesOf(h.calls[1]!)).toContain(full[4999]!.id);
    });
  });

  describe('kopplingar.csv', () => {
    const link = { id: 'l1', guardian: OTHER, guardianEmail: 'g@x', student: PUPIL, studentEmail: 's@x', origin: 'MANUAL', created: 'c', hid: 0 };

    it('writes a link and names both ends, and counts the links held out only when someone is marked', async () => {
      const none = harness([[link]]);
      expect(await rowsOf(KOPPLINGAR, none.env)).toEqual([['l1', OTHER, 'g@x', PUPIL, 's@x', 'MANUAL', 'c']]);
      expect(none.named).toEqual([['GUARDIANS', [OTHER, PUPIL]], ['PEOPLE', [OTHER, PUPIL]]]);
      expect(none.held).toEqual([]);

      const marked = harness([[link], [{ n: 3 }]], { markedOut: [MARKED] });
      await rowsOf(KOPPLINGAR, marked.env);
      expect(marked.held).toEqual([['data/kopplingar.csv', 'rows', 3]]);
    });

    it('writes the other end as empty cells, and counts them, where the database hid it for a protected person', async () => {
      const h = harness([[{ ...link, guardian: null, guardianEmail: null, hid: 1 }], [{ n: 0 }]], { scope: { ids: [PUPIL] }, isolate: true, markedOut: [MARKED] });
      expect(await rowsOf(KOPPLINGAR, h.env)).toEqual([['l1', '', '', PUPIL, 's@x', 'MANUAL', 'c']]);
      expect(h.held).toContainEqual(['data/kopplingar.csv', 'blanked', 1]);
      // The condition: anyone outside the persons asked for is hidden, in the id and the address both.
      const sql = textOf(h.calls[0]!);
      expect(sql).toContain('NOT (l."guardianId" = ANY(');
      expect(sql).toContain('CASE WHEN ((l."guardianId" = ANY(?::uuid[])) OR (NOT (l."guardianId" = ANY(?::uuid[])))) THEN NULL ELSE l."guardianId" END');
      expect(valuesOf(h.calls[0]!)).toEqual(expect.arrayContaining([[PUPIL], [MARKED]]));
    });

    it('does not hide the other end in the extract of someone who is not protected', async () => {
      const h = harness([[link]], { scope: { ids: [PUPIL] }, isolate: false });
      await rowsOf(KOPPLINGAR, h.env);
      expect(textOf(h.calls[0]!).split(' FROM ')[0]).not.toContain('NOT (');
    });
  });

  describe('narvaro.csv', () => {
    const mark = {
      date: '2026-10-05', start: '09:00', end: '10:00', subject: 'Matematik', code: null, grp: '7A', lesson: 'L1', lessonStatus: 'SCHEDULED',
      student: PUPIL, studentEmail: 's@x', status: 'PRESENT', recorder: null, recorderEmail: null, recordedAt: null, note: null, hid: 0,
    };

    it('reads a school a day at a time, in the school\'s own zone, and counts what it held out and blanked', async () => {
      const h = harness(
        [[{ tz: 'Europe/Stockholm' }], [{ d: '2026-10-05' }, { d: '2026-10-06' }], [{ ...mark, hid: 2 }], [], [{ held: 4 }]],
        { markedOut: [MARKED] },
      );
      expect(await rowsOf(NARVARO, h.env)).toEqual([['2026-10-05', '09:00', '10:00', 'Matematik', '', '7A', 'L1', 'SCHEDULED', PUPIL, 's@x', 'PRESENT', '', '', '', '']]);
      // One statement per day: the zone, the days, two days, the counts.
      expect(h.calls).toHaveLength(5);
      expect(valuesOf(h.calls[2]!)).toEqual(expect.arrayContaining([['2026-10-05'], 'Europe/Stockholm']));
      expect(valuesOf(h.calls[3]!)).toEqual(expect.arrayContaining([['2026-10-06']]));
      expect(h.held).toEqual([['data/narvaro.csv', 'blanked', 2], ['data/narvaro.csv', 'rows', 4]]);
      expect(h.named).toContainEqual(['ATTENDANCE', [PUPIL]]);
    });

    it('reads a person\'s days a hundred and twenty at a time, only the days with their marks', async () => {
      const days = Array.from({ length: 130 }, (_, i) => ({ d: `2026-10-${String((i % 28) + 1).padStart(2, '0')}` }));
      const h = harness([[{ tz: 'Europe/Stockholm' }], days, [mark], [mark]], { scope: { ids: [PUPIL] } });
      expect(await rowsOf(NARVARO, h.env)).toHaveLength(2);
      expect(h.calls).toHaveLength(4);
      expect(valuesOf(h.calls[1]!)).toContain(SCHOOL);
      expect((valuesOf(h.calls[2]!).find((v) => Array.isArray(v) && v.length > 1) as unknown[]).length).toBe(120);
      expect((valuesOf(h.calls[3]!).find((v) => Array.isArray(v) && v.length > 1) as unknown[]).length).toBe(10);
    });

    it('writes no counts query when nobody is marked', async () => {
      const h = harness([[{ tz: 'Europe/Stockholm' }], []]);
      expect(await rowsOf(NARVARO, h.env)).toEqual([]);
      expect(h.calls).toHaveLength(2);
    });
  });

  describe('franvaroanmalningar.csv and ledigheter.csv', () => {
    it('write the reporter and the decider as empty cells when the database blanked them, and count', async () => {
      const absence = { id: 'a1', date: '2026-10-05', from: null, to: null, type: 'SICK', student: PUPIL, studentEmail: 's@x', reporter: null, reporterEmail: null, note: 'feber', granted: false, created: 'c', key: '2026-10-05', hid: 2 };
      const a = harness([[absence], [{ held: 1 }]], { markedOut: [MARKED] });
      expect(await rowsOf(FRANVARO, a.env)).toEqual([['a1', '2026-10-05', '', '', 'SICK', PUPIL, 's@x', '', '', 'feber', 'nej', 'c']]);
      expect(a.held).toEqual([['data/franvaroanmalningar.csv', 'blanked', 2], ['data/franvaroanmalningar.csv', 'rows', 1]]);

      const leave = {
        id: 'v1', student: PUPIL, studentEmail: 's@x', requester: OTHER, requesterEmail: 'g@x', start: '2026-11-02', end: '2026-11-03', reason: 'släkt', status: 'APPROVED',
        decider: null, deciderEmail: null, decidedAt: 'd', decisionNote: null, decidedAs: 'ADMIN', referrer: null, referredAt: null, created: 'c', at: 'x', hid: 1,
      };
      const l = harness([[leave], [{ held: 0 }]], { markedOut: [MARKED] });
      expect(await rowsOf(LEDIGHETER, l.env)).toEqual([['v1', PUPIL, 's@x', OTHER, 'g@x', '2026-11-02', '2026-11-03', 'släkt', 'APPROVED', '', '', 'd', '', 'ADMIN', '', '', 'c']]);
      expect(l.held).toEqual([['data/ledigheter.csv', 'blanked', 1], ['data/ledigheter.csv', 'rows', 0]]);
      expect(l.named).toContainEqual(['LEAVE_REQUESTS', [PUPIL]]);
    });

    it('widen a person\'s scope to the leave they asked for and decided', async () => {
      const h = harness([[]], { scope: { ids: [OTHER] } });
      await rowsOf(LEDIGHETER, h.env);
      // The person is the student, the requester, the decider and the one who passed it on.
      const where = textOf(h.calls[0]!).split(' WHERE ')[1]!;
      for (const column of ['studentId', 'requestedById', 'decidedById', 'referredById']) expect(where).toContain(`l."${column}" = ANY(`);
      expect(valuesOf(h.calls[0]!).filter((v) => Array.isArray(v) && v.length === 1 && v[0] === OTHER).length).toBeGreaterThanOrEqual(4);
    });

    it('writes nothing of the pupil in a leave the person only decided, and asks the database for it', async () => {
      const h = harness([[]], { scope: { ids: [OTHER] } });
      await rowsOf(LEDIGHETER, h.env);
      const select = textOf(h.calls[0]!).split(' FROM ')[0]!;
      // The pupil's id and address, the reason and the decision's note are hidden when the row is not about the persons asked for.
      expect(select).toContain('CASE WHEN ((l."studentId" = ANY(?::uuid[])) OR ((NOT (l."studentId" = ANY(?::uuid[])) AND NOT (l."studentId" = ANY(?::uuid[]))))) THEN NULL ELSE l."studentId" END');
      expect(select).toContain('CASE WHEN (NOT (l."studentId" = ANY(?::uuid[])) OR false) THEN NULL ELSE l."reason" END');
      expect(select).toContain('l."decisionNote"');
      // The person's own act stays: nobody but a marked person (or, in a protected extract, a stranger) is hidden from the decider's column.
      expect(select).toContain('CASE WHEN ((l."decidedById" = ANY(?::uuid[])) OR ((NOT (l."studentId" = ANY(?::uuid[])) AND NOT (l."decidedById" = ANY(?::uuid[]))))) THEN NULL ELSE l."decidedById" END');
    });

    it('does not hide the pupil of a leave in the school\'s own file', async () => {
      const h = harness([[]]);
      await rowsOf(LEDIGHETER, h.env);
      const select = textOf(h.calls[0]!).split(' FROM ')[0]!;
      expect(select).toContain('CASE WHEN ((l."studentId" = ANY(?::uuid[]))) THEN NULL ELSE l."studentId" END');
      expect(select).not.toContain('NOT (l."studentId" = ANY');
      expect(select).toContain('CASE WHEN (false OR false) THEN NULL ELSE l."reason" END');
    });

    it('empties free text that names a marked person, by id or by full name, in every file that has any', async () => {
      const h = harness(
        [[], [{ held: 0 }], [], [{ held: 0 }], [{ tz: 'Europe/Stockholm' }], [{ d: '2026-10-05' }], [], [{ held: 0 }]],
        { markedOut: [MARKED], markedTerms: ['anna ek'] },
      );
      await rowsOf(FRANVARO, h.env);
      await rowsOf(LEDIGHETER, h.env);
      await rowsOf(NARVARO, h.env);
      const selects = h.calls.map((sql) => textOf(sql)).filter((text) => text.includes('position('));
      expect(selects).toHaveLength(3);
      expect(selects[0]).toContain('a."note"');
      expect(selects[1]).toContain('l."reason"');
      expect(selects[2]).toContain('ar."note"');
      expect(valuesOf(h.calls[0]!)).toEqual(expect.arrayContaining([['anna ek']]));
    });
  });

  describe('notiser.csv', () => {
    const notice = (over: object) => ({ id: 'n1', recipient: PUPIL, recipientEmail: 's@x', type: 'LEAVE_DECIDED', content: '{"a":1}', mentionsMarked: false, readAt: null, emailedAt: null, created: 'c', at: 'x', ...over });

    it('keeps a notice\'s type and time but not its content when the content names a marked person', async () => {
      const h = harness([[notice({}), notice({ id: 'n2', mentionsMarked: true, content: '{"student":"Anna Ek"}' })], [{ n: 2 }]], { markedOut: [MARKED], markedTerms: ['anna ek'] });
      expect(await rowsOf(NOTISER, h.env)).toEqual([
        ['n1', PUPIL, 's@x', 'LEAVE_DECIDED', '{"a":1}', '', '', 'c'],
        ['n2', PUPIL, 's@x', 'LEAVE_DECIDED', '', '', '', 'c'],
      ]);
      expect(h.held).toEqual([['data/notiser.csv', 'blanked', 1], ['data/notiser.csv', 'rows', 2]]);
      expect(valuesOf(h.calls[0]!)).toEqual(expect.arrayContaining([[MARKED], ['anna ek']]));
    });
  });

  describe('notiser.csv without a marked person', () => {
    it('does not scan the notices\' content for one', async () => {
      const h = harness([[]]);
      await rowsOf(NOTISER, h.env);
      expect(h.calls[0]!.strings.join('?')).not.toContain('position(');
      expect(h.calls[0]!.strings.join('?')).toContain('false AS "mentionsMarked"');
    });
  });

  describe('laslogg.csv', () => {
    const read = (over: object) => ({
      id: 'r1', at: '2026-11-05T10:00:00Z', channel: 'WEB', actor: OTHER, actorEmail: 'a@x', role: 'SCHOOL_ADMIN', member: null, key: null, huvudmanKey: null,
      kind: 'PEOPLE', size: 3, subjects: [PUPIL, MARKED, OTHER], atKey: '2026-11-05 10:00:00.000000+00', actorHeld: false, ...over,
    });

    it('lists the persons a read named without the marked ones, and leaves out a read by a marked reader or of marked persons alone', async () => {
      const h = harness([[
        read({}),
        read({ id: 'r2', actorHeld: true }),
        read({ id: 'r3', subjects: [MARKED], size: 1 }),
        read({ id: 'r4', subjects: [], size: 0, key: 'k1' }),
      ]], { markedOut: [MARKED] });
      expect(await rowsOf(LASLOGG, h.env)).toEqual([
        ['2026-11-05T10:00:00Z', 'WEB', OTHER, 'a@x', 'SCHOOL_ADMIN', '', '', 'PEOPLE', '2', `${PUPIL} ${OTHER}`],
        ['2026-11-05T10:00:00Z', 'WEB', OTHER, 'a@x', 'SCHOOL_ADMIN', '', 'k1', 'PEOPLE', '0', ''],
      ]);
      expect(h.held).toEqual([['data/laslogg.csv', 'rows', 2], ['data/laslogg.csv', 'blanked', 2]]);
      expect(h.named).toEqual([['ACCESS_LOG', [PUPIL, OTHER]]]);
    });

    it('lists, in a registerutdrag, only the persons it is about, with the read\'s whole size', async () => {
      const h = harness([[read({})]], { scope: { ids: [PUPIL] }, markedOut: [MARKED] });
      expect(await rowsOf(LASLOGG, h.env)).toEqual([['2026-11-05T10:00:00Z', 'WEB', OTHER, 'a@x', 'SCHOOL_ADMIN', '', '', 'PEOPLE', '3', PUPIL]]);
      expect(h.named).toEqual([['ACCESS_LOG', [PUPIL]]]);
    });
  });
});
