import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { blankLesson, type ExchangeLesson } from './exchange-model';
import { writeCsv } from './csv';
import { lessonsToTable } from './lesson-table';
import { writeXlsx } from './xlsx';
import { documentOf, IMPORT_HAS_REFUSALS, IMPORT_PLAN_CHANGED, ScheduleExchangeService } from './exchange.service';
import { indexContext, type PlanContext } from './exchange-plan';

jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn().mockResolvedValue({ kind: 'CURRENT' }) }));
jest.mock('../optimization/room-eligibility', () => ({
  loadRosters: jest.fn().mockResolvedValue({}),
  gradeSpanOf: jest.fn((_rosters: unknown, ids: string[]) => ({ 'g-7a': { min: 7, max: 7 }, 'g-7b': { min: 7, max: 7 } })[ids[0]!] ?? null),
}));
jest.mock('../publication/publish-mode', () => ({
  ...jest.requireActual('../publication/publish-mode'),
  enterGrundschemaWrite: jest.fn().mockResolvedValue('DIRECT'),
  publishModeOf: jest.fn().mockResolvedValue('DIRECT'),
}));
jest.mock('../optimization/regeneration-lock', () => ({
  ...jest.requireActual('../optimization/regeneration-lock'),
  lockYearForGrundschemaEdit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../access-log/access-log', () => ({ ...jest.requireActual('../access-log/access-log'), recordRead: jest.fn().mockResolvedValue(undefined) }));

import { enterGrundschemaWrite, publishModeOf } from '../publication/publish-mode';
import { recordRead } from '../access-log/access-log';

const SCHOOL = 'school-1';
const YEAR = 'year-1';
const user: AuthenticatedUser = { authId: 'a', role: Role.SCHOOL_ADMIN, userId: 'u-admin', schoolId: SCHOOL, channel: 'WEB' };

const time = (hh: number, mm = 0) => new Date(Date.UTC(1970, 0, 1, hh, mm));
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function masterRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    studentGroupId: 'g-7a',
    subjectId: 's-ma',
    teacherId: 't-abe',
    coTeacherId: null,
    roomId: 'r-101',
    dayOfWeek: 1,
    startTime: time(8, 10),
    endTime: time(9, 10),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isLocked: false,
    isGenerated: true,
    extraGroups: [],
    participants: [],
    ...over,
  };
}

function world(over: { lessons?: unknown[]; requirements?: unknown[]; blocks?: unknown[]; frames?: unknown[]; rasts?: unknown[]; lunch?: unknown; sittings?: unknown[]; conflicts?: unknown[] } = {}) {
  const tx = {
    academicYear: {
      findUnique: jest.fn().mockResolvedValue({
        id: YEAR,
        schoolId: SCHOOL,
        name: '2026/2027',
        startDate: date('2026-08-17'),
        endDate: date('2027-06-11'),
        isActive: true,
        predecessorId: null,
        gradeNumbering: 'NIOARIG',
        school: { name: 'Högstadieskolan' },
      }),
    },
    studentGroup: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'g-7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
        { id: 'g-7b', name: '7B', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
      ]),
    },
    subject: {
      findMany: jest.fn().mockResolvedValue([
        { id: 's-ma', name: 'Matematik', code: 'MA' },
        { id: 's-sv', name: 'Svenska', code: 'SV' },
      ]),
    },
    room: { findMany: jest.fn().mockResolvedValue([{ id: 'r-101', name: 'A101', code: null }, { id: 'r-102', name: 'A102', code: null }]) },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: 't-abe', firstName: 'Anna', lastName: 'Berg', email: 'anna@skolan.example', isActive: true },
        { id: 't-blu', firstName: 'Bo', lastName: 'Lund', email: 'bo@skolan.example', isActive: true },
        { id: 't-nosig', firstName: 'Nina', lastName: 'Utan', email: 'nina@skolan.example', isActive: true },
      ]),
    },
    teacherEmployment: {
      findMany: jest.fn().mockResolvedValue([
        { userId: 't-abe', signature: 'ABE' },
        { userId: 't-blu', signature: ' BLU ' },
        { userId: 't-nosig', signature: null },
      ]),
    },
    masterLesson: {
      findMany: jest.fn().mockResolvedValue(over.lessons ?? []),
      count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    masterLessonGroup: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    scheduleChangeLog: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    frameTime: { findMany: jest.fn().mockResolvedValue(over.frames ?? []) },
    rast: { findMany: jest.fn().mockResolvedValue(over.rasts ?? []) },
    lunchSetting: { findUnique: jest.fn().mockResolvedValue(over.lunch ?? null) },
    lunchServing: { findMany: jest.fn().mockResolvedValue([]) },
    lunchSitting: { findMany: jest.fn().mockResolvedValue(over.sittings ?? []) },
    teachingRequirement: { findMany: jest.fn().mockResolvedValue(over.requirements ?? []), create: jest.fn().mockResolvedValue({}) },
    teachingBlock: {
      findMany: jest.fn().mockResolvedValue(over.blocks ?? []),
      create: jest.fn().mockImplementation(({ data }: { data: { name: string } }) => Promise.resolve({ id: `b-${data.name}`, name: data.name })),
    },
  };
  const prisma = { withRls: jest.fn((_user: unknown, fn: (tx: unknown) => unknown) => fn(tx)) };
  const masterLessons = { findConflicts: jest.fn().mockResolvedValue(over.conflicts ?? []) };
  const realtime = { notifyMasterTimetableChanged: jest.fn() };
  const service = new ScheduleExchangeService(prisma as never, realtime as never, masterLessons as never);
  return { service, tx, prisma, masterLessons, realtime };
}

