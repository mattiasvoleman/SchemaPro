import { ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { MasterLessonsService } from './master-lessons.service';

/*
 * E1, EN DOMARE MED ORD: the hand edit's write path (create, PATCH, a block's
 * card) is held to the rules a swap and a förläggning are held to, and says no
 * with a code and the other lesson's class, subject, day and time.
 *
 * What these rows pin, each one a refusal that was a green save, an English
 * sentence with no code, or both:
 *
 *   - a lesson dragged onto the class's lunch, out of the stage's ramtid, onto
 *     an hour closed to the årskurs, or into a shared teacher's lesson at
 *     another school, is refused (FRAME, LUNCH, GRADE_RULE, OTHER_SCHOOL);
 *   - a clash is refused as MASTER_LESSON_REFUSED with the reason and the other
 *     lesson's class, subject, day and time as flat params;
 *   - "låt stå": a lesson that already stands against one of the rules may be
 *     changed on anything that is not where it stands (its room, its lock);
 *   - the refusal's `detail` stays a sentence (the mobile app and an older web
 *     read `detail` and nothing else).
 */

jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SUBJECT = '00000000-aaaa-4aaa-8aaa-000000000004';
const G7A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const G8B = '00000000-aaaa-4aaa-8aaa-000000000003';
const TEACHER = '99999999-9999-4999-8999-999999999999';
const ROOM = '66666666-6666-4666-8666-666666666666';
const NEW_ROOM = '00000000-aaaa-4aaa-8aaa-000000000009';
const LESSON = '55555555-5555-4555-8555-555555555555';
const OTHER = '44444444-4444-4444-8444-444444444444';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

type Row = Record<string, any>;

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
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  extraGroups: [],
  participants: [],
  ...overrides,
});

