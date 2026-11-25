import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { placementChanged, type JudgedCandidate } from './lesson-judge';
import { MasterLessonsService } from './master-lessons.service';

/*
 * WHAT "WHERE A LESSON STANDS" IS (review of #461).
 *
 * The board's rules (ramtid, the class's meal, the rules on årskurser) read a lesson's day, clock, classes and the DATES it runs
 * in (a meal of the autumn is not the spring lesson's meal), and the other schools' holds have no weeks at all. Whether a lesson
 * runs in every week, the odd ones or the even ones is read by none of them, so an edit that changes only that moves the lesson
 * nowhere the rules can see, and a lesson that stands against a rule may be given other weeks (låt stå).
 */

jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const base: JudgedCandidate = { dayOfWeek: 1, startMinutes: 720, endMinutes: 780, teacherId: 't', roomId: 'r', recurrence: 'ALL_WEEKS', startDate: null, endDate: null, extraGroupIds: ['g'] };

describe('placementChanged', () => {
  it('is false for an edit of the weeks of the year alone, true for what the rules read', () => {
    expect(placementChanged({ ...base, recurrence: 'ODD_WEEKS' }, base)).toBe(false);
    expect(placementChanged({ ...base, recurrence: 'EVEN_WEEKS' }, { ...base, recurrence: 'ODD_WEEKS' })).toBe(false);
    expect(placementChanged({ ...base, dayOfWeek: 2 }, base)).toBe(true);
    expect(placementChanged({ ...base, startMinutes: 725 }, base)).toBe(true);
    expect(placementChanged({ ...base, endMinutes: 770 }, base)).toBe(true);
    expect(placementChanged({ ...base, startDate: new Date('2026-09-07') }, base)).toBe(true);
    expect(placementChanged({ ...base, endDate: new Date('2026-12-20') }, base)).toBe(true);
    expect(placementChanged({ ...base, extraGroupIds: ['g', 'h'] }, base)).toBe(true);
    expect(placementChanged({ ...base, extraGroupIds: [] }, base)).toBe(true);
  });
});

describe('a lesson that stands on the class’s lunch is given other weeks (låt stå)', () => {
  const SCHOOL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const YEAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const G7A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const LESSON = '55555555-5555-4555-8555-555555555555';
  const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
  let service: MasterLessonsService;
  let tx: TxMock;

  beforeEach(() => {
    tx = createTxMock();
    service = new MasterLessonsService(
      createPrismaMock(tx) as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    const row = {
      id: LESSON, academicYearId: YEAR, subjectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', studentGroupId: G7A, teacherId: null, coTeacherId: null, roomId: null,
      dayOfWeek: 1, startTime: t('12:00'), endTime: t('13:00'), isLocked: false, isParked: false, recurrence: 'ALL_WEEKS', startDate: null, endDate: null,
      extraGroups: [], participants: [], fromPlacement: false, school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
    };
    tx['masterLesson']!['findUnique']!.mockResolvedValue(row);
    tx['masterLesson']!['update']!.mockResolvedValue(row);
    tx['masterLesson']!['findMany']!.mockResolvedValue([]);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
    tx['studentGroup']!['findMany']!.mockResolvedValue([]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null }]);
  });

  it('may be given the odd weeks, and is still refused a new place on the lunch', async () => {
    await expect(service.update(LESSON, { recurrence: 'ODD_WEEKS' }, testUser())).resolves.toBeDefined();
    await expect(service.update(LESSON, { recurrence: 'EVEN_WEEKS', startTime: '12:10', endTime: '13:10' }, testUser())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MASTER_LESSON_REFUSED', params: expect.objectContaining({ reason: 'LUNCH' }) }),
    });
  });
});
