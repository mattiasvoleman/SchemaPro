import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';
import { changedSince, EXPECTED_FIELDS, LESSON_CHANGED, type LessonAsStored } from './lesson-expectation';
import { LESSON_DATE_FORM, MasterLessonsService } from './master-lessons.service';

jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const G7A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TEACHER = '99999999-9999-4999-8999-999999999999';
const ROOM = '66666666-6666-4666-8666-666666666666';
const OTHER_ROOM = '00000000-aaaa-4aaa-8aaa-000000000009';
const PUPIL = '77777777-7777-4777-8777-777777777777';
const GROUP2 = '00000000-aaaa-4aaa-8aaa-000000000003';
const LESSON = '55555555-5555-4555-8555-555555555555';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
type Row = Record<string, any>;
/** The text of a raw statement, whether it was a tagged template or a built one. */
const sqlOf = (query: unknown): string =>
  Array.isArray(query) ? query.join('?') : typeof query === 'object' && query !== null && 'strings' in query ? (query as { strings: string[] }).strings.join('?') : String(query);
const WROTE_FIRST = new Date('2026-11-28T09:00:00.000Z');
const WROTE_MEANWHILE = new Date('2026-11-28T09:00:05.123Z');

const lessonRecord = (overrides: Row = {}): Row => ({
  id: LESSON,
  academicYearId: YEAR,
  subjectId: SUBJECT,
  studentGroupId: G7A,
  teacherId: TEACHER,
  coTeacherId: null,
  roomId: ROOM,
  dayOfWeek: 1,
  startTime: t('10:00'),
  endTime: t('11:00'),
  isLocked: false,
  isParked: false,
  exemptFrom: [],
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  extraGroups: [],
  participants: [],
  updatedAt: WROTE_FIRST,
  ...overrides,
});

/** What a page that read `lessonRecord()` holds of it, in the forms the page sends. */
const SAW = {
  dayOfWeek: 1,
  startTime: '10:00',
  endTime: '11:00',
  roomId: ROOM,
  teacherId: TEACHER,
  coTeacherId: null,
  isLocked: false,
  isParked: false,
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  exempt: [],
};

/*
 * SÄKERHETSNÄT (E9): EN ÄNDRING SOM KROCKAR MED EN KOLLEGAS NEKAS MED BESKED, OCH INGET SKRIVS ÖVER TYST.
 *
 *   - en begäran som säger vad sidan såg (`expected`) hålls mot lektionen som den står under radlåset, i skrivningens egen transaktion: ett värde
 *     som inte är det sidan läste är en annans ändring, och begäran blir 409 LESSON_CHANGED med fältens namn; ingenting skrivs och domaren frågas inte;
 *   - bara de fält som sidan nämner jämförs: en kollegas ändring av något annat är inte i vägen, och `null` är ett svar (ingen sal);
 *   - en begäran utan `expected` skrivs som förut och tar inget lås i förväg (mobilen och en äldre webb skickar ingen);
 *   - raden läses om när någon skrev den mellan första läsningen och låset, och jämförelsen görs mot den skrivningen.
 */