describe('MasterLessonsService, domaren med ord', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  /** The lessons of the day the clash scan reads, and the ones the refusal then names (the same table). */
  let dayLessons: Row[] = [];
  /** The lessons a question is asked about (judgeMoves reads them whole). */
  let stored: Row[] = [];

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new MasterLessonsService(
      prisma as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    dayLessons = [];
    stored = [];
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    tx['masterLesson']!['findUnique']!.mockResolvedValue({
      ...lessonRecord(),
      fromPlacement: false,
      school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
    });
    tx['masterLesson']!['update']!.mockResolvedValue(lessonRecord());
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      const rows = [...stored, ...dayLessons];
      // The lessons themselves, or the ones a refusal names, by id.
      if (where['id']?.in) return rows.filter((row) => where['id'].in.includes(row['id']));
      // The clash scan: the day's placed lessons, but for the ones left out of where they stood.
      return rows.filter(
        (row) =>
          row['dayOfWeek'] === where['dayOfWeek'] &&
          row['isParked'] !== true &&
          row['id'] !== where['id']?.not &&
          !(where['id']?.notIn ?? []).includes(row['id']),
      );
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
    tx['studentGroup']!['findMany']!.mockImplementation(async (query: { where: Row }) => {
      const ids: string[] = query.where['id']?.in ?? [];
      return ids.map((id) => ({ id, name: id === G7A ? '7A' : '8B', gradeLevel: id === G7A ? 7 : 8, halfOfId: null, kind: 'CLASS', replacesSubjectId: null, academicYearId: YEAR }));
    });
    tx['subject']!['findMany']!.mockResolvedValue([]);
  });

  const theOther = (overrides: Row = {}): Row => ({
    id: OTHER,
    dayOfWeek: 1,
    teacherId: '00000000-aaaa-4aaa-8aaa-000000000001',
    coTeacherId: null,
    roomId: '00000000-aaaa-4aaa-8aaa-000000000002',
    studentGroupId: G8B,
    subjectId: OTHER_SUBJECT,
    startTime: t('13:10'),
    endTime: t('14:10'),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    subject: { name: 'Kemi' },
    studentGroup: { name: '8B' },
    extraGroups: [],
    participants: [],
    ...overrides,
  });

  const refusalOf = async (attempt: Promise<unknown>): Promise<{ message: string; code: string; params: Record<string, string | number> }> => {
    try {
      await attempt;
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).getResponse() as never;
    }
    throw new Error('the edit was not refused');
  };

  describe('update', () => {
    it('refuses a drag onto the class’s lunch as MASTER_LESSON_REFUSED, LUNCH, and writes nothing', async () => {
      tx['lunchSitting']!['findMany']!.mockResolvedValue([
        { studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null },
      ]);
      const body = await refusalOf(service.update(LESSON, { startTime: '12:00', endTime: '13:00' }, testUser()));
      expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'LUNCH' } });
      expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
    });

    it('refuses a drag out of the stage’s ramtid as FRAME', async () => {
      tx['frameTime']!['findMany']!.mockResolvedValue([{ minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: t('08:00'), endTime: t('15:00') }]);
      const body = await refusalOf(service.update(LESSON, { startTime: '15:00', endTime: '16:00' }, testUser()));
      expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'FRAME' } });
    });

    it('refuses an hour closed to the årskurs as GRADE_RULE', async () => {
      // Only the board's own read asks for the rules on whole årskurser; the clash rule's asks for the teacher's, the room's and the class's.
      tx['availabilityConstraint']!['findMany']!.mockImplementation(async (query: { where: Row }) =>
        query.where['resourceType'] === 'GRADE_LEVEL'
          ? [{ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: 1, date: null, startTime: t('14:00'), endTime: t('16:00') }]
          : [],
      );
      const body = await refusalOf(service.update(LESSON, { startTime: '14:00', endTime: '15:00' }, testUser()));
      expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'GRADE_RULE' } });
    });

    it('refuses the teacher’s time at another school as OTHER_SCHOOL, naming the school', async () => {
      (readOtherSchoolHolds as jest.Mock).mockResolvedValue({
        holds: [{ holdId: 'h', kind: 'TEACHER_BUSY', resourceKind: 'TEACHER', resourceId: TEACHER, dayOfWeek: 1, startTime: '14:00:00', endTime: '15:00:00', schools: ['Norra skolan'] }],
      });
      const body = await refusalOf(service.update(LESSON, { startTime: '14:00', endTime: '15:00' }, testUser()));
      expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'OTHER_SCHOOL', schools: 'Norra skolan' } });
    });

    it('names the other lesson of a clash by class, subject, day and time, never a person, with a code', async () => {
      dayLessons = [theOther({ teacherId: TEACHER, startTime: t('13:10'), endTime: t('14:10') })];
      const body = await refusalOf(service.update(LESSON, { startTime: '13:10', endTime: '14:10' }, testUser()));
      expect(body.code).toBe('MASTER_LESSON_REFUSED');
      expect(body.params).toMatchObject({ reason: 'TEACHER', otherKind: 'LESSON', className: '8B', subjectName: 'Kemi', day: 1, start: '13:10', end: '14:10' });
      expect(JSON.stringify(body)).not.toContain(TEACHER);
    });

    it('keeps `detail` a sentence for the clients that read nothing else', async () => {
      dayLessons = [theOther({ teacherId: TEACHER })];
      const body = await refusalOf(service.update(LESSON, { startTime: '13:10', endTime: '14:10' }, testUser()));
      expect(body.message).toEqual(expect.stringContaining('Kemi 8B'));
      expect(body.message).toEqual(expect.stringContaining('13:10'));
    });

    it('lets a lesson that already stands on the lunch be changed on anything but where it stands (låt stå)', async () => {
      tx['masterLesson']!['findUnique']!.mockResolvedValue({
        ...lessonRecord({ startTime: t('12:00'), endTime: t('13:00') }),
        fromPlacement: false,
        school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
      });
      tx['lunchSitting']!['findMany']!.mockResolvedValue([
        { studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null },
      ]);
      tx['masterLesson']!['update']!.mockResolvedValue(lessonRecord({ roomId: NEW_ROOM, startTime: t('12:00'), endTime: t('13:00') }));
      await expect(service.update(LESSON, { roomId: NEW_ROOM, isLocked: true }, testUser())).resolves.toMatchObject({ roomId: NEW_ROOM });
      // ... but moving it to another time on the lunch is a new placement, and is refused.
      await expect(service.update(LESSON, { startTime: '12:10', endTime: '13:10' }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'MASTER_LESSON_REFUSED' }),
      });
    });

    it('asks nothing of the board for an edit that moves nothing (a lock, a room)', async () => {
      await service.update(LESSON, { isLocked: true }, testUser());
      expect(tx['frameTime']!['findMany']).not.toHaveBeenCalled();
      expect(tx['lunchSitting']!['findMany']).not.toHaveBeenCalled();
      expect(readOtherSchoolHolds).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('refuses a new lesson on the class’s lunch, as a drag would be', async () => {
      tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL, isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG', _count: { teacherEmployments: 0 } });
      tx['lunchSitting']!['findMany']!.mockResolvedValue([
        { studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null },
      ]);
      const body = await refusalOf(
        service.create({ academicYearId: YEAR, subjectId: SUBJECT, studentGroupId: G7A, dayOfWeek: 1, startTime: '12:00', endTime: '13:00' }, testUser()),
      );
      expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'LUNCH' } });
      expect(tx['masterLesson']!['create']).not.toHaveBeenCalled();
    });
  });
});

