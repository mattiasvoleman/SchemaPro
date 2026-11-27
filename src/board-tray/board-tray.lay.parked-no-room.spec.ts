import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { lockPostForShares } from '../resources/requirement-shares';
import { BoardTrayService } from './board-tray.service';
import type { LayBrickDto } from './dto/lay-brick.dto';

/*
 * "UTAN SAL" FÖR EN PARKERAD LEKTION SOM LÄGGS TILLBAKA (E4 Klart (e), granskaren g490).
 *
 * Svaret säger `noRoom` också när brickan är en parkerad lektion som flyttas tillbaka: ingen sal angiven är "Utan sal", och lektionens egen sal på
 * parkeringen är inte ett svar på frågan (läggaren valde ingen). En sal angiven är en sal.
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

describe('BoardTrayService.lay: a parked lesson laid back says "Utan sal" when no room is given', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let masters: { createIn: jest.Mock; updateIn: jest.Mock };

  const request = (over: Partial<LayBrickDto> = {}): LayBrickDto =>
    ({ academicYearId: YEAR, postId: POST, teacherId: ANNA, minutes: 60, partKey: 'unset', dayOfWeek: 2, startTime: '10:00', lessonId: 'parked-1', ...over }) as LayBrickDto;
  const keyNow = async (): Promise<string> => (await service.trayOfYear(YEAR, undefined, testUser())).bricks.find((brick) => brick.lessonId === 'parked-1')!.partKey;

  beforeEach(() => {
    masters = { createIn: jest.fn(), updateIn: jest.fn(async () => ({ id: 'parked-1', isLocked: true, warnings: [] })) };
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, masters as unknown as MasterLessonsService);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL });
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([post()]);
    tx['teachingRequirement']!['findUnique']!.mockResolvedValue(post());
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where: { OR?: unknown } }) =>
      query.where.OR ? [lesson({ id: 'parked-1', isParked: true, isLocked: false, startTime: time('13:00'), endTime: time('14:00') })] : [],
    );
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
    (enterGrundschemaWrite as jest.Mock).mockReset().mockResolvedValue('DIRECT');
    (lockYearForGrundschemaEdit as jest.Mock).mockReset();
    (lockPostForShares as jest.Mock).mockReset();
  });

  it('says noRoom: true and moves the lesson back without a room when none was given', async () => {
    const result = await service.lay(request({ partKey: await keyNow(), roomId: null }), testUser());
    expect(result.noRoom).toBe(true);
    expect(masters.updateIn.mock.calls[0]![2]).toMatchObject({ isParked: false, roomId: null, isLocked: true });
  });

  it('says noRoom: false when a room was given', async () => {
    const result = await service.lay(request({ partKey: await keyNow(), roomId: '11111111-1111-4111-8111-111111111111' }), testUser());
    expect(result.noRoom).toBe(false);
  });
});
