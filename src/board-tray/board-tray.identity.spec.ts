import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { BoardTrayService } from './board-tray.service';

/*
 * BRICKANS IDENTITET OCH VAD SOM SVARAR EN LEKTION (E4, granskaren g473 L-2, L-3 och L-4; samordnarens beslut om parkerade lektioner).
 *
 *   - varje del av en post (lärare och längd) har en nyckel som säger bilden den lästes i: lägger någon en bricka, eller ändras en lektion i delen,
 *     blir nyckeln en annan, så att en läggning som bär nyckeln nekas om den kommer sist;
 *   - en parkerad lektion är en bricka, nämligen sig själv: den får lektionens id, och inget extra bricka görs för den;
 *   - en lektion Generera skrivit från en förläggning som inte längre har någon rad svarar en lektion; en som har sin rad räknas av raden och inte två gånger.
 */

const YEAR = '99999999-9999-4999-8999-999999999999';
const G7A = '66666666-6666-4666-8666-666666666666';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANNA = '44444444-4444-4444-8444-444444444444';
const POST_MATH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POST_KEM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
  isParked: false,
  fromPlacement: false,
  extraGroups: [],
  ...over,
});

describe('BoardTrayService: brickans identitet, parkerade lektioner och förlagda lektioner utan rad', () => {
  let service: BoardTrayService;
  let tx: TxMock;
  let posts: Row[];
  let standing: Row[];
  /** The lessons the second read asks for: those on the tray and those Generera wrote from a förläggning. */
  let aside: Row[];
  let rows: Row[];

  beforeEach(() => {
    tx = createTxMock();
    service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, {} as never);
    posts = [post()];
    standing = [];
    aside = [];
    rows = [];
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    tx['teachingRequirement']!['findMany']!.mockImplementation(async () => posts);
    tx['teachingRequirementPlacement']!['findMany']!.mockImplementation(async () => rows);
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where: { OR?: unknown } }) => (query.where.OR ? aside : standing));
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
  });

  const tray = () => service.trayOfYear(YEAR, undefined, testUser());

  describe('a part has a key that says the picture it was read in', () => {
    it('is the same for the bricks of a part and for two reads of the same year, and another for another part of the post', async () => {
      posts = [post({ lessonsPerWeek: 3, lessonLengths: [60, 60, 90] })];
      const first = await tray();
      const keys = [...new Set(first.bricks.map((brick) => brick.partKey))];
      expect(keys).toHaveLength(2);
      for (const brick of first.bricks) expect(brick.partKey).toMatch(/^[0-9a-f]{16}$/);
      const second = await tray();
      expect(second.bricks.map((brick) => brick.partKey)).toEqual(first.bricks.map((brick) => brick.partKey));
      // The two lengths of one post, each its own part: the same `nth` in both does not make one brick of them.
      const byPart = new Map<string, number[]>();
      for (const brick of first.bricks) byPart.set(brick.partKey, [...(byPart.get(brick.partKey) ?? []), brick.nth]);
      expect([...byPart.values()].map((nths) => nths.join(',')).sort()).toEqual(['1', '1,2']);
    });

    it('changes when a lesson of the part is laid, so that a second administrator who read the same picture is the one that is refused', async () => {
      const before = (await tray()).bricks[0]!.partKey;
      standing = [lesson({ id: 'hand', isLocked: true })];
      const after = await tray();
      expect(after.bricks).toHaveLength(2);
      expect(after.bricks[0]!.partKey).not.toBe(before);
    });

    it('is another for another post, whatever the lesson of it, and does not name a person', async () => {
      posts = [post(), post({ id: POST_KEM, subjectId: KEM })];
      const keys = (await tray()).bricks.map((brick) => brick.partKey);
      expect(new Set(keys).size).toBe(2);
    });
  });

  describe('a lesson on the tray is a brick, namely itself', () => {
    it('gives the brick the lesson\'s id and makes no new brick for it: the post has three lessons to lay, one of them is the parked one', async () => {
      aside = [lesson({ id: 'parked-1', isParked: true, startTime: time('13:00'), endTime: time('14:00') })];
      const response = await tray();
      expect(response.bricks).toHaveLength(3);
      expect(response.bricks.map((brick) => brick.lessonId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([null, null, 'parked-1']);
      // The count is Generera's, as before: a lesson on the tray answers none.
      expect(response.tally).toMatchObject({ lessons: 3, laid: 0, left: 3 });
    });

    it('takes a parked lesson only for a lesson of its own kind: the same class, subject, teacher and length', async () => {
      aside = [
        lesson({ id: 'other-subject', isParked: true, subjectId: KEM }),
        lesson({ id: 'other-length', isParked: true, endTime: time('09:30') }),
        lesson({ id: 'other-teacher', isParked: true, teacherId: '77777777-7777-4777-8777-777777777777' }),
      ];
      const response = await tray();
      expect(response.bricks.every((brick) => brick.lessonId === null)).toBe(true);
    });

    it('makes no more bricks of a part than it has lessons left: two parked lessons of a part with one left are one brick, the other stays parked', async () => {
      standing = [lesson({ id: 'a', isLocked: true }), lesson({ id: 'b', isLocked: true, startTime: time('10:00'), endTime: time('11:00') })];
      aside = [lesson({ id: 'p1', isParked: true }), lesson({ id: 'p2', isParked: true, startTime: time('11:00'), endTime: time('12:00') })];
      const response = await tray();
      expect(response.bricks).toHaveLength(1);
      expect(response.bricks[0]!.lessonId).toBe('p1');
    });

    it('changes the part\'s key when the parked lesson changes: laying the lesson back is not laying a new one', async () => {
      const without = (await tray()).bricks[0]!.partKey;
      aside = [lesson({ id: 'parked-1', isParked: true })];
      const withParked = (await tray()).bricks.find((brick) => brick.lessonId === 'parked-1')!.partKey;
      expect(withParked).not.toBe(without);
    });
  });

  describe('a lesson Generera wrote from a förläggning that has no row any more answers a lesson', () => {
    const written = (over: Row = {}) => lesson({ id: 'written', fromPlacement: true, isLocked: true, ...over });
    const row = (over: Row = {}) => ({ id: 'r-1', requirementId: POST_MATH, dayOfWeek: 1, startTime: time('08:00'), minutes: 60, roomId: null, recurrence: 'ALL_WEEKS', teacherId: ANNA, room: null, ...over });

    it('is laid once the row is gone: three lessons asked, one stands, two bricks', async () => {
      aside = [written()];
      const response = await tray();
      expect(response.bricks).toHaveLength(2);
      expect(response.tally).toMatchObject({ lessons: 3, laid: 1, placedByRow: 0, left: 2 });
    });

    it('is the row\'s while the row stands: it is counted once, by the row', async () => {
      aside = [written()];
      rows = [row()];
      const response = await tray();
      expect(response.bricks).toHaveLength(2);
      expect(response.tally).toMatchObject({ lessons: 3, laid: 0, placedByRow: 1, left: 2 });
    });

    it('is told from a row that stands elsewhere: a lesson at another time than the row is the one without a row', async () => {
      aside = [written({ startTime: time('10:00'), endTime: time('11:00') })];
      rows = [row()];
      const response = await tray();
      expect(response.tally).toMatchObject({ laid: 1, placedByRow: 1, left: 1 });
    });
  });
});
