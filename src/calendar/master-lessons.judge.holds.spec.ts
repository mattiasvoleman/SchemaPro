import { ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { MasterLessonsService } from './master-lessons.service';

/*
 * LÅT STÅ AND THE OTHER SCHOOLS' HOLDS (review of #461).
 *
 * A lesson that already stands in a hold of another school on its teacher or its room (a shared teacher given a lesson there
 * after this one was laid, a room lent out since) may be changed on anything but where it stands. The holds are asked again
 * of an edit that changes who teaches or which room, but only of what the edit CHANGED: a room given to a lesson whose
 * teacher is held elsewhere is not refused for the teacher, and a teacher given to a lesson whose room is lent out is not
 * refused for the room. A teacher or a room that is itself held in that hour is still refused, and a lesson that moves is
 * asked every hold.
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
const NEW_TEACHER = '00000000-aaaa-4aaa-8aaa-000000000008';
const ROOM = '66666666-6666-4666-8666-666666666666';
const NEW_ROOM = '00000000-aaaa-4aaa-8aaa-000000000009';
const LESSON = '55555555-5555-4555-8555-555555555555';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
type Row = Record<string, any>;

const stored = (overrides: Row = {}): Row => ({
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

const teacherHold = (resourceId: string) => ({ holdId: `t-${resourceId}`, kind: 'TEACHER_BUSY', resourceKind: 'TEACHER', resourceId, dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00', schools: ['Norra skolan'] });
const roomHold = (resourceId: string) => ({ holdId: `r-${resourceId}`, kind: 'ROOM_LENT', resourceKind: 'ROOM', resourceId, dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00', schools: ['Södra skolan'] });

describe('låt stå and the other schools’ holds', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let table: Row[];

  beforeEach(() => {
    tx = createTxMock();
    service = new MasterLessonsService(
      createPrismaMock(tx) as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    table = [stored()];
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    tx['masterLesson']!['findUnique']!.mockResolvedValue(stored());
    tx['masterLesson']!['update']!.mockResolvedValue(stored());
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      if (where['id']?.in) return table.filter((row) => where['id'].in.includes(row['id']));
      return table.filter((row) => row['dayOfWeek'] === where['dayOfWeek'] && row['isParked'] !== true && row['id'] !== where['id']?.not && !(where['id']?.notIn ?? []).includes(row['id']));
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
    tx['studentGroup']!['findMany']!.mockResolvedValue([]);
  });

  const refusedBy = async (attempt: Promise<unknown>): Promise<string | null> => {
    try {
      await attempt;
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { code: string; params: { reason: string } };
      expect(body.code).toBe('MASTER_LESSON_REFUSED');
      return body.params.reason;
    }
    return null;
  };
  const judged = async (move: Row): Promise<string | null> => {
    const answer = await service.judgeMoves({ moves: [{ lessonId: LESSON, ...move }] } as never, testUser());
    return answer.moves[0]!.refusals[0]?.reason ?? null;
  };

  it('lets a lesson whose teacher is held at another school be given another room, a lock or a co-teacher', async () => {
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [teacherHold(TEACHER)] });
    expect(await refusedBy(service.update(LESSON, { roomId: NEW_ROOM }, testUser()))).toBeNull();
    expect(await refusedBy(service.update(LESSON, { isLocked: true }, testUser()))).toBeNull();
    expect(await refusedBy(service.update(LESSON, { coTeacherId: NEW_TEACHER }, testUser()))).toBeNull();
    // ... and the question says what the save says.
    expect(await judged({ roomId: NEW_ROOM })).toBeNull();
  });

  it('lets a lesson whose room is lent out be given another teacher', async () => {
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [roomHold(ROOM)] });
    expect(await refusedBy(service.update(LESSON, { teacherId: NEW_TEACHER }, testUser()))).toBeNull();
    expect(await judged({ teacherId: NEW_TEACHER })).toBeNull();
  });

  it('still refuses a room or a teacher that is itself held in that hour, and a lesson that moves into a hold', async () => {
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [teacherHold(TEACHER), roomHold(NEW_ROOM), teacherHold(NEW_TEACHER)] });
    expect(await refusedBy(service.update(LESSON, { roomId: NEW_ROOM }, testUser()))).toBe('OTHER_SCHOOL');
    expect(await refusedBy(service.update(LESSON, { teacherId: NEW_TEACHER }, testUser()))).toBe('OTHER_SCHOOL');
    expect(await refusedBy(service.update(LESSON, { coTeacherId: NEW_TEACHER }, testUser()))).toBe('OTHER_SCHOOL');
    expect(await judged({ roomId: NEW_ROOM })).toBe('OTHER_SCHOOL');
    expect(await judged({ teacherId: NEW_TEACHER })).toBe('OTHER_SCHOOL');
    // A lesson that stands clear of the hold and is moved into it: every hold is asked.
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [{ ...teacherHold(TEACHER), startTime: '14:00:00', endTime: '15:00:00' }] });
    expect(await refusedBy(service.update(LESSON, { startTime: '14:00', endTime: '15:00' }, testUser()))).toBe('OTHER_SCHOOL');
    expect(await judged({ startTime: '14:00', endTime: '15:00' })).toBe('OTHER_SCHOOL');
  });

  it('asks every hold of a lesson that stands nowhere yet (a new lesson, one put back from the tray)', async () => {
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [teacherHold(TEACHER)] });
    tx['masterLesson']!['findUnique']!.mockResolvedValue(stored({ isParked: true }));
    expect(await refusedBy(service.update(LESSON, { isParked: false }, testUser()))).toBe('OTHER_SCHOOL');
    // Still on the tray, it occupies nothing and its remembered place is asked nothing.
    expect(await refusedBy(service.update(LESSON, { roomId: NEW_ROOM }, testUser()))).toBeNull();
  });
});
