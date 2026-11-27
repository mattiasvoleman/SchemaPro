import { NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { BoardTrayService } from './board-tray.service';

/*
 * ATT LÄGGA (E4): en bricka per lektion en timplanspost har kvar, räknad som Generera räknar (post-demand.ts demandLeftOf), med de lektioner som redan
 * står i grundschemat som svar, de Generera lagt och ingen låst också: det är vad schemaläggaren ser på brädet. Nätet och huvudets tal är samma tal.
 *
 *   - en post på 3 lektioner à 60 min med en låst lektion på sin klass och ämne och ett lagt (fritt) har en bricka kvar;
 *   - en förläggning svarar en lektion, en lektion på parkeringen svarar ingen;
 *   - en delad post har sina brickor per lärare, och en lektion ingen undervisar kan inte läggas;
 *   - en post i ett block läggs med blocket: brickan säger det;
 *   - ingen person nämns: bara id.
 */

const YEAR = '99999999-9999-4999-8999-999999999999';
const G7A = '66666666-6666-4666-8666-666666666666';
const G7B = '77777777-7777-4777-8777-777777777777';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANNA = '44444444-4444-4444-8444-444444444444';
const BO = '55555555-5555-4555-8555-555555555555';
const POST_MATH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POST_KEM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const POST_BLOCK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BLOCK = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
type Row = Record<string, unknown>;

const post = (over: Row = {}): Row => ({
  id: POST_MATH,
  studentGroupId: G7A,
  subjectId: MATH,
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
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
  isLocked: false,
  isGenerated: false,
  extraGroups: [],
  ...over,
});

describe('BoardTrayService: Att lägga', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let posts: Row[];
  let lessons: Row[];
  let rows: Row[];

  beforeEach(() => {
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, {} as never);
    posts = [post()];
    lessons = [];
    rows = [];
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    tx['teachingRequirement']!['findMany']!.mockImplementation(async () => posts);
    tx['teachingRequirementPlacement']!['findMany']!.mockImplementation(async () => rows);
    tx['masterLesson']!['findMany']!.mockImplementation(async () => lessons);
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
  });

  it('says a lesson per lesson a post has none for, longest first, and where the post is and whose it is by id', async () => {
    posts = [post({ lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [60, 90] })];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks.map((brick) => [brick.postId, brick.minutes, brick.teacherId])).toEqual([
      [POST_MATH, 90, ANNA],
      [POST_MATH, 60, ANNA],
    ]);
    expect(tray.bricks[0]).toMatchObject({ studentGroupId: G7A, subjectId: MATH, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, blockId: null, cannotPlace: null, possibleTimes: null });
    expect(JSON.stringify(tray)).not.toMatch(/firstName|lastName|email/);
  });

  it('counts the lessons the grundschema already holds as laid, the ones Generera laid and nobody locked too, and the others as bricks', async () => {
    lessons = [lesson({ id: 'hand', isLocked: true }), lesson({ id: 'machine', isGenerated: true, startTime: time('10:00'), endTime: time('11:00') })];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks).toHaveLength(1);
    expect(tray.tally).toMatchObject({ lessons: 3, laid: 2, left: 1 });
  });

  it('does not count a lesson on the tray (it occupies nothing) and asks for exactly what stands on the grundschema, no arm of what Generera keeps', async () => {
    await service.trayOfYear(YEAR, undefined, testUser());
    const where = (tx['masterLesson']!['findMany']!.mock.calls[0]![0] as { where: Row }).where;
    // Exactly this: the mocked read below answers whatever it is asked, so only the question itself says that a lesson Generera laid and
    // nobody locked is read at all (an `OR: PRESERVED_FROM_REGENERATION` beside these keys would drop it, and no row of this spec would notice).
    expect(where).toEqual({ academicYearId: YEAR, isParked: false, fromPlacement: false });
  });

  it('lets a förläggning answer a lesson: it is placed, and no brick is left for it', async () => {
    rows = [{ id: 'r-1', requirementId: POST_MATH, dayOfWeek: 2, startTime: time('09:00'), minutes: 60, roomId: null, recurrence: 'ALL_WEEKS', teacherId: ANNA, room: null }];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks).toHaveLength(2);
    expect(tray.tally).toMatchObject({ lessons: 3, laid: 0, placedByRow: 1, left: 2 });
  });

  it('gives the bricks of a shared post per teacher, and marks a lesson nobody teaches as one that cannot be placed', async () => {
    posts = [post({ teacherId: ANNA, lessonsPerWeek: 3, minutesPerLesson: 40, shares: [{ teacherId: ANNA, lessons: 2, minutes: 40 }, { teacherId: null, lessons: 1, minutes: 40 }] })];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    const byTeacher = tray.bricks.map((brick) => [brick.teacherId, brick.cannotPlace]).sort();
    expect(byTeacher).toEqual([[null, 'NO_TEACHER'], [ANNA, null], [ANNA, null]]);
  });

  it('says a lesson of a post in a parallel block is the block\'s: it is placed with the block', async () => {
    posts = [post({ id: POST_BLOCK, subjectId: KEM, blockId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', lessonsPerWeek: 1, shares: [] })];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks).toEqual([expect.objectContaining({ blockId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', cannotPlace: 'BLOCK' })]);
  });

  it('shows the bricks of one class when asked for it and the whole year\'s tally all the same', async () => {
    posts = [post(), post({ id: POST_KEM, studentGroupId: G7B, subjectId: KEM, lessonsPerWeek: 2 })];
    const one = await service.trayOfYear(YEAR, G7B, testUser());
    expect(one.bricks.every((brick) => brick.studentGroupId === G7B)).toBe(true);
    expect(one.bricks).toHaveLength(2);
    expect(one.tally).toMatchObject({ lessons: 5, laid: 0, left: 5 });
    expect(one.groups).toEqual(expect.arrayContaining([{ studentGroupId: G7A, left: 3 }, { studentGroupId: G7B, left: 2 }]));
  });

  it('is a 404 for a year that is not the school\'s', async () => {
    tx['academicYear']!['findUnique']!.mockResolvedValue(null);
    await expect(service.trayOfYear(YEAR, undefined, testUser())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is sorted the same whatever order the database answered in, so that a brick keeps its place from one read to the next', async () => {
    posts = [post({ id: POST_KEM, subjectId: KEM, lessonsPerWeek: 1, minutesPerLesson: 60 }), post({ lessonsPerWeek: 1, minutesPerLesson: 60 })];
    const first = (await service.trayOfYear(YEAR, undefined, testUser())).bricks.map((brick) => `${brick.postId}#${brick.nth}`);
    posts = [...posts].reverse();
    const second = (await service.trayOfYear(YEAR, undefined, testUser())).bricks.map((brick) => `${brick.postId}#${brick.nth}`);
    expect(second).toEqual(first);
  });

  it('gives a brick the weeks its post runs, which the lesson inherits, and a lesson that does not run them answers none', async () => {
    posts = [post({ recurrence: 'ODD_WEEKS', startDate: new Date('2098-08-16T00:00:00.000Z'), endDate: new Date('2098-12-19T00:00:00.000Z'), lessonsPerWeek: 2 })];
    lessons = [lesson({ id: 'every-week', isLocked: true })];
    const none = await service.trayOfYear(YEAR, undefined, testUser());
    expect(none.bricks).toHaveLength(2);
    expect(none.bricks.every((brick) => brick.recurrence === 'ODD_WEEKS' && brick.startDate === '2098-08-16' && brick.endDate === '2098-12-19')).toBe(true);
    expect(none.tally).toMatchObject({ laid: 0, left: 2 });
    lessons = [lesson({ id: 'odd', isLocked: true, recurrence: 'ODD_WEEKS', startDate: new Date('2098-08-16T00:00:00.000Z'), endDate: new Date('2098-12-19T00:00:00.000Z') })];
    const one = await service.trayOfYear(YEAR, undefined, testUser());
    expect(one.bricks).toHaveLength(1);
    expect(one.tally).toMatchObject({ laid: 1, left: 1 });
  });

  it('numbers the bricks of a part from 1, the ones that are left', async () => {
    lessons = [lesson({ id: 'hand', isLocked: true })];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks.map((brick) => brick.nth)).toEqual([1, 2]);
  });

  it('lists every class that has a post, the answered ones with 0 left, in a fixed order', async () => {
    posts = [post({ id: POST_KEM, studentGroupId: G7B, subjectId: KEM, lessonsPerWeek: 1 }), post()];
    lessons = [lesson({ id: 'kem', studentGroupId: G7B, subjectId: KEM, isLocked: true })];
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.groups).toEqual([{ studentGroupId: G7A, left: 3 }, { studentGroupId: G7B, left: 0 }]);
  });

  it('lets a lesson of a parallel block that is placed answer one lesson of each member, as the week of förläggningar does', async () => {
    const member = (id: string, groupId: string) => post({ id, studentGroupId: groupId, subjectId: KEM, blockId: BLOCK, lessonsPerWeek: 3 });
    posts = [member(POST_BLOCK, G7A), member(POST_KEM, G7B)];
    tx['teachingBlock']!['findMany']!.mockResolvedValue([
      {
        id: BLOCK,
        name: 'Språkval',
        sameTimesAsBlockId: null,
        requirements: posts.map((entry) => ({ ...entry })),
        placements: [{ id: 'bp-1', dayOfWeek: 2, startTime: time('10:00'), minutes: 60, recurrence: 'ALL_WEEKS', updatedAt: new Date('2026-11-13T08:00:00.000Z'), rooms: [] }],
      },
    ]);
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks).toHaveLength(4);
    expect(tray.bricks.every((brick) => brick.blockId === BLOCK && brick.cannotPlace === 'BLOCK')).toBe(true);
    expect(tray.tally).toMatchObject({ lessons: 6, placedByRow: 2, left: 4 });
  });
});