const base = (over: Partial<ExchangeLesson> = {}): ExchangeLesson =>
  blankLesson({ ref: '', group: '7A', subject: 'Matematik', day: 1, start: '08:10', end: '09:10', room: 'A101', teachers: [{ short: 'ABE', name: null, email: null, id: null }], ...over });

/** An upload the way the controller hands it over: a CSV written by the codec the page's export uses. */
function csv(lessons: ExchangeLesson[]): { name: string; bytes: Buffer }[] {
  const doc = { school: 'x', year: { name: '2026/2027', start: '2026-08-17', end: '2027-06-11' }, lessons, groups: [], subjects: [], rooms: [], teachers: [] };
  return [{ name: 'schema.csv', bytes: Buffer.from(writeCsv(lessonsToTable(doc)), 'utf8') }];
}

const preview = (service: ScheduleExchangeService, lessons: ExchangeLesson[]) =>
  service.preview({ academicYearId: YEAR, format: 'TABLE_CSV', files: csv(lessons) }, user);

beforeEach(() => {
  jest.clearAllMocks();
  (enterGrundschemaWrite as jest.Mock).mockResolvedValue('DIRECT');
  (publishModeOf as jest.Mock).mockResolvedValue('DIRECT');
});

describe('ScheduleExchangeService.preview', () => {
  it('plans a new lesson, derives its post, and writes nothing', async () => {
    const { service, tx, masterLessons } = world();
    const plan = await preview(service, [base(), base({ day: 3 })]);
    expect(plan.canApply).toBe(true);
    expect(plan.summary).toMatchObject({ rows: 2, create: 2, unchanged: 0, refused: 0, unreadable: 0, notInFile: 0 });
    expect(plan.rows.map((r) => r.action)).toEqual(['CREATE', 'CREATE']);
    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0]).toMatchObject({ action: 'CREATE', groupName: '7A', subjectName: 'Matematik', lessonsPerWeek: 2, minutesPerLesson: 60, teacherId: 't-abe' });
    expect(masterLessons.findConflicts).toHaveBeenCalledTimes(2);
    expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
    expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    // The teachers it matched are read about other people, so the read is recorded.
    expect(recordRead).toHaveBeenCalledWith(tx, 'PEOPLE', new Set(['t-abe']), 'WEB');
  });

  it('gives the same fingerprint for the same file and another when the file differs', async () => {
    const { service } = world();
    const a = await preview(service, [base()]);
    const b = await preview(service, [base()]);
    const c = await preview(service, [base({ day: 2 })]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it('names every row it cannot place and does not ask the clash scan about it', async () => {
    const { service, masterLessons } = world();
    const plan = await preview(service, [
      base({ group: '9Z' }),
      base({ teachers: [{ short: 'NOPE', name: null, email: null, id: null }], day: 2 }),
      base({ room: 'Aulan', day: 3 }),
      base({ day: 4 }),
    ]);
    expect(plan.canApply).toBe(false);
    expect(plan.summary).toMatchObject({ create: 1, refused: 3 });
    // The table is written sorted (class, day, start), and read in that order.
    expect(plan.rows.map((r) => [r.action, r.refusals.map((x) => x.code)])).toEqual([
      ['REFUSED', ['UNKNOWN_TEACHER']],
      ['REFUSED', ['UNKNOWN_ROOM']],
      ['CREATE', []],
      ['REFUSED', ['UNKNOWN_GROUP']],
    ]);
    expect(masterLessons.findConflicts).toHaveBeenCalledTimes(1);
  });

  it('refuses a row that repeats an earlier one', async () => {
    const { service } = world();
    const plan = await preview(service, [base(), base()]);
    expect(plan.rows[1]!.refusals.map((r) => r.code)).toEqual(['DUPLICATE_ROW']);
    expect(plan.rows[1]!.refusals[0]!.params).toEqual({ first: plan.rows[0]!.ref });
  });

  it('reports a lesson the school already has as unchanged, and one with other content as refused, naming what differs', async () => {
    const { service, masterLessons } = world({ lessons: [masterRow(), masterRow({ id: 'm2', dayOfWeek: 2 })] });
    const plan = await preview(service, [base(), base({ day: 2, room: 'A102' }), base({ day: 5 })]);
    expect(plan.rows.map((r) => r.action)).toEqual(['UNCHANGED', 'REFUSED', 'CREATE']);
    expect(plan.rows[1]!.changes).toEqual(['sal']);
    expect(plan.rows[1]!.refusals[0]).toMatchObject({ code: 'EXISTS_DIFFERENT', params: { changes: 'sal' } });
    expect(plan.summary).toMatchObject({ unchanged: 1, refused: 1, create: 1, notInFile: 0 });
    // Only the new row meets the clash scan: the school's own lessons are not re-judged.
    expect(masterLessons.findConflicts).toHaveBeenCalledTimes(1);
  });

  it('counts the school’s lessons that the file does not mention', async () => {
    const { service } = world({ lessons: [masterRow(), masterRow({ id: 'm2', dayOfWeek: 2 })] });
    const plan = await preview(service, [base()]);
    expect(plan.summary).toMatchObject({ unchanged: 1, notInFile: 1 });
  });

  it('turns the clash scan’s answers into refusals that name the other lesson, the school’s or an earlier row', async () => {
    const { service, masterLessons } = world({ lessons: [masterRow({ id: 'm9', dayOfWeek: 2, subjectId: 's-sv' })] });
    masterLessons.findConflicts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { kind: 'TEACHER', message: 'Teacher already teaches Svenska in this slot.', masterLessonId: 'm9' },
        { kind: 'ROOM', message: 'Room is already booked.', masterLessonId: 'import:0' },
        { kind: 'GROUP', message: 'The group already has it.' },
        { kind: 'AVAILABILITY', message: 'The teacher is unavailable in this slot.' },
        { kind: 'GROUP', message: 'x', masterLessonId: 'gone' },
      ]);
    const plan = await preview(service, [base(), base({ day: 2, room: 'A102', ref: 'x' })]);
    const refusals = plan.rows[1]!.refusals;
    expect(refusals.map((r) => r.code)).toEqual(['CLASH_TEACHER', 'CLASH_ROOM', 'CLASH_GROUP', 'CLASH_AVAILABILITY', 'CLASH_GROUP']);
    expect(refusals[0]!.params['with']).toBe('Svenska för 7A tis 08:10');
    expect(refusals[1]!.params['with']).toBe(plan.rows[0]!.ref);
    expect(refusals[2]!.params['with']).toBe('en regel');
    expect(refusals[4]!.params['with']).toBe('en annan lektion');
    expect(plan.canApply).toBe(false);
  });

  it('holds a row against the rows accepted before it, on its own day only', async () => {
    const { service, masterLessons } = world();
    await preview(service, [base(), base({ day: 1, start: '10:00', end: '11:00' }), base({ day: 2 })]);
    const alongside = (call: number) => (masterLessons.findConflicts.mock.calls[call]![4] as { alongside: { id: string }[] }).alongside.map((a) => a.id);
    expect(alongside(0)).toEqual([]);
    expect(alongside(1)).toEqual(['import:0']);
    expect(alongside(2)).toEqual([]);
    const candidate = masterLessons.findConflicts.mock.calls[0]![3] as Record<string, unknown>;
    expect(candidate).toMatchObject({ dayOfWeek: 1, startMinutes: 490, endMinutes: 550, teacherId: 't-abe', roomId: 'r-101', recurrence: 'ALL_WEEKS', startDate: null });
  });

  it('refuses a lesson outside the frame, over a rast, or on the generator’s lunch, before the clash scan', async () => {
    const { service, masterLessons } = world({
      frames: [{ minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: time(8), endTime: time(15) }],
      rasts: [{ name: 'Rast', minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: time(9, 40), endTime: time(10) }],
      sittings: [{ studentGroupId: 'g-7a', dayOfWeek: 3, startTime: time(11), endTime: time(11, 30) }],
    });
    const plan = await preview(service, [
      base({ start: '14:30', end: '15:30' }),
      base({ day: 2, start: '09:30', end: '10:30' }),
      base({ day: 3, start: '10:40', end: '11:40' }),
    ]);
    expect(plan.rows.map((r) => r.refusals.map((x) => x.code))).toEqual([['OUTSIDE_FRAME'], ['IN_RAST'], ['ON_LUNCH_SITTING']]);
    expect(masterLessons.findConflicts).not.toHaveBeenCalled();
  });

  it('warns about a lesson outside the engine’s day and does not refuse it', async () => {
    const { service } = world();
    const plan = await preview(service, [base({ start: '07:30', end: '08:30' })]);
    expect(plan.canApply).toBe(true);
    expect(plan.warnings.map((w) => [w.code, w.params['ref']])).toEqual([['OUTSIDE_SOLVER_DAY', plan.rows[0]!.ref]]);
  });

  it('refuses the last lesson that leaves a class no lunch, and not the ones before it', async () => {
    const { service } = world({
      lunch: { lunchEnabled: true, lunchStartTime: time(11), lunchEndTime: time(13), lunchMinutes: 30 },
      lessons: [masterRow({ id: 'am', startTime: time(10), endTime: time(11, 45), dayOfWeek: 1, subjectId: 's-sv' })],
    });
    const plan = await preview(service, [
      base({ start: '12:10', end: '13:00', day: 1 }),
      base({ start: '10:00', end: '11:45', day: 1, subject: 'Svenska', teachers: [{ short: 'BLU', name: null, email: null, id: null }], room: 'A102' }),
    ]);
    // The school already has a 10:00 svenska, but with another room and teacher; the 12:10 lesson tips the lunch.
    expect(plan.rows.map((r) => [r.action, r.refusals.map((x) => x.code)])).toEqual([
      ['REFUSED', ['EXISTS_DIFFERENT']],
      ['REFUSED', ['NO_ROOM_FOR_LUNCH']],
    ]);
    expect(plan.rows[1]!.refusals[0]!.params).toMatchObject({ group: '7A', day: 1, start: '11:00', end: '13:00', minutes: 30 });
  });

  it('lets a lunch window with room for the lunch pass', async () => {
    const { service } = world({ lunch: { lunchEnabled: true, lunchStartTime: time(11), lunchEndTime: time(13), lunchMinutes: 30 } });
    const plan = await preview(service, [base({ start: '10:00', end: '11:30' }), base({ start: '12:00', end: '13:00' })]);
    expect(plan.rows.map((r) => r.action)).toEqual(['CREATE', 'CREATE']);
  });

  it('says a post that exists is left alone and what the lessons would have made it', async () => {
    const post = { id: 'q1', studentGroupId: 'g-7a', subjectId: 's-ma', teacherId: 't-blu', coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [], recurrence: 'ALL_WEEKS', startDate: null, endDate: null, blockId: null };
    const { service } = world({ requirements: [post] });
    const plan = await preview(service, [base()]);
    expect(plan.requirements[0]).toMatchObject({ action: 'KEEP', existingId: 'q1' });
    expect(plan.warnings.map((w) => w.code)).toEqual(['REQ_DIFFERS_FROM_POST']);
  });

  it('makes a block for posts that agree, and none for posts that differ', async () => {
    const agree = await world().service.preview(
      { academicYearId: YEAR, format: 'TABLE_CSV', files: csv([base({ block: 'Språkval' }), base({ group: '7B', subject: 'Matematik', block: 'Språkval' })]) },
      user,
    );
    expect(agree.newBlocks).toEqual(['Språkval']);
    expect(agree.requirements.every((q) => q.block === 'Språkval')).toBe(true);

    const differ = await world().service.preview(
      { academicYearId: YEAR, format: 'TABLE_CSV', files: csv([base({ block: 'Språkval' }), base({ day: 2, block: 'Språkval' }), base({ group: '7B', block: 'Språkval' })]) },
      user,
    );
    expect(differ.newBlocks).toEqual([]);
    expect(differ.requirements.every((q) => q.block === null)).toBe(true);
    expect(differ.warnings.map((w) => w.code)).toContain('BLOCK_MEMBERS_DIFFER');

    // A block the school has: a new post joins it only when it matches a post already in it.
    const existingPost = { id: 'q1', studentGroupId: 'g-7b', subjectId: 's-sv', teacherId: null, coTeacherId: null, lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], recurrence: 'ALL_WEEKS', startDate: null, endDate: null, blockId: 'b1' };
    const joins = await world({ requirements: [existingPost], blocks: [{ id: 'b1', name: 'Språkval' }] }).service.preview(
      { academicYearId: YEAR, format: 'TABLE_CSV', files: csv([base({ block: 'Språkval' }), base({ day: 2, block: 'Språkval' })]) },
      user,
    );
    expect(joins.newBlocks).toEqual([]);
    expect(joins.requirements.find((q) => q.subjectName === 'Matematik')!.block).toBe('Språkval');
    const refuses = await world({ requirements: [existingPost], blocks: [{ id: 'b1', name: 'Språkval' }] }).service.preview(
      { academicYearId: YEAR, format: 'TABLE_CSV', files: csv([base({ block: 'Språkval' })]) },
      user,
    );
    expect(refuses.requirements.find((q) => q.subjectName === 'Matematik')!.block).toBeNull();
  });

  it('is not blocked by notes, but is by a line it could not read', async () => {
    const { service } = world();
    const files = [{ name: 'schema.csv', bytes: Buffer.from('Klass/grupp;Ämne;Dag;Start;Slut\r\n7A;Matematik;Mån;08:10;09:10\r\n7A;Matematik;Mån;08:10;nonsense\r\n', 'utf8') }];
    const plan = await service.preview({ academicYearId: YEAR, format: 'TABLE_CSV', files }, user);
    expect(plan.unreadable.length).toBeGreaterThan(0);
    expect(plan.summary.unreadable).toBe(plan.unreadable.length);
    expect(plan.canApply).toBe(false);
  });

  it('cannot apply an empty file', async () => {
    const { service } = world();
    const plan = await service.preview({ academicYearId: YEAR, format: 'TABLE_CSV', files: csv([]) }, user);
    expect(plan.summary.rows).toBe(0);
    expect(plan.canApply).toBe(false);
  });

  it('says 400 for a format it does not know, a file it cannot read and a year it cannot find', async () => {
    const { service, tx } = world();
    await expect(service.preview({ academicYearId: YEAR, format: 'PDF' as never, files: csv([]) }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.preview({ academicYearId: YEAR, format: 'TABLE_XLSX', files: [{ name: 'a.xlsx', bytes: Buffer.from('not a zip') }] }, user)).rejects.toMatchObject({
      response: { code: 'IMPORT_XLSX_UNREADABLE' },
    });
    await expect(service.preview({ academicYearId: YEAR, format: 'UNTIS_GPU', files: [{ name: 'GPU005.TXT', bytes: Buffer.from('x') }] }, user)).rejects.toMatchObject({
      response: { code: 'IMPORT_UNTIS_NO_GPU001' },
    });
    await expect(service.preview({ academicYearId: YEAR, format: 'TABLE_CSV', files: [] }, user)).rejects.toMatchObject({ response: { code: 'IMPORT_FILE_COUNT' } });
    tx.academicYear.findUnique.mockResolvedValueOnce(null);
    await expect(preview(service, [base()])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads an xlsx upload as the page’s own export writes it', async () => {
    const { service } = world();
    const rows = lessonsToTable({ school: 'x', year: { name: 'y', start: '2026-08-17', end: '2027-06-11' }, lessons: [base()], groups: [], subjects: [], rooms: [], teachers: [] });
    const plan = await service.preview({ academicYearId: YEAR, format: 'TABLE_XLSX', files: [{ name: 'schema.xlsx', bytes: writeXlsx(rows, { sheetName: 'Schema' }) }] }, user);
    expect(plan.summary.create).toBe(1);
  });
});

