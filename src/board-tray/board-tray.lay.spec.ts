import { ConflictException, NotFoundException } from '@nestjs/common';
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
 * LÄGG EN BRICKA (E4): en bricka blir en låst lektion, och inget läggs två gånger.
 *
 *   - läggningen bär delens nyckel (partKey) och görs i en transaktion som läser om delen under postens lås: den som kommer sist, med en nyckel
 *     som inte längre är delens, får 409 (REQUIREMENT_PLACEMENTS_STALE, som veckans skrivning) och inget skrivs;
 *   - en bricka som är en parkerad lektion (`lessonId`) läggs genom att lektionen flyttas tillbaka, och ingen ny lektion görs;
 *   - lektionen är handgjord och låst (Generera behåller den), med postens klass, ämne, lärare, medlärare och veckor, och med den sal läggaren
 *     angett eller ingen: ingen sal är "Utan sal" och säger det;
 *   - låsordningen är årets (som varje skrivväg), sedan postens: en annan ordning kan blockera mot en Generera som väntar.
 */

jest.mock('../publication/publish-mode', () => ({ ...jest.requireActual('../publication/publish-mode'), enterGrundschemaWrite: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ ...jest.requireActual('../optimization/regeneration-lock'), lockYearForGrundschemaEdit: jest.fn() }));
jest.mock('../resources/requirement-shares', () => ({ ...jest.requireActual('../resources/requirement-shares'), lockPostForShares: jest.fn() }));

const YEAR = '99999999-9999-4999-8999-999999999999';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const G7A = '66666666-6666-4666-8666-666666666666';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = '44444444-4444-4444-8444-444444444444';
const CIA = '55555555-5555-4555-8555-555555555555';
const ROOM = '11111111-1111-4111-8111-111111111111';
const POST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
type Row = Record<string, unknown>;

const post = (over: Row = {}): Row => ({
  id: POST,
  academicYearId: YEAR,
  studentGroupId: G7A,
  subjectId: MATH,
  teacherId: ANNA,
  coTeacherId: CIA,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ODD_WEEKS',
  blockId: null,
  startDate: new Date('2026-08-17T00:00:00.000Z'),
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
  recurrence: 'ODD_WEEKS',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: null,
  isLocked: true,
  isGenerated: false,
  isParked: false,
  fromPlacement: false,
  extraGroups: [],
  ...over,
});

