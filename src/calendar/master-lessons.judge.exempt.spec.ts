import { BadRequestException, ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import type { RealtimeService } from '../realtime/realtime.service';
import { MasterLessonsService } from './master-lessons.service';

/*
 * E1b, UNDANTAG MED FLIT: the hand edit's judge lets an administrator break the stage's ramtid or the class's meal on one lesson, by naming the
 * rule in the request (`exempt`), and nothing else.
 *
 *   - the judge answers EVERY board rule a time breaks, not the first (an exemption for the ramtid must not hide the lunch);
 *   - an exemption lets through the rule it names and no other: a clash, a closed årskurs and another school's time stay refused;
 *   - it is saved on the lesson with the rule's name, and the lesson is locked in the same breath;
 *   - it is for the time it was given for: another time that breaks the rule asks again, a time that holds ends it, and a lock taken off ends it;
 *   - a lesson that only stands against the rule (låt stå) can be made an exemption with a request that names it, and nothing else of it is asked.
 */

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

describe('MasterLessonsService: ett undantag med flit', () => {
  let service: MasterLessonsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let stored: Row;
  let dayLessons: Row[];

  /** The stage's day is 08:00-15:00, and the class eats 12:00-12:30 every day. */
  const board = () => {
    tx['frameTime']!['findMany']!.mockResolvedValue([{ minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: t('08:00'), endTime: t('15:00') }]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null }]);
  };

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
    board();
  });

  const writtenData = (): Row => (tx['masterLesson']!['update']!.mock.calls.at(-1)![0] as { data: Row }).data;
  const refusal = async (attempt: Promise<unknown>) => {
    try {
      await attempt;
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).getResponse() as { message: string; code: string; params: Record<string, string | number> };
    }
    throw new Error('the edit was not refused');
  };

  it('answers every board rule a time breaks, the ramtid first and the lunch beside it, not the first alone', async () => {
    // 14:30-15:30 breaks the ramtid only; 12:00-13:00 the lunch only; the class's meal 12:00-12:30 on a lesson that ends past 15:00 cannot both, so a
    // second meal makes both: the meal 14:45-15:15 is under the lesson 14:30-15:30, which also ends outside the day.
    tx['lunchSitting']!['findMany']!.mockResolvedValue([{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('14:45'), endTime: t('15:15'), startDate: null, endDate: null }]);
    const body = await refusal(service.update(LESSON, { startTime: '14:30', endTime: '15:30' }, testUser()));
    expect(body.params).toMatchObject({ reason: 'FRAME', reasons: 'FRAME,LUNCH' });
    expect(body.message).toContain('ramtid');
    expect(body.message).toContain('lunch');
  });

  it('lets the rule an exemption names through, saves its name on the lesson and locks the lesson in the same breath', async () => {
    const saved = await service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, testUser());
    expect(writtenData()).toMatchObject({ exemptFrom: ['FRAME'], isLocked: true });
    expect(saved).toMatchObject({ isLocked: true, exemptFrom: ['FRAME'] });
  });

  it('does not let an exemption for the ramtid hide the lunch: the other rule still refuses, and says it can be exempted', async () => {
    tx['lunchSitting']!['findMany']!.mockResolvedValue([{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('14:45'), endTime: t('15:15'), startDate: null, endDate: null }]);
    const body = await refusal(service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, testUser()));
    expect(body.params).toMatchObject({ reason: 'LUNCH', reasons: 'LUNCH' });
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
    // Both named: it is let through, and both are saved.
    await service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME', 'LUNCH'] }, testUser());
    expect(writtenData()).toMatchObject({ exemptFrom: ['FRAME', 'LUNCH'], isLocked: true });
  });

  it('never lets an exemption through for anything else: a clash, a rule on årskurser, another school’s time', async () => {
    // A clash with the teacher's other lesson at 14:30.
    dayLessons = [{ ...lessonRecord({ id: OTHER, teacherId: TEACHER, roomId: null, studentGroupId: '00000000-aaaa-4aaa-8aaa-000000000003', startTime: t('14:30'), endTime: t('15:30') }), subject: { name: 'Kemi' }, studentGroup: { name: '8B' } }];
    const clash = await refusal(service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME', 'LUNCH'] }, testUser()));
    expect(clash.params).toMatchObject({ reason: 'TEACHER' });
    dayLessons = [];
    // Another school's hold on the teacher.
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({
      holds: [{ holdId: 'h', kind: 'TEACHER_BUSY', resourceKind: 'TEACHER', resourceId: TEACHER, dayOfWeek: 1, startTime: '14:00:00', endTime: '16:00:00', schools: ['Norra skolan'] }],
    });
    const held = await refusal(service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, testUser()));
    expect(held.params).toMatchObject({ reason: 'OTHER_SCHOOL' });
    (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [] });
    // A rule on whole årskurser.
    tx['availabilityConstraint']!['findMany']!.mockImplementation(async (query: { where: Row }) =>
      query.where['resourceType'] === 'GRADE_LEVEL'
        ? [{ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: 1, date: null, startTime: t('14:00'), endTime: t('16:00') }]
        : [],
    );
    const closed = await refusal(service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, testUser()));
    expect(closed.params).toMatchObject({ reason: 'GRADE_RULE' });
  });

  it('saves nothing for a rule the time does not break, and refuses a name that cannot be exempted before the service', async () => {
    const saved = await service.update(LESSON, { startTime: '09:00', endTime: '10:00', exempt: ['FRAME', 'LUNCH'] }, testUser());
    expect(writtenData()['exemptFrom']).toEqual([]);
    // The lock is the move's (E4, beslut 2: a lesson moved by hand is locked, in sight), not an exemption's: nothing was granted.
    expect(saved).toMatchObject({ lockedByMove: true });
  });

  it('is for the time it was given for: the lesson moved to a time that holds loses it, and the answer says so', async () => {
    stored = { ...stored, ...lessonRecord({ startTime: t('14:30'), endTime: t('15:30'), isLocked: true, exemptFrom: ['FRAME'] }), fromPlacement: false, school: stored['school'] };
    const saved = await service.update(LESSON, { startTime: '09:00', endTime: '10:00' }, testUser());
    expect(writtenData()['exemptFrom']).toEqual([]);
    expect(saved.warnings).toEqual(expect.arrayContaining([{ code: 'EXEMPTION_ENDED', params: { rules: 'FRAME' } }]));
  });

  it('asks again for another time that breaks the rule, and keeps it when the question is answered yes again', async () => {
    stored = { ...stored, ...lessonRecord({ startTime: t('14:30'), endTime: t('15:30'), isLocked: true, exemptFrom: ['FRAME'] }), fromPlacement: false, school: stored['school'] };
    const body = await refusal(service.update(LESSON, { startTime: '14:40', endTime: '15:40' }, testUser()));
    expect(body.params).toMatchObject({ reason: 'FRAME' });
    await service.update(LESSON, { startTime: '14:40', endTime: '15:40', exempt: ['FRAME'] }, testUser());
    expect(writtenData()['exemptFrom']).toEqual(['FRAME']);
  });

  it('keeps the exemption when what is changed is not where the lesson stands (a room), and asks nothing of the board for it', async () => {
    stored = { ...stored, ...lessonRecord({ startTime: t('14:30'), endTime: t('15:30'), isLocked: true, exemptFrom: ['FRAME'] }), fromPlacement: false, school: stored['school'] };
    tx['frameTime']!['findMany']!.mockClear();
    await service.update(LESSON, { roomId: NEW_ROOM }, testUser());
    expect('exemptFrom' in writtenData() ? writtenData()['exemptFrom'] : ['FRAME']).toEqual(['FRAME']);
    expect(tx['frameTime']!['findMany']).not.toHaveBeenCalled();
  });

  it('ends when the lock is taken off, and an empty `exempt` takes it back', async () => {
    stored = { ...stored, ...lessonRecord({ startTime: t('14:30'), endTime: t('15:30'), isLocked: true, exemptFrom: ['FRAME'] }), fromPlacement: false, school: stored['school'] };
    await service.update(LESSON, { isLocked: false }, testUser());
    expect(writtenData()['exemptFrom']).toEqual([]);
    await service.update(LESSON, { exempt: [] }, testUser());
    expect(writtenData()['exemptFrom']).toEqual([]);
  });

  it('makes a lesson that only stands against the rule (låt stå) an exemption with a request that names it, and asks nothing else of it', async () => {
    stored = { ...stored, ...lessonRecord({ startTime: t('14:30'), endTime: t('15:30') }), fromPlacement: false, school: stored['school'] };
    // Without the request it is let stand, and nothing is saved on it.
    await service.update(LESSON, { roomId: NEW_ROOM }, testUser());
    expect('exemptFrom' in writtenData()).toBe(false);
    // A closed hour for the årskurs is no concern of the question "Lägg ändå, FRAME", and the lesson stands against it as it did.
    tx['availabilityConstraint']!['findMany']!.mockImplementation(async (query: { where: Row }) =>
      query.where['resourceType'] === 'GRADE_LEVEL'
        ? [{ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: 1, date: null, startTime: t('14:00'), endTime: t('16:00') }]
        : [],
    );
    await service.update(LESSON, { exempt: ['FRAME'] }, testUser());
    expect(writtenData()).toMatchObject({ exemptFrom: ['FRAME'], isLocked: true });
  });

  it('is saved on a new lesson that names the rule, locked', async () => {
    tx['masterLesson']!['create']!.mockImplementation(async (args: { data: Row }) => lessonRecord({ ...args.data, id: LESSON, extraGroups: [], participants: [] }));
    await service.create({ academicYearId: YEAR, subjectId: SUBJECT, studentGroupId: G7A, dayOfWeek: 1, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, testUser());
    expect((tx['masterLesson']!['create']!.mock.calls[0]![0] as { data: Row }).data).toMatchObject({ exemptFrom: ['FRAME'], isLocked: true });
    await refusal(service.create({ academicYearId: YEAR, subjectId: SUBJECT, studentGroupId: G7A, dayOfWeek: 1, startTime: '14:30', endTime: '15:30' }, testUser()));
  });

  it('is answered by the question as what the answer yes would give, and whether the refusal can be exempted at all', async () => {
    const plain = await service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '14:30', endTime: '15:30' }] }, testUser());
    expect(plain.moves[0]).toMatchObject({ ok: false, exemptable: true, exempted: [] });
    const asked = await service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }] }, testUser());
    expect(asked.moves[0]).toMatchObject({ ok: true, exemptable: false, exempted: ['FRAME'], refusals: [] });
    // A refusal that is also a clash cannot be exempted away.
    dayLessons = [{ ...lessonRecord({ id: OTHER, teacherId: TEACHER, roomId: null, studentGroupId: '00000000-aaaa-4aaa-8aaa-000000000003', startTime: t('14:30'), endTime: t('15:30') }), subject: { name: 'Kemi' }, studentGroup: { name: '8B' } }];
    const clashing = await service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '14:30', endTime: '15:30' }] }, testUser());
    expect(clashing.moves[0]!.exemptable).toBe(false);
  });

  // g467 (granskningen): påståenden i PR:en som inget prov höll fast. Varje rad faller mot en mutant av koden (se rapporten).

  it('refuses a request that grants an exemption and takes the lock off in the same breath, on a create as on a PATCH', async () => {
    tx['masterLesson']!['create']!.mockImplementation(async (args: { data: Row }) => lessonRecord({ ...args.data, id: LESSON, extraGroups: [], participants: [] }));
    await expect(
      service.create({ academicYearId: YEAR, subjectId: SUBJECT, studentGroupId: G7A, dayOfWeek: 1, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'], isLocked: false }, testUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx['masterLesson']!['create']).not.toHaveBeenCalled();
    await expect(service.update(LESSON, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'], isLocked: false }, testUser())).rejects.toBeInstanceOf(BadRequestException);
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
    // Naming a rule the time does not break, with the lock off, is no contradiction: nothing is granted. (The move locks it, as every move by hand does.)
    await service.update(LESSON, { startTime: '09:00', endTime: '10:00', exempt: ['FRAME'], isLocked: false }, testUser());
    expect(writtenData()).toMatchObject({ exemptFrom: [], isLocked: true });
  });

  it('gives no exemption to a lesson Generera wrote from a förläggning', async () => {
    stored = { ...stored, fromPlacement: true };
    await expect(service.update(LESSON, { exempt: ['FRAME'] }, testUser())).rejects.toBeInstanceOf(BadRequestException);
    expect(tx['masterLesson']!['update']).not.toHaveBeenCalled();
  });

  it('answers the lunch and a rule on årskurser together, and an exemption for the lunch leaves the årskurs rule asked (LUNCH is not hidden by, and does not hide, GRADE_RULE)', async () => {
    // 12:00-13:00 is inside the ramtid, over the class's meal 12:00-12:30 and inside a closed hour for year 7.
    tx['lunchSitting']!['findMany']!.mockResolvedValue([{ studentGroupId: G7A, dayOfWeek: 1, startTime: t('12:00'), endTime: t('12:30'), startDate: null, endDate: null }]);
    tx['availabilityConstraint']!['findMany']!.mockImplementation(async (query: { where: Row }) =>
      query.where['resourceType'] === 'GRADE_LEVEL'
        ? [{ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: 1, date: null, startTime: t('12:00'), endTime: t('13:00') }]
        : [],
    );
    const asked = await service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '12:00', endTime: '13:00' }] }, testUser());
    expect(asked.moves[0]!.refusals.map((refusal) => refusal.reason)).toEqual(['LUNCH', 'GRADE_RULE']);
    expect(asked.moves[0]!.exemptable).toBe(false);
    const lunchExempt = await service.judgeMoves({ moves: [{ lessonId: LESSON, startTime: '12:00', endTime: '13:00', exempt: ['LUNCH'] }] }, testUser());
    expect(lunchExempt.moves[0]).toMatchObject({ ok: false, exempted: ['LUNCH'] });
    expect(lunchExempt.moves[0]!.refusals.map((refusal) => refusal.reason)).toEqual(['GRADE_RULE']);
    const body = await refusal(service.update(LESSON, { startTime: '12:00', endTime: '13:00', exempt: ['LUNCH'] }, testUser()));
    expect(body.params).toMatchObject({ reason: 'GRADE_RULE', reasons: 'GRADE_RULE' });
  });
});
