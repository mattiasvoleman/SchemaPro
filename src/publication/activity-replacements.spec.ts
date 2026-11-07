import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { calendarLessonRosters, rostersOf } from '../calendar/lesson-roster';
import {
  loadGroupFacts,
  memberHomes,
  ownersWithPupils,
  planOf,
  syncReplacementsInTransaction,
  type ReplacedLesson,
} from './activity-replacements';
import type { GroupFacts, ScopeRule } from './activity-plan';

// The roster reader answers from the database; what a roster is, is its own
// spec's. Here it says who is on which lesson and in which class.
jest.mock('../calendar/lesson-roster', () => ({
  rostersOf: jest.fn(),
  calendarLessonRosters: jest.fn(),
}));
const rosters = rostersOf as jest.MockedFunction<typeof rostersOf>;
const lessonRosters = calendarLessonRosters as jest.MockedFunction<typeof calendarLessonRosters>;

const NOW = new Date('2026-11-05T09:00:00.000Z');
const SCHOOL = 'school';
const BATCH = 'batch';
const ACTIVITY = 'activity';
const SUBJECT = 'temadag';

const instant = (iso: string) => new Date(`${iso}:00.000Z`);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const CLASSES: GroupFacts[] = [
  { id: 'g7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: 'g7b', name: '7B', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
];

const activity = (overrides: Record<string, unknown> = {}) => ({
  id: ACTIVITY,
  academicYearId: 'year',
  replacementSubjectId: SUBJECT,
  description: 'Vandring',
  scopeGroupIds: ['g7a', 'g7b'],
  batch: {
    name: 'Friluftsdag',
    cause: 'EVENT',
    scope: 'GROUPS',
    minGradeLevel: null,
    maxGradeLevel: null,
    fromDate: day('2026-11-09'),
    toDate: day('2026-11-10'),
  },
  teachers: [
    { studentGroupId: 'g7a', teacherId: 't1', role: 'LEAD' },
    { studentGroupId: 'g7a', teacherId: 't2', role: 'ASSISTANT' },
    { studentGroupId: 'g7b', teacherId: 't3', role: 'LEAD' },
  ],
  ...overrides,
});

const cancelled = (id: string, from: string, to: string, date = from.slice(0, 10)): ReplacedLesson => ({
  id,
  date: day(date),
  startsAt: instant(from),
  endsAt: instant(to),
  subjectId: 'ma',
  studentGroupId: 'g7a',
  extraGroups: [],
});

/** A replacement lesson already written, as the sync reads it. */
const written = (overrides: Record<string, unknown> = {}, lesson: Record<string, unknown> = {}) => ({
  calendarLessonId: 'r1',
  studentGroupId: 'g7a',
  date: day('2026-11-09'),
  calendarLesson: {
    id: 'r1',
    startsAt: instant('2026-11-09T08:00'),
    endsAt: instant('2026-11-09T11:00'),
    note: 'Friluftsdag: Vandring',
    status: 'SCHEDULED',
    _count: { attendanceRecords: 0 },
    teachers: [
      { id: 'row1', teacherId: 't1', role: 'LEAD' },
      { id: 'row2', teacherId: 't2', role: 'ASSISTANT' },
    ],
    ...lesson,
  },
  ...overrides,
});

describe('replacement lessons of an activity', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;

  /** The pupils of each owner (class), and of each cancelled lesson. */
  function world(options: {
    activityRow?: ReturnType<typeof activity> | null;
    owned?: ReplacedLesson[];
    existing?: ReturnType<typeof written>[];
    ownerPupils?: Record<string, string[]>;
    lessonPupils?: Record<string, string[]>;
  }) {
    const ownerPupils = options.ownerPupils ?? { g7a: ['p1', 'p2'], g7b: ['p3'] };
    const lessonPupils = options.lessonPupils ?? {};
    tx.scheduleActivity.findFirst.mockResolvedValue(options.activityRow === undefined ? activity() : options.activityRow);
    tx.calendarLesson.findMany.mockResolvedValue(options.owned ?? []);
    tx.studentGroup.findMany.mockResolvedValue(CLASSES);
    tx.scheduleActivityLesson.findMany.mockResolvedValue(options.existing ?? []);
    rosters.mockImplementation(async (_tx, scopes) => scopes.map((scope) => new Set(ownerPupils[scope.groupIds[0]] ?? [])));
    lessonRosters.mockImplementation(async (_tx, lessons) => {
      const out = new Map<string, Set<string>>();
      for (const lesson of lessons) out.set(lesson.id, new Set(lessonPupils[lesson.id] ?? ['p1']));
      return out;
    });
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    tx.calendarLesson.create.mockResolvedValue({ id: 'new-lesson' });
    tx.calendarLesson.deleteMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  describe('what it reads', () => {
    it('gives the groups of a year as the planner reads them', async () => {
      tx.studentGroup.findMany.mockResolvedValue([
        { id: 'g7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null, extra: 'dropped' },
      ]);
      expect(await loadGroupFacts(client(), 'year')).toEqual([
        { id: 'g7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
      ]);
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { academicYearId: 'year' } }));
    });

    it('asks nothing for no groups', async () => {
      expect(await memberHomes(client(), [])).toEqual(new Map());
      expect(tx.studentGroupMember.findMany).not.toHaveBeenCalled();
    });

    it('asks for active pupils only: a pupil who has left ties no group to another class', async () => {
      await memberHomes(client(), ['sp']);
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGroupId: { in: ['sp'] }, student: { role: 'STUDENT', isActive: true } },
        }),
      );
    });

    it("gives each teaching group the home class of its members, 'none' for a pupil with no class", async () => {
      tx.studentGroupMember.findMany.mockResolvedValue([
        { studentGroupId: 'sp', student: { studentGroupId: 'g7a' } },
        { studentGroupId: 'sp', student: { studentGroupId: 'g7b' } },
        { studentGroupId: 'sp', student: { studentGroupId: null } },
        { studentGroupId: 'ty', student: { studentGroupId: 'g7a' } },
      ]);
      expect(await memberHomes(client(), ['sp', 'ty'])).toEqual(
        new Map([
          ['sp', ['g7a', 'g7b', 'none']],
          ['ty', ['g7a']],
        ]),
      );
    });

    it('reads the pupils of each owner by the replacement subject', async () => {
      world({ ownerPupils: { g7a: ['p1', 'p2'], g7b: ['p3'] } });
      const rule: ScopeRule = { scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: ['g7b', 'g7a'] };
      const { owners, planOwners } = await ownersWithPupils(client(), rule, CLASSES, SUBJECT);
      expect(owners.map((owner) => owner.name)).toEqual(['7A', '7B']);
      expect(planOwners).toEqual([
        { groupId: 'g7a', pupils: new Set(['p1', 'p2']) },
        { groupId: 'g7b', pupils: new Set(['p3']) },
      ]);
      expect(rosters).toHaveBeenCalledWith(
        tx,
        [
          { subjectId: SUBJECT, groupIds: ['g7a'], participantIds: [] },
          { subjectId: SUBJECT, groupIds: ['g7b'], participantIds: [] },
        ],
        { pupils: 'ACTIVE' },
      );
    });

    it('reads the days each owner is off school from the breaks inside the activity', async () => {
      world({ ownerPupils: { g7a: ['p1'], g7b: ['p3'] } });
      const rule: ScopeRule = { scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: ['g7a', 'g7b'] };
      const lessons: GroupFacts[] = [CLASSES[0], { ...CLASSES[1], gradeLevel: 8 }];
      tx.schoolBreak.findMany.mockResolvedValue([
        // Studiedag for åk 7 only, and a lov for the whole school one day later.
        { startDate: day('2026-11-09'), endDate: day('2026-11-09'), minGradeLevel: 7, maxGradeLevel: 7 },
        { startDate: day('2026-11-10'), endDate: day('2026-11-10'), minGradeLevel: null, maxGradeLevel: null },
      ]);
      const { planOwners } = await ownersWithPupils(client(), rule, lessons, SUBJECT, {
        academicYearId: 'year',
        from: '2026-11-09',
        to: '2026-11-10',
      });
      expect(planOwners.map((owner) => [owner.groupId, [...(owner.closed ?? [])]])).toEqual([
        ['g7a', ['2026-11-09', '2026-11-10']],
        ['g7b', ['2026-11-10']],
      ]);
      expect(tx.schoolBreak.findMany).toHaveBeenCalledWith({
        where: { academicYearId: 'year', startDate: { lte: day('2026-11-10') }, endDate: { gte: day('2026-11-09') } },
        select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
      });
    });

    it('asks for no breaks without the activity\'s days', async () => {
      world({});
      await ownersWithPupils(client(), { scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: ['g7a'] }, CLASSES, SUBJECT);
      expect(tx.schoolBreak.findMany).not.toHaveBeenCalled();
    });

    it('plans a lesson per class and day, and counts the pupils no class holds', async () => {
      world({ lessonPupils: { a: ['p1'], b: ['p9'] } });
      const lessons = [cancelled('a', '2026-11-09T08:00', '2026-11-09T09:00'), cancelled('b', '2026-11-09T10:00', '2026-11-09T11:00')];
      const { planOwners } = await ownersWithPupils(
        client(),
        { scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: ['g7a'] },
        CLASSES,
        SUBJECT,
      );
      const { plan, planLessons, uncovered, uncoveredIds } = await planOf(client(), lessons, planOwners);
      expect(plan).toEqual([
        { groupId: 'g7a', date: '2026-11-09', startsAt: instant('2026-11-09T08:00'), endsAt: instant('2026-11-09T09:00'), lessonIds: ['a'] },
      ]);
      expect(planLessons.map((lesson) => lesson.id)).toEqual(['a', 'b']);
      expect(uncovered).toBe(1);
      expect([...uncoveredIds]).toEqual(['p9']);
    });

    it('reads a lesson with no roster as nobody', async () => {
      world({});
      lessonRosters.mockResolvedValue(new Map());
      const { plan } = await planOf(client(), [cancelled('a', '2026-11-09T08:00', '2026-11-09T09:00')], [
        { groupId: 'g7a', pupils: new Set(['p1']) },
      ]);
      expect(plan).toEqual([]);
    });
  });

  describe('syncReplacementsInTransaction', () => {
    const sync = () => syncReplacementsInTransaction(client(), SCHOOL, BATCH, NOW);

    it('writes nothing for an avbokning no activity owns, or one that was removed', async () => {
      world({ activityRow: null });
      expect(await sync()).toEqual({ created: [], updated: [], deleted: [], kept: [] });
      expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.create).not.toHaveBeenCalled();
    });

    it('writes one lesson per class and day, from the first start to the last end, with the teachers responsible', async () => {
      world({
        owned: [
          cancelled('a', '2026-11-09T08:00', '2026-11-09T09:00'),
          cancelled('b', '2026-11-09T10:00', '2026-11-09T11:00'),
          cancelled('c', '2026-11-10T08:00', '2026-11-10T09:00'),
        ],
        lessonPupils: { a: ['p1'], b: ['p2'], c: ['p1'] },
      });
      tx.calendarLesson.create.mockResolvedValueOnce({ id: 'new-1' }).mockResolvedValueOnce({ id: 'new-2' });

      const result = await sync();

      expect(result).toEqual({ created: ['new-1', 'new-2'], updated: [], deleted: [], kept: [] });
      expect(tx.calendarLesson.create).toHaveBeenNthCalledWith(1, {
        data: {
          schoolId: SCHOOL,
          masterLessonId: null,
          subjectId: SUBJECT,
          studentGroupId: 'g7a',
          date: day('2026-11-09'),
          startsAt: instant('2026-11-09T08:00'),
          endsAt: instant('2026-11-09T11:00'),
          status: 'SCHEDULED',
          note: 'Friluftsdag: Vandring',
          teachers: {
            create: [
              { teacherId: 't1', role: 'LEAD' },
              { teacherId: 't2', role: 'ASSISTANT' },
            ],
          },
        },
        select: { id: true },
      });
      expect(tx.scheduleActivityLesson.create).toHaveBeenNthCalledWith(1, {
        data: { activityId: ACTIVITY, calendarLessonId: 'new-1', studentGroupId: 'g7a', date: day('2026-11-09'), schoolId: SCHOOL },
      });
      expect(tx.scheduleActivityLesson.create).toHaveBeenCalledTimes(2);
    });

    it('gives each class with a pupil on a cancelled lesson its own lesson, with no teacher where nobody is responsible', async () => {
      world({
        activityRow: activity({ teachers: [], description: null }),
        owned: [cancelled('a', '2026-11-09T08:00', '2026-11-09T09:00')],
        lessonPupils: { a: ['p1', 'p3'] },
      });
      tx.calendarLesson.create.mockResolvedValueOnce({ id: 'n-a' }).mockResolvedValueOnce({ id: 'n-b' });
      const result = await sync();
      expect(result.created).toEqual(['n-a', 'n-b']);
      expect(tx.calendarLesson.create.mock.calls[0][0].data).toMatchObject({ note: 'Friluftsdag', teachers: { create: [] } });
    });

    it('writes no lesson for a day the class is off school, though the lessons cancelled that day are still there', async () => {
      world({
        owned: [cancelled('a', '2026-11-09T08:00', '2026-11-09T09:00'), cancelled('b', '2026-11-10T08:00', '2026-11-10T09:00')],
        lessonPupils: { a: ['p1'], b: ['p1'] },
      });
      tx.schoolBreak.findMany.mockResolvedValue([
        { startDate: day('2026-11-10'), endDate: day('2026-11-10'), minGradeLevel: null, maxGradeLevel: null },
      ]);
      expect((await sync()).created).toEqual(['new-lesson']);
      expect(tx.calendarLesson.create).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.create.mock.calls[0][0].data.date).toEqual(day('2026-11-09'));
    });

    it('gives a day that has begun no replacement after the fact', async () => {
      world({ owned: [cancelled('a', '2026-11-05T07:00', '2026-11-05T08:00')] });
      expect((await sync()).created).toEqual([]);
      expect(tx.calendarLesson.create).not.toHaveBeenCalled();
      expect(tx.scheduleActivityLesson.create).not.toHaveBeenCalled();
    });

    it('writes nothing a second time over the same calendar', async () => {
      world({
        owned: [cancelled('a', '2026-11-09T08:00', '2026-11-09T11:00')],
        existing: [written()],
      });
      expect(await sync()).toEqual({ created: [], updated: [], deleted: [], kept: [] });
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.update).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.delete).not.toHaveBeenCalled();
    });

    it('moves a lesson to the span its cancelled lessons make now, and corrects its text and subject', async () => {
      world({
        owned: [cancelled('a', '2026-11-09T07:30', '2026-11-09T12:00')],
        existing: [written({}, { note: 'Gammalt namn' })],
      });
      const result = await sync();
      expect(result.updated).toEqual(['r1']);
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: {
          startsAt: instant('2026-11-09T07:30'),
          endsAt: instant('2026-11-09T12:00'),
          note: 'Friluftsdag: Vandring',
          subjectId: SUBJECT,
        },
      });
    });

    it('rewrites only the text when the span is the same', async () => {
      world({
        owned: [cancelled('a', '2026-11-09T08:00', '2026-11-09T11:00')],
        existing: [written({}, { note: 'Gammalt namn' })],
      });
      expect((await sync()).updated).toEqual(['r1']);
      expect(tx.calendarLesson.update).toHaveBeenCalledTimes(1);
    });

    it('lets the teachers follow the activity: a role changed, a teacher taken off, one added, a substitute left', async () => {
      world({
        owned: [cancelled('a', '2026-11-09T08:00', '2026-11-09T11:00')],
        existing: [
          written(
            {},
            {
              teachers: [
                { id: 'row1', teacherId: 't1', role: 'ASSISTANT' },
                { id: 'row9', teacherId: 't9', role: 'LEAD' },
                { id: 'rowS', teacherId: 't7', role: 'SUBSTITUTE' },
              ],
            },
          ),
        ],
      });
      const result = await sync();
      expect(result.updated).toEqual(['r1']);
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.update).toHaveBeenCalledWith({ where: { id: 'row1' }, data: { role: 'LEAD' } });
      expect(tx.calendarLessonTeacher.delete).toHaveBeenCalledTimes(1);
      expect(tx.calendarLessonTeacher.delete).toHaveBeenCalledWith({ where: { id: 'row9' } });
      expect(tx.calendarLessonTeacher.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL, calendarLessonId: 'r1', teacherId: 't2', role: 'ASSISTANT' },
      });
    });

    it('does not add a teacher who is already on the lesson as its substitute', async () => {
      world({
        owned: [cancelled('a', '2026-11-09T08:00', '2026-11-09T11:00')],
        existing: [
          written(
            {},
            {
              teachers: [
                { id: 'row1', teacherId: 't1', role: 'LEAD' },
                { id: 'rowS', teacherId: 't2', role: 'SUBSTITUTE' },
              ],
            },
          ),
        ],
      });
      expect((await sync()).updated).toEqual([]);
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    it.each([
      ['has begun', { startsAt: instant('2026-11-05T08:00') }],
      ['carries attendance', { _count: { attendanceRecords: 3 } }],
      ['was cancelled by hand', { status: 'CANCELLED' }],
    ])('leaves a replacement lesson that %s as it was held', async (_name, lesson) => {
      world({
        owned: [cancelled('a', '2026-11-09T07:00', '2026-11-09T12:00')],
        existing: [written({}, { note: 'Annat', ...lesson })],
      });
      expect(await sync()).toEqual({ created: [], updated: [], deleted: [], kept: [] });
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.create).not.toHaveBeenCalled();
    });

    it('deletes a lesson ahead that no cancelled lesson needs any more', async () => {
      world({ owned: [], existing: [written()] });
      expect(await sync()).toEqual({ created: [], updated: [], deleted: ['r1'], kept: [] });
      // With the guard in the statement, so that a register saved since the read goes nowhere.
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: { id: 'r1', startsAt: { gt: NOW }, attendanceRecords: { none: {} } },
      });
      // Nothing cancelled, so nothing was asked of the rosters of lessons.
      expect(lessonRosters).not.toHaveBeenCalled();
    });

    it('keeps a lesson whose register was saved between the read and the delete', async () => {
      world({ owned: [], existing: [written()] });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      expect(await sync()).toEqual({ created: [], updated: [], deleted: [], kept: ['r1'] });
    });

    it('keeps a lesson that no cancelled lesson needs if it has begun or carries attendance', async () => {
      world({
        owned: [],
        existing: [
          written({ calendarLessonId: 'began', date: day('2026-11-04') }, { id: 'began', startsAt: instant('2026-11-04T08:00') }),
          written({ calendarLessonId: 'held', studentGroupId: 'g7b' }, { id: 'held', _count: { attendanceRecords: 2 } }),
        ],
      });
      expect(await sync()).toEqual({ created: [], updated: [], deleted: [], kept: ['began', 'held'] });
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });
  });
});
