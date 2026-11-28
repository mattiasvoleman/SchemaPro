import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PossibleTimesService } from '../calendar/possible-times.service';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { BoardTrayService, TrayBrick } from '../board-tray/board-tray.service';
import type { PrismaService } from '../database/prisma.service';
import { judgeLessons } from '../calendar/lesson-judge';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { readSwapData } from '../swaps/swap-snapshot';
import { BOARD_FILL_TOO_MANY, BoardFillService } from './board-fill.service';
import { FILL_MAX_BRICKS } from './dto/fill.dto';

/*
 * What a proposal offers, Ta in must be able to take: Ta in's body holds at most FILL_MAX_BRICKS lessons. A question about more bricks than that is refused at
 * the proposal, with the number and the limit as flat params, and the page narrows it to a year or a class; the bricks nobody can lay (a block's, a lesson nobody
 * teaches) are never placed and do not count.
 */

jest.mock('../swaps/swap-snapshot', () => ({ ...jest.requireActual('../swaps/swap-snapshot'), readSwapData: jest.fn() }));
jest.mock('../calendar/lesson-judge', () => ({ ...jest.requireActual('../calendar/lesson-judge'), judgeLessons: jest.fn() }));
jest.mock('./fill-reads');

const YEAR = '99999999-9999-4999-8999-999999999999';
const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const bricksOf = (placeable: number, unplaceable: number): TrayBrick[] =>
  Array.from({ length: placeable + unplaceable }, (_, index) => ({
    postId: POST,
    nth: index + 1,
    partKey: 'p'.repeat(16),
    lessonId: null,
    studentGroupId: 'c1',
    subjectId: SUBJECT,
    teacherId: index < placeable ? '44444444-4444-4444-8444-444444444444' : null,
    coTeacherId: null,
    minutes: 60,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    blockId: null,
    cannotPlace: index < placeable ? null : 'NO_TEACHER',
    possibleTimes: null,
  }));

describe('BoardFillService.propose: no more than Ta in takes in', () => {
  let tx: TxMock;
  let service: BoardFillService;
  let bricks: TrayBrick[];
  let possible: { worldFactsOf: jest.Mock; worldOf: jest.Mock };
  const world = makeWorld({ seed: 3, classes: 3, perClass: 0 });

  beforeEach(() => {
    tx = createTxMock();
    bricks = [];
    const tray = { trayIn: jest.fn(async () => ({ academicYearId: YEAR, bricks, tally: { lessons: bricks.length, laid: 0, placedByRow: 0, left: bricks.length }, groups: [] })) };
    possible = {
      worldFactsOf: jest.fn(async () => ({ closedWeeks: null, sharedRooms: new Set<string>() })),
      worldOf: jest.fn(async () => ({ rooms: [], wishes: [], needsOf: () => null })),
    };
    tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 10 }, _max: { updatedAt: new Date('2026-11-01T10:00:00Z') } });
    tx['teachingRequirement']!['aggregate']!.mockResolvedValue({ _count: { _all: 4 }, _max: { updatedAt: new Date('2026-10-01T10:00:00Z') } });
    (readSwapData as jest.Mock).mockReset().mockResolvedValue({ ...world.data, lessons: [], posts: [] });
    (judgeLessons as jest.Mock).mockReset().mockResolvedValue([{ ok: true, refusals: [], exempted: [], exemptable: false }]);
    service = new BoardFillService(createPrismaMock(tx) as unknown as PrismaService, tray as unknown as BoardTrayService, {} as MasterLessonsService, possible as unknown as PossibleTimesService, {} as ScheduleVersionsService);
    service.budgetMs = -1; // nothing is laid: the question here is how many bricks may be asked about
  });

  it('refuses a question about more bricks than Ta in takes, with the number and the limit as flat params, and builds no world', async () => {
    bricks = bricksOf(FILL_MAX_BRICKS + 1, 0);
    await expect(service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, testUser())).rejects.toMatchObject({
      status: 400,
      response: { code: BOARD_FILL_TOO_MANY, params: { asked: FILL_MAX_BRICKS + 1, max: FILL_MAX_BRICKS } },
    });
    expect(possible.worldOf).not.toHaveBeenCalled();
  });

  it('answers a question about exactly that many, and does not count the bricks nobody can lay', async () => {
    bricks = bricksOf(FILL_MAX_BRICKS, 50);
    const proposal = await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, testUser());
    expect(proposal.asked).toBe(FILL_MAX_BRICKS + 50);
  });
});