describe('MasterLessonsService: förutsättningen (expected)', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let stored: Row;
  /** The updatedAt the row lock returns: what the row holds when the lock is taken. */
  let lockedUpdatedAt: Date | null;
  /** What the second read of the lesson (after the lock) returns, when it is asked. */
  let afterTheLock: Row | null;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new MasterLessonsService(
      prisma as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    stored = { ...lessonRecord(), fromPlacement: false, school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } } };
    lockedUpdatedAt = WROTE_FIRST;
    afterTheLock = null;
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    let reads = 0;
    tx['masterLesson']!['findUnique']!.mockImplementation(async () => (reads++ === 0 || afterTheLock === null ? stored : afterTheLock));
    tx['masterLesson']!['update']!.mockImplementation(async (args: { data: Row }) => lessonRecord({ ...stored, ...args.data }));
    // The other lessons of the lesson's day: none (the lesson itself is not its own neighbour).
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      const rows = [stored];
      if (where['id']?.in) return rows.filter((row) => where['id'].in.includes(row['id']));
      return rows.filter((row) => row['dayOfWeek'] === where['dayOfWeek'] && row['isParked'] !== true && row['id'] !== where['id']?.not);
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG', id: YEAR, schoolId: SCHOOL, isActive: true, predecessorId: null, _count: { teacherEmployments: 0 } });
    tx['studentGroup']!['findMany']!.mockImplementation(async (query: { where: Row }) => (query.where['OR']?.[0]?.id?.in ?? query.where['id']?.in ?? []).map((id: string) => ({ id, name: '7A', gradeLevel: 7, halfOfId: null })));
    tx['subject']!['findMany']!.mockResolvedValue([]);
    tx['frameTime']!['findMany']!.mockResolvedValue([]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
    tx.$queryRaw.mockImplementation(async (query: unknown) =>
      sqlOf(query).includes('FOR NO KEY UPDATE') ? (lockedUpdatedAt ? [{ updatedAt: lockedUpdatedAt }] : []) : [],
    );
  });

  const rowLocks = () => tx.$queryRaw.mock.calls.filter(([query]) => sqlOf(query).includes('FOR NO KEY UPDATE'));
  const refusal = async (body: UpdateMasterLessonDto): Promise<HttpException> => {
    try {
      await service.update(LESSON, body, testUser());
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('the update was let through');
  };

  it('writes a request whose values are what the page saw, and takes the row lock before it writes', async () => {
    const saved = await service.update(LESSON, { roomId: OTHER_ROOM, expected: SAW }, testUser());
    expect(saved).toMatchObject({ roomId: OTHER_ROOM });
    expect(rowLocks()).toHaveLength(1);
    expect(tx['masterLesson']!['update']).toHaveBeenCalledTimes(1);
    // The lock is held to commit before the write: the write is what the compare was about.
    const lockedAt = tx.$queryRaw.mock.invocationCallOrder[tx.$queryRaw.mock.calls.findIndex(([query]) => sqlOf(query).includes('FOR NO KEY UPDATE'))]!;
    expect(lockedAt).toBeLessThan(tx['masterLesson']!['update']!.mock.invocationCallOrder[0]!);
  });

  it('takes the year\'s share of the regeneration lock before the lesson\'s row lock, never after: Generera holds the year and then every row, so a row held first is a deadlock with it (granskaren g515)', async () => {
    await service.update(LESSON, { roomId: OTHER_ROOM, expected: SAW }, testUser());
    const yearLockAt = tx.$executeRaw.mock.calls.findIndex(([query]) => sqlOf(query).includes('lock_years_for_grundschema_edit'));
    const rowLockAt = tx.$queryRaw.mock.calls.findIndex(([query]) => sqlOf(query).includes('FOR NO KEY UPDATE'));
    expect(yearLockAt).toBeGreaterThanOrEqual(0);
    expect(rowLockAt).toBeGreaterThanOrEqual(0);
    expect(tx.$executeRaw.mock.invocationCallOrder[yearLockAt]!).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[rowLockAt]!);
  });

  it('writes a request that sends no expectation as it always was, and takes no row lock in advance', async () => {
    await service.update(LESSON, { roomId: OTHER_ROOM }, testUser());
    expect(rowLocks()).toHaveLength(0);
    expect(tx['masterLesson']!['findUnique']).toHaveBeenCalledTimes(1);
    expect(tx['masterLesson']!['update']).toHaveBeenCalledTimes(1);
  });

  it('refuses a value that is not what the page saw with 409 LESSON_CHANGED naming the fields, and writes nothing and asks no judge', async () => {
    stored = { ...stored, dayOfWeek: 3, startTime: t('13:00'), endTime: t('14:00') };
    const refused = await refusal({ dayOfWeek: 2, startTime: '09:00', endTime: '10:00', expected: { dayOfWeek: 1, startTime: '10:00', endTime: '11:00' } });
    expect(refused).toBeInstanceOf(ConflictException);
    expect(refused.getResponse()).toMatchObject({ code: LESSON_CHANGED, params: { fields: 'dayOfWeek,startTime,endTime' } });
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
    expect(readOtherSchoolHolds).not.toHaveBeenCalled();
  });

  it('names each field in one order whatever order the page sent them in, and only the ones that differ', async () => {
    stored = { ...stored, teacherId: '88888888-8888-4888-8888-888888888888', roomId: OTHER_ROOM };
    const refused = await refusal({ isLocked: true, expected: { teacherId: TEACHER, roomId: ROOM, isLocked: false } });
    expect(refused.getResponse()).toMatchObject({ code: LESSON_CHANGED, params: { fields: 'roomId,teacherId' } });
  });

  it('is not in the way of a colleague\'s change of a field the page did not name', async () => {
    // A colleague locked it and gave it another room while this request moves it: the move writes neither.
    stored = { ...stored, isLocked: true, roomId: OTHER_ROOM };
    await expect(service.update(LESSON, { dayOfWeek: 2, expected: { dayOfWeek: 1, startTime: '10:00', endTime: '11:00' } }, testUser())).resolves.toMatchObject({ dayOfWeek: 2 });
  });

  it('reads null as an answer: a page that saw no room is refused when somebody has given the lesson one', async () => {
    const refused = await refusal({ roomId: OTHER_ROOM, expected: { roomId: null } });
    expect(refused.getResponse()).toMatchObject({ code: LESSON_CHANGED, params: { fields: 'roomId' } });
    stored = { ...stored, roomId: null };
    await expect(service.update(LESSON, { roomId: OTHER_ROOM, expected: { roomId: null } }, testUser())).resolves.toMatchObject({ roomId: OTHER_ROOM });
  });

  it('reads the classes, the pupils and the exemption as sets, so another order is not a change', async () => {
    stored = { ...stored, isLocked: true, exemptFrom: ['LUNCH', 'FRAME'], extraGroups: [{ studentGroupId: GROUP2 }, { studentGroupId: G7A }], participants: [{ studentId: PUPIL }] };
    await expect(
      service.update(LESSON, { roomId: OTHER_ROOM, expected: { extraGroupIds: [G7A, GROUP2], studentIds: [PUPIL], exempt: ['FRAME', 'LUNCH'] } }, testUser()),
    ).resolves.toMatchObject({ roomId: OTHER_ROOM });
    const refused = await refusal({ roomId: OTHER_ROOM, expected: { extraGroupIds: [G7A], studentIds: [], exempt: ['FRAME'] } });
    expect(refused.getResponse()).toMatchObject({ params: { fields: 'extraGroupIds,studentIds,exempt' } });
  });

  it('reads the lesson again when somebody wrote it between the first read and the lock, and compares with that write', async () => {
    // The first read saw the room the page saw. A colleague changed it and committed before this request had the row lock.
    lockedUpdatedAt = WROTE_MEANWHILE;
    afterTheLock = { ...stored, roomId: OTHER_ROOM, updatedAt: WROTE_MEANWHILE };
    const refused = await refusal({ roomId: '00000000-aaaa-4aaa-8aaa-000000000010', expected: { roomId: ROOM } });
    expect(refused.getResponse()).toMatchObject({ code: LESSON_CHANGED, params: { fields: 'roomId' } });
    expect(tx['masterLesson']!['findUnique']).toHaveBeenCalledTimes(2);
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('judges and writes what the second read holds when somebody wrote an unrelated field meanwhile, and not the stale first read', async () => {
    lockedUpdatedAt = WROTE_MEANWHILE;
    afterTheLock = { ...stored, isLocked: true, updatedAt: WROTE_MEANWHILE };
    // The page did not name the lock, so the write goes through, on the lesson as it is now: a move of a locked lesson locks nothing by itself.
    const saved = await service.update(LESSON, { dayOfWeek: 2, expected: { dayOfWeek: 1 } }, testUser());
    expect(saved).toMatchObject({ dayOfWeek: 2 });
    expect(saved).not.toHaveProperty('lockedByMove');
  });

  it('does not read the lesson again when nobody wrote it since the first read', async () => {
    await service.update(LESSON, { roomId: OTHER_ROOM, expected: SAW }, testUser());
    expect(tx['masterLesson']!['findUnique']).toHaveBeenCalledTimes(1);
  });

  it('lets a request through that sets a value which already stands, though it is not the one the page saw: a lock a colleague set too, a move made twice (granskaren g515)', async () => {
    // A bulk lock of a lesson a colleague has just locked as well: the value written is the one that stands, so nothing is written over.
    stored = { ...stored, isLocked: true };
    await expect(service.update(LESSON, { isLocked: true, propagate: false, expected: { isLocked: false } }, testUser())).resolves.toMatchObject({ isLocked: true });
    // The same save sent a second time (the first has been written; the page still holds what it saw before).
    stored = { ...stored, isLocked: false, dayOfWeek: 3, startTime: t('13:00'), endTime: t('14:00') };
    await expect(
      service.update(LESSON, { dayOfWeek: 3, startTime: '13:00', endTime: '14:00', expected: { dayOfWeek: 1, startTime: '10:00', endTime: '11:00' } }, testUser()),
    ).resolves.toMatchObject({ dayOfWeek: 3 });
  });

  it('still names the field whose written value is not the one that stands, and a field the request does not write', async () => {
    stored = { ...stored, dayOfWeek: 3, teacherId: '88888888-8888-4888-8888-888888888888', roomId: OTHER_ROOM };
    // The day is written as it already stands and passes; the teacher is a colleague's and is written over; the room is not written but was named.
    const refused = await refusal({ dayOfWeek: 3, teacherId: TEACHER, expected: { dayOfWeek: 1, teacherId: TEACHER, roomId: ROOM } });
    expect(refused.getResponse()).toMatchObject({ code: LESSON_CHANGED, params: { fields: 'roomId,teacherId' } });
  });

  it('answers 404 for a lesson that is gone by the time the row is locked', async () => {
    lockedUpdatedAt = null;
    await expect(service.update(LESSON, { roomId: OTHER_ROOM, expected: SAW }, testUser())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('changedSince', () => {
  const row: LessonAsStored = {
    dayOfWeek: 2,
    startTime: t('09:05'),
    endTime: t('09:50'),
    roomId: ROOM,
    teacherId: null,
    coTeacherId: null,
    isLocked: true,
    isParked: false,
    recurrence: 'ODD_WEEKS',
    startDate: new Date('2026-09-07T00:00:00.000Z'),
    endDate: null,
    exemptFrom: ['FRAME'],
    extraGroups: [{ studentGroupId: GROUP2 }],
    participants: [],
  };
  const saw = { dayOfWeek: 2, startTime: '09:05', endTime: '09:50', roomId: ROOM, teacherId: null, coTeacherId: null, isLocked: true, isParked: false, recurrence: 'ODD_WEEKS' as const, startDate: '2026-09-07', endDate: null, exempt: ['FRAME' as const], extraGroupIds: [GROUP2], studentIds: [] };

  it('finds nothing when the page saw every field as it is, and nothing when it names none', () => {
    expect(changedSince(row, saw)).toEqual([]);
    expect(changedSince(row, {})).toEqual([]);
  });

  // One field changed at a time: dropping any one of them from the comparison lets that overwrite through unasked.
  it.each([
    ['dayOfWeek', { dayOfWeek: 3 }],
    ['startTime', { startTime: '09:10' }],
    ['endTime', { endTime: '09:55' }],
    ['roomId', { roomId: OTHER_ROOM }],
    ['teacherId', { teacherId: TEACHER }],
    ['coTeacherId', { coTeacherId: TEACHER }],
    ['isLocked', { isLocked: false }],
    ['isParked', { isParked: true }],
    ['recurrence', { recurrence: 'EVEN_WEEKS' as const }],
    ['startDate', { startDate: '2026-09-14' }],
    ['endDate', { endDate: '2026-12-18' }],
    ['extraGroupIds', { extraGroupIds: [] }],
    ['studentIds', { studentIds: [PUPIL] }],
    ['exempt', { exempt: [] }],
  ])('names %s alone when it is the one that is not what the page saw', (field, change) => {
    expect(changedSince(row, { ...saw, ...change })).toEqual([field]);
  });

  it('names every field the page can say it saw, so that none is left out of the comparison', () => {
    expect([...EXPECTED_FIELDS].sort()).toEqual(Object.keys(saw).sort());
  });

  it('passes a field that the request writes as it already stands, whatever the page saw, in the forms the request writes it', () => {
    // A day told with a time of day after it, and no day as an empty string, are the days parseDateOrNull reads them as.
    expect(changedSince(row, { ...saw, startDate: '2026-09-14', endDate: '2026-12-18' }, { startDate: '2026-09-07T00:00:00.000Z', endDate: '' })).toEqual([]);
    expect(changedSince(row, { ...saw, exempt: [], extraGroupIds: [] }, { exempt: ['FRAME'] })).toEqual(['extraGroupIds']);
    expect(changedSince(row, { ...saw, isLocked: false }, { isLocked: false })).toEqual(['isLocked']);
    expect(changedSince(row, { ...saw, roomId: OTHER_ROOM }, { roomId: null })).toEqual(['roomId']);
  });

  it('reads a clock and a day in the forms the page sends them in, however the row stores them', () => {
    expect(changedSince({ ...row, startTime: t('00:00'), endDate: new Date('2027-06-11T00:00:00.000Z') }, { startTime: '00:00', endDate: '2027-06-11' })).toEqual([]);
  });
});

describe('UpdateMasterLessonDto: expected', () => {
  const failing = async (body: object) => (await validate(plainToInstance(UpdateMasterLessonDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((error) => error.property);
  const nested = async (body: object) => {
    const errors = await validate(plainToInstance(UpdateMasterLessonDto, body), { whitelist: true, forbidNonWhitelisted: true });
    return errors.flatMap((error) => (error.children ?? []).map((child) => `${error.property}.${child.property}`));
  };

  it('takes what a page can have read, null included', async () => {
    await expect(failing({ roomId: ROOM, expected: SAW })).resolves.toEqual([]);
    await expect(failing({ expected: {} })).resolves.toEqual([]);
    await expect(failing({ expected: null })).resolves.toEqual([]);
  });

  it('refuses a field that is not one the page reads, a clock that is not one, a day with a time of day and an id that is not a uuid', async () => {
    await expect(nested({ expected: { colour: 'red' } })).resolves.toEqual(['expected.colour']);
    await expect(nested({ expected: { startTime: '9' } })).resolves.toEqual(['expected.startTime']);
    await expect(nested({ expected: { startDate: '2026-09-07T00:00:00.000Z' } })).resolves.toEqual(['expected.startDate']);
    await expect(nested({ expected: { roomId: 'Sal 1' } })).resolves.toEqual(['expected.roomId']);
    await expect(nested({ expected: { dayOfWeek: 9, extraGroupIds: ['x'] } })).resolves.toEqual(['expected.dayOfWeek', 'expected.extraGroupIds']);
  });

  it('refuses an expectation that is not an object', async () => {
    await expect(failing({ expected: 'dag' })).resolves.toEqual(['expected']);
  });
});

/*
 * L-6 (granskaren g511): ISO 8601's other forms of a date (`20260817`, `2026-W34-1`, `2026-229`) pass the DTO's validator and used to be sliced to ten characters,
 * which built a date that is not one and threw where the lesson was told back: a 500. They are a 400 with a code now, from both writes, and the forms
 * that always worked still do.
 */
describe('MasterLessonsService: a date that is no YYYY-MM-DD', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let stored: Row;

  beforeEach(() => {
    tx = createTxMock();
    service = new MasterLessonsService(
      createPrismaMock(tx) as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    stored = { ...lessonRecord(), fromPlacement: false, school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } } };
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    tx['masterLesson']!['findUnique']!.mockImplementation(async () => stored);
    tx['masterLesson']!['update']!.mockImplementation(async (args: { data: Row }) => lessonRecord({ ...stored, ...args.data }));
    // The other lessons of the lesson's day: none (the lesson itself is not its own neighbour).
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      const rows = [stored];
      if (where['id']?.in) return rows.filter((row) => where['id'].in.includes(row['id']));
      return rows.filter((row) => row['dayOfWeek'] === where['dayOfWeek'] && row['isParked'] !== true && row['id'] !== where['id']?.not);
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG', id: YEAR, schoolId: SCHOOL, isActive: true, predecessorId: null, _count: { teacherEmployments: 0 } });
    tx['studentGroup']!['findMany']!.mockImplementation(async (query: { where: Row }) => (query.where['OR']?.[0]?.id?.in ?? query.where['id']?.in ?? []).map((id: string) => ({ id, name: '7A', gradeLevel: 7, halfOfId: null })));
    tx['subject']!['findMany']!.mockResolvedValue([]);
    tx['frameTime']!['findMany']!.mockResolvedValue([]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
  });

  const refused = async (run: () => Promise<unknown>): Promise<HttpException> => {
    try {
      await run();
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('the write was let through');
  };

  it.each(['20260817', '2026-W34-1', '2026-229'])('answers 400 LESSON_DATE_FORM, and writes nothing, for a first day of %s on a PATCH', async (day) => {
    const error = await refused(() => service.update(LESSON, { startDate: day }, testUser()));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ code: LESSON_DATE_FORM });
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('answers the same for a last day, and for a day that is told as a calendar date but is none', async () => {
    expect((await refused(() => service.update(LESSON, { endDate: '20261218' }, testUser()))).getResponse()).toMatchObject({ code: LESSON_DATE_FORM });
    expect((await refused(() => service.update(LESSON, { startDate: '2026-13-45' }, testUser()))).getResponse()).toMatchObject({ code: LESSON_DATE_FORM });
  });

  it('answers it for the läsande frågan\'s days too: the same parser', async () => {
    const error = await refused(() => service.judgeMoves({ moves: [{ lessonId: LESSON, startDate: '20260817' }] }, testUser()));
    expect(error.getResponse()).toMatchObject({ code: LESSON_DATE_FORM });
  });

  it('still takes a day, a day with a time of day after it, and no day at all', async () => {
    for (const startDate of ['2026-09-07', '2026-09-07T00:00:00.000Z', '2026-09-07T23:59:59+02:00', null, '']) {
      await expect(service.update(LESSON, { startDate }, testUser())).resolves.toBeDefined();
    }
  });
});
