import { BadRequestException, ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { MasterLessonsService } from './master-lessons.service';

jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const G7A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TEACHER = '99999999-9999-4999-8999-999999999999';
const ROOM = '66666666-6666-4666-8666-666666666666';
const NEW_ROOM = '00000000-aaaa-4aaa-8aaa-000000000009';
const LESSON = '55555555-5555-4555-8555-555555555555';
const OTHER = '44444444-4444-4444-8444-444444444444';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
type Row = Record<string, any>;

const lessonRecord = (overrides: Row = {}): Row => ({
  id: LESSON,
  academicYearId: YEAR,
  subjectId: SUBJECT,
  studentGroupId: G7A,
  teacherId: TEACHER,
  coTeacherId: null,
  roomId: ROOM,
  dayOfWeek: 1,
  startTime: t('10:00'),
  endTime: t('11:00'),
  isLocked: false,
  isParked: false,
  exemptFrom: [],
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  extraGroups: [],
  participants: [],
  ...overrides,
});


/*
 * E4: EN LEKTION SOM FLYTTAS FÖR HAND LÅSES, SYNLIGT (beslut 2), och att låsa eller låsa upp flyttar ingenting och frågar därför inte klashregeln.
 *
 *   - ett PATCH som flyttar en olåst lektion (en annan dag, ett annat klockslag, andra veckor, eller tillbaka från parkeringen) låser den och säger det
 *     (`lockedByMove`): annars lägger nästa Generera om det den just flyttat;
 *   - ett lås som begäran själv satte, en lektion som redan är låst och ett uttryckligt "lås upp" i samma flytt är inte det: bara det servern gjorde sägs;
 *   - en ny sal eller lärare flyttar ingenting av var lektionen står och låser inte;
 *   - att låsa eller låsa upp en lektion som redan är dubbelbokad nekas inte (granskaren g461, L-5): inget flyttas, ingenting nytt krockar. En ny sal på den frågas som förut;
 *   - ett undantag ges inte åt en lektion på parkeringen (granskaren g467, L-3).
 */
describe('MasterLessonsService: ett lås vid flytt', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let stored: Row;
  let dayLessons: Row[];

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new MasterLessonsService(
      prisma as unknown as PrismaService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn().mockResolvedValue([]), notifyUsers: jest.fn().mockResolvedValue(0) } as unknown as NotificationsService,
    );
    dayLessons = [];
    stored = { ...lessonRecord(), fromPlacement: false, school: { id: SCHOOL, timezone: 'Europe/Stockholm', _count: { academicYears: 1 } } };
    (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
    tx['masterLesson']!['findUnique']!.mockImplementation(async () => stored);
    tx['masterLesson']!['update']!.mockImplementation(async (args: { data: Row }) => lessonRecord({ ...stored, ...args.data, exemptFrom: args.data['exemptFrom'] ?? stored['exemptFrom'] }));
    tx['masterLesson']!['findMany']!.mockImplementation(async (query: { where?: Row }) => {
      const where = query.where ?? {};
      const rows = [stored, ...dayLessons];
      if (where['id']?.in) return rows.filter((row) => where['id'].in.includes(row['id']));
      return rows.filter((row) => row['dayOfWeek'] === where['dayOfWeek'] && row['isParked'] !== true && row['id'] !== where['id']?.not);
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'NIOARIG', id: YEAR, schoolId: SCHOOL, isActive: true, predecessorId: null, _count: { teacherEmployments: 0 } });
    tx['studentGroup']!['findMany']!.mockImplementation(async (query: { where: Row }) => (query.where['OR']?.[0]?.id?.in ?? query.where['id']?.in ?? []).map((id: string) => ({ id, name: id === G7A ? '7A' : '8B', gradeLevel: id === G7A ? 7 : 8, halfOfId: null })));
    tx['subject']!['findMany']!.mockResolvedValue([]);
    tx['frameTime']!['findMany']!.mockResolvedValue([]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
  });

  const writtenData = (): Row => (tx['masterLesson']!['update']!.mock.calls.at(-1)![0] as { data: Row }).data;
  const standing = (over: Row = {}) => {
    stored = { ...stored, ...lessonRecord(over) };
  };
  /** The same teacher's other lesson on the same Monday at 10:30, which any lesson at 10:00-11:00 clashes with. */
  const doubleBooked = () => {
    dayLessons = [{ ...lessonRecord({ id: OTHER, studentGroupId: '00000000-aaaa-4aaa-8aaa-000000000003', roomId: null, startTime: t('10:30'), endTime: t('11:30') }), subject: { name: 'Kemi' }, studentGroup: { name: '8B' } }];
  };

  it('locks an unlocked lesson that is moved by hand, and says so', async () => {
    const saved = await service.update(LESSON, { startTime: '13:00', endTime: '14:00' }, testUser());
    expect(writtenData()['isLocked']).toBe(true);
    expect(saved).toMatchObject({ isLocked: true, lockedByMove: true });
  });

  it('locks one that is moved to another day, to other weeks, or put back from the tray, and the dialog restating isLocked: false changes nothing of it', async () => {
    for (const patch of [{ dayOfWeek: 2 }, { recurrence: 'ODD_WEEKS' as const }, { startDate: '2027-01-11' }]) {
      const saved = await service.update(LESSON, { ...patch, isLocked: false }, testUser());
      expect(saved).toMatchObject({ isLocked: true, lockedByMove: true });
      expect(writtenData()['isLocked']).toBe(true);
    }
    standing({ isParked: true });
    const back = await service.update(LESSON, { isParked: false }, testUser());
    expect(back).toMatchObject({ isLocked: true, lockedByMove: true });
  });

  it('does not say it for a lock the request set itself, a lesson that was locked, or an explicit unlock in the same move', async () => {
    const own = await service.update(LESSON, { startTime: '13:00', endTime: '14:00', isLocked: true }, testUser());
    expect(own).toMatchObject({ isLocked: true });
    expect(own).not.toHaveProperty('lockedByMove');

    standing({ isLocked: true });
    const already = await service.update(LESSON, { startTime: '13:00', endTime: '14:00' }, testUser());
    expect(already).not.toHaveProperty('lockedByMove');

    const unlocked = await service.update(LESSON, { startTime: '14:00', endTime: '15:00', isLocked: false }, testUser());
    expect(writtenData()['isLocked']).toBe(false);
    expect(unlocked).toMatchObject({ isLocked: false });
    expect(unlocked).not.toHaveProperty('lockedByMove');
  });

  it('leaves a lesson unlocked that is only given another room, or set aside: nothing about where it stands moved', async () => {
    const room = await service.update(LESSON, { roomId: NEW_ROOM }, testUser());
    expect(room).toMatchObject({ isLocked: false });
    expect(room).not.toHaveProperty('lockedByMove');
    expect('isLocked' in writtenData()).toBe(false);

    const parked = await service.update(LESSON, { isParked: true }, testUser());
    expect(parked).not.toHaveProperty('lockedByMove');
    expect(writtenData()['isLocked']).not.toBe(true);
  });

  it('lets a lock or an unlock through on a lesson that is double-booked: it moves nothing and clashes with nothing it did not clash with', async () => {
    doubleBooked();
    const locked = await service.update(LESSON, { isLocked: true }, testUser());
    expect(locked).toMatchObject({ isLocked: true });
    standing({ isLocked: true });
    const unlocked = await service.update(LESSON, { isLocked: false }, testUser());
    expect(unlocked).toMatchObject({ isLocked: false });
    // Restated whole, as the dialog does on every save, with the lock changed.
    const dialog = await service.update(LESSON, { dayOfWeek: 1, startTime: '10:00', endTime: '11:00', roomId: ROOM, teacherId: TEACHER, isLocked: true }, testUser());
    expect(dialog).toMatchObject({ isLocked: true });
  });

  // Every field the judge reads, changed on its own: dropping any one of them from `changesNothingJudged` lets that edit through unasked onto a lesson
  // that already clashes (g486: the start, the end, the weeks, a date and the pupils were each unasked by a mutant no test killed).
  it.each([
    ['the start', { startTime: '10:15' }],
    ['the end', { endTime: '11:15' }],
    ['the weeks', { recurrence: 'ODD_WEEKS' as const }],
    ['the first date', { startDate: '2027-01-11' }],
    ['the last date', { endDate: '2027-03-01' }],
    ['the pupils', { studentIds: ['77777777-7777-4777-8777-777777777777'] }],
    ['the teacher', { teacherId: '88888888-8888-4888-8888-888888888888' }],
    ['the co-teacher', { coTeacherId: '88888888-8888-4888-8888-888888888888' }],
  ])('still asks the clash rule of %s changed on its own, on a lesson that is double-booked', async (_label, patch) => {
    doubleBooked();
    // The other lesson has both teachers, so a changed teacher or co-teacher still stands on a clash.
    dayLessons = [{ ...dayLessons[0]!, coTeacherId: TEACHER, teacherId: '88888888-8888-4888-8888-888888888888' }, ...dayLessons.slice(1)];
    await expect(service.update(LESSON, patch, testUser())).rejects.toBeInstanceOf(ConflictException);
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  // The question says what the PATCH says (g467, L-3): a lesson that stays on the tray is given no exemption, so the answer yes to a rule its remembered
  // time breaks is not carried to the judge, whatever the time. Put back, the same lesson is asked as any lesson is, and the answer yes is its own.
  it('answers no exemption for a lesson that stays on the tray, and the exemption the time asks for once it is put back', async () => {
    tx['frameTime']!['findMany']!.mockResolvedValue([{ minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: t('08:00'), endTime: t('15:00') }]);
    standing({ isParked: true, startTime: t('14:30'), endTime: t('15:30') });
    const onTray = await service.judgeMoves({ moves: [{ lessonId: LESSON, exempt: ['FRAME'] }] }, testUser());
    expect(onTray.moves[0]).toMatchObject({ ok: true, exempted: [] });
    const putBack = await service.judgeMoves({ moves: [{ lessonId: LESSON, isParked: false, exempt: ['FRAME'] }] }, testUser());
    expect(putBack.moves[0]).toMatchObject({ ok: true, exempted: ['FRAME'] });
  });

  it('still asks the clash rule of anything that moves or changes who or what is in the way: a new room, a move', async () => {
    doubleBooked();
    for (const patch of [{ roomId: NEW_ROOM }, { startTime: '10:15', endTime: '11:15' }]) {
      await expect(service.update(LESSON, patch, testUser())).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('refuses an exemption for a lesson that stays on the tray: it occupies nothing there (granskaren g467, L-3)', async () => {
    standing({ isParked: true });
    await expect(service.update(LESSON, { exempt: ['FRAME'] }, testUser())).rejects.toThrow(/tray/);
    await expect(service.update(LESSON, { isParked: true, exempt: ['FRAME'] }, testUser())).rejects.toThrow(/tray/);
    // Taken back on the tray is no exemption and stays allowed.
    await expect(service.update(LESSON, { exempt: [] }, testUser())).resolves.toBeDefined();
  });

  // Gör om of a parking (g486): the page's redo sends the snapshot of the lesson as it stood, `exempt` included, with `isParked: true`. Parking is not
  // judged and ends the exemption, so the request is let through and saves none, as it did before the refusal above was written.
  it('lets the request that parks a lesson carry the exemption it has, and saves none', async () => {
    standing({ isLocked: true, exemptFrom: ['FRAME'] });
    const saved = await service.update(LESSON, { isParked: true, isLocked: true, exempt: ['FRAME'] }, testUser());
    expect(writtenData()).toMatchObject({ isParked: true, exemptFrom: [] });
    expect(saved).toMatchObject({ isParked: true });
    expect(saved).not.toHaveProperty('lockedByMove');
  });
});
