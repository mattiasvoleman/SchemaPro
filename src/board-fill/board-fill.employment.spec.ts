import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
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
 * A proposal ranks every start by a cost that counts a teacher's days and stretch against the limits of their post, which is HR data (access-log.ts: a teacher's
 * day counted against a limit of their post is a read of that post, recorded EMPLOYMENT). Möjliga tider, Vad får plats and the swap search record it; the fill
 * reads the same world and costs the same and recorded nothing.
 */

jest.mock('../swaps/swap-snapshot', () => ({ ...jest.requireActual('../swaps/swap-snapshot'), readSwapData: jest.fn() }));
jest.mock('../calendar/lesson-judge', () => ({ ...jest.requireActual('../calendar/lesson-judge'), judgeLessons: jest.fn() }));
jest.mock('./fill-reads');

const YEAR = '99999999-9999-4999-8999-999999999999';
const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LIMITED = '44444444-4444-4444-8444-444444444444';
const FREE = '55555555-5555-4555-8555-555555555555';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const brick = (over: Partial<TrayBrick> = {}): TrayBrick => ({
  postId: POST,
  nth: 1,
  partKey: 'p'.repeat(16),
  lessonId: null,
  studentGroupId: 'c1',
  subjectId: SUBJECT,
  teacherId: LIMITED,
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

describe('BoardFillService.propose: the read of a teacher\'s post', () => {
  let tx: TxMock;
  let service: BoardFillService;
  let bricks: TrayBrick[];
  const world = makeWorld({ seed: 3, classes: 3, perClass: 0 });
  const user = { ...testUser(), channel: 'WEB' as const };

  beforeEach(() => {
    tx = createTxMock();
    bricks = [brick(), brick({ nth: 2, teacherId: FREE })];
    const tray = { trayIn: jest.fn(async () => ({ academicYearId: YEAR, bricks, tally: { lessons: 2, laid: 0, placedByRow: 0, left: 2 }, groups: [] })) };
    const possible = {
      worldFactsOf: jest.fn(async () => ({ closedWeeks: null, sharedRooms: new Set<string>() })),
      worldOf: jest.fn(async () => ({ rooms: [], wishes: [], needsOf: () => null })),
    };
    tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 10 }, _max: { updatedAt: new Date('2026-11-01T10:00:00Z') } });
    tx['teachingRequirement']!['aggregate']!.mockResolvedValue({ _count: { _all: 4 }, _max: { updatedAt: new Date('2026-10-01T10:00:00Z') } });
    (readSwapData as jest.Mock).mockReset().mockResolvedValue({ ...world.data, lessons: [], posts: [], postLimited: new Set([LIMITED]) });
    (judgeLessons as jest.Mock).mockReset().mockResolvedValue([{ ok: true, refusals: [], exempted: [], exemptable: false }]);
    service = new BoardFillService(createPrismaMock(tx) as unknown as PrismaService, tray as unknown as BoardTrayService, {} as MasterLessonsService, possible as unknown as PossibleTimesService, {} as ScheduleVersionsService);
  });

  it('records an EMPLOYMENT read of the teachers whose posts carry a limit and whose bricks were costed, and of no one else', async () => {
    const proposal = await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, user);
    expect(proposal.placed.length).toBe(2);
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [LIMITED] }]);
  });

  it('records nothing when no teacher of a costed brick has a limit on the post', async () => {
    (readSwapData as jest.Mock).mockResolvedValue({ ...world.data, lessons: [], posts: [], postLimited: new Set<string>() });
    await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, user);
    expect(recordedReads(tx)).toEqual([]);
  });
});
