import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { calendarLessonRosters, rostersOf } from '../calendar/lesson-roster';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { createCreditInTransaction } from '../timplan/timplan-credits.service';
import { digestAudience, sendDigest } from './cancellation-digest';
import { tryEnterPublication } from './publish-mode';
import type { CreateScheduleActivityDto, ScheduleActivitySelectionDto } from './dto/schedule-activity.dto';
import {
  ACTIVITY_CREDIT_SUBJECT,
  ACTIVITY_OWNED_BY_EXAM,
  ACTIVITY_REMOVED,
  ACTIVITY_SCOPE_TOO_WIDE,
  ACTIVITY_SUBJECT,
  ACTIVITY_SUBJECT_COUNTS,
  ACTIVITY_TEACHER,
  ScheduleActivitiesService,
} from './schedule-activities.service';

// The roster reader, the digest and the credit writer are other files' to test
// (their own specs and scripts/test/probe-schemabrytande.ts, which runs this
// service against a real database). What is tested here is what the service
// decides and the order in which it writes.
jest.mock('../calendar/lesson-roster', () => ({
  rostersOf: jest.fn(),
  calendarLessonRosters: jest.fn(),
}));
jest.mock('./cancellation-digest', () => ({
  ...jest.requireActual('./cancellation-digest'),
  digestAudience: jest.fn(),
  sendDigest: jest.fn(),
}));
jest.mock('./publish-mode', () => ({
  ...jest.requireActual('./publish-mode'),
  tryEnterPublication: jest.fn(),
}));
jest.mock('../timplan/timplan-credits.service', () => ({
  ...jest.requireActual('../timplan/timplan-credits.service'),
  createCreditInTransaction: jest.fn(),
}));
const rosters = rostersOf as jest.MockedFunction<typeof rostersOf>;
const lessonRosters = calendarLessonRosters as jest.MockedFunction<typeof calendarLessonRosters>;
const audienceOf = digestAudience as jest.MockedFunction<typeof digestAudience>;
const digest = sendDigest as jest.MockedFunction<typeof sendDigest>;
const writeCredit = createCreditInTransaction as jest.MockedFunction<typeof createCreditInTransaction>;
const tryPublication = tryEnterPublication as jest.MockedFunction<typeof tryEnterPublication>;

const NOW = new Date('2026-11-05T09:00:00.000Z');
const YEAR = 'year';
const BATCH = 'batch';
const ACTIVITY = 'activity';
const G7A = 'g7a';
const G7B = 'g7b';
const HALF = 'g7a-half';
const SV = 'sva7';
const MU = 'mu7';
const TEMADAG = 'temadag';
const MA = 'matematik';
const IDROTT = 'idrott';
const T1 = 'teacher-1';
const T2 = 'teacher-2';

const instant = (iso: string) => new Date(`${iso}:00.000Z`);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const GROUPS = [
  { id: G7A, name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: G7B, name: '7B', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: HALF, name: '7A-halva 1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: G7A },
  { id: SV, name: 'SvA7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null },
  { id: MU, name: 'Musik 7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null },
];
// SvA7 is wholly 7A's pupils; Musik 7 has pupils from 7B too.
const MEMBERS = [
  { studentGroupId: SV, student: { studentGroupId: G7A } },
  { studentGroupId: SV, student: { studentGroupId: G7A } },
  { studentGroupId: MU, student: { studentGroupId: G7A } },
  { studentGroupId: MU, student: { studentGroupId: G7B } },
];
const SUBJECTS: Record<string, { id: string; name: string; countsTowardTimplan: boolean }> = {
  [TEMADAG]: { id: TEMADAG, name: 'Temadag', countsTowardTimplan: false },
  [MA]: { id: MA, name: 'Matematik', countsTowardTimplan: true },
  [IDROTT]: { id: IDROTT, name: 'Idrott', countsTowardTimplan: false },
};

/** A lesson as the selection reads it (CANDIDATE_SELECT). */
const lesson = (id: string, date: string, overrides: Record<string, unknown> = {}) => ({
  id,
  date: day(date),
  startsAt: instant(`${date}T07:00`),
  endsAt: instant(`${date}T08:00`),
  status: 'SCHEDULED',
  note: null,
  subjectId: MA,
  studentGroupId: G7A,
  studentGroup: { name: '7A', gradeLevel: 7 },
  subject: { name: 'Matematik' },
  extraGroups: [],
  _count: { attendanceRecords: 0 },
  ...overrides,
});

const batchRow = (overrides: Record<string, unknown> = {}) => ({
  id: BATCH,
  academicYearId: YEAR,
  name: 'Friluftsdag åk 7',
  cause: 'EVENT',
  fromDate: day('2026-11-09'),
  toDate: day('2026-11-10'),
  startTime: null,
  endTime: null,
  scope: 'GROUPS',
  minGradeLevel: null,
  maxGradeLevel: null,
  groupIds: [G7A, HALF, SV],
  cancelled: 2,
  createdAt: new Date('2026-11-01T08:00:00.000Z'),
  createdByUserId: null,
  reversedAt: null,
  reinstated: 0,
  skippedRoomTaken: 0,
  notifies: true,
  _count: { credits: 2 },
  ...overrides,
});

const activityRow = (overrides: Record<string, unknown> = {}, batch: Record<string, unknown> = {}) => ({
  id: ACTIVITY,
  schoolId: 'school',
  academicYearId: YEAR,
  batchId: BATCH,
  replacementSubjectId: TEMADAG,
  description: 'Vandring',
  scopeGroupIds: [G7A, G7B],
  createdAt: new Date('2026-11-01T08:00:00.000Z'),
  createdByUserId: 'admin',
  removedAt: null,
  teachers: [{ studentGroupId: G7A, teacherId: T1, role: 'LEAD' }],
  batch: batchRow(batch),
  _count: { lessons: 2 },
  ...overrides,
});

const selection = (overrides: Partial<ScheduleActivitySelectionDto> = {}): ScheduleActivitySelectionDto =>
  ({
    academicYearId: YEAR,
    name: 'Friluftsdag åk 7',
    fromDate: '2026-11-09',
    toDate: '2026-11-10',
    scope: 'GROUPS',
    groupIds: [G7A],
    replacementSubjectId: TEMADAG,
    description: 'Vandring',
    teachers: [{ studentGroupId: G7A, teacherId: T1, role: 'LEAD' }],
    credits: [{ subjectId: MA, minutes: 240 }],
    ...overrides,
  }) as ScheduleActivitySelectionDto;

const create = (overrides: Partial<CreateScheduleActivityDto> = {}): CreateScheduleActivityDto =>
  ({ ...selection(), ...overrides }) as CreateScheduleActivityDto;

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse?: () => { code?: string } }).getResponse?.().code ?? (error as Error).constructor.name;
  }
  return 'resolved';
};

