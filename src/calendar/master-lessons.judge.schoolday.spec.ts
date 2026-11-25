import { ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { placementRefusalText } from '../requirement-placements/placement-refusal';
import { MasterLessonsService } from './master-lessons.service';

/*
 * SCHOOL_DAY (En domare med ord, E1, granskaren g461, L-4): the hand edit refuses a lesson on a Saturday or a Sunday as the förläggning
 * does, in the förläggning's own words, and lets one that already stands there stand (låt stå): the engine reads SCHEDULE_DAYS 1-5
 * and a weekend lesson is one a file brought in. The rule reads only the day, so it is asked of an edit that CHANGES the day.
 */

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
const NEW_ROOM = '00000000-aaaa-4aaa-8aaa-000000000009';
const LESSON = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, any>;
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

const lesson = (overrides: Row = {}): Row => ({
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
  fromPlacement: false,
  subject: { name: 'Matematik' },
  studentGroup: { name: '7A' },
  school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
  ...overrides,
});

describe('a lesson on a Saturday or a Sunday is the school day’s no, as the förläggning says it', () => {
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
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    stored = lesson();
    tx['masterLesson']!['findUnique']!.mockImplementation(async () => stored);
    tx['masterLesson']!['update']!.mockImplementation(async () => stored);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => (query.where?.['id']?.in ? [stored] : []));
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG', id: YEAR, schoolId: SCHOOL, isActive: true, predecessorId: null, _count: { teacherEmployments: 0 } });
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: G7A, name: '7A', gradeLevel: 7, halfOfId: null }]);
  });

  const refusal = async (attempt: Promise<unknown>) => {
    try {
      await attempt;
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).getResponse() as { message: string; code: string; params: Record<string, unknown> };
    }
    throw new Error('the edit was not refused');
  };

  it.each([6, 7])('refuses a PATCH to day %i as SCHOOL_DAY, in the förläggning’s words, and writes nothing', async (day) => {
    const body = await refusal(service.update(LESSON, { dayOfWeek: day }, testUser()));
    expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'SCHOOL_DAY', reasons: 'SCHOOL_DAY' } });
    expect(body.message).toBe(placementRefusalText('SCHOOL_DAY'));
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('refuses a new lesson on a Sunday', async () => {
    const body = await refusal(
      service.create({ academicYearId: YEAR, subjectId: SUBJECT, studentGroupId: G7A, dayOfWeek: 7, startTime: '10:00', endTime: '11:00' }, testUser()),
    );
    expect(body).toMatchObject({ code: 'MASTER_LESSON_REFUSED', params: { reason: 'SCHOOL_DAY' } });
    expect(tx['masterLesson']!['create']).not.toHaveBeenCalled();
  });

  it('answers the same to the question, the heaviest first', async () => {
    const answer = await service.judgeMoves({ moves: [{ lessonId: LESSON, dayOfWeek: 6 }] }, testUser());
    expect(answer).toMatchObject({ ok: false, moves: [{ ok: false, refusals: [{ reason: 'SCHOOL_DAY', text: placementRefusalText('SCHOOL_DAY') }] }] });
  });

  it('lets a lesson that already stands on a Saturday be given another room or time that day (låt stå), and refuses a move to another weekend day', async () => {
    stored = lesson({ dayOfWeek: 6 });
    await expect(service.update(LESSON, { roomId: NEW_ROOM, isLocked: true }, testUser())).resolves.toBeDefined();
    await expect(service.update(LESSON, { startTime: '12:00', endTime: '13:00' }, testUser())).resolves.toBeDefined();
    const body = await refusal(service.update(LESSON, { dayOfWeek: 7 }, testUser()));
    expect(body.params).toMatchObject({ reason: 'SCHOOL_DAY' });
    // ... and back to a school day is let through.
    await expect(service.update(LESSON, { dayOfWeek: 2 }, testUser())).resolves.toBeDefined();
    await expect(service.judgeMoves({ moves: [{ lessonId: LESSON, roomId: NEW_ROOM }] }, testUser())).resolves.toMatchObject({ ok: true });
  });

  it('names a clash with a lesson on a Saturday by the day, not by an empty word', async () => {
    stored = lesson({ dayOfWeek: 1 });
    const other = lesson({ id: '44444444-4444-4444-8444-444444444444', dayOfWeek: 6, teacherId: TEACHER, roomId: null, studentGroupId: '00000000-aaaa-4aaa-8aaa-000000000003', subject: { name: 'Kemi' }, studentGroup: { name: '8B' } });
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      if (query.where?.['id']?.in) return query.where['id'].in.includes(other.id) ? [other] : [stored];
      return query.where?.['dayOfWeek'] === 6 ? [other] : [];
    });
    const body = await refusal(service.update(LESSON, { dayOfWeek: 6 }, testUser()));
    expect(body.params).toMatchObject({ reason: 'SCHOOL_DAY', reasons: 'SCHOOL_DAY,TEACHER' });
    expect(body.message).toContain('lördag');
    expect(body.message).not.toMatch(/  /);
  });
});
