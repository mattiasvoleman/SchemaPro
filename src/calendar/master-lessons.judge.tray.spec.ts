import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { MasterLessonsService } from './master-lessons.service';

/*
 * A LESSON ON THE TRAY OCCUPIES NOTHING, ALSO WHEN THE QUESTION NAMES IT (review of #461).
 *
 * The läsande frågan lays the other drag of a set where it would stand, beside each lesson it judges. A lesson that is parked and is
 * named without `isParked: false` (a new room, a note) stays on the tray when it is saved: laid at its remembered place it would
 * refuse another lesson a place that is free, which the saves in turn would not.
 */

jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const G7A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const G8B = '00000000-aaaa-4aaa-8aaa-000000000003';
const TEACHER = '99999999-9999-4999-8999-999999999999';
const PARKED = '55555555-5555-4555-8555-555555555555';
const MOVING = '44444444-4444-4444-8444-444444444444';
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
type Row = Record<string, any>;

const row = (id: string, overrides: Row = {}): Row => ({
  id,
  academicYearId: YEAR,
  subjectId: SUBJECT,
  studentGroupId: id === PARKED ? G7A : G8B,
  teacherId: TEACHER,
  coTeacherId: null,
  roomId: null,
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
  studentGroup: { name: id === PARKED ? '7A' : '8B' },
  school: { id: SCHOOL, _count: { academicYears: 1 } },
  ...overrides,
});

describe('judgeMoves, a lesson on the tray', () => {
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
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    // The parked lesson remembers Monday 10:00-11:00 with TEACHER; the other lesson stands on Tuesday and is dragged onto that hour.
    table = [row(PARKED, { isParked: true }), row(MOVING, { dayOfWeek: 2 })];
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      if (where['id']?.in) return table.filter((entry) => where['id'].in.includes(entry['id']));
      return table.filter((entry) => entry['dayOfWeek'] === where['dayOfWeek'] && entry['isParked'] !== true && !(where['id']?.notIn ?? []).includes(entry['id']));
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
    tx['studentGroup']!['findMany']!.mockResolvedValue([]);
  });

  const drag = { lessonId: MOVING, dayOfWeek: 1, startTime: '10:00', endTime: '11:00' };

  it('does not stand in the way of a lesson dragged onto its remembered hour, named or not', async () => {
    const alone = await service.judgeMoves({ moves: [drag] }, testUser());
    expect(alone.ok).toBe(true);
    // Named beside it with a new note (a room), it stays on the tray: the same answer.
    const beside = await service.judgeMoves({ moves: [drag, { lessonId: PARKED, roomId: '66666666-6666-4666-8666-666666666666' }] }, testUser());
    expect(beside.moves.find((move) => move.lessonId === MOVING)).toMatchObject({ ok: true, refusals: [] });
  });

  it('does stand there once it is put back in the same question', async () => {
    const answer = await service.judgeMoves({ moves: [drag, { lessonId: PARKED, isParked: false }] }, testUser());
    expect(answer.moves.find((move) => move.lessonId === MOVING)!.refusals[0]).toMatchObject({ reason: 'TEACHER' });
  });
});
