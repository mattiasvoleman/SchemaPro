import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { lockPostForShares } from '../resources/requirement-shares';
import { BoardTrayService } from './board-tray.service';
import { LayBrickDto } from './dto/lay-brick.dto';

/*
 * UNDANTAG MED FLIT VID LÄGGNING (E1b, granskaren g490): en hand som lägger en bricka över lunchen eller utanför ramtiden svarar ja ("Lägg ändå") som vid
 * varje handredigering. Läggningen bär `exempt` till handredigeringens egen skrivning, som dömer det: bara FRAME och LUNCH kan nämnas.
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

const post = {
  id: POST, academicYearId: YEAR, studentGroupId: G7A, subjectId: MATH, teacherId: ANNA, coTeacherId: null, lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [],
  recurrence: 'ALL_WEEKS', blockId: null, startDate: null, endDate: null, minutesBefore: 0, minutesAfter: 0, shares: [],
};
const parked = {
  id: 'parked-1', dayOfWeek: 1, startTime: time('13:00'), endTime: time('14:00'), studentGroupId: G7A, subjectId: MATH, teacherId: ANNA, coTeacherId: null, roomId: null,
  recurrence: 'ALL_WEEKS', startDate: null, endDate: null, isLocked: false, isGenerated: false, isParked: true, fromPlacement: false, extraGroups: [],
};

describe('lay: Undantag med flit', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let masters: { createIn: jest.Mock; updateIn: jest.Mock };
  let aside: object[];

  const request = (over: Record<string, unknown> = {}): LayBrickDto =>
    ({ academicYearId: YEAR, postId: POST, teacherId: ANNA, minutes: 60, partKey: 'unset', dayOfWeek: 2, startTime: '12:00', roomId: null, ...over }) as LayBrickDto;
  const keyNow = async (): Promise<string> => (await service.trayOfYear(YEAR, undefined, testUser())).bricks[0]!.partKey;

  beforeEach(() => {
    aside = [];
    masters = { createIn: jest.fn(async () => ({ id: 'new', isLocked: true, warnings: [] })), updateIn: jest.fn(async () => ({ id: 'parked-1', isLocked: true, warnings: [] })) };
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, masters as unknown as MasterLessonsService);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL });
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([post]);
    tx['teachingRequirement']!['findUnique']!.mockResolvedValue(post);
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where: { OR?: unknown } }) => (query.where.OR ? aside : []));
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
    (enterGrundschemaWrite as jest.Mock).mockReset().mockResolvedValue('DIRECT');
    (lockYearForGrundschemaEdit as jest.Mock).mockReset();
    (lockPostForShares as jest.Mock).mockReset();
  });

  it('hands the rules the request named to the hand edit\'s own create, where the judge asks them', async () => {
    await service.lay(request({ partKey: await keyNow(), exempt: ['LUNCH'] }), testUser());
    expect(masters.createIn.mock.calls[0]![1]).toMatchObject({ isLocked: true, exempt: ['LUNCH'] });
  });

  it('hands them to the update that moves a parked lesson back, too', async () => {
    aside = [parked];
    const brick = (await service.trayOfYear(YEAR, undefined, testUser())).bricks.find((entry) => entry.lessonId === 'parked-1')!;
    await service.lay(request({ partKey: brick.partKey, lessonId: 'parked-1', exempt: ['FRAME'] }), testUser());
    expect(masters.updateIn.mock.calls[0]![2]).toMatchObject({ isParked: false, isLocked: true, exempt: ['FRAME'] });
  });

  it('says nothing of an exemption when the request names none: the judge is asked as it was', async () => {
    await service.lay(request({ partKey: await keyNow() }), testUser());
    expect(masters.createIn.mock.calls[0]![1].exempt).toBeUndefined();
  });

  it('takes only the two rules a lesson may be exempt from (the request is a 400 for any other)', async () => {
    const body = { academicYearId: YEAR, postId: POST, teacherId: ANNA, minutes: 60, partKey: '0123456789abcdef', dayOfWeek: 2, startTime: '12:00' };
    expect(await validate(plainToInstance(LayBrickDto, { ...body, exempt: ['FRAME', 'LUNCH'] }))).toHaveLength(0);
    expect(await validate(plainToInstance(LayBrickDto, { ...body, exempt: [] }))).toHaveLength(0);
    for (const exempt of [['TEACHER'], ['SCHOOL_DAY'], ['FRAME', 'FRAME', 'LUNCH'], 'FRAME']) {
      expect((await validate(plainToInstance(LayBrickDto, { ...body, exempt }))).length).toBeGreaterThan(0);
    }
  });
});