describe('ScheduleExchangeService.apply', () => {
  async function applied(lessons: ExchangeLesson[], over: Parameters<typeof world>[0] = {}, mode: 'DIRECT' | 'DRAFT' = 'DIRECT') {
    (enterGrundschemaWrite as jest.Mock).mockResolvedValue(mode);
    const w = world(over);
    const files = csv(lessons);
    const plan = await w.service.preview({ academicYearId: YEAR, format: 'TABLE_CSV', files }, user);
    return { ...w, files, plan };
  }

  it('writes the locked lessons, their extra groups, the posts, the blocks and the change log, in one transaction', async () => {
    const { service, tx, files, plan, realtime, prisma } = await applied([
      base({ block: 'Språkval', extraGroups: ['7B'] }),
      base({ day: 3, block: 'Språkval', extraGroups: ['7B'] }),
    ]);
    const result = await service.apply({ academicYearId: YEAR, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, user);
    expect(result).toMatchObject({ created: 2, requirementsCreated: 1, blocksCreated: 1, unchanged: 0 });
    const data = (tx.masterLesson.createMany.mock.calls[0]![0] as { data: Record<string, unknown>[] }).data;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ schoolId: SCHOOL, academicYearId: YEAR, studentGroupId: 'g-7a', subjectId: 's-ma', teacherId: 't-abe', roomId: 'r-101', dayOfWeek: 1, isLocked: true, isGenerated: false, recurrence: 'ALL_WEEKS' });
    expect((data[0]!['startTime'] as Date).toISOString()).toBe('1970-01-01T08:10:00.000Z');
    const extras = (tx.masterLessonGroup.createMany.mock.calls[0]![0] as { data: { masterLessonId: string; studentGroupId: string }[] }).data;
    expect(extras.map((e) => e.studentGroupId)).toEqual(['g-7b', 'g-7b']);
    expect(extras.map((e) => e.masterLessonId)).toEqual(data.map((d) => d['id']));
    const logs = (tx.scheduleChangeLog.createMany.mock.calls[0]![0] as { data: { action: string; actorId: string; masterLessonId: string; after: Record<string, unknown> }[] }).data;
    expect(logs.map((l) => [l.action, l.actorId, l.after['isLocked'], l.after['source']])).toEqual([['CREATE', 'u-admin', true, 'schedule-exchange'], ['CREATE', 'u-admin', true, 'schedule-exchange']]);
    expect(tx.teachingBlock.create).toHaveBeenCalledWith({ data: { schoolId: SCHOOL, academicYearId: YEAR, name: 'Språkval' }, select: { id: true, name: true } });
    expect(tx.teachingRequirement.create).toHaveBeenCalledTimes(1);
    expect(tx.teachingRequirement.create.mock.calls[0]![0]).toMatchObject({
      data: { studentGroupId: 'g-7a', subjectId: 's-ma', lessonsPerWeek: 2, minutesPerLesson: 60, teacherId: 't-abe', recurrence: 'ALL_WEEKS', blockId: 'b-Språkval' },
    });
    expect(enterGrundschemaWrite).toHaveBeenCalledWith(tx, SCHOOL);
    expect(prisma.withRls).toHaveBeenLastCalledWith(user, expect.any(Function), { timeoutMs: 120_000 });
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL);
  });

  it('tells the staff room only that a draft changed, in a school that publishes through one', async () => {
    const { service, files, plan, realtime } = await applied([base()], {}, 'DRAFT');
    await service.apply({ academicYearId: YEAR, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, user);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { draft: true });
  });

  it('writes a split post with its lengths, weeks and period, and joins an existing block', async () => {
    const { service, tx, files, plan } = await applied(
      [base({ weeks: 'ODD', from: '2026-08-17', to: '2026-12-18', block: 'Språkval' }), base({ weeks: 'ODD', from: '2026-08-17', to: '2026-12-18', day: 2, start: '08:10', end: '08:50', block: 'Språkval' })],
      { blocks: [{ id: 'b1', name: 'Språkval' }] },
    );
    await service.apply({ academicYearId: YEAR, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, user);
    expect(tx.teachingBlock.create).not.toHaveBeenCalled();
    expect(tx.teachingRequirement.create.mock.calls[0]![0]).toMatchObject({
      data: { lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [60, 40], recurrence: 'ODD_WEEKS', blockId: 'b1' },
    });
    expect((tx.teachingRequirement.create.mock.calls[0]![0] as { data: { startDate: Date } }).data.startDate.toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('writes nothing, and does not tell the staff room, when the lessons are all there already', async () => {
    const { service, tx, files, plan, realtime } = await applied([base()], { lessons: [masterRow()] });
    const result = await service.apply({ academicYearId: YEAR, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, user);
    expect(result).toMatchObject({ created: 0, unchanged: 1 });
    expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
    expect(tx.masterLessonGroup.createMany).not.toHaveBeenCalled();
    expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
  });

  it('refuses with 409 IMPORT_PLAN_CHANGED when the plan is not the one previewed, writing nothing', async () => {
    const { service, tx, files } = await applied([base()]);
    const attempt = service.apply({ academicYearId: YEAR, format: 'TABLE_CSV', files, fingerprint: '0'.repeat(32) }, user);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({ response: { code: IMPORT_PLAN_CHANGED } });
    expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
  });

  it('refuses with 409 IMPORT_HAS_REFUSALS while any row is refused, writing nothing at all', async () => {
    const { service, tx, files, plan } = await applied([base(), base({ group: '9Z', day: 2 })]);
    const attempt = service.apply({ academicYearId: YEAR, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, user);
    await expect(attempt).rejects.toMatchObject({ response: { code: IMPORT_HAS_REFUSALS, refused: 1, unreadable: 0 } });
    expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
    expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    expect(tx.teachingBlock.create).not.toHaveBeenCalled();
  });
});

describe('ScheduleExchangeService.export and summary', () => {
  const rows = [
    masterRow(),
    masterRow({ id: 'm2', dayOfWeek: 2, teacherId: 't-nosig', coTeacherId: 't-blu', extraGroups: [{ studentGroupId: 'g-7b' }], recurrence: 'ODD_WEEKS', startDate: date('2026-08-17'), endDate: date('2026-12-18'), roomId: null }),
  ];

  it('writes the grundschema as a CSV and records that it read the teachers', async () => {
    const { service, tx } = world({ lessons: rows });
    const file = await service.export(YEAR, 'TABLE_CSV', user);
    expect(file.filename).toBe('rastra-schema-2026-2027.csv');
    expect(file.contentType).toContain('text/csv');
    const text = file.body.toString('utf8');
    expect(text).toContain('Matematik');
    expect(text).toContain('ABE');
    expect(recordRead).toHaveBeenCalledWith(tx, 'PEOPLE', new Set(['t-abe', 't-nosig', 't-blu']), 'WEB');
    // Parked lessons are left out at the source.
    expect((tx.masterLesson.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where).toEqual({ academicYearId: YEAR, isParked: false });
  });

  it('writes every format, and refuses one it does not know', async () => {
    const { service } = world({ lessons: rows });
    expect((await service.export(YEAR, 'TABLE_XLSX', user)).filename).toBe('rastra-schema-2026-2027.xlsx');
    expect((await service.export(YEAR, 'UNTIS_GPU', user)).filename).toBe('rastra-schema-2026-2027-untis.zip');
    expect((await service.export(YEAR, 'ASC_XML', user)).filename).toBe('rastra-schema-2026-2027-asc.xml');
    await expect(service.export(YEAR, 'PDF' as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('counts lessons, the ones on the tray and the teachers who have no signature', async () => {
    const { service } = world({ lessons: rows });
    (publishModeOf as jest.Mock).mockResolvedValue('DRAFT');
    const w = world({ lessons: rows });
    w.tx.masterLesson.findMany.mockResolvedValue([{ teacherId: 't-abe', coTeacherId: null }, { teacherId: 't-nosig', coTeacherId: 't-blu' }]);
    const summary = await w.service.summary(YEAR, user);
    expect(summary).toEqual({ academicYearId: YEAR, yearName: '2026/2027', publishMode: 'DRAFT', lessons: 3, parked: 1, teachers: 3, teachersWithoutSignature: 1 });
    void service;
  });
});

describe('documentOf', () => {
  it('gives a teacher with no signature a short name from the name, and a number when it is taken', () => {
    const ctx = {
      year: { id: YEAR, name: '2026/2027', start: '2026-08-17', end: '2027-06-11', numbering: 'NIOARIG' },
      groups: [{ id: 'g1', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null }, { id: 'g2', name: '7A-1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: 'g1' }],
      subjects: [{ id: 's1', name: 'Matematik', code: 'MA' }],
      rooms: [],
      teachers: [
        { id: 't1', firstName: 'Anna', lastName: 'Berg', email: 'a@x.example', signature: null, isActive: true },
        { id: 't2', firstName: 'Anneli', lastName: 'Bergman', email: 'b@x.example', signature: null, isActive: true },
        { id: 't3', firstName: 'Cia', lastName: 'Dal', email: 'c@x.example', signature: 'ANBE', isActive: true },
        { id: 't4', firstName: 'Ej', lastName: 'Aktiv', email: 'd@x.example', signature: 'EJA', isActive: false },
      ],
      existing: [
        { id: 'm1', groupId: 'g2', subjectId: 's1', teacherId: 't1', coTeacherId: 't2', roomId: null, day: 1, startMin: 490, endMin: 550, weeks: 'EVEN', from: null, to: null, extraGroupIds: ['g1'], isLocked: true, isGenerated: false },
        { id: 'm2', groupId: 'g1', subjectId: 's1', teacherId: 't3', coTeacherId: null, roomId: null, day: 2, startMin: 490, endMin: 550, weeks: 'ALL', from: null, to: null, extraGroupIds: [], isLocked: true, isGenerated: false },
      ],
      frames: [], rasts: [], lunch: null, servings: [], sittings: [],
      requirements: [{ id: 'q1', groupId: 'g2', subjectId: 's1', teacherId: null, coTeacherId: null, lessonsPerWeek: 1, minutesPerLesson: 60, lessonLengths: [], recurrence: 'EVEN', from: null, to: null, blockId: 'b1' }],
      blocks: [{ id: 'b1', name: 'Språkval' }],
      spans: new Map(),
    } as unknown as PlanContext;
    const doc = documentOf('Skolan', ctx, new Map([['b1', { id: 'b1', name: 'Språkval' }]]));
    expect(doc.lessons[0]).toMatchObject({ group: '7A-1', extraGroups: ['7A'], weeks: 'EVEN', block: 'Språkval', start: '08:10', end: '09:10' });
    // ANBE is a real signature, so the made-up one for Anna Berg steps over it.
    expect(doc.lessons[0]!.teachers.map((t) => t.short)).toEqual(['ANBE2', 'ANBE3']);
    expect(doc.lessons[1]!.teachers.map((t) => t.short)).toEqual(['ANBE']);
    expect(doc.lessons[1]!.block).toBeNull();
    expect(doc.groups).toEqual([{ name: '7A', kind: 'CLASS', gradeLevel: 7, halfOf: null }, { name: '7A-1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: '7A' }]);
    // A teacher who is inactive and teaches nothing is left out of the directory.
    expect(doc.teachers.map((t) => t.short)).toEqual(['ANBE2', 'ANBE3', 'ANBE']);
    expect(indexContext(ctx).groupsById.size).toBe(2);
  });
});
