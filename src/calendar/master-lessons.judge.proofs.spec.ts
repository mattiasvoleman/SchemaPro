import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { MasterLessonsService } from './master-lessons.service';

/*
 * WHAT THE JUDGE CLAIMS AND NO ROW HELD (review of #461). Each row here fails against a mutant of the judge that the PR's own rows let
 * through:
 *
 *   - "a lesson put back from the tray stands nowhere and is asked everything" (the PATCH's `stands`, and the question's): a lesson
 *     parked on the class's lunch and put back is refused; given another room while it stays on the tray, it is not;
 *   - the board's rules are asked of an edit that changes the classes of a lesson (a class that eats then is now on it);
 *   - a meal of another part of the läsår is not the lesson's meal (the lesson's dates against the meal's), and a lesson with no dates
 *     meets every meal of the class that day.
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
const ROOM = '66666666-6666-4666-8666-666666666666';
const NEW_ROOM = '00000000-aaaa-4aaa-8aaa-000000000009';
const LESSON = '55555555-5555-4555-8555-555555555555';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
type Row = Record<string, any>;

const stored = (overrides: Row = {}): Row => ({
  id: LESSON,
  academicYearId: YEAR,
  subjectId: SUBJECT,
  studentGroupId: G7A,
  teacherId: null,
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

describe('the judge, what a mutant of it would let through', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let meals: Row[];

  const arrange = (lesson: Row) => {
    tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
    tx['masterLesson']!['update']!.mockResolvedValue(lesson);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => (query.where?.['id']?.in ? [lesson] : []));
  };
  const reasonOf = async (attempt: Promise<unknown>): Promise<string | null> => {
    try {
      await attempt;
    } catch (error) {
      return (error as { getResponse: () => { params: { reason: string } } }).getResponse().params.reason;
    }
    return null;
  };
  const asked = async (move: Row): Promise<string | null> => (await service.judgeMoves({ moves: [{ lessonId: LESSON, ...move }] } as never, testUser())).moves[0]!.refusals[0]?.reason ?? null;

  beforeEach(() => {
    tx = createTxMock();
    service = new MasterLessonsService(
      createPrismaMock(tx) as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    meals = [{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null }];
    tx['lunchSitting']!['findMany']!.mockImplementation(async () => meals);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
    tx['studentGroup']!['findMany']!.mockImplementation(async (query: { where: Row }) =>
      (query.where['id']?.in ?? []).map((id: string) => ({ id, name: id === G7A ? '7A' : '8B', gradeLevel: id === G7A ? 7 : 8, halfOfId: null, kind: 'CLASS', replacesSubjectId: null, academicYearId: YEAR })),
    );
  });

  it('asks a lesson put back from the tray everything, and a lesson edited on the tray nothing of where it was', async () => {
    arrange(stored({ isParked: true, startTime: t('12:00'), endTime: t('13:00') }));
    // The tray remembers Monday 12:00, on the class's lunch. Put back where it was, it is on the lunch.
    expect(await reasonOf(service.update(LESSON, { isParked: false }, testUser()))).toBe('LUNCH');
    expect(await asked({ isParked: false })).toBe('LUNCH');
    // Still on the tray, given another room: it occupies nothing.
    expect(await reasonOf(service.update(LESSON, { roomId: NEW_ROOM }, testUser()))).toBeNull();
    expect(await asked({ roomId: NEW_ROOM })).toBeNull();
    // A lesson that is not parked and stands on the lunch is let stand for the same edit (låt stå), which is what the tray is not.
    arrange(stored({ startTime: t('12:00'), endTime: t('13:00') }));
    expect(await reasonOf(service.update(LESSON, { isParked: false }, testUser()))).toBeNull();
    expect(await asked({ isParked: false })).toBeNull();
  });

  it('asks the board of an edit that gives the lesson another class: the class that eats then is now on it', async () => {
    arrange(stored());
    meals = [{ studentGroupId: G8B, dayOfWeek: 1, startTime: t('10:00'), endTime: t('10:30'), startDate: null, endDate: null }];
    expect(await reasonOf(service.update(LESSON, { extraGroupIds: [G8B] }, testUser()))).toBe('LUNCH');
    expect(await asked({ extraGroupIds: [G8B] })).toBe('LUNCH');
    // The same classes in another order, or none added, move nothing.
    expect(await reasonOf(service.update(LESSON, { roomId: NEW_ROOM }, testUser()))).toBeNull();
  });

  it('holds a lesson to the meals of its own weeks: a spring lesson is clear of an autumn meal, a lesson with no dates is not', async () => {
    arrange(stored());
    // 7A eats 12:00-12:30 on Mondays from 31 August to 25 October only.
    meals = [{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: day('2026-08-31'), endDate: day('2026-10-25') }];
    const onTheMeal = { startTime: '12:00', endTime: '13:00' };
    expect(await reasonOf(service.update(LESSON, { ...onTheMeal, startDate: '2027-01-11', endDate: '2027-06-06' }, testUser()))).toBeNull();
    expect(await asked({ ...onTheMeal, startDate: '2027-01-11', endDate: '2027-06-06' })).toBeNull();
    expect(await reasonOf(service.update(LESSON, { ...onTheMeal, startDate: '2026-09-07', endDate: '2026-10-18' }, testUser()))).toBe('LUNCH');
    expect(await asked({ ...onTheMeal, startDate: '2026-09-07', endDate: '2026-10-18' })).toBe('LUNCH');
    // Every week of the year meets every meal of the class that day.
    expect(await reasonOf(service.update(LESSON, onTheMeal, testUser()))).toBe('LUNCH');
    expect(await asked(onTheMeal)).toBe('LUNCH');
  });
});
