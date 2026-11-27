import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { lockPostForShares } from '../resources/requirement-shares';
import { BoardTrayService } from './board-tray.service';
import type { LayBrickDto } from './dto/lay-brick.dto';
import { BOARD_ROOM_NOT_ALLOWED, layRoomRefusal } from './lay-room';

/*
 * LÄGGNINGEN NEKAR EN SAL GENERATORN INTE SKULLE TA, OCH LÄGGER UTAN SAL NÄR INGEN SAL ÄR ANGIVEN (E4 Klart (e), granskaren g490).
 * Frågan till generatorns regel är lay-room.spec.ts; här är hur läggningen använder den: nekad läggning skriver ingenting.
 */

jest.mock('../publication/publish-mode', () => ({ ...jest.requireActual('../publication/publish-mode'), enterGrundschemaWrite: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ ...jest.requireActual('../optimization/regeneration-lock'), lockYearForGrundschemaEdit: jest.fn() }));
jest.mock('../resources/requirement-shares', () => ({ ...jest.requireActual('../resources/requirement-shares'), lockPostForShares: jest.fn() }));
jest.mock('./lay-room', () => ({ ...jest.requireActual('./lay-room'), layRoomRefusal: jest.fn() }));

const YEAR = '99999999-9999-4999-8999-999999999999';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const G7A = '66666666-6666-4666-8666-666666666666';
const KEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANNA = '44444444-4444-4444-8444-444444444444';
const ROOM = '11111111-1111-4111-8111-111111111111';
const POST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const post = {
  id: POST, academicYearId: YEAR, studentGroupId: G7A, subjectId: KEM, teacherId: ANNA, coTeacherId: null, lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [],
  recurrence: 'ALL_WEEKS', blockId: null, startDate: null, endDate: null, minutesBefore: 0, minutesAfter: 0, shares: [],
};

describe('BoardTrayService.lay: the room', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let masters: { createIn: jest.Mock; updateIn: jest.Mock };

  const request = (over: Partial<LayBrickDto> = {}): LayBrickDto =>
    ({ academicYearId: YEAR, postId: POST, teacherId: ANNA, minutes: 60, partKey: 'unset', dayOfWeek: 2, startTime: '10:00', roomId: ROOM, ...over }) as LayBrickDto;
  const keyNow = async (): Promise<string> => (await service.trayOfYear(YEAR, undefined, testUser())).bricks[0]!.partKey;

  beforeEach(() => {
    masters = { createIn: jest.fn(async () => ({ id: 'new', isLocked: true, warnings: [] })), updateIn: jest.fn() };
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, masters as unknown as MasterLessonsService);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL });
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([post]);
    tx['teachingRequirement']!['findUnique']!.mockResolvedValue(post);
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockResolvedValue([]);
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
    (enterGrundschemaWrite as jest.Mock).mockReset().mockResolvedValue('DIRECT');
    (lockYearForGrundschemaEdit as jest.Mock).mockReset();
    (lockPostForShares as jest.Mock).mockReset();
    (layRoomRefusal as jest.Mock).mockReset().mockResolvedValue(null);
  });

  it('refuses a room the generator would not use, with the reason, and writes nothing', async () => {
    (layRoomRefusal as jest.Mock).mockResolvedValue('TYPE');
    await expect(service.lay(request({ partKey: await keyNow() }), testUser())).rejects.toMatchObject({
      response: { code: BOARD_ROOM_NOT_ALLOWED, params: { roomId: ROOM, reason: 'TYPE' } },
    });
    expect(masters.createIn).not.toHaveBeenCalled();
    expect((layRoomRefusal as jest.Mock).mock.calls[0]![2]).toEqual({ academicYearId: YEAR, studentGroupId: G7A, subjectId: KEM, roomId: ROOM });
  });

  it('lays a brick in a room the generator would use, and lays it without a room ("Utan sal") with no question about one', async () => {
    await service.lay(request({ partKey: await keyNow() }), testUser());
    expect(masters.createIn).toHaveBeenCalledTimes(1);
    expect(layRoomRefusal).toHaveBeenCalledTimes(1);
    (layRoomRefusal as jest.Mock).mockClear();
    const result = await service.lay(request({ partKey: await keyNow(), roomId: null }), testUser());
    expect(layRoomRefusal).not.toHaveBeenCalled();
    expect(result.noRoom).toBe(true);
  });
});