describe('ScheduleActivitiesService', () => {
  let tx: TxMock;
  let service: ScheduleActivitiesService;
  let realtime: { notifyCoverBoardChanged: jest.Mock; notifyLessonsChanged: jest.Mock };
  const user = testUser();
  const SCHOOL = user.schoolId as string;

  /** What the database holds; a test changes what it needs. */
  let world: {
    candidates: unknown[];
    owned: unknown[];
    /** What the selection would take now that the avbokning does not hold yet. */
    pending: unknown[];
    continuing: unknown[];
    digestRows: unknown[];
    ownerPupils: Record<string, string[]>;
    lessonPupils: Record<string, string[]>;
    teachers: Array<{ id: string }>;
    busy: unknown[];
    groups: typeof GROUPS;
    activity: ReturnType<typeof activityRow> | null;
    reverse: unknown[];
    scheduleLessons: unknown[];
    creditIds: string[];
    linkedCredits: unknown[];
  };

  const owned = (...ids: Array<[string, string]>) =>
    ids.map(([id, date]) => {
      const { _count, studentGroup, subject, status, note, ...shape } = lesson(id, date);
      void _count, studentGroup, subject, status, note;
      return shape;
    });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    tx = createTxMock();
    realtime = { notifyCoverBoardChanged: jest.fn(), notifyLessonsChanged: jest.fn().mockResolvedValue(undefined) };
    service = new ScheduleActivitiesService(
      createPrismaMock(tx) as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      { notifyUsers: jest.fn() } as unknown as NotificationsService,
    );
    const free = [lesson('l1', '2026-11-09'), lesson('l2', '2026-11-10')];
    world = {
      candidates: free,
      owned: owned(['l1', '2026-11-09'], ['l2', '2026-11-10']),
      pending: [],
      continuing: [],
      digestRows: [],
      ownerPupils: { [G7A]: ['p1', 'p2'], [G7B]: ['p3'] },
      lessonPupils: {},
      teachers: [{ id: T1 }, { id: T2 }],
      busy: [],
      groups: GROUPS,
      activity: activityRow(),
      reverse: [],
      scheduleLessons: [],
      creditIds: ['c1', 'c2'],
      linkedCredits: [
        { batchId: BATCH, credit: { subjectId: MA, minutes: 240, date: day('2026-11-09') } },
        { batchId: BATCH, credit: { subjectId: MA, minutes: 200, date: day('2026-11-10') } },
        { batchId: BATCH, credit: { subjectId: null, minutes: 30, date: day('2026-11-10') } },
      ],
    };

    tx.academicYear.findUnique.mockResolvedValue({
      startDate: day('2026-08-17'),
      endDate: day('2027-06-11'),
      school: { timezone: 'Europe/Stockholm' },
    });
    tx.studentGroup.count.mockImplementation(
      async ({ where }) => new Set((where.id.in as string[]).filter((id) => world.groups.some((group) => group.id === id))).size,
    );
    tx.studentGroup.findMany.mockImplementation(async () => world.groups);
    tx.studentGroupMember.findMany.mockResolvedValue(MEMBERS);
    tx.subject.findUnique.mockImplementation(async ({ where }) => SUBJECTS[where.id] ?? null);
    tx.subject.findMany.mockImplementation(async ({ where }) =>
      (where.id.in as string[]).map((id) => SUBJECTS[id]).filter(Boolean),
    );
    tx.user.findMany.mockImplementation(async () => world.teachers);
    tx.calendarLessonTeacher.findMany.mockImplementation(async () => world.busy);
    tx.calendarLesson.findMany.mockImplementation(async ({ where }) => {
      if (where.OR) return world.candidates;
      if (where.status === 'SCHEDULED') return world.continuing;
      if (where.batchLessons?.some) return world.owned;
      if (where.batchLessons?.none) return world.pending;
      if (where.id?.in) return world.digestRows;
      return [];
    });
    tx.calendarLesson.updateMany.mockImplementation(async ({ where }) => ({ count: where?.id?.in?.length ?? (typeof where?.id === 'string' ? 1 : 0) }));
    tx.calendarLesson.deleteMany.mockImplementation(async ({ where }) => ({ count: where?.id?.in?.length ?? 0 }));
    tx.calendarLesson.create
      .mockResolvedValueOnce({ id: 'repl-1' })
      .mockResolvedValueOnce({ id: 'repl-2' })
      .mockResolvedValue({ id: 'repl-n' });
    tx.cancellationBatch.create.mockResolvedValue({ id: BATCH });
    tx.scheduleActivity.create.mockResolvedValue({ id: ACTIVITY });
    tx.scheduleActivity.findFirst.mockImplementation(async () => world.activity);
    tx.scheduleActivity.findUnique.mockImplementation(async () => world.activity);
    tx.scheduleActivity.findUniqueOrThrow.mockImplementation(async () => world.activity);
    tx.scheduleActivity.findMany.mockImplementation(async () => (world.activity ? [world.activity] : []));
    tx.scheduleActivityLesson.findMany.mockImplementation(async () => world.scheduleLessons);
    tx.cancellationBatchLesson.findMany.mockImplementation(async ({ select }) =>
      select.calendarLessonId ? [{ calendarLessonId: 'l1' }, { calendarLessonId: 'l2' }] : world.reverse,
    );
    tx.cancellationBatchLesson.count.mockResolvedValue(2);
    tx.cancellationBatchCredit.findMany.mockImplementation(async ({ select }) =>
      select.creditId ? world.creditIds.map((creditId) => ({ creditId })) : world.linkedCredits,
    );

    let credit = 0;
    writeCredit.mockImplementation(async () => ({ id: `credit-${++credit}` }) as never);
    rosters.mockImplementation(async (_tx, scopes) => scopes.map((scope) => new Set(world.ownerPupils[scope.groupIds[0]] ?? [])));
    lessonRosters.mockImplementation(
      async (_tx, lessons) => new Map(lessons.map((entry) => [entry.id, new Set(world.lessonPupils[entry.id] ?? ['p1'])])),
    );
    audienceOf.mockImplementation(async (_tx, lessons) => {
      const people = new Map<string, { lessons: Set<string>; first: string; last: string }>();
      if (lessons.length > 0) {
        const dates = lessons.map((entry) => entry.date).sort();
        people.set('pupil-1', { lessons: new Set(lessons.map((entry) => entry.id)), first: dates[0], last: dates[dates.length - 1] });
      }
      return { people, counts: { pupils: people.size, guardians: 0, teachers: 0 } };
    });
    digest.mockResolvedValue(3);
    tryPublication.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  describe('preview', () => {
    it('says what the activity cancels, who gets a lesson, and what it takes along', async () => {
      const preview = await service.preview(selection(), user);

      expect(preview.matched).toBe(2);
      expect(preview.lessons.map((entry) => entry.id)).toEqual(['l1', 'l2']);
      expect(preview.replacementLessons).toBe(2);
      expect(preview.classes).toEqual([
        {
          groupId: G7A,
          name: '7A',
          teachers: [{ teacherId: T1, role: 'LEAD' }],
          days: 2,
          firstDate: '2026-11-09',
          lastDate: '2026-11-10',
        },
      ]);
      // 7A's half and SvA7 go with the class; Musik 7 has pupils from 7B too and goes on.
      expect(preview.expandedGroups).toEqual([
        { id: HALF, name: '7A-halva 1' },
        { id: SV, name: 'SvA7' },
      ]);
      expect(preview.creditDates).toEqual(['2026-11-09', '2026-11-10']);
      expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
      // The pupil of the mock, and the responsible teacher who teaches nothing that was cancelled.
      expect(preview.audience).toEqual({ pupils: 1, guardians: 0, teachers: 1 });
      expect(preview.change).toBeUndefined();
      expect(tx.cancellationBatch.create).not.toHaveBeenCalled();
    });

    it('is the same plan, and the same digest, when asked twice', async () => {
      const first = await service.preview(selection(), user);
      const second = await service.preview(selection(), user);
      expect(second.digest).toBe(first.digest);
      const other = await service.preview(selection({ description: 'Orientering' }), user);
      expect(other.digest).not.toBe(first.digest);
    });

    it('names a lesson that goes on for pupils of the activity, and a class with nobody responsible', async () => {
      world.continuing = [
        { id: 'mu1', subjectId: 'mu', studentGroupId: MU, studentGroup: { name: 'Musik 7' }, extraGroups: [] },
        { id: 'mu2', subjectId: 'mu', studentGroupId: MU, studentGroup: { name: 'Musik 7' }, extraGroups: [] },
        { id: 'sl1', subjectId: 'sl', studentGroupId: G7B, studentGroup: { name: 'Slöjd' }, extraGroups: [] },
      ];
      world.lessonPupils = { mu1: ['p1'], mu2: ['p2'], sl1: ['p9'] };
      const preview = await service.preview(selection({ teachers: [], credits: [] }), user);
      expect(preview.warnings.continuing).toEqual([{ name: 'Musik 7', lessons: 2 }]);
      expect(preview.warnings.classesWithoutTeacher).toEqual(['7A']);
    });

    it('does not look for continuing lessons when the school is out, or when nobody has a lesson to lose', async () => {
      const school = await service.preview(selection({ scope: 'SCHOOL', groupIds: undefined }), user);
      expect(school.warnings.continuing).toEqual([]);
      expect(tx.studentGroupMember.findMany).not.toHaveBeenCalled();

      world.ownerPupils = {};
      const nobody = await service.preview(selection(), user);
      expect(nobody.warnings.continuing).toEqual([]);
      expect(nobody.replacementLessons).toBe(0);
    });

    it('reads grades as every class of the span', async () => {
      const preview = await service.preview(selection({ scope: 'GRADES', groupIds: undefined, minGradeLevel: 7, maxGradeLevel: 7 }), user);
      expect(preview.expandedGroups).toEqual([]);
      expect(rosters).toHaveBeenCalledWith(
        tx,
        [
          { subjectId: TEMADAG, groupIds: [G7A], participantIds: [] },
          { subjectId: TEMADAG, groupIds: [G7B], participantIds: [] },
        ],
        { pupils: 'ACTIVE' },
      );
    });

    it('warns of pupils whom no class holds, and of a teacher who has a lesson that stays', async () => {
      world.lessonPupils = { l1: ['p1', 'stray'] };
      world.busy = [
        {
          teacherId: T1,
          calendarLesson: {
            date: day('2026-11-09'),
            startsAt: instant('2026-11-09T07:30'),
            endsAt: instant('2026-11-09T08:30'),
            studentGroup: { name: '8C' },
          },
        },
      ];
      const preview = await service.preview(selection(), user);
      expect(preview.warnings.uncoveredPupils).toBe(1);
      expect(preview.warnings.teacherClashes).toEqual([{ teacherId: T1, date: '2026-11-09', groupName: '7A', busyWith: '8C' }]);
    });

    it('lists the first fifty lessons only', async () => {
      world.candidates = Array.from({ length: 60 }, (_v, index) => lesson(`m${index}`, '2026-11-09', { id: `m${String(index).padStart(2, '0')}` }));
      const preview = await service.preview(selection({ credits: [] }), user);
      expect(preview.matched).toBe(60);
      expect(preview.lessons).toHaveLength(50);
    });

    it('counts what the selection leaves out', async () => {
      world.candidates = [
        lesson('l1', '2026-11-09'),
        lesson('held', '2026-11-09', { _count: { attendanceRecords: 4 } }),
        lesson('off', '2026-11-09', { status: 'CANCELLED' }),
        lesson('began', '2026-11-05', { startsAt: instant('2026-11-05T07:00') }),
      ];
      const preview = await service.preview(selection({ fromDate: '2026-11-05', credits: [] }), user);
      expect(preview.excluded).toEqual({ started: 1, notScheduled: 1, attendance: 1 });
      expect(preview.matched).toBe(1);
    });

    it('refuses a subject that is not there, or that counts toward the timplan', async () => {
      expect(await code(service.preview(selection({ replacementSubjectId: 'gone' }), user))).toBe(ACTIVITY_SUBJECT);
      expect(await code(service.preview(selection({ replacementSubjectId: MA }), user))).toBe(ACTIVITY_SUBJECT_COUNTS);
    });

    it('refuses a credit on a subject that is not there, or that no pupil has a timplan for', async () => {
      expect(await code(service.preview(selection({ credits: [{ subjectId: 'gone', minutes: 60 }] }), user))).toBe(
        ACTIVITY_CREDIT_SUBJECT,
      );
      expect(await code(service.preview(selection({ credits: [{ subjectId: IDROTT, minutes: 60 }] }), user))).toBe(
        ACTIVITY_CREDIT_SUBJECT,
      );
    });

    it('refuses credits for a window, and for days none of which lies ahead', async () => {
      expect(await code(service.preview(selection({ startTime: '08:00', endTime: '12:00' }), user))).toBe('CANCELLATION_CREDIT');
      world.candidates = [];
      expect(await code(service.preview(selection(), user))).toBe('CANCELLATION_CREDIT');
    });

    it('refuses a teacher for a class the activity is not for, and one who is not an active teacher', async () => {
      expect(await code(service.preview(selection({ teachers: [{ studentGroupId: G7B, teacherId: T1 }] }), user))).toBe(ACTIVITY_TEACHER);
      expect(await code(service.preview(selection({ teachers: [{ studentGroupId: G7A, teacherId: 'stranger' }] }), user))).toBe(
        ACTIVITY_TEACHER,
      );
    });

    it('refuses a selection that grows past 200 groups', async () => {
      const many = Array.from({ length: 201 }, (_v, index) => ({
        id: `tg${index}`,
        name: `TG ${index}`,
        kind: 'TEACHING_GROUP',
        gradeLevel: 7,
        halfOfId: null,
      }));
      world.groups = [...GROUPS, ...many] as typeof GROUPS;
      tx.studentGroupMember.findMany.mockResolvedValue(many.map((group) => ({ studentGroupId: group.id, student: { studentGroupId: G7A } })));
      expect(await code(service.preview(selection(), user))).toBe(ACTIVITY_SCOPE_TOO_WIDE);
    });

    it('refuses a group that is not in the year', async () => {
      tx.studentGroup.count.mockResolvedValue(0);
      expect(await code(service.preview(selection(), user))).toBe('CANCELLATION_SCOPE');
    });

    it('refuses a year that is not there', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.preview(selection(), user)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses the request the DTO cannot judge: more than eight teachers for a class, two leaders, a subject twice', async () => {
      const nine = Array.from({ length: 9 }, (_v, index) => ({ studentGroupId: G7A, teacherId: `t${index}` }));
      expect(await code(service.preview(selection({ teachers: nine }), user))).toBe(ACTIVITY_TEACHER);
      expect(
        await code(
          service.preview(
            selection({
              teachers: [
                { studentGroupId: G7A, teacherId: T1, role: 'LEAD' },
                { studentGroupId: G7A, teacherId: T2, role: 'LEAD' },
              ],
            }),
            user,
          ),
        ),
      ).toBe(ACTIVITY_TEACHER);
      expect(
        await code(
          service.preview(
            selection({
              credits: [
                { subjectId: MA, minutes: 60 },
                { subjectId: MA, minutes: 90 },
              ],
            }),
            user,
          ),
        ),
      ).toBe(ACTIVITY_CREDIT_SUBJECT);
    });

    it('is refused for a user with no school', async () => {
      await expect(service.preview(selection(), testUser({ schoolId: undefined }))).rejects.toThrow('No school');
    });
  });

  describe('create', () => {
    it('cancels the lessons, writes the activity, its credits and its replacement lessons, and tells the families', async () => {
      const result = await service.create(create({ expectedDigest: (await service.preview(selection(), user)).digest }), user);

      expect(result).toMatchObject({ cancelled: 2, replacementLessons: 2, credits: 2 });
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.cancellationBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schoolId: SCHOOL,
          academicYearId: YEAR,
          name: 'Friluftsdag åk 7',
          cause: 'EVENT',
          fromDate: day('2026-11-09'),
          toDate: day('2026-11-10'),
          startTime: null,
          endTime: null,
          scope: 'GROUPS',
          groupIds: [G7A, HALF, SV],
          notifies: true,
        }),
        select: { id: true },
      });
      expect(tx.cancellationBatchLesson.createMany).toHaveBeenCalledWith({
        data: [
          { batchId: BATCH, calendarLessonId: 'l1', schoolId: SCHOOL, previousNote: null },
          { batchId: BATCH, calendarLessonId: 'l2', schoolId: SCHOOL, previousNote: null },
        ],
      });
      expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED', cancelCause: 'EVENT', note: 'Inställd: Friluftsdag åk 7' } }),
      );
      // The activity names the classes the administrator named, not the ones the cancellation took along.
      expect(tx.scheduleActivity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          batchId: BATCH,
          replacementSubjectId: TEMADAG,
          description: 'Vandring',
          scopeGroupIds: [G7A],
          teachers: { create: [{ studentGroupId: G7A, teacherId: T1, role: 'LEAD' }] },
        }),
        select: { id: true },
      });
      // One credit per day, subject and NAMED class.
      expect(writeCredit).toHaveBeenCalledTimes(2);
      expect(writeCredit.mock.calls.map((call) => [call[2].date, call[2].subjectId, call[2].minutes, call[2].studentGroupId])).toEqual([
        ['2026-11-09', MA, 240, G7A],
        ['2026-11-10', MA, 240, G7A],
      ]);
      expect(tx.cancellationBatchCredit.create).toHaveBeenCalledTimes(2);
      expect(tx.calendarLesson.create).toHaveBeenCalledTimes(2);
      expect(tx.cancellationBatch.update).toHaveBeenCalledWith({ where: { id: BATCH }, data: { cancelled: 2 } });
      expect(digest).toHaveBeenCalledTimes(1);
      expect(digest.mock.calls[0].slice(2, 6)).toEqual([
        SCHOOL,
        { id: BATCH, name: 'Friluftsdag åk 7' },
        expect.objectContaining({ counts: { pupils: 1, guardians: 0, teachers: 1 } }),
        false,
      ]);
      expect(digest.mock.calls[0][6]).toEqual({ responsible: new Map([[T1, ['7A']]]), plain: new Set() });

      expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, ['l1', 'l2', 'repl-1', 'repl-2']);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-10');
      expect(result.activity).toMatchObject({
        id: ACTIVITY,
        name: 'Friluftsdag åk 7',
        fromDate: '2026-11-09',
        toDate: '2026-11-10',
        replacementSubject: SUBJECTS[TEMADAG],
        doubleCounts: false,
        credits: 3,
        // The latest day's minutes per subject: what a change would send again.
        creditLines: [{ subjectId: MA, minutes: 200 }],
        teachers: [{ studentGroupId: G7A, teacherId: T1, role: 'LEAD' }],
      });
    });

    it('makes the first teacher of a class its leader unless the request says who leads, and drops a teacher named twice', async () => {
      await service.create(
        create({
          description: '',
          teachers: [
            { studentGroupId: G7A, teacherId: T1 },
            { studentGroupId: G7A, teacherId: T2 },
            { studentGroupId: G7A, teacherId: T1, role: 'LEAD' },
          ],
        }),
        user,
      );
      const data = tx.scheduleActivity.create.mock.calls[0][0].data;
      expect(data.description).toBeNull();
      expect(data.teachers.create).toEqual([
        { studentGroupId: G7A, teacherId: T1, role: 'LEAD' },
        { studentGroupId: G7A, teacherId: T2, role: 'ASSISTANT' },
      ]);
    });

    it('tells nobody, and writes no credits, when the request says so', async () => {
      await service.create(create({ notify: false, credits: [] }), user);
      expect(digest).not.toHaveBeenCalled();
      expect(writeCredit).not.toHaveBeenCalled();
      expect(tx.cancellationBatch.create.mock.calls[0][0].data.notifies).toBe(false);
    });

    it('answers 409 when the plan has changed since the preview, and writes nothing', async () => {
      const error = await service.create(create({ expectedDigest: 'f'.repeat(64) }), user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CANCELLATION_STALE' });
      expect(tx.cancellationBatch.create).not.toHaveBeenCalled();
    });

    it('answers 409 when a lesson changed between the read and the write', async () => {
      tx.calendarLesson.updateMany.mockResolvedValue({ count: 1 });
      expect(await code(service.create(create(), user))).toBe('CANCELLATION_STALE');
      expect(tx.scheduleActivity.create).not.toHaveBeenCalled();
    });

    it('refuses a selection that cancels nothing', async () => {
      world.candidates = [];
      expect(await code(service.create(create({ credits: [] }), user))).toBe('CANCELLATION_SCOPE');
      expect(tx.cancellationBatch.create).not.toHaveBeenCalled();
    });

    it('is done even when the broadcasts fail', async () => {
      realtime.notifyLessonsChanged.mockRejectedValue(new Error('down'));
      realtime.notifyCoverBoardChanged.mockImplementation(() => {
        throw new Error('down');
      });
      await expect(service.create(create(), user)).resolves.toMatchObject({ cancelled: 2 });
    });

    it('gives an activity with no subject row its view with no subject, and flags one that counts toward the timplan', async () => {
      world.activity = activityRow({ replacementSubjectId: MA });
      expect((await service.list(YEAR, user))[0]).toMatchObject({ replacementSubject: SUBJECTS[MA], doubleCounts: true });
      world.activity = activityRow({ replacementSubjectId: 'gone', removedAt: new Date('2026-11-04T10:00:00.000Z') });
      expect((await service.list(YEAR, user))[0]).toMatchObject({
        replacementSubject: null,
        doubleCounts: false,
        removedAt: '2026-11-04T10:00:00.000Z',
      });
    });
  });

  describe('list', () => {
    it('gives the activities of a year, newest first', async () => {
      const views = await service.list(YEAR, user);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ id: ACTIVITY, scopeGroupIds: [G7A, G7B], notifies: true, startTime: null, replacementLessons: 2 });
      expect(tx.scheduleActivity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR }, orderBy: [{ batch: { fromDate: 'desc' } }, { createdAt: 'desc' }] }),
      );
    });

    it('asks for nothing more when there are none', async () => {
      world.activity = null;
      expect(await service.list(YEAR, user)).toEqual([]);
      expect(tx.subject.findMany).not.toHaveBeenCalled();
    });
  });

  describe('the days a class is off school', () => {
    it('plans no replacement lesson for a lov entered after the activity', async () => {
      tx.schoolBreak.findMany.mockResolvedValue([
        { startDate: day('2026-11-10'), endDate: day('2026-11-10'), minGradeLevel: null, maxGradeLevel: null },
      ]);
      const preview = await service.preview(selection(), user);
      expect(preview.replacementLessons).toBe(1);
      expect(preview.classes[0]).toMatchObject({ days: 1, firstDate: '2026-11-09', lastDate: '2026-11-09' });
    });
  });

  describe('what is waiting', () => {
    it('counts the lessons that have come into the activity’s days since it was made', async () => {
      world.pending = [lesson('p1', '2026-11-10'), lesson('p2', '2026-11-10')];
      expect((await service.list(YEAR, user))[0].addedSince).toBe(2);
    });

    it('counts nothing, and asks nothing, for an activity that is removed, reversed or over', async () => {
      world.pending = [lesson('p1', '2026-11-10')];
      for (const row of [
        activityRow({ removedAt: NOW }),
        activityRow({}, { reversedAt: NOW }),
        activityRow({}, { toDate: day('2026-11-04') }),
      ]) {
        world.activity = row;
        tx.calendarLesson.findMany.mockClear();
        expect((await service.list(YEAR, user))[0].addedSince).toBe(0);
        expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
      }
    });
  });

  describe('apply again', () => {
    function arrived() {
      world.pending = [lesson('p1', '2026-11-10', { startsAt: instant('2026-11-10T12:00'), endsAt: instant('2026-11-10T13:00') })];
      world.owned = owned(['l1', '2026-11-09'], ['l2', '2026-11-10'], ['p1', '2026-11-10']);
      world.digestRows = [{ id: 'p1', date: day('2026-11-10'), subjectId: MA, studentGroupId: G7A, extraGroups: [] }];
    }

    it('cancels what has come into the days, lets the replacement lessons follow, and tells those it touches', async () => {
      arrived();
      const result = await service.reapply(ACTIVITY, user);

      expect(result.added).toBe(1);
      expect(tx.cancellationBatchLesson.createMany).toHaveBeenCalledWith({
        data: [{ batchId: BATCH, calendarLessonId: 'p1', schoolId: SCHOOL, previousNote: null }],
      });
      expect(tx.cancellationBatch.update).toHaveBeenCalledWith({ where: { id: BATCH }, data: { cancelled: { increment: 1 } } });
      expect(tx.calendarLesson.create).toHaveBeenCalled();
      expect(digest).toHaveBeenCalledTimes(1);
      expect(digest.mock.calls[0][5]).toBe(false);
      expect(digest.mock.calls[0][6]).toEqual({ responsible: new Map([[T1, ['7A']]]), plain: new Set() });
      expect(realtime.notifyLessonsChanged.mock.calls[0][1]).toEqual(expect.arrayContaining(['p1']));
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-10');
      expect(result.activity.id).toBe(ACTIVITY);
    });

    it('still lets the replacement lessons follow when there is nothing new to cancel, and tells nobody', async () => {
      const result = await service.reapply(ACTIVITY, user);
      expect(result.added).toBe(0);
      expect(tx.cancellationBatchLesson.createMany).not.toHaveBeenCalled();
      expect(tx.scheduleActivityLesson.findMany).toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    });

    it('tells nobody when the activity told nobody', async () => {
      arrived();
      world.activity = activityRow({}, { notifies: false });
      expect((await service.reapply(ACTIVITY, user)).added).toBe(1);
      expect(digest).not.toHaveBeenCalled();
    });

    it('refuses an activity that is not there, removed, or whose avbokning was reversed', async () => {
      world.activity = null;
      await expect(service.reapply(ACTIVITY, user)).rejects.toBeInstanceOf(NotFoundException);
      world.activity = activityRow({ removedAt: NOW });
      expect(await code(service.reapply(ACTIVITY, user))).toBe(ACTIVITY_REMOVED);
      world.activity = activityRow({}, { reversedAt: NOW });
      expect(await code(service.reapply(ACTIVITY, user))).toBe('CANCELLATION_REVERSED');
    });
  });

  describe('beside a publish in a DIRECT school', () => {
    const sharedLock = () =>
      tx.$queryRaw.mock.calls.filter(([query]) => String((query as { sql?: string }).sql).includes('enter_grundschema_write')).length;

    it('applies the selection once more after the commit, holding the lock exclusively, to what a publish wrote meanwhile', async () => {
      world.pending = [lesson('late', '2026-11-12')];
      await service.create(create(), user);
      expect(sharedLock()).toBe(1);
      expect(tryPublication).toHaveBeenCalledTimes(1);
      expect(tryPublication).toHaveBeenCalledWith(tx, SCHOOL, { waitMs: 0 });
      // Shared first, in the main transaction; the pass after it.
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tryPublication.mock.invocationCallOrder[0]);
      // The main transaction cancelled l1 and l2; the pass cancelled what the publish left.
      const batches = tx.cancellationBatchLesson.createMany.mock.calls.map(([args]) => args.data.map((row: { calendarLessonId: string }) => row.calendarLessonId));
      expect(batches).toEqual([['l1', 'l2'], ['late']]);
      expect(realtime.notifyLessonsChanged.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['late']));
    });

    it('does so after a change too', async () => {
      world.candidates = world.owned.map((entry) =>
        lesson((entry as { id: string }).id, asDate(entry), { status: 'CANCELLED', batchLessons: [{ batchId: BATCH }] }),
      );
      await service.update(ACTIVITY, create({ credits: [], teachers: [] }), user);
      expect(tryPublication).toHaveBeenCalledTimes(1);
    });

    it('does not in a DRAFT school, where the exclusive publish already orders the two', async () => {
      tx.$queryRaw.mockResolvedValue([{ mode: 'DRAFT' }]);
      await service.create(create(), user);
      expect(tryPublication).not.toHaveBeenCalled();
    });

    it('tries again, holding no connection between the tries, until the publish has finished', async () => {
      const pauses: number[] = [];
      (service as unknown as { pause: (ms: number) => Promise<void> }).pause = async (ms) => {
        pauses.push(ms);
        jest.setSystemTime(Date.now() + ms);
      };
      tryPublication.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
      world.pending = [lesson('late', '2026-11-12')];
      await service.create(create(), user);
      expect(tryPublication).toHaveBeenCalledTimes(3);
      expect(pauses).toEqual([200, 200]);
      expect(tx.cancellationBatchLesson.createMany.mock.calls.map(([args]) => args.data.length)).toEqual([2, 1]);
    });

    it('leaves the activity made when a publish was open the whole time, says so in the log, and in the activity it answers with', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      (service as unknown as { pause: (ms: number) => Promise<void> }).pause = async (ms) => {
        jest.setSystemTime(Date.now() + ms);
      };
      tryPublication.mockResolvedValue(false);
      world.pending = [lesson('late', '2026-11-12'), lesson('later', '2026-11-12')];
      const result = await service.create(create(), user);
      expect(result).toMatchObject({ cancelled: 2 });
      // 10 s at 200 ms: the first try and fifty more.
      expect(tryPublication.mock.calls.length).toBeGreaterThanOrEqual(50);
      // Nothing was cancelled by the pass, and the row says what waits for "Tillämpa igen".
      expect(tx.cancellationBatchLesson.createMany).toHaveBeenCalledTimes(1);
      expect(result.activity.addedSince).toBe(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('apply again'));
    });

    it('leaves the activity made when the pass fails, and says so in the log', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      tryPublication.mockRejectedValue(new Error('connection reset'));
      await expect(service.create(create(), user)).resolves.toMatchObject({ cancelled: 2 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    });

    it('does nothing for an activity removed between its commit and the pass', async () => {
      world.pending = [lesson('late', '2026-11-12')];
      // The synchronisation in the main transaction finds it; the pass, after the commit, does not.
      tx.scheduleActivity.findFirst.mockResolvedValueOnce(world.activity).mockResolvedValue(null);
      await service.create(create(), user);
      expect(tx.cancellationBatchLesson.createMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('a class that has been deleted since', () => {
    function heldAsBefore() {
      world.candidates = world.owned.map((entry) =>
        lesson((entry as { id: string }).id, asDate(entry), { status: 'CANCELLED', batchLessons: [{ batchId: BATCH }] }),
      );
    }

    it('is left out when the activity is changed, with its teachers, instead of refusing the change for good', async () => {
      heldAsBefore();
      await service.update(
        ACTIVITY,
        create({
          groupIds: [G7A, 'deleted-class'],
          credits: [],
          teachers: [
            { studentGroupId: G7A, teacherId: T1 },
            { studentGroupId: 'deleted-class', teacherId: T2 },
          ],
        }),
        user,
      );
      expect(tx.scheduleActivity.update.mock.calls[0][0].data.scopeGroupIds).toEqual([G7A]);
      expect(tx.scheduleActivityTeacher.createMany.mock.calls[0][0].data).toEqual([
        { studentGroupId: G7A, teacherId: T1, role: 'LEAD', activityId: ACTIVITY, schoolId: SCHOOL },
      ]);
    });

    it('is left out of the preview of a change too', async () => {
      heldAsBefore();
      const preview = await service.updatePreview(ACTIVITY, selection({ groupIds: [G7A, 'deleted-class'], credits: [] }), user);
      expect(preview.classes.map((entry) => entry.groupId)).toEqual([G7A]);
    });

    it('leaves nothing to change when every class of the selection is gone', async () => {
      heldAsBefore();
      expect(await code(service.update(ACTIVITY, create({ groupIds: ['deleted-class'], credits: [], teachers: [] }), user))).toBe(
        'CANCELLATION_SCOPE',
      );
    });

    it('is still refused in a new activity', async () => {
      expect(await code(service.preview(selection({ groupIds: [G7A, 'deleted-class'] }), user))).toBe('CANCELLATION_SCOPE');
    });
  });

  describe('the notice to those nothing replaces', () => {
    it('promises no replacement to a pupil in a joint lesson whose class is outside the activity, nor to a guardian of such pupils only', async () => {
      world.lessonPupils = { l1: ['p1', 'stray'] };
      audienceOf.mockImplementation(async () => {
        const share = { lessons: new Set(['l1']), first: '2026-11-09', last: '2026-11-09' };
        return {
          people: new Map([
            ['p1', share],
            ['stray', share],
            ['g-stray', share],
            ['g-both', share],
          ]),
          counts: { pupils: 2, guardians: 2, teachers: 0 },
        };
      });
      tx.guardianStudent.findMany.mockImplementation(async ({ where }) =>
        where.studentId
          ? [{ guardianId: 'g-stray' }, { guardianId: 'g-both' }]
          : [
              { guardianId: 'g-stray', studentId: 'stray' },
              { guardianId: 'g-both', studentId: 'stray' },
              { guardianId: 'g-both', studentId: 'p1' },
            ],
      );
      await service.create(create(), user);
      expect(digest.mock.calls[0][6]).toMatchObject({ plain: new Set(['stray', 'g-stray']) });
    });

    it('asks nothing when every pupil is held by a class', async () => {
      await service.create(create(), user);
      expect(tx.guardianStudent.findMany).not.toHaveBeenCalled();
    });

    it('does not look further when none of the guardians is on the notice', async () => {
      world.lessonPupils = { l1: ['p1', 'stray'] };
      tx.guardianStudent.findMany.mockResolvedValue([{ guardianId: 'not-told' }]);
      await service.create(create(), user);
      // Only the guardians of the pupils nothing replaces were asked for, never their other children.
      expect(tx.guardianStudent.findMany).toHaveBeenCalled();
      expect(tx.guardianStudent.findMany.mock.calls.every(([args]) => args.where.studentId !== undefined)).toBe(true);
    });
  });

  describe('a change', () => {
    /** Friluftsdag 9–10 Nov becomes Utedag 9 Nov only: 10 Nov comes back, a third lesson on the 9th is taken. */
    function shrink() {
      const held = (id: string, date: string, overrides: Record<string, unknown> = {}) =>
        lesson(id, date, { status: 'CANCELLED', batchLessons: [{ batchId: BATCH }], ...overrides });
      world.candidates = [
        held('l1', '2026-11-09'),
        held('l2', '2026-11-10', { startsAt: instant('2026-11-10T06:00'), endsAt: instant('2026-11-10T07:00') }),
        lesson('l3', '2026-11-09', { startsAt: instant('2026-11-09T09:00'), endsAt: instant('2026-11-09T10:00') }),
      ];
      world.owned = owned(['l1', '2026-11-09'], ['l3', '2026-11-09']);
      world.digestRows = [{ id: 'l2', date: day('2026-11-10'), subjectId: MA, studentGroupId: G7A, extraGroups: [] }];
      world.reverse = [
        {
          previousNote: 'Gammal anteckning',
          calendarLesson: {
            id: 'l2',
            date: day('2026-11-10'),
            startsAt: instant('2026-11-10T06:00'),
            endsAt: instant('2026-11-10T07:00'),
            status: 'CANCELLED',
            cancelCause: 'EVENT',
            roomId: null,
            masterLessonId: 'm2',
            _count: { attendanceRecords: 0 },
          },
        },
      ];
      tx.masterLesson.findMany.mockResolvedValue([
        {
          id: 'm2',
          isParked: false,
          dayOfWeek: 2,
          startTime: new Date('1970-01-01T07:00:00.000Z'),
          endTime: new Date('1970-01-01T08:00:00.000Z'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      ]);
    }
    const change = (overrides: Partial<CreateScheduleActivityDto> = {}) =>
      create({ name: 'Utedag åk 7', toDate: '2026-11-09', credits: [{ subjectId: MA, minutes: 180 }], ...overrides });

    it('says what it puts back and what it takes', async () => {
      shrink();
      const preview = await service.updatePreview(ACTIVITY, change(), user);
      expect(preview.change).toEqual({ released: 1, taken: 1 });
      expect(preview.matched).toBe(2);
    });

    /**
     * THE GRUNDSCHEMA WAS MOVED AFTER THE ACTIVITY (the review of #319): l2 was Tuesday 10 Nov 07:00-08:00 and the template went to
     * Thursday, written after the activity was made. The change lets l2 go (the new description no longer takes 10 Nov), and l2 is the
     * class's lesson that week: it goes to Thursday 12 Nov, as in a removal, instead of being deleted and leaving the class without it.
     */
    describe('a lesson whose template moved after the activity', () => {
      const moved = (over: Record<string, unknown> = {}) => [
        {
          id: 'm2',
          isParked: false,
          updatedAt: new Date('2026-11-03T08:00:00.000Z'),
          roomId: 'room-new',
          teacherId: T2,
          dayOfWeek: 4,
          startTime: new Date('1970-01-01T07:00:00.000Z'),
          endTime: new Date('1970-01-01T08:00:00.000Z'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          ...over,
        },
      ];

      it('carries the lesson to the template’s slot, takes it out of the avbokning, and counts it as put back', async () => {
        shrink();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        const result = await service.update(ACTIVITY, change(), user);
        expect(result).toMatchObject({ released: 1, taken: 1 });
        expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith({
          where: { id: 'l2', status: 'CANCELLED', cancelCause: 'EVENT', startsAt: { gt: NOW }, attendanceRecords: { none: {} } },
          data: {
            date: day('2026-11-12'),
            startsAt: instant('2026-11-12T06:00'),
            endsAt: instant('2026-11-12T07:00'),
            roomId: 'room-new',
            status: 'SCHEDULED',
            cancelCause: null,
            note: 'Gammal anteckning',
          },
        });
        // Nothing is deleted, and the lesson leaves the avbokning like a lesson put back: left in it, "apply again" would count it held,
        // and the new description could not take it where it stands now.
        expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l2'] } }) }));
        expect(tx.cancellationBatchLesson.deleteMany).toHaveBeenCalledWith({ where: { batchId: BATCH, calendarLessonId: { in: ['l2'] } } });
      });

      it('gives the lesson the template’s LEAD', async () => {
        shrink();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        await service.update(ACTIVITY, change(), user);
        expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: 'l2', role: 'LEAD', teacherId: { not: T2 } } });
      });

      it('holds it against the OTHER batches still on, after the activity’s own is written; the activity itself judges it after the commit', async () => {
        shrink();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        tx.cancellationBatch.findMany.mockResolvedValue([]);
        await service.update(ACTIVITY, change(), user);
        expect(tx.cancellationBatch.findMany).toHaveBeenCalledWith({
          where: { academicYearId: YEAR, reversedAt: null, fromDate: { lte: day('2026-11-12') }, toDate: { gte: day('2026-11-12') }, id: { not: BATCH } },
          select: expect.anything(),
        });
        const written = tx.cancellationBatch.update.mock.invocationCallOrder[0]!;
        expect(written).toBeLessThan(tx.cancellationBatch.findMany.mock.invocationCallOrder[0]!);
      });

      it('tells the class and the board of the lesson that came back and the day it came back to, and broadcasts it', async () => {
        shrink();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        await service.update(ACTIVITY, change(), user);
        // What is newly cancelled, and what is back (l2, carried).
        expect(digest).toHaveBeenCalledTimes(2);
        expect(digest.mock.calls[1][5]).toBe(true);
        expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, expect.arrayContaining(['l2']));
        expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-12');
      });

      it('says nothing of a lesson that came back to a day another batch took it for: the digest would say it is back when it is cancelled again', async () => {
        shrink();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        // Studiedag takes Thursday 12 Nov, where l2 was carried to: it is held there, and cancelled with that one.
        tx.cancellationBatch.findMany.mockResolvedValue([
          batchRow({ id: 'studiedag', name: 'Studiedag', fromDate: day('2026-11-12'), toDate: day('2026-11-12'), groupIds: [G7A] }),
        ]);
        world.pending = [lesson('l2', '2026-11-12', { startsAt: instant('2026-11-12T06:00'), endsAt: instant('2026-11-12T07:00') })];
        await service.update(ACTIVITY, change(), user);
        expect(tx.cancellationBatchLesson.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ batchId: 'studiedag', calendarLessonId: 'l2' })] });
        // Only what is newly cancelled is told of; nothing "comes back".
        expect(digest).toHaveBeenCalledTimes(1);
        expect(digest.mock.calls[0][5]).toBe(false);
      });

      it('lets the board hear of the day the lesson was carried to when that is before the activity’s own days', async () => {
        // The activity is Wed–Thu 11–12 Nov and becomes Wed only. l2 (Thursday) is released, and its template went to Monday 9 Nov.
        world.activity = activityRow({}, { fromDate: day('2026-11-11'), toDate: day('2026-11-12') });
        const thursday = { startsAt: instant('2026-11-12T06:00'), endsAt: instant('2026-11-12T07:00') };
        world.candidates = [lesson('l1', '2026-11-11', { status: 'CANCELLED', batchLessons: [{ batchId: BATCH }] }), lesson('l2', '2026-11-12', { ...thursday, status: 'CANCELLED', batchLessons: [{ batchId: BATCH }] })];
        world.owned = owned(['l1', '2026-11-11'], ['l2', '2026-11-12']);
        world.digestRows = [{ id: 'l2', date: day('2026-11-12'), subjectId: MA, studentGroupId: G7A, extraGroups: [] }];
        world.reverse = [
          {
            previousNote: null,
            calendarLesson: { id: 'l2', date: day('2026-11-12'), ...thursday, status: 'CANCELLED', cancelCause: 'EVENT', roomId: null, masterLessonId: 'm2', studentGroupId: G7A, _count: { attendanceRecords: 0 } },
          },
        ];
        tx.masterLesson.findMany.mockResolvedValue(moved({ dayOfWeek: 1 }));
        const result = await service.update(ACTIVITY, change({ fromDate: '2026-11-11', toDate: '2026-11-11' }), user);
        expect(result.released).toBe(1);
        expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ date: day('2026-11-09') }) }));
        expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-12');
      });

      it('deletes the old row as before when the lesson already stands on its new day, and holds nothing', async () => {
        shrink();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        const reads = tx.calendarLesson.findMany.getMockImplementation();
        tx.calendarLesson.findMany.mockImplementation(async (query: { where: Record<string, any> }) =>
          query.where.masterLessonId ? [{ masterLessonId: 'm2', date: day('2026-11-12') }] : reads ? reads(query) : [],
        );
        tx.cancellationBatch.findMany.mockClear();
        const result = await service.update(ACTIVITY, change(), user);
        expect(result.released).toBe(0);
        expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l2'] } }) }));
        expect(tx.cancellationBatchLesson.deleteMany).toHaveBeenCalledWith({ where: { batchId: BATCH, calendarLessonId: { in: ['l2'] } } });
      });
    });

    it('does not put back a lesson that a replacement lesson that was held stands for (a removal’s rule)', async () => {
      shrink();
      // 7A's replacement lesson on 10 Nov has begun: l2 stays cancelled with it.
      world.owned = owned(['l1', '2026-11-09'], ['l2', '2026-11-10'], ['l3', '2026-11-09']);
      world.scheduleLessons = [
        {
          studentGroupId: G7A,
          date: day('2026-11-10'),
          calendarLesson: { id: 'r-held', startsAt: instant('2026-11-05T07:00'), _count: { attendanceRecords: 0 } },
        },
      ];
      expect((await service.updatePreview(ACTIVITY, change(), user)).change).toEqual({ released: 0, taken: 1 });
      tx.calendarLesson.updateMany.mockClear();

      const result = await service.update(ACTIVITY, change(), user);

      expect(result).toMatchObject({ released: 0, taken: 1 });
      expect(tx.calendarLesson.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }),
      );
      expect(tx.cancellationBatchLesson.deleteMany).not.toHaveBeenCalled();
      // It is still told of what is newly cancelled, and of nothing coming back.
      expect(digest).toHaveBeenCalledTimes(1);
    });

    it('puts back what it no longer takes, takes what is new, and writes the rest again', async () => {
      shrink();
      const result = await service.update(ACTIVITY, change({ teachers: [{ studentGroupId: G7A, teacherId: T2 }] }), user);

      expect(result).toMatchObject({ released: 1, taken: 1 });
      // 10 Nov back to scheduled with the note it had, and out of the avbokning.
      expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['l2'] }, status: 'CANCELLED', cancelCause: 'EVENT' },
        data: { status: 'SCHEDULED', cancelCause: null, note: 'Gammal anteckning' },
      });
      expect(tx.cancellationBatchLesson.deleteMany).toHaveBeenCalledWith({ where: { batchId: BATCH, calendarLessonId: { in: ['l2'] } } });
      // The new name on the lessons that stay cancelled.
      expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ note: 'Inställd: Friluftsdag åk 7' }),
          data: { note: 'Inställd: Utedag åk 7' },
        }),
      );
      expect(tx.cancellationBatch.update).toHaveBeenCalledWith({
        where: { id: BATCH },
        data: expect.objectContaining({ name: 'Utedag åk 7', toDate: day('2026-11-09'), notifies: true }),
      });
      expect(tx.cancellationBatchLesson.createMany).toHaveBeenCalledWith({
        data: [{ batchId: BATCH, calendarLessonId: 'l3', schoolId: SCHOOL, previousNote: null }],
      });
      expect(tx.scheduleActivity.update).toHaveBeenCalledWith({
        where: { id: ACTIVITY },
        data: expect.objectContaining({ replacementSubjectId: TEMADAG, scopeGroupIds: [G7A] }),
      });
      expect(tx.scheduleActivityTeacher.deleteMany).toHaveBeenCalledWith({ where: { activityId: ACTIVITY } });
      expect(tx.scheduleActivityTeacher.createMany).toHaveBeenCalledWith({
        data: [{ studentGroupId: G7A, teacherId: T2, role: 'LEAD', activityId: ACTIVITY, schoolId: SCHOOL }],
      });
      // The credits ahead are the school's word again: the old ones go, the new are written for the lessons it holds.
      expect(tx.timplanCredit.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c1', 'c2'] } } });
      expect(writeCredit).toHaveBeenCalledTimes(1);
      expect(writeCredit.mock.calls[0][2]).toMatchObject({ date: '2026-11-09', minutes: 180, name: 'Utedag åk 7' });
      expect(tx.cancellationBatch.update).toHaveBeenCalledWith({ where: { id: BATCH }, data: { cancelled: 2 } });
      // Those whose day moved are told of exactly that: what is newly cancelled and what is back.
      expect(digest).toHaveBeenCalledTimes(2);
      expect(digest.mock.calls[0][5]).toBe(false);
      expect(digest.mock.calls[1][5]).toBe(true);
      expect(realtime.notifyLessonsChanged).toHaveBeenCalled();
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-10');
    });

    it('moves a lesson whose template has moved out of the calendar instead of reinstating it', async () => {
      shrink();
      tx.masterLesson.findMany.mockResolvedValue([]);
      const result = await service.update(ACTIVITY, change(), user);
      expect(result.released).toBe(0);
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l2'] } }) }),
      );
      expect(tx.cancellationBatchLesson.deleteMany).toHaveBeenCalledWith({ where: { batchId: BATCH, calendarLessonId: { in: ['l2'] } } });
    });

    it('leaves a lesson where its room has been taken, and reports it as put back by no one', async () => {
      shrink();
      (world.reverse[0] as { calendarLesson: { roomId: string | null } }).calendarLesson.roomId = 'room-1';
      tx.calendarLesson.findFirst.mockResolvedValueOnce({ id: 'other' });
      expect((await service.update(ACTIVITY, change({ notify: false }), user)).released).toBe(0);
      expect(digest).not.toHaveBeenCalled();

      (world.reverse[0] as { calendarLesson: { roomId: string | null } }).calendarLesson.roomId = 'room-2';
      tx.calendarLesson.findFirst.mockResolvedValue(null);
      tx.roomBooking.findFirst.mockResolvedValueOnce({ id: 'booking' });
      expect((await service.update(ACTIVITY, change({ notify: false }), user)).released).toBe(0);

      tx.roomBooking.findFirst.mockResolvedValue(null);
      expect((await service.update(ACTIVITY, change({ notify: false }), user)).released).toBe(1);
    });

    it('leaves the avbokning alone when only the text changes', async () => {
      world.activity = activityRow({}, { name: 'Friluftsdag åk 7' });
      world.candidates = world.owned.map((entry) =>
        lesson((entry as { id: string }).id, asDate(entry), { status: 'CANCELLED', batchLessons: [{ batchId: BATCH }] }),
      );
      const result = await service.update(ACTIVITY, create({ description: 'Orientering', credits: [], teachers: [] }), user);
      expect(result).toMatchObject({ released: 0, taken: 0 });
      expect(tx.cancellationBatchLesson.createMany).not.toHaveBeenCalled();
      expect(tx.cancellationBatchLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.scheduleActivityTeacher.createMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ note: expect.any(String) }) }));
      // No lesson newly cancelled and none back: nobody is told.
      expect(digest).not.toHaveBeenCalled();
    });

    it('widens the range the board refreshes to the old and the new days', async () => {
      world.activity = activityRow();
      world.candidates = [lesson('l1', '2026-11-09', { status: 'CANCELLED', batchLessons: [{ batchId: BATCH }] })];
      world.owned = owned(['l1', '2026-11-09']);
      await service.update(ACTIVITY, create({ fromDate: '2026-11-09', toDate: '2026-11-12', credits: [] }), user);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-12');
    });

    it('answers 409 when the plan has changed since the preview', async () => {
      shrink();
      expect(await code(service.update(ACTIVITY, change({ expectedDigest: 'a'.repeat(64) }), user))).toBe('CANCELLATION_STALE');
      expect(tx.scheduleActivity.update).not.toHaveBeenCalled();
    });

    it('does not move an activity to another year', async () => {
      const error = await service.update(ACTIVITY, change({ academicYearId: 'other' }), user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CANCELLATION_SCOPE' });
    });

    it('refuses an activity that is not there, was removed, or whose avbokning was reversed', async () => {
      world.activity = null;
      await expect(service.update(ACTIVITY, change(), user)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updatePreview(ACTIVITY, change(), user)).rejects.toBeInstanceOf(NotFoundException);
      world.activity = activityRow({ removedAt: new Date('2026-11-01T00:00:00.000Z') });
      expect(await code(service.update(ACTIVITY, change(), user))).toBe(ACTIVITY_REMOVED);
      world.activity = activityRow({}, { reversedAt: new Date('2026-11-01T00:00:00.000Z') });
      expect(await code(service.update(ACTIVITY, change(), user))).toBe('CANCELLATION_REVERSED');
    });
  });

  describe('removing', () => {
    const ahead = { id: 'r-ahead', startsAt: instant('2026-11-10T07:00'), _count: { attendanceRecords: 0 } };
    const held = { id: 'r-held', startsAt: instant('2026-11-05T07:00'), _count: { attendanceRecords: 0 } };
    const marked = { id: 'r-marked', startsAt: instant('2026-11-10T07:00'), _count: { attendanceRecords: 5 } };
    const link = (calendarLesson: typeof ahead, studentGroupId: string, date: string) => ({ studentGroupId, date: day(date), calendarLesson });

    function lessons() {
      world.scheduleLessons = [link(ahead, G7A, '2026-11-10'), link(held, G7B, '2026-11-09'), link(marked, G7A, '2026-11-09')];
      // 7B's replacement lesson was held for l1, so l1 stays cancelled with it.
      world.lessonPupils = { l1: ['p1', 'p3'] };
      world.activity = activityRow({ scopeGroupIds: [G7A, G7B] });
      world.reverse = [
        {
          previousNote: null,
          calendarLesson: {
            id: 'l2',
            date: day('2026-11-10'),
            startsAt: instant('2026-11-10T06:00'),
            endsAt: instant('2026-11-10T07:00'),
            status: 'CANCELLED',
            cancelCause: 'EVENT',
            roomId: null,
            masterLessonId: 'm2',
            studentGroupId: G7A,
            _count: { attendanceRecords: 0 },
          },
        },
      ];
      world.digestRows = [{ id: 'l2', date: day('2026-11-10'), subjectId: MA, studentGroupId: G7A, extraGroups: [] }];
      tx.masterLesson.findMany.mockResolvedValue([
        {
          id: 'm2',
          isParked: false,
          dayOfWeek: 2,
          startTime: new Date('1970-01-01T07:00:00.000Z'),
          endTime: new Date('1970-01-01T08:00:00.000Z'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      ]);
    }

    it('shows what goes, what stays with the day that was held, and who is told', async () => {
      lessons();
      expect(await service.removePreview(ACTIVITY, user)).toEqual({
        reinstate: 1,
        notify: 1,
        replacementsDeleted: 1,
        replacementsKept: 2,
        creditsDeleted: 2,
        skippedRoomTaken: [],
        removedTemplateMoved: [],
        relocated: [],
        notReinstatable: 0,
      });
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.scheduleActivity.update).not.toHaveBeenCalled();
    });

    /**
     * THE GRUNDSCHEMA WAS MOVED AFTER THE ACTIVITY (the exam's unplan, review of #286): l2 was Tuesday 10 Nov 07:00-08:00 and the
     * template went to Thursday, written after the activity was made. A DIRECT edit moves the rows it can carry and wrote none for
     * Thursday, so the cancelled Tuesday row is the class's lesson that week: the removal carries it to Thursday 12 Nov, a lesson again.
     */
    describe('a lesson whose template moved after the activity', () => {
      const moved = (over: Record<string, unknown> = {}) => [
        {
          id: 'm2',
          isParked: false,
          updatedAt: new Date('2026-11-03T08:00:00.000Z'),
          dayOfWeek: 4,
          startTime: new Date('1970-01-01T07:00:00.000Z'),
          endTime: new Date('1970-01-01T08:00:00.000Z'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          ...over,
        },
      ];

      it('names the lesson it will carry, and does not count it as put back or as deleted', async () => {
        lessons();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        const preview = await service.removePreview(ACTIVITY, user);
        expect(preview).toMatchObject({
          reinstate: 0,
          removedTemplateMoved: [],
          relocated: [{ lessonId: 'l2', from: '2026-11-10', to: '2026-11-12' }],
        });
      });

      it('writes the lesson at its new day and hours, scheduled, and tells the class as it tells of any lesson it puts back', async () => {
        lessons();
        tx.masterLesson.findMany.mockResolvedValue(moved({ roomId: 'room-new', teacherId: 'teacher-new' }));
        tx.cancellationBatch.findMany.mockResolvedValue([]);
        const result = await service.remove(ACTIVITY, user);

        expect(result).toMatchObject({ reinstate: 0, notify: 3, relocated: [{ lessonId: 'l2', from: '2026-11-10', to: '2026-11-12' }] });
        expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith({
          where: { id: 'l2', status: 'CANCELLED', cancelCause: 'EVENT', startsAt: { gt: NOW }, attendanceRecords: { none: {} } },
          data: {
            date: day('2026-11-12'),
            startsAt: instant('2026-11-12T06:00'),
            endsAt: instant('2026-11-12T07:00'),
            roomId: 'room-new',
            status: 'SCHEDULED',
            cancelCause: null,
            note: null,
          },
        });
        expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: 'l2', role: 'LEAD', teacherId: { not: 'teacher-new' } } });
        // Not deleted, and counted among the lessons that came back for the notices and the board.
        expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l2'] }, status: 'CANCELLED' }) }));
        expect(digest).toHaveBeenCalledTimes(1);
        expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, ['l2']);
        // The board hears of the new day as well as of the activity's own days.
        expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-12');
      });

      it('holds the carried lesson against the batches still on, after this activity is marked removed (it must not take its own lesson back)', async () => {
        lessons();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        tx.cancellationBatch.findMany.mockResolvedValue([]);
        await service.remove(ACTIVITY, user);
        expect(tx.cancellationBatch.findMany).toHaveBeenCalledWith({
          where: { academicYearId: YEAR, reversedAt: null, fromDate: { lte: day('2026-11-12') }, toDate: { gte: day('2026-11-12') } },
          select: expect.anything(),
        });
        const [marked] = tx.cancellationBatch.update.mock.invocationCallOrder;
        const [held] = tx.cancellationBatch.findMany.mock.invocationCallOrder;
        expect(marked).toBeLessThan(held!);
        // A lesson that came back carried is a lesson that came back: the history says one, not none.
        expect(tx.cancellationBatch.update).toHaveBeenCalledWith({
          where: { id: BATCH },
          data: expect.objectContaining({ reinstated: 1, skippedRoomTaken: 0 }),
        });
      });

      it('deletes the old row as before when the lesson already stands on its new day', async () => {
        lessons();
        tx.masterLesson.findMany.mockResolvedValue(moved());
        tx.calendarLesson.findMany.mockImplementation(async ({ where }) => {
          if (where.masterLessonId) return [{ masterLessonId: 'm2', date: day('2026-11-12') }];
          if (where.id?.in) return world.digestRows;
          return [];
        });
        const result = await service.remove(ACTIVITY, user);
        expect(result).toMatchObject({ relocated: [], removedTemplateMoved: [{ lessonId: 'l2', date: '2026-11-10' }] });
        expect(tx.cancellationBatch.findMany).not.toHaveBeenCalled();
      });
    });

    it('reaches nobody for an activity that told nobody', async () => {
      lessons();
      world.activity = activityRow({ scopeGroupIds: [G7A, G7B] }, { notifies: false });
      expect((await service.removePreview(ACTIVITY, user)).notify).toBe(0);
    });

    it('puts back every lesson when no replacement lesson was held', async () => {
      lessons();
      world.scheduleLessons = [link(ahead, G7A, '2026-11-10')];
      const preview = await service.removePreview(ACTIVITY, user);
      expect(preview).toMatchObject({ replacementsDeleted: 1, replacementsKept: 0 });
      // Nothing was held, so the rosters of the lessons were never needed.
      expect(lessonRosters).not.toHaveBeenCalled();
    });

    it('puts the lessons back, deletes the replacement lessons ahead and the credits ahead, and tells those it reinstates', async () => {
      lessons();
      const result = await service.remove(ACTIVITY, user);

      expect(result).toMatchObject({ reinstate: 1, notify: 3, replacementsDeleted: 1, replacementsKept: 2, creditsDeleted: 2 });
      expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['l2'] }, status: 'CANCELLED', cancelCause: 'EVENT' },
        data: { status: 'SCHEDULED', cancelCause: null, note: null },
      });
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['r-ahead'] }, startsAt: { gt: NOW }, attendanceRecords: { none: {} } },
      });
      expect(tx.timplanCredit.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c1', 'c2'] } } });
      expect(tx.cancellationBatch.update).toHaveBeenCalledWith({
        where: { id: BATCH },
        data: { reversedAt: NOW, reversedByUserId: user.userId, reinstated: 1, skippedRoomTaken: 0 },
      });
      expect(tx.scheduleActivity.update).toHaveBeenCalledWith({
        where: { id: ACTIVITY },
        data: { removedAt: NOW, removedByUserId: user.userId, updatedAt: NOW },
      });
      expect(digest).toHaveBeenCalledTimes(1);
      expect(digest.mock.calls[0][5]).toBe(true);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-10');
      expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, ['l2']);
    });

    it('deletes nothing and tells nobody when there is nothing to delete and the activity told nobody', async () => {
      lessons();
      world.scheduleLessons = [];
      world.creditIds = [];
      world.reverse = [];
      world.activity = activityRow({}, { notifies: false });
      const result = await service.remove(ACTIVITY, user);
      expect(result).toMatchObject({ reinstate: 0, notify: 0, replacementsDeleted: 0, creditsDeleted: 0 });
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.timplanCredit.deleteMany).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
      expect(realtime.notifyLessonsChanged).not.toHaveBeenCalled();
    });

    it('answers 409 when a register was saved on a replacement lesson after the plan was read, and removes nothing', async () => {
      lessons();
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      expect(await code(service.remove(ACTIVITY, user))).toBe('CANCELLATION_STALE');
    });

    it('lets its caller undo something in the same transaction first: after the publication lock, before the plan is read', async () => {
      lessons();
      const order: string[] = [];
      tx.cancellationBatchLesson.findMany.mockImplementation(async () => {
        order.push('plan read');
        return [];
      });
      await service.remove(ACTIVITY, user, async (inside) => {
        expect(inside).toBe(tx);
        order.push('before removal');
      });
      expect(order[0]).toBe('before removal');
      expect(order).toContain('plan read');
      expect(tx.scheduleActivity.update).toHaveBeenCalledTimes(1);
    });

    it('removes nothing when what the caller undid first fails', async () => {
      lessons();
      await expect(
        service.remove(ACTIVITY, user, async () => {
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
      expect(tx.calendarLesson.updateMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.scheduleActivity.update).not.toHaveBeenCalled();
      expect(tx.cancellationBatch.update).not.toHaveBeenCalled();
    });

    it('is done once: an activity already removed answers 409', async () => {
      world.activity = activityRow({ removedAt: NOW });
      expect(await code(service.remove(ACTIVITY, user))).toBe(ACTIVITY_REMOVED);
      expect(await code(service.removePreview(ACTIVITY, user))).toBe(ACTIVITY_REMOVED);
    });
  });

  describe('an activity an exam carries', () => {
    it('is refused a change or a removal from here: the exam changes and removes it', async () => {
      tx.exam.findFirst.mockResolvedValue({ id: 'exam-1' });
      expect(await code(service.refuseWhenAnExam(ACTIVITY, user))).toBe(ACTIVITY_OWNED_BY_EXAM);
      expect(tx.exam.findFirst).toHaveBeenCalledWith({ where: { activityId: ACTIVITY }, select: { id: true } });
    });

    it('is left to the activities page when no exam holds it', async () => {
      tx.exam.findFirst.mockResolvedValue(null);
      await expect(service.refuseWhenAnExam(ACTIVITY, user)).resolves.toBeUndefined();
    });
  });
});

function asDate(entry: unknown): string {
  return (entry as { date: Date }).date.toISOString().slice(0, 10);
}
