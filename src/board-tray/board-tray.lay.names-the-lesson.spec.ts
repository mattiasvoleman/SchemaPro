import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { REQUIREMENT_PLACEMENTS_STALE } from '../requirement-placements/placement-refusal';
import { lockPostForShares } from '../resources/requirement-shares';
import { BoardTrayService } from './board-tray.service';
import type { LayBrickDto } from './dto/lay-brick.dto';

/*
 * EN LÄGGNING SOM INTE NÄMNER LEKTIONEN, NÄR VARJE BRICKA I DELEN ÄR EN LEKTION PÅ PARKERINGEN (granskaren g490).
 *
 * En parkerad lektion är en bricka, nämligen sig själv. Säger en läggning ingen `lessonId` fast delens alla bricka är parkerade lektioner, görs en ny
 * lektion bredvid den parkerade: den nya räknas av postens antal, och den parkerade ligger kvar på parkeringen som ett spöke som en dag tas fram
 * och ger posten en lektion för mycket. Läggningen nekas då som en gammal bild (409), och ingenting skrivs.
 */

jest.mock('../publication/publish-mode', () => ({ ...jest.requireActual('../publication/publish-mode'), enterGrundschemaWrite: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ ...jest.requireActual('../optimization/regeneration-lock'), lockYearForGrundschemaEdit: jest.fn() }));
jest.mock('../resources/requirement-shares', () => ({ ...jest.requireActual('../resources/requirement-shares'), lockPostForShares: jest.fn() }));

const YEAR = '99999999-9999-4999-8999-999999999999';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const G7A = '66666666-6666-4666-8666-666666666666';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = '44444444-4444-4444-8444-444444444444';
const POST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
type Row = Record<string, unknown>;

const post = (over: Row = {}): Row => ({
  id: POST,
  academicYearId: YEAR,
  studentGroupId: G7A,
  subjectId: MATH,
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  minutesBefore: 0,
  minutesAfter: 0,
  shares: [],
  ...over,
});

const lesson = (over: Row = {}): Row => ({
  id: 'l-1',
  dayOfWeek: 1,
  startTime: time('08:00'),
  endTime: time('09:00'),
  studentGroupId: G7A,
  subjectId: MATH,
  teacherId: ANNA,
  coTeacherId: null,
  roomId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: true,
  isGenerated: false,
  isParked: false,
  fromPlacement: false,
  extraGroups: [],
  ...over,
});

describe('BoardTrayService: a lay that names no lesson, when every brick of the part is a lesson on the tray', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let masters: { createIn: jest.Mock; updateIn: jest.Mock };
  let standing: Row[];
  let aside: Row[];

  const request = (over: Partial<LayBrickDto> = {}): LayBrickDto =>
    ({ academicYearId: YEAR, postId: POST, teacherId: ANNA, minutes: 60, partKey: 'unset', dayOfWeek: 2, startTime: '10:00', roomId: null, ...over }) as LayBrickDto;
  const bricks = async () => (await service.trayOfYear(YEAR, undefined, testUser())).bricks;

  beforeEach(() => {
    masters = { createIn: jest.fn(async () => ({ id: 'new', isLocked: true, warnings: [] })), updateIn: jest.fn(async () => ({ id: 'parked-1', isLocked: true, warnings: [] })) };
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, masters as unknown as MasterLessonsService);
    standing = [lesson({ id: 'a' })];
    aside = [lesson({ id: 'parked-1', isParked: true, isLocked: false, startTime: time('13:00'), endTime: time('14:00') })];
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL });
    tx['teachingRequirement']!['findMany']!.mockImplementation(async () => [post()]);
    tx['teachingRequirement']!['findUnique']!.mockImplementation(async () => post());
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where: { OR?: unknown } }) => (query.where.OR ? aside : standing));
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
    (enterGrundschemaWrite as jest.Mock).mockReset().mockResolvedValue('DIRECT');
    (lockYearForGrundschemaEdit as jest.Mock).mockReset();
    (lockPostForShares as jest.Mock).mockReset();
  });

  it('is refused as a stale picture, and writes nothing: the one brick left is the parked lesson, and a new lesson would sit beside it', async () => {
    const found = await bricks();
    expect(found.map((brick) => brick.lessonId)).toEqual(['parked-1']);
    await expect(service.lay(request({ partKey: found[0]!.partKey }), testUser())).rejects.toMatchObject({ response: { code: REQUIREMENT_PLACEMENTS_STALE } });
    expect(masters.createIn).not.toHaveBeenCalled();
    expect(masters.updateIn).not.toHaveBeenCalled();
  });

  it('lays a new lesson when the part has a brick that is no lesson (one of the two bricks is the parked lesson, the other is not)', async () => {
    standing = [];
    const found = await bricks();
    expect(found.map((brick) => brick.lessonId)).toEqual(['parked-1', null]);
    await service.lay(request({ partKey: found[0]!.partKey }), testUser());
    expect(masters.createIn).toHaveBeenCalledTimes(1);
  });

  it('lays the parked lesson itself when the request names it (the case that already held)', async () => {
    const found = await bricks();
    await service.lay(request({ partKey: found[0]!.partKey, lessonId: 'parked-1' }), testUser());
    expect(masters.updateIn).toHaveBeenCalledTimes(1);
    expect(masters.createIn).not.toHaveBeenCalled();
  });
});