/*
 * The läsande frågan (POST /master-lessons/judge): one or more tänkta drag, judged together as one move, with the
 * PATCH's own verdict and nothing written.
 */
describe('MasterLessonsService.judgeMoves', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let table: Row[];

  const B = '77777777-7777-4777-8777-777777777777';
  const C = '88888888-8888-4888-8888-888888888888';
  const OTHER_TEACHER = '99999999-9999-4999-8999-999999999990';

  /** A stored lesson as the question reads it whole, and as the clash scan and a refusal's naming read it. */
  const lesson = (id: string, overrides: Row = {}): Row => ({
    ...lessonRecord({ id }),
    fromPlacement: false,
    subject: { name: id === LESSON ? 'Matematik' : 'Kemi' },
    studentGroup: { name: id === LESSON ? '7A' : '8B' },
    school: { id: SCHOOL, _count: { academicYears: 1 } },
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    service = new MasterLessonsService(
      createPrismaMock(tx) as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    table = [];
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      if (where['id']?.in) return table.filter((row) => where['id'].in.includes(row['id']));
      return table.filter(
        (row) =>
          row['dayOfWeek'] === where['dayOfWeek'] &&
          row['isParked'] !== true &&
          row['id'] !== where['id']?.not &&
          !(where['id']?.notIn ?? []).includes(row['id']),
      );
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
    tx['studentGroup']!['findMany']!.mockResolvedValue([]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([
      { studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null },
    ]);
  });

  it('answers a refusal with its reason, its sentence, and writes nothing', async () => {
    table = [lesson(LESSON)];
    const answer = await service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '12:00', endTime: '13:00' }] }, testUser());
    expect(answer).toMatchObject({ ok: false, moves: [{ lessonId: LESSON, ok: false, refusals: [{ reason: 'LUNCH', text: expect.stringContaining('lunch') }] }] });
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
    expect(tx['scheduleChangeLog']!['create']).not.toHaveBeenCalled();
  });

  it('says ok for a drag that stands, and for one that leaves where a lesson already stands unchanged (låt stå)', async () => {
    table = [lesson(LESSON, { startTime: t('12:00'), endTime: t('13:00') })];
    await expect(service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '14:00', endTime: '15:00' }] }, testUser())).resolves.toMatchObject({ ok: true });
    await expect(service.judgeMoves({ moves: [{ lessonId: LESSON, roomId: NEW_ROOM }] }, testUser())).resolves.toMatchObject({ ok: true });
    await expect(service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '12:10', endTime: '13:10' }] }, testUser())).resolves.toMatchObject({ ok: false });
  });

  it('gives the verdict of the PATCH that would follow: the same reason for the same drag', async () => {
    table = [lesson(LESSON)];
    const other = lesson(OTHER, { teacherId: TEACHER, roomId: null, startTime: t('13:10'), endTime: t('14:10'), studentGroupId: G8B });
    table.push(other);
    tx['masterLesson']!['findUnique']!.mockResolvedValue(table[0]);
    tx['masterLesson']!['update']!.mockResolvedValue(lessonRecord());
    for (const drag of [
      { startTime: '13:10', endTime: '14:10' },
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '09:00', endTime: '10:00' },
    ]) {
      const asked = await service.judgeMoves({ moves: [{ lessonId: LESSON, ...drag }] }, testUser());
      let patched: string | null = null;
      try {
        await service.update(LESSON, drag, testUser());
      } catch (error) {
        patched = ((error as ConflictException).getResponse() as { params: { reason: string } }).params.reason;
      }
      expect(asked.moves[0]!.refusals[0]?.reason ?? null).toBe(patched);
    }
  });

  it('judges two lessons that change places as one move: neither is in the other’s way where they stood', async () => {
    // A (10:00-11:00) and B (11:00-12:00) have one teacher; each takes the other's hour.
    table = [lesson(LESSON, { teacherId: TEACHER }), lesson(OTHER, { teacherId: TEACHER, startTime: t('11:00'), endTime: t('12:00'), studentGroupId: G8B })];
    const swap = {
      moves: [
        { lessonId: LESSON, startTime: '11:00', endTime: '12:00' },
        { lessonId: OTHER, startTime: '10:00', endTime: '11:00' },
      ],
    };
    await expect(service.judgeMoves(swap, testUser())).resolves.toMatchObject({ ok: true });
    // One of them alone is held against the other where it stands, and the teacher is double-booked.
    const alone = await service.judgeMoves({ moves: [swap.moves[0]!] }, testUser());
    expect(alone.ok).toBe(false);
    // The teacher first, then the room they share: every reason found, the heaviest first.
    expect(alone.moves[0]!.refusals.map((refusal) => refusal.reason)).toEqual(['TEACHER', 'ROOM']);
    expect(alone.moves[0]!.refusals[0]!.params).toMatchObject({ className: '8B', subjectName: 'Kemi', day: 1, start: '11:00', end: '12:00' });
  });

  it('holds the movers beside each other on their own day only: a set that moves lessons to two days clashes with none of them', async () => {
    // Both land at 10:00-11:00 with one teacher, but on Tuesday and on Wednesday.
    table = [lesson(LESSON, { teacherId: TEACHER }), lesson(OTHER, { teacherId: TEACHER, dayOfWeek: 4, studentGroupId: G8B })];
    const apart = {
      moves: [
        { lessonId: LESSON, dayOfWeek: 2, startTime: '10:00', endTime: '11:00' },
        { lessonId: OTHER, dayOfWeek: 3, startTime: '10:00', endTime: '11:00' },
      ],
    };
    await expect(service.judgeMoves(apart, testUser())).resolves.toMatchObject({ ok: true });
    // The same set on ONE day is a double booking of the teacher, and each names the other where it would stand.
    const together = { moves: apart.moves.map((move) => ({ ...move, dayOfWeek: 2 })) };
    const answer = await service.judgeMoves(together, testUser());
    expect(answer.ok).toBe(false);
    expect(answer.moves[0]!.refusals[0]).toMatchObject({ reason: 'TEACHER', params: { className: '8B', day: 2, start: '10:00', end: '11:00' } });
    expect(answer.moves[1]!.refusals[0]).toMatchObject({ reason: 'TEACHER', params: { className: '7A', day: 2 } });
  });

  it('asks nothing of a lesson set aside on the tray, and says a förlagd lesson stands only where it stands', async () => {
    table = [lesson(LESSON), lesson(OTHER, { fromPlacement: true, studentGroupId: G8B, teacherId: OTHER_TEACHER })];
    const answer = await service.judgeMoves(
      {
        moves: [
          { lessonId: LESSON, isParked: true, startTime: '12:00', endTime: '13:00' },
          { lessonId: OTHER, startTime: '14:00', endTime: '15:00' },
        ],
      },
      testUser(),
    );
    expect(answer.moves[0]).toMatchObject({ ok: true, refusals: [] });
    expect(answer.moves[1]).toMatchObject({ ok: false, placed: true, refusals: [] });
  });

  it('refuses to name a lesson twice, a lesson that is not there, and lessons of two läsår', async () => {
    table = [lesson(LESSON), lesson(OTHER, { academicYearId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc00' })];
    await expect(service.judgeMoves({ moves: [{ lessonId: LESSON }, { lessonId: LESSON }] }, testUser())).rejects.toMatchObject({ status: 400 });
    await expect(service.judgeMoves({ moves: [{ lessonId: C }] }, testUser())).rejects.toMatchObject({ status: 404 });
    await expect(service.judgeMoves({ moves: [{ lessonId: LESSON }, { lessonId: OTHER }] }, testUser())).rejects.toMatchObject({ status: 400 });
  });

  it('reads every fact once however many drags it is asked: the board’s per weekday, the other schools’ holds once', async () => {
    table = [lesson(LESSON), lesson(OTHER, { studentGroupId: G8B, teacherId: OTHER_TEACHER }), lesson(B, { studentGroupId: G8B, teacherId: '99999999-9999-4999-8999-999999999991', startTime: t('08:00'), endTime: t('09:00') })];
    await service.judgeMoves(
      {
        moves: [
          { lessonId: LESSON, startTime: '14:00', endTime: '15:00' },
          { lessonId: OTHER, startTime: '15:00', endTime: '16:00' },
          { lessonId: B, startTime: '16:00', endTime: '17:00' },
        ],
      },
      testUser(),
    );
    expect(tx['frameTime']!['findMany']).toHaveBeenCalledTimes(1);
    expect(tx['lunchSitting']!['findMany']).toHaveBeenCalledTimes(1);
    expect(readOtherSchoolHolds).toHaveBeenCalledTimes(1);
  });
});
