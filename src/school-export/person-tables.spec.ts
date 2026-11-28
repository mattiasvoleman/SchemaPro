import { Prisma } from '@prisma/client';
import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';
import { ACCOUNT_KINDS, NOT_A_USER, SUBJECT_ACCESS, WITHOUT_KEY, WITHOUT_SCHOOL_COLUMN, cellOf, emptyPupilPart, excludedTables, inventoriedTables, narrowToPersons, readTable, tableFiles, type CellRules } from './person-tables';

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
    expect(left.map((item) => item.table)).toEqual(['ExamSittings', 'IntegrationKeyWebhookSecrets', 'OutboundNotices', 'PublishedLessons', 'ReportingReminders', 'Ss12000SourceSecrets']);
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

describe('the json columns of a table that name a person (the review of #385, L-9)', () => {
  const TEACHER = '22222222-2222-4222-8222-222222222222';
  const SCHOOL = '33333333-3333-4333-8333-333333333333';

  /** The statement readTable sends for `table`, with no database: what it asks of each column is in the text. */
  const statementFor = async (table: string): Promise<string> => {
    const file = tableFiles().find((candidate) => candidate.table === table)!;
    const sent: Array<{ sql: string }> = [];
    const tx = { $queryRaw: async (statement: { sql: string }) => (sent.push(statement), []) } as unknown as Parameters<typeof readTable>[0];
    await readTable(tx, SCHOOL, file, [TEACHER]);
    return sent[0]!.sql;
  };

  it('reads a Generera run by every json column that holds a teacher\'s Users id, so that a teacher named only there is in the extract', async () => {
    // A run keeps teacher ids in the json of its conflicts, notes and summary params (subjectIds), of its failure's params, and of the
    // analysis that offers changes (teacherIds, resourceIds). The actor's column was the only one read.
    const sql = await statementFor('OptimizationJobs');

    expect(sql).toContain('t."actorId" = ANY(');
    for (const column of ['conflicts', 'notes', 'suggestions', 'conflictSummaryParams', 'errorParams']) {
      expect(sql).toContain(`t."${column}"::text LIKE`);
    }
  });

  it('keeps reading the search\'s own json, as before', async () => {
    expect(await statementFor('StaffingSearchRuns')).toContain('t."checkpoint"::text LIKE');
  });
});

