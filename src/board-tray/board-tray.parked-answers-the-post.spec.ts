import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { BoardTrayService } from './board-tray.service';

/*
 * EN PARKERAD LEKTION ÄR EN BRICKA BARA OM DEN, TILLBAKALAGD, SVARAR POSTEN (granskaren g490).
 *
 * Läsningen tar en parkerad lektion för postens egen om klass, ämne, lärare och längd stämmer. Men en lektion som läggs tillbaka räknas av postens
 * antal bara om dess veckor omsluter postens (lockCoversDemand, som antalet läser en stående lektion). En parkerad lektion för alla veckor bredvid en
 * post för ojämna veckor lades tillbaka som sig själv och svarade ingenting av posten: efter läggningen visade facket samma bricka igen.
 */

const YEAR = '99999999-9999-4999-8999-999999999999';
const G7A = '66666666-6666-4666-8666-666666666666';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = '44444444-4444-4444-8444-444444444444';
const POST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
type Row = Record<string, unknown>;

const post = (over: Row = {}): Row => ({
  id: POST,
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

const parked = (over: Row = {}): Row => ({
  id: 'parked-1',
  dayOfWeek: 1,
  startTime: time('13:00'),
  endTime: time('14:00'),
  studentGroupId: G7A,
  subjectId: MATH,
  teacherId: ANNA,
  coTeacherId: null,
  roomId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: false,
  isParked: true,
  fromPlacement: false,
  extraGroups: [],
  ...over,
});

describe('BoardTrayService: a parked lesson is a brick only when, laid back, it answers the post', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let posts: Row[];
  let aside: Row[];

  beforeEach(() => {
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, {} as never);
    posts = [post()];
    aside = [];
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    tx['teachingRequirement']!['findMany']!.mockImplementation(async () => posts);
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where: { OR?: unknown } }) => (query.where.OR ? aside : []));
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
  });

  const lessonIds = async (): Promise<Array<string | null>> => (await service.trayOfYear(YEAR, undefined, testUser())).bricks.map((brick) => brick.lessonId);

  it('names a parked lesson of the same weeks as the post\'s brick (the case that already held)', async () => {
    aside = [parked()];
    expect(await lessonIds()).toEqual(['parked-1', null]);
  });

  it('does not name a parked lesson of every week as the brick of a post of odd weeks: laid back it would answer none of the post', async () => {
    posts = [post({ recurrence: 'ODD_WEEKS' })];
    aside = [parked({ recurrence: 'ALL_WEEKS' })];
    expect(await lessonIds()).toEqual([null, null]);
  });

  it('does not name a parked lesson whose dates fall inside the post\'s term: the lesson would not run the whole of it', async () => {
    posts = [post({ startDate: new Date('2027-01-11T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z') })];
    aside = [parked({ startDate: new Date('2027-02-01T00:00:00.000Z'), endDate: new Date('2027-03-01T00:00:00.000Z') })];
    expect(await lessonIds()).toEqual([null, null]);
  });

  it('names a parked lesson whose dates enclose the post\'s term', async () => {
    posts = [post({ startDate: new Date('2027-01-11T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z') })];
    aside = [parked({ startDate: new Date('2027-01-01T00:00:00.000Z'), endDate: new Date('2027-06-30T00:00:00.000Z') })];
    expect(await lessonIds()).toEqual(['parked-1', null]);
  });
});
