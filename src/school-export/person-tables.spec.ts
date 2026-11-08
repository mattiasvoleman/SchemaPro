import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';
import { ACCOUNT_KINDS, NOT_A_USER, SUBJECT_ACCESS, WITHOUT_KEY, WITHOUT_SCHOOL_COLUMN, cellOf, emptyPupilPart, excludedTables, inventoriedTables, tableFiles, type CellRules } from './person-tables';

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
    expect(left.map((item) => item.table)).toEqual(['ExamSittings', 'IntegrationKeyWebhookSecrets', 'PublishedLessons', 'ReportingReminders', 'Ss12000SourceSecrets']);
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

describe('the registerutdrag of a member of staff who booked or registered for Lokal', () => {
  const HIRER_COLUMNS = ['organisation', 'contactName', 'contactPhone', 'contactEmail', 'purpose', 'note'];

  it('dumps the series by the person who registered it, and hides the hirer: somebody who is not the person asked for', () => {
    expect(SUBJECT_ACCESS['ExternalBookings']).toMatchObject({ dump: { columns: ['registeredById'], thirdParty: HIRER_COLUMNS } });
    expect(SUBJECT_ACCESS['ExternalBookings']).not.toHaveProperty('dump.pupil');
  });

  it('is the only table with a third party in it', () => {
    expect(tableFiles().filter((file) => file.dump.thirdParty).map((file) => file.table)).toEqual(['ExternalBookings']);
  });

  it('dumps what the person booked and decided of a resource, as of a room', () => {
    expect(SUBJECT_ACCESS['ResourceBookings']).toMatchObject({ dump: { columns: ['bookedById', 'decidedById'] } });
    expect(SUBJECT_ACCESS['ResourceBookings']).toEqual(
      expect.objectContaining({ dump: expect.objectContaining({ kind: (SUBJECT_ACCESS['RoomBookings'] as { dump: { kind: string } }).dump.kind }) }),
    );
    expect(SUBJECT_ACCESS['ResourceBookings']).not.toHaveProperty('dump.thirdParty');
  });

  it('gives the series a file of its own under data/person', () => {
    expect(tableFiles().find((file) => file.table === 'ExternalBookings')?.path).toBe('data/person/externalbookings.csv');
  });
});