describe('BoardTrayService: lägg en bricka', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let masters: { createIn: jest.Mock; updateIn: jest.Mock };
  let posts: Row[];
  let standing: Row[];
  let aside: Row[];
  const order: string[] = [];

  const request = (over: Partial<LayBrickDto> = {}): LayBrickDto =>
    ({ academicYearId: YEAR, postId: POST, teacherId: ANNA, minutes: 60, partKey: 'unset', dayOfWeek: 2, startTime: '10:00', roomId: ROOM, ...over }) as LayBrickDto;
  const tray = (): ReturnType<BoardTrayService['trayOfYear']> => service.trayOfYear(YEAR, undefined, testUser());
  /** The key the tray gives the part now: what a page that has just read it sends. */
  const keyNow = async (): Promise<string> => (await tray()).bricks.find((brick) => brick.postId === POST && brick.minutes === 60)!.partKey;

  beforeEach(() => {
    order.length = 0;
    tx = createTxMock();
    masters = {
      createIn: jest.fn(async () => {
        order.push('create');
        // What laying does to the year: a lesson of the part now stands, and the part's picture is another.
        standing = [...standing, lesson({ id: 'laid', dayOfWeek: 2, startTime: time('10:00'), endTime: time('11:00') })];
        return { id: 'laid', isLocked: true, warnings: [] };
      }),
      updateIn: jest.fn(async () => {
        order.push('update');
        aside = [];
        standing = [...standing, lesson({ id: 'parked-1', dayOfWeek: 2, startTime: time('10:00'), endTime: time('11:00') })];
        return { id: 'parked-1', isLocked: true, warnings: [] };
      }),
    };
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, masters as unknown as MasterLessonsService);
    posts = [post()];
    standing = [];
    aside = [];
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL });
    tx['teachingRequirement']!['findMany']!.mockImplementation(async () => posts);
    tx['teachingRequirement']!['findUnique']!.mockImplementation(async () => posts[0] ?? null);
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where: { OR?: unknown } }) => (query.where.OR ? aside : standing));
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
    (enterGrundschemaWrite as jest.Mock).mockReset().mockImplementation(async () => {
      order.push('mode');
      return 'DIRECT';
    });
    (lockYearForGrundschemaEdit as jest.Mock).mockReset().mockImplementation(async () => void order.push('year'));
    (lockPostForShares as jest.Mock).mockReset().mockImplementation(async () => void order.push('post'));
  });

  it('lays a brick as a locked lesson of the post: its class, subject, teacher, medlärare and weeks, the minute it was asked for and the room it was given', async () => {
    const result = await service.lay(request({ partKey: await keyNow() }), testUser());
    expect(masters.createIn).toHaveBeenCalledTimes(1);
    expect(masters.createIn.mock.calls[0]![1]).toEqual({
      academicYearId: YEAR,
      subjectId: MATH,
      studentGroupId: G7A,
      teacherId: ANNA,
      coTeacherId: CIA,
      roomId: ROOM,
      dayOfWeek: 2,
      startTime: '10:00',
      endTime: '11:00',
      isLocked: true,
      recurrence: 'ODD_WEEKS',
      startDate: '2026-08-17',
      endDate: null,
    });
    expect(result).toMatchObject({ lesson: { id: 'laid', isLocked: true }, noRoom: false });
  });

  it('says "Utan sal" when no room was given: the lesson is laid all the same, and the answer says it', async () => {
    const result = await service.lay(request({ roomId: null, partKey: await keyNow() }), testUser());
    expect(masters.createIn.mock.calls[0]![1]).toMatchObject({ roomId: null });
    expect(result.noRoom).toBe(true);
    const absent = await service.lay({ ...request({ partKey: await keyNow() }), roomId: undefined }, testUser());
    expect(absent.noRoom).toBe(true);
  });

  it('refuses the one that comes last: a second lay of the same picture is 409 and nothing is written (b: inget läggs två gånger)', async () => {
    const key = await keyNow();
    await service.lay(request({ partKey: key }), testUser());
    await expect(service.lay(request({ partKey: key, dayOfWeek: 3 }), testUser())).rejects.toMatchObject({
      response: { code: REQUIREMENT_PLACEMENTS_STALE, params: { requirementId: POST } },
    });
    expect(masters.createIn).toHaveBeenCalledTimes(1);
  });

  it('lays the part it was asked for when the post has several: the teacher and the minutes pick the brick, and the key is that part\'s own', async () => {
    // A post that shares its lessons between two teachers, one of them in lessons of 90 minutes: three parts, and the first of the tray's order
    // is not the one asked for.
    posts = [
      post({
        lessonsPerWeek: 3,
        coTeacherId: null,
        lessonLengths: [60, 60, 90],
        shares: [
          { teacherId: ANNA, lessons: 2, minutes: 60 },
          { teacherId: CIA, lessons: 1, minutes: 90 },
        ],
      }),
    ];
    const bricks = (await tray()).bricks.filter((brick) => brick.postId === POST);
    const ciasBrick = bricks.find((brick) => brick.teacherId === CIA)!;
    const annasBrick = bricks.find((brick) => brick.teacherId === ANNA)!;
    expect([ciasBrick.minutes, annasBrick.minutes]).toEqual([90, 60]);
    expect(bricks[0]!.teacherId).toBe(CIA);
    await service.lay(request({ teacherId: ANNA, minutes: 60, partKey: annasBrick.partKey }), testUser());
    expect(masters.createIn.mock.calls[0]![1]).toMatchObject({ teacherId: ANNA, startTime: '10:00', endTime: '11:00' });
    // The right key under another teacher's or another length's name is the picture of another part: refused.
    await expect(service.lay(request({ teacherId: CIA, minutes: 90, partKey: annasBrick.partKey }), testUser())).rejects.toMatchObject({ response: { code: REQUIREMENT_PLACEMENTS_STALE } });
    await expect(service.lay(request({ teacherId: ANNA, minutes: 90, partKey: ciasBrick.partKey }), testUser())).rejects.toMatchObject({ response: { code: REQUIREMENT_PLACEMENTS_STALE } });
    expect(masters.createIn).toHaveBeenCalledTimes(1);
  });

  it('lays the length it was asked for when one teacher has lessons of two lengths: the minutes pick the brick, and the end follows them', async () => {
    posts = [post({ lessonsPerWeek: 2, coTeacherId: null, lessonLengths: [60, 90] })];
    const bricks = (await tray()).bricks.filter((brick) => brick.postId === POST);
    expect(bricks.map((brick) => brick.minutes)).toEqual([90, 60]);
    const short = bricks.find((brick) => brick.minutes === 60)!;
    await service.lay(request({ teacherId: ANNA, minutes: 60, partKey: short.partKey }), testUser());
    expect(masters.createIn.mock.calls[0]![1]).toMatchObject({ startTime: '10:00', endTime: '11:00' });
    await expect(service.lay(request({ teacherId: ANNA, minutes: 90, partKey: short.partKey }), testUser())).rejects.toMatchObject({ response: { code: REQUIREMENT_PLACEMENTS_STALE } });
    expect(masters.createIn).toHaveBeenCalledTimes(1);
  });

  it('refuses a key that was never the part\'s, and a part with nothing left to lay', async () => {
    await expect(service.lay(request({ partKey: '0000000000000000' }), testUser())).rejects.toBeInstanceOf(ConflictException);
    standing = [lesson({ id: 'a' }), lesson({ id: 'b', startTime: time('09:00'), endTime: time('10:00') }), lesson({ id: 'c', startTime: time('10:00'), endTime: time('11:00') })];
    await expect(service.lay(request({ partKey: 'ffffffffffffffff' }), testUser())).rejects.toMatchObject({ response: { code: REQUIREMENT_PLACEMENTS_STALE } });
    expect(masters.createIn).not.toHaveBeenCalled();
  });

  it('lays a lesson on the tray by moving it back, and makes no new lesson: the brick was the lesson itself', async () => {
    aside = [lesson({ id: 'parked-1', isParked: true, startTime: time('13:00'), endTime: time('14:00') })];
    const brick = (await tray()).bricks.find((entry) => entry.lessonId === 'parked-1')!;
    const result = await service.lay(request({ partKey: brick.partKey, lessonId: 'parked-1', roomId: ROOM }), testUser());
    expect(masters.createIn).not.toHaveBeenCalled();
    expect(masters.updateIn).toHaveBeenCalledTimes(1);
    expect(masters.updateIn.mock.calls[0]![1]).toBe('parked-1');
    expect(masters.updateIn.mock.calls[0]![2]).toEqual({ isParked: false, dayOfWeek: 2, startTime: '10:00', endTime: '11:00', roomId: ROOM, isLocked: true });
    expect(result).toMatchObject({ lesson: { id: 'parked-1' }, noRoom: false });
  });

  it('refuses a lesson that is not one of the part\'s parked ones: another post\'s lesson is no brick of this part', async () => {
    aside = [lesson({ id: 'parked-1', isParked: true })];
    const key = (await tray()).bricks.find((entry) => entry.lessonId === 'parked-1')!.partKey;
    await expect(service.lay(request({ partKey: key, lessonId: 'somebody-elses' }), testUser())).rejects.toMatchObject({ response: { code: REQUIREMENT_PLACEMENTS_STALE } });
    expect(masters.updateIn).not.toHaveBeenCalled();
  });

  it('refuses a brick that is laid with its block or that nobody teaches, with a code of its own and the reason: the brick cannot be laid on its own', async () => {
    posts = [post({ blockId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', shares: [] })];
    const key = (await tray()).bricks[0]!.partKey;
    await expect(service.lay(request({ partKey: key }), testUser())).rejects.toMatchObject({ response: { code: 'BOARD_BRICK_CANNOT_BE_LAID', params: { requirementId: POST, reason: 'BLOCK' } } });
    expect(masters.createIn).not.toHaveBeenCalled();
  });

  it('is a 404 for a year that is not the school\'s and a post that is not that year\'s', async () => {
    tx['academicYear']!['findUnique']!.mockResolvedValue(null);
    await expect(service.lay(request(), testUser())).rejects.toBeInstanceOf(NotFoundException);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, schoolId: SCHOOL });
    posts = [post({ academicYearId: '00000000-0000-4000-8000-000000000000' })];
    await expect(service.lay(request(), testUser())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('takes the locks in the order every writer of the grundschema does: the mode and the year, then the post, then the write', async () => {
    await service.lay(request({ partKey: await keyNow() }), testUser());
    expect(order).toEqual(['mode', 'year', 'post', 'create']);
  });
});
