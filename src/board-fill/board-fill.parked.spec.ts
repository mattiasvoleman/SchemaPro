import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PossibleTimesService } from '../calendar/possible-times.service';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { BoardTrayService, TrayBrick } from '../board-tray/board-tray.service';
import type { PrismaService } from '../database/prisma.service';
import { judgeLessons } from '../calendar/lesson-judge';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { readSwapData } from '../swaps/swap-snapshot';
import { BoardFillService } from './board-fill.service';

/*
 * A brick that is a lesson on the tray (parked) is judged by the proposal as the lesson Ta in will write: updateIn keeps the lesson's other classes, its named
 * pupils and its weeks, so the proposal asks the judge about those too. Left out, a proposal said "fits" at a time the same lesson's other class was in a lesson,
 * and Ta in then refused the whole write with 409 MASTER_LESSON_REFUSED (reason GROUP), after the school had been told every brick had a place.
 */

jest.mock('../swaps/swap-snapshot', () => ({ ...jest.requireActual('../swaps/swap-snapshot'), readSwapData: jest.fn() }));
jest.mock('../calendar/lesson-judge', () => ({ ...jest.requireActual('../calendar/lesson-judge'), judgeLessons: jest.fn() }));
jest.mock('./fill-reads');

const YEAR = '99999999-9999-4999-8999-999999999999';
const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const brick = (over: Partial<TrayBrick> = {}): TrayBrick => ({
  postId: POST,
  nth: 1,
  partKey: 'p'.repeat(16),
  lessonId: null,
  studentGroupId: 'c1',
  subjectId: SUBJECT,
  teacherId: TEACHER,
  coTeacherId: null,
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  blockId: null,
  cannotPlace: null,
  possibleTimes: null,
  ...over,
});

describe('BoardFillService.propose: a brick that is a lesson on the tray', () => {
  let tx: TxMock;
  let service: BoardFillService;
  let bricks: TrayBrick[];
  const world = makeWorld({ seed: 3, classes: 3, perClass: 0 });

  beforeEach(() => {
    tx = createTxMock();
    bricks = [brick({ lessonId: 'parked-1' }), brick({ nth: 2 })];
    const tray = { trayIn: jest.fn(async () => ({ academicYearId: YEAR, bricks, tally: { lessons: 2, laid: 0, placedByRow: 0, left: 2 }, groups: [] })) };
    const possible = {
      worldFactsOf: jest.fn(async () => ({ closedWeeks: null, sharedRooms: new Set<string>() })),
      worldOf: jest.fn(async () => ({ rooms: [], wishes: [], needsOf: () => null })),
    };
    tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 10 }, _max: { updatedAt: new Date('2026-11-01T10:00:00Z') } });
    tx['teachingRequirement']!['aggregate']!.mockResolvedValue({ _count: { _all: 4 }, _max: { updatedAt: new Date('2026-10-01T10:00:00Z') } });
    tx['masterLesson']!['findMany']!.mockReset().mockResolvedValue([
      {
        id: 'parked-1',
        coTeacherId: null,
        recurrence: 'ODD_WEEKS',
        startDate: new Date('2026-09-01T00:00:00Z'),
        endDate: null,
        extraGroups: [{ studentGroupId: 'c2' }, { studentGroupId: 'c1' }],
        participants: [{ studentId: 's2' }, { studentId: 's1' }],
      },
    ]);
    (readSwapData as jest.Mock).mockReset().mockResolvedValue({ ...world.data, lessons: [], posts: [] });
    (judgeLessons as jest.Mock).mockReset().mockResolvedValue([{ ok: true, refusals: [], exempted: [], exemptable: false }]);
    service = new BoardFillService(createPrismaMock(tx) as unknown as PrismaService, tray as unknown as BoardTrayService, {} as MasterLessonsService, possible as unknown as PossibleTimesService, {} as ScheduleVersionsService);
  });

  const candidatesAsked = () => (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as Array<{ candidate: Record<string, unknown> }>).map((item) => item.candidate);

  it('asks the judge about the lesson\'s other classes, its named pupils and its weeks, and about a new lesson with none', async () => {
    await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, testUser());
    const asked = candidatesAsked();
    expect(asked.length).toBe(2);
    const ofParked = asked.find((candidate) => (candidate['recurrence'] as string) === 'ODD_WEEKS');
    expect(ofParked).toMatchObject({ extraGroupIds: ['c2'], studentIds: ['s1', 's2'], recurrence: 'ODD_WEEKS', startDate: new Date('2026-09-01T00:00:00.000Z') });
    const ofNew = asked.find((candidate) => (candidate['recurrence'] as string) === 'ALL_WEEKS');
    expect(ofNew).toMatchObject({ extraGroupIds: [], studentIds: [] });
  });

  it('reads the lessons once, for the lessons only, and not at all when no brick is one', async () => {
    await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, testUser());
    expect(tx['masterLesson']!['findMany']).toHaveBeenCalledTimes(1);
    expect(tx['masterLesson']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['parked-1'] } } }));
    tx['masterLesson']!['findMany']!.mockClear();
    bricks = [brick(), brick({ nth: 2 })];
    await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, testUser());
    expect(tx['masterLesson']!['findMany']).not.toHaveBeenCalled();
  });
});