describe('a cell of a dumped row', () => {
  const MARKED = '11111111-1111-4111-8111-111111111111';
  const STRANGER = '33333333-3333-4333-8333-333333333333';
  const SUBJECT = '22222222-2222-4222-8222-222222222222';
  const marked: CellRules = { markedOut: new Set([MARKED]), markedTerms: ['anna ek'] };
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

describe('the rows of a table that is about a pupil', () => {
  const files = tableFiles().filter((file) => file.dump.pupil);
  const PUPIL = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const TEACHER = '33333333-3333-4333-8333-333333333333';

  it('are the crisis tables, where a teacher marks a pupil found, the two tables of Checklistor, where a teacher ticks a pupil and a mentor writes what a guardian decided, and the moves of a pupil to a parallel lesson, and the pupil is one of the columns the dump reads', () => {
    // A table added here has to be said to be about a pupil on purpose: this list fails when one is, and when one is left out.
    expect(files.map((file) => file.table).sort()).toEqual(['ConsentEntries', 'CrisisPupils', 'CrisisReports', 'InstructionProofs', 'LessonPupilMoves']);
    for (const file of files) expect(file.dump.columns).toContain(file.dump.pupil!.column);
  });

  it("hides, in the two tables of Checklistor, the pupil's state: what a guardian decided, who gave it and the note, and a proof's note and reason, and nothing of the act (granskning #288, M1)", () => {
    const hidden = (table: string) => files.find((file) => file.table === table)!.dump.pupil!;
    expect(hidden('InstructionProofs')).toEqual({ column: 'studentId', hides: ['note', 'voidReason'] });
    expect(hidden('ConsentEntries')).toEqual({ column: 'studentId', hides: ['kind', 'givenOn', 'givenBy', 'note'] });
    // The act is who ticked or wrote, and the template or list: never in a hidden column.
    for (const file of files.filter((item) => ['InstructionProofs', 'ConsentEntries'].includes(item.table))) {
      for (const act of ['instructorId', 'recordedById', 'voidedById', 'templateId', 'listId', 'instructedOn', 'recordedAt', 'source']) expect(file.dump.pupil!.hides).not.toContain(act);
    }
  });

  it("lose the pupil and the pupil's state in a teacher's proof and in a mentor's answer, and keep both for the pupil", () => {
    const proofs = files.find((file) => file.table === 'InstructionProofs')!;
    const answers = files.find((file) => file.table === 'ConsentEntries')!;
    const proof = () => ({ studentId: OTHER, instructedOn: '2026-11-02', instructorId: TEACHER, note: 'orolig', voidReason: 'fel elev' });
    const answer = () => ({ studentId: OTHER, kind: 'DECLINED', givenOn: '2026-11-04', givenBy: 'pappa Bertil', note: 'inte på nätet', recordedById: TEACHER });
    const [teachers, mentors, pupils] = [[proof()], [answer()], [proof(), answer()]];
    expect(emptyPupilPart(proofs, teachers, new Set([TEACHER]))).toBe(3);
    expect(teachers[0]).toEqual({ studentId: null, instructedOn: '2026-11-02', instructorId: TEACHER, note: null, voidReason: null });
    expect(emptyPupilPart(answers, mentors, new Set([TEACHER]))).toBe(5);
    expect(mentors[0]).toEqual({ studentId: null, kind: null, givenOn: null, givenBy: null, note: null, recordedById: TEACHER });
    expect(emptyPupilPart(proofs, [pupils[0]!], new Set([OTHER]))).toBe(0);
    expect(emptyPupilPart(answers, [pupils[1]!], new Set([OTHER]))).toBe(0);
    expect(pupils[0]).toEqual(proof());
    expect(pupils[1]).toEqual(answer());
  });

  it('hold back, in the extract of the member of staff who moved a pupil, the pupil, the two lessons and the mark the move displaced', () => {
    const moves = files.find((file) => file.table === 'LessonPupilMoves')!;
    expect(moves.dump.columns).toEqual(['studentId', 'movedById']);
    expect(moves.dump.pupil).toEqual({ column: 'studentId', hides: ['displacedMark', 'fromLessonId', 'toLessonId'] });
    const rows = [
      {
        id: 'm1', studentId: OTHER, fromLessonId: 'l1', toLessonId: 'l2', movedById: TEACHER,
        displacedMark: { status: 'EXCUSED', note: 'Anmäld av mamma: kontroll på BUP', recordedById: '44444444-4444-4444-8444-444444444444' },
        createdAt: '2026-11-05T09:00:00Z',
      },
    ];
    expect(emptyPupilPart(moves, rows, new Set([TEACHER]))).toBe(4);
    expect(rows[0]).toEqual({ id: 'm1', studentId: null, fromLessonId: null, toLessonId: null, movedById: TEACHER, displacedMark: null, createdAt: '2026-11-05T09:00:00Z' });
    // The pupil's own extract keeps all of it.
    const own = [{ id: 'm2', studentId: PUPIL, fromLessonId: 'l1', toLessonId: 'l2', movedById: TEACHER, displacedMark: { note: 'sjuk' }, createdAt: 'x' }];
    expect(emptyPupilPart(moves, own, new Set([PUPIL]))).toBe(0);
    expect(own[0]!.displacedMark).toEqual({ note: 'sjuk' });
    expect(own[0]!.studentId).toBe(PUPIL);
  });

  it("lose the pupil and the pupil's state when the pupil is not asked for, and keep the act and everything for a pupil that is", () => {
    const pupils = files.find((file) => file.table === 'CrisisPupils');
    const rows = [
      { studentId: OTHER, state: 'FOUND', priorAbsentSource: null, stateAt: '2026-11-05T09:00:00Z', stateByUserId: TEACHER },
      { studentId: PUPIL, state: 'MISSING', priorAbsentSource: 'LEAVE', stateAt: '2026-11-05T09:01:00Z', stateByUserId: TEACHER },
    ];
    expect(emptyPupilPart(pupils!, rows, new Set([TEACHER, PUPIL]))).toBe(2);
    expect(rows[0]).toEqual({ studentId: null, state: null, priorAbsentSource: null, stateAt: '2026-11-05T09:00:00Z', stateByUserId: TEACHER });
    expect(rows[1]!.studentId).toBe(PUPIL);
    expect(rows[1]!.state).toBe('MISSING');
  });

  it('are left alone in a table that is about no pupil', () => {
    const other = tableFiles().find((file) => !file.dump.pupil)!;
    const rows = [{ studentId: OTHER, x: 1 }];
    expect(emptyPupilPart(other, rows, new Set())).toBe(0);
    expect(rows[0]!.studentId).toBe(OTHER);
  });
});