describe('the json of a run names a whole school, and the extract of one teacher carries only that teacher (GDPR art. 15.4)', () => {
  const TEACHER = '22222222-2222-4222-8222-222222222222';
  const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const SCHOOL = '33333333-3333-4333-8333-333333333333';
  const RULE = '66666666-6666-4666-8666-666666666666';
  const strangers = new Set([COLLEAGUE, OTHER]);

  /** A note as OptimizationJobs."notes" keeps it (stored-conflicts.ts): the teacher's Users id in subjectIds, server-side. */
  const note = (code: string, who: string[], params: Record<string, number> = { day: 3 }) => ({
    category: 'AVAILABILITY', code, params, message: 'a sentence', resourceNames: [], subjectIds: who,
  });

  it('keeps the entries of a list that name the person asked for, and no other person\'s', () => {
    const notes = [
      note('TEACHER_FREE_DAY_WISH_NOT_KEPT', [TEACHER]),
      note('TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT', [COLLEAGUE], { day: 4, minutes: 180 }),
      note('TEACHER_TRAVEL_CANNOT_BE_KEPT', [COLLEAGUE, TEACHER]),
    ];

    const kept = narrowToPersons(notes, new Set([TEACHER]), strangers) as Array<{ code: string; subjectIds: string[] }>;

    // The colleague's limit (HR data, shown by the page to a reader with HR-läs only) is not in the teacher's extract; the walk that names
    // both is, and names only the teacher.
    expect(kept.map((entry) => entry.code)).toEqual(['TEACHER_FREE_DAY_WISH_NOT_KEPT', 'TEACHER_TRAVEL_CANNOT_BE_KEPT']);
    expect(kept.map((entry) => entry.subjectIds)).toEqual([[TEACHER], [TEACHER]]);
    expect(JSON.stringify(kept)).not.toContain(COLLEAGUE);
  });

  it('narrows the analysis of a run to the caps of the person, and a params object to the person\'s id', () => {
    const cap = (teacher: string) => ({ rule: 'TEACHER_DAILY_CAP', proof: 'SOLVED', cost: 1, teacherIds: [teacher], resourceIds: [RULE] });
    const analysis = { version: 1, state: 'DONE', verified: true, changes: [cap(COLLEAGUE), cap(TEACHER)] };
    const params = { day: 2, subjectIds: [COLLEAGUE, TEACHER, OTHER] };

    const narrowed = narrowToPersons(analysis, new Set([TEACHER]), strangers) as typeof analysis;
    expect(narrowed.changes).toEqual([cap(TEACHER)]);
    expect(narrowed.state).toBe('DONE');
    // A rule's id is no user: it stays.
    expect(narrowed.changes[0]!.resourceIds).toEqual([RULE]);
    expect(narrowToPersons(params, new Set([TEACHER]), strangers)).toEqual({ day: 2, subjectIds: [TEACHER] });
  });

  it('writes a stranger\'s id that stands on its own, and leaves what is not an id of a user of the school', () => {
    expect(narrowToPersons({ about: COLLEAGUE, rule: RULE, minutes: 5, names: ['Sal 4'] }, new Set([TEACHER]), strangers)).toEqual({
      about: '(annan person)', rule: RULE, minutes: 5, names: ['Sal 4'],
    });
    expect(narrowToPersons(null, new Set([TEACHER]), strangers)).toBeNull();
  });

  it('reads a run through it: a teacher named only in the notes gets her entries and none of the colleague\'s, through readTable', async () => {
    const file = tableFiles().find((candidate) => candidate.table === 'OptimizationJobs')!;
    const row = {
      id: '77777777-7777-4777-8777-777777777777', actorId: OTHER, status: 'SUCCEEDED',
      notes: [note('TEACHER_FREE_DAY_WISH_NOT_KEPT', [TEACHER]), note('TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT', [COLLEAGUE], { day: 4, minutes: 180 })],
      conflicts: [note('TEACHER_TRAVEL_CANNOT_BE_KEPT', [COLLEAGUE, OTHER])],
      conflictSummaryParams: { subjectIds: [COLLEAGUE] },
      errorParams: null,
      suggestions: null,
    };
    const tx = { $queryRaw: async () => [{ j: JSON.stringify(row) }] } as unknown as Parameters<typeof readTable>[0];

    const [read] = await readTable(tx, SCHOOL, file, [TEACHER], strangers);

    expect(read!['notes']).toEqual([note('TEACHER_FREE_DAY_WISH_NOT_KEPT', [TEACHER])]);
    expect(read!['conflicts']).toEqual([]);
    expect(read!['conflictSummaryParams']).toEqual({ subjectIds: [] });
    // The columns that are not json about people are as the table has them.
    expect(read!['status']).toBe('SUCCEEDED');
    expect(JSON.stringify(read!['notes'])).not.toContain(COLLEAGUE);
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
    // The process that ran a Generera run (OptimizationJobs.claimedBy) is the platform's name for an instance, not the person's.
    expect(cellOf('claimedBy', 'host-7f9c:4242:3fa91c0e', marked)).toEqual({ text: '(dold)', held: false });
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
  const files = tableFiles().filter((file) => file.dump.pupil && file.dump.pupil.column === 'studentId');
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

/**
 * g409-L-5, K7 and K7b. A rektor who assessed twenty teachers is handed twenty colleagues' level, exception, day and note in their own
 * extract, an administrator who edited forty posts the whole post, before and after, of forty colleagues, and an expedition clerk who
 * registered a year of sick leave the period and the category (health data, GDPR art. 9) of every teacher who called in. The page
 * shows those only to a reader with HR-läs or, for an absence, to an administrator and the absent teacher and nobody else, and GDPR
 * art. 15.4 says the copy must not harm anyone else's rights. The act is the extract's; the colleague and what was decided about
 * them are not.
 */
describe('the rows of a table that holds a decision about a colleague', () => {
  const RECTOR = '33333333-3333-4333-8333-333333333333';
  const TEACHER = '11111111-1111-4111-8111-111111111111';
  const COLLEAGUE = '22222222-2222-4222-8222-222222222222';
  const SUBSTITUTE = '44444444-4444-4444-8444-444444444444';
  const colleagueTables = tableFiles().filter((file) => file.dump.pupil && file.dump.pupil.column !== 'studentId');
  const fileOf = (table: string) => colleagueTables.find((file) => file.table === table)!;
  /** Every column of the table as the schema has it, by the table's own name. */
  const columnsOf = (table: string): string[] => {
    const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.dbName === table);
    if (!model) throw new Error(`no model for ${table}`);
    return model.fields.filter((field) => field.kind !== 'object').map((field) => field.name);
  };

  // The tables where one person decides and the row is a colleague's, with the column that is the colleague and the kind of läslogg
  // record. A table added here is said to be about a colleague on purpose.
  const ABOUT_A_COLLEAGUE = {
    AssignmentScopeAssessments: { column: 'userId', kind: 'EMPLOYMENT' },
    TeacherEmploymentLogs: { column: 'userId', kind: 'EMPLOYMENT' },
    TeacherAbsences: { column: 'userId', kind: 'STAFF_ABSENCES' },
    TeacherAbsenceCovers: { column: 'absentTeacherId', kind: 'STAFF_ABSENCES' },
    SupervisionCovers: { column: 'absentTeacherId', kind: 'STAFF_ABSENCES' },
  } as const;

  it("are the rektor's assessments of a teacher, the history of a post, and the three tables that say a teacher was away; the colleague is the column the dump reads", () => {
    expect(colleagueTables.map((file) => file.table).sort()).toEqual(Object.keys(ABOUT_A_COLLEAGUE).sort());
    for (const [table, expected] of Object.entries(ABOUT_A_COLLEAGUE)) {
      expect(fileOf(table).dump.pupil!.column).toBe(expected.column);
      expect(fileOf(table).dump.columns).toContain(expected.column);
      expect(fileOf(table).dump.kind).toBe(expected.kind);
    }
  });

  // The test that matters most for the future: a column added to any of these tables is neither the act nor hidden until somebody says
  // which, and until then this fails. Written the other way round (a list of what to hide) a new column would be handed out.
  it.each([
    ['AssignmentScopeAssessments', ['id', 'schoolId', 'academicYearId', 'decidedById', 'decidedAt', 'createdAt', 'updatedAt']],
    ['TeacherEmploymentLogs', ['id', 'schoolId', 'academicYearId', 'entity', 'action', 'actorId', 'createdAt']],
    // Who registered, who took it back, and when: the status says only that the registration stands or was taken back. The period and the
    // category are the colleague's.
    ['TeacherAbsences', ['id', 'schoolId', 'status', 'createdByUserId', 'withdrawnAt', 'withdrawnByUserId', 'createdAt', 'updatedAt']],
    // Which lesson the decision was about, what was decided (a substitute, the lesson cancelled, supervised study, a co-teacher), who
    // the substitute was and who decided. Who was away, which absence, who the lesson was taken from and the note that was on it are
    // the colleague's.
    ['TeacherAbsenceCovers', ['id', 'schoolId', 'calendarLessonId', 'decision', 'substituteId', 'decidedByUserId', 'decidedAt']],
    // The pass as it was decided that day (the vikarie reads the place and the time from the row: it is their own duty), what was
    // decided and by whom. The pass row, which is the absent teacher's own and not the vikarie's to read, and the absence are the
    // colleague's.
    ['SupervisionCovers', ['id', 'schoolId', 'date', 'areaId', 'startsAt', 'endsAt', 'decision', 'substituteId', 'decidedByUserId', 'decidedAt']],
  ])('%s: every column is the act, the colleague or what was decided about them, and no column is more than one', (table, act) => {
    const about = fileOf(table).dump.pupil!;
    const decided = [about.column, ...about.hides];
    expect([...act, ...decided].sort()).toEqual(columnsOf(table).sort());
    expect(act.filter((column) => decided.includes(column))).toEqual([]);
    // The ones who acted are always the act, in every table: it is what the extract is about.
    expect(fileOf(table).dump.columns.filter((column) => column !== about.column).every((column) => act.includes(column))).toBe(true);
  });

  it("empties the teacher, the level, the exception, the day and the note of an assessment in the rektor's extract, and keeps who decided and when", () => {
    const rows = [
      {
        id: 'a1', schoolId: 's', userId: COLLEAGUE, academicYearId: 'y', teachingLevelHours: 600, exceptionKind: 'OWN_INITIATIVE',
        ownInitiativeOn: '2027-09-01', note: 'Vill undervisa mer, efter sjukskrivningen', decidedById: RECTOR, decidedAt: '2027-03-10T09:00:00Z',
        createdAt: '2027-03-10T09:00:00Z', updatedAt: '2027-03-10T09:00:00Z',
      },
    ];
    expect(emptyPupilPart(fileOf('AssignmentScopeAssessments'), rows, new Set([RECTOR]))).toBe(5);
    expect(rows[0]).toEqual({
      id: 'a1', schoolId: 's', userId: null, academicYearId: 'y', teachingLevelHours: null, exceptionKind: null,
      ownInitiativeOn: null, note: null, decidedById: RECTOR, decidedAt: '2027-03-10T09:00:00Z',
      createdAt: '2027-03-10T09:00:00Z', updatedAt: '2027-03-10T09:00:00Z',
    });
  });

  it("empties the colleague, the post and both versions of it in the extract of the administrator who changed it, and keeps the act", () => {
    const rows = [
      {
        id: 'l1', schoolId: 's', userId: COLLEAGUE, academicYearId: 'y', version: 3, entity: 'EMPLOYMENT', entityId: 'e1', action: 'UPDATE',
        before: { employmentPercent: 80, reductionPercent: 10 }, after: { employmentPercent: 60, reductionPercent: 0, note: 'föräldraledig' },
        actorId: RECTOR, createdAt: '2027-03-10T09:00:00Z',
      },
    ];
    expect(emptyPupilPart(fileOf('TeacherEmploymentLogs'), rows, new Set([RECTOR]))).toBe(5);
    expect(rows[0]).toEqual({
      id: 'l1', schoolId: 's', userId: null, academicYearId: 'y', version: null, entity: 'EMPLOYMENT', entityId: null, action: 'UPDATE',
      before: null, after: null, actorId: RECTOR, createdAt: '2027-03-10T09:00:00Z',
    });
  });

  it("keeps the whole row in the teacher's own extract, with the one who decided, and in the extract of a rektor who assessed themself", () => {
    const assessment = () => ({ id: 'a1', userId: TEACHER, teachingLevelHours: 560, exceptionKind: null, ownInitiativeOn: null, note: 'Mentor för åk 9', decidedById: RECTOR });
    const own = [assessment()];
    expect(emptyPupilPart(fileOf('AssignmentScopeAssessments'), own, new Set([TEACHER]))).toBe(0);
    expect(own[0]).toEqual(assessment());
    const self = [{ ...assessment(), userId: RECTOR }];
    expect(emptyPupilPart(fileOf('AssignmentScopeAssessments'), self, new Set([RECTOR]))).toBe(0);
    expect(self[0]!.userId).toBe(RECTOR);
    expect(self[0]!.teachingLevelHours).toBe(560);
  });

  it('counts the cells it empties, and only the ones that held something', () => {
    const rows = [{ id: 'a2', userId: COLLEAGUE, teachingLevelHours: null, exceptionKind: 'SMALL_GROUP', ownInitiativeOn: null, note: null, decidedById: RECTOR }];
    // The colleague and the exception: two cells that held something.
    expect(emptyPupilPart(fileOf('AssignmentScopeAssessments'), rows, new Set([RECTOR]))).toBe(2);
  });

  describe('an absence (K7b): the period and the category are health data, read by an administrator and the absent teacher and no one else', () => {
    const absence = (over: Record<string, unknown> = {}) => ({
      id: 'f1', schoolId: 's', userId: COLLEAGUE, startsAt: '2027-02-01T00:00:00Z', endsAt: '2027-02-04T00:00:00Z', wholeDays: true,
      reasonId: 'r-sjukdom', status: 'ACTIVE', createdByUserId: RECTOR, withdrawnAt: null, withdrawnByUserId: null,
      createdAt: '2027-02-01T06:50:00Z', updatedAt: '2027-02-01T06:50:00Z', ...over,
    });

    it("empties the teacher, the period, whether it was whole days and the category in the extract of the one who registered it, and keeps who registered it and when", () => {
      const rows = [absence()];
      expect(emptyPupilPart(fileOf('TeacherAbsences'), rows, new Set([RECTOR]))).toBe(5);
      expect(rows[0]).toEqual(absence({ userId: null, startsAt: null, endsAt: null, wholeDays: null, reasonId: null }));
    });

    it('keeps the act of the one who took the registration back: who, when, and that it stands no longer', () => {
      const rows = [absence({ status: 'WITHDRAWN', withdrawnAt: '2027-02-02T08:00:00Z', withdrawnByUserId: RECTOR, createdByUserId: SUBSTITUTE })];
      emptyPupilPart(fileOf('TeacherAbsences'), rows, new Set([RECTOR]));
      expect(rows[0]).toMatchObject({ status: 'WITHDRAWN', withdrawnAt: '2027-02-02T08:00:00Z', withdrawnByUserId: RECTOR, userId: null, reasonId: null });
    });

    // A teacher reports their own absence when the school lets them (CoverSettings.teacherSelfReport) and takes it back themself: the
    // colleague's id then stands in an actor column too, and the extract of the administrator who took part must not carry it there.
    it("does not leave the teacher in the column of the one who registered or took back, where the teacher did it themself", () => {
      const reported = [absence({ createdByUserId: COLLEAGUE, withdrawnAt: '2027-02-02T08:00:00Z', withdrawnByUserId: RECTOR, status: 'WITHDRAWN' })];
      expect(emptyPupilPart(fileOf('TeacherAbsences'), reported, new Set([RECTOR]))).toBe(6);
      expect(reported[0]).toMatchObject({ userId: null, createdByUserId: null, withdrawnByUserId: RECTOR });
      const withdrawn = [absence({ withdrawnAt: '2027-02-02T08:00:00Z', withdrawnByUserId: COLLEAGUE, status: 'WITHDRAWN' })];
      expect(emptyPupilPart(fileOf('TeacherAbsences'), withdrawn, new Set([RECTOR]))).toBe(6);
      expect(withdrawn[0]).toMatchObject({ userId: null, withdrawnByUserId: null, createdByUserId: RECTOR });
    });

    it("keeps the whole row in the absent teacher's own extract, and in the extract of an administrator who registered their own absence", () => {
      const own = [absence({ createdByUserId: COLLEAGUE, withdrawnByUserId: RECTOR, withdrawnAt: 'x' })];
      expect(emptyPupilPart(fileOf('TeacherAbsences'), own, new Set([COLLEAGUE]))).toBe(0);
      expect(own[0]).toEqual(absence({ createdByUserId: COLLEAGUE, withdrawnByUserId: RECTOR, withdrawnAt: 'x' }));
      const self = [absence({ userId: RECTOR })];
      expect(emptyPupilPart(fileOf('TeacherAbsences'), self, new Set([RECTOR]))).toBe(0);
      expect(self[0]).toEqual(absence({ userId: RECTOR }));
    });

    const cover = (over: Record<string, unknown> = {}) => ({
      id: 'c1', schoolId: 's', absenceId: 'f1', calendarLessonId: 'lesson-1', absentTeacherId: COLLEAGUE,
      removedTeachers: [{ teacherId: COLLEAGUE, role: 'LEAD' }], decision: 'SUBSTITUTE', substituteId: SUBSTITUTE,
      previousNote: 'Se uppgiften, jag är hos läkaren', decidedByUserId: RECTOR, decidedAt: '2027-02-01T07:10:00Z', ...over,
    });

    it("empties who was away, the absence, who the lesson was taken from and the note that was on it in the extract of the one who decided and in the substitute's, and keeps the decision", () => {
      const decided = [cover()];
      expect(emptyPupilPart(fileOf('TeacherAbsenceCovers'), decided, new Set([RECTOR]))).toBe(4);
      expect(decided[0]).toEqual(cover({ absenceId: null, absentTeacherId: null, removedTeachers: null, previousNote: null }));
      const covering = [cover()];
      expect(emptyPupilPart(fileOf('TeacherAbsenceCovers'), covering, new Set([SUBSTITUTE]))).toBe(4);
      expect(covering[0]).toMatchObject({ calendarLessonId: 'lesson-1', decision: 'SUBSTITUTE', substituteId: SUBSTITUTE, decidedByUserId: RECTOR, absentTeacherId: null });
    });

    it("keeps the whole decision in the extract of the teacher who was away", () => {
      const own = [cover()];
      expect(emptyPupilPart(fileOf('TeacherAbsenceCovers'), own, new Set([COLLEAGUE]))).toBe(0);
      expect(own[0]).toEqual(cover());
    });

    const pass = (over: Record<string, unknown> = {}) => ({
      id: 'p1', schoolId: 's', shiftId: 'shift-1', date: '2027-02-02', areaId: 'area-1', startsAt: '2027-02-02T10:20:00Z', endsAt: '2027-02-02T10:40:00Z',
      absenceId: 'f1', absentTeacherId: COLLEAGUE, decision: 'SUBSTITUTE', substituteId: SUBSTITUTE, decidedByUserId: RECTOR, decidedAt: '2027-02-01T07:12:00Z', ...over,
    });

    it("empties the teacher whose pass it was, the pass and the absence, and keeps the occurrence the vikarie reads, the decision and who made it", () => {
      const decided = [pass()];
      expect(emptyPupilPart(fileOf('SupervisionCovers'), decided, new Set([RECTOR]))).toBe(3);
      expect(decided[0]).toEqual(pass({ shiftId: null, absenceId: null, absentTeacherId: null }));
      const taken = [pass()];
      expect(emptyPupilPart(fileOf('SupervisionCovers'), taken, new Set([SUBSTITUTE]))).toBe(3);
      // The vikarie's own duty is theirs: where, when and who put them there.
      expect(taken[0]).toMatchObject({ date: '2027-02-02', areaId: 'area-1', startsAt: '2027-02-02T10:20:00Z', endsAt: '2027-02-02T10:40:00Z', decidedByUserId: RECTOR });
      const own = [pass()];
      expect(emptyPupilPart(fileOf('SupervisionCovers'), own, new Set([COLLEAGUE]))).toBe(0);
      expect(own[0]).toEqual(pass());
    });
  });

  // K7b: these tables too have a member of staff who acts against a colleague, and each was checked against the schema and what the page
  // shows. None holds an HR figure, a health category or a free text about the colleague: what the row says about the colleague is what
  // every administrator reads and what the school shows or tells in its own work. They are the extract's whole, and a column added to
  // one of them is a decision for whoever adds it (this list fails when one of them starts to hide something, and when one is added).
  describe('the tables where a member of staff acts against a colleague and the row is the extract\'s whole', () => {
    const WHOLE = {
      // Every administrator reads the history on the people page, and the current role, profile, HR-läs and teaching are on the same page
      // (UserRoleChanges is `readOnly` in admin-areas.ts, and the profile and HR-läs of an administrator are in the list every administrator
      // reads). The row is the record of who gave whom which authority: no HR figure, no category, no text.
      UserRoleChanges: ['userId', 'actorId'],
      // The row holds nobody's state but that the person is in the pool the cover board draws from, which every administrator reads and the
      // person reads of themself. No column beyond who and who added them.
      SubstitutePoolMembers: ['userId', 'createdByUserId'],
      // Which class was given to whom and who gave it: every administrator reads the table and the teacher reads their own row. An
      // assignment of work: no HR figure, no health category and no free text.
      ClassTeacherAppointments: ['userId', 'appointedByUserId'],
      // A link to the school's published timetable of a teacher, a class, a room or a pupil. The token is `(dold)`. The teacher's
      // published timetable is public by the school's own act.
      PublicTimetableLinks: ['targetTeacherId', 'targetStudentId', 'createdByUserId'],
    } as const;

    it.each(Object.entries(WHOLE))('%s is dumped whole: no colleague, no column, is held back', (table, columns) => {
      const decision = SUBJECT_ACCESS[table]!;
      expect('dump' in decision).toBe(true);
      const dumped = (decision as { dump: { columns: readonly string[]; pupil?: unknown; thirdParty?: unknown } }).dump;
      expect(dumped.columns).toEqual(columns);
      expect(dumped.pupil).toBeUndefined();
      expect(dumped.thirdParty).toBeUndefined();
      expect(colleagueTables.map((file) => file.table)).not.toContain(table);
    });
  });
});
