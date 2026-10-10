import { ConflictException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import { CoverService } from './cover.service';
import { SUPERVISED_STUDY_NOTE } from './cover-decisions';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const LESSON = '44444444-4444-4444-8444-444444444444';
const LESSON_B = '45454545-4545-4545-8545-454545454545';
const ABSENCE = '55555555-5555-4555-8555-555555555555';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const NOW = new Date('2026-10-14T06:00:00.000Z');
const START = new Date('2026-10-14T08:00:00.000Z');
const END = new Date('2026-10-14T09:00:00.000Z');

type Teacher = { teacherId: string; role: 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE' };

describe('CoverService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let realtime: { notifyLessonChanged: jest.Mock; notifyLessonsChanged: jest.Mock; notifyCoverBoardChanged: jest.Mock };
  let notifications: { notifyUsers: jest.Mock; recipientsForGroups: jest.Mock };
  let cover: CoverService;
  let calendar: CalendarLessonsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = {
      notifyLessonChanged: jest.fn().mockResolvedValue(undefined),
      notifyLessonsChanged: jest.fn().mockResolvedValue(undefined),
      notifyCoverBoardChanged: jest.fn(),
    };
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), recipientsForGroups: jest.fn().mockResolvedValue([]) };
    calendar = new CalendarLessonsService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );
    cover = new CoverService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
      calendar,
    );
    jest.spyOn(cover, 'now').mockReturnValue(NOW);
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
  });

  const lessonRow = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON,
    schoolId: SCHOOL,
    status: 'SCHEDULED',
    cancelCause: null,
    note: null,
    date: new Date('2026-10-14T00:00:00.000Z'),
    startsAt: START,
    endsAt: END,
    roomId: null,
    subjectId: 'subj',
    studentGroupId: 'grp',
    subject: { name: 'Matematik' },
    teachers: [{ teacherId: A, role: 'LEAD' }] as Teacher[],
    extraGroups: [],
    participants: [],
    ...overrides,
  });

  const decision = (overrides: Record<string, unknown> = {}) => ({
    id: 'dec-1',
    absenceId: ABSENCE,
    calendarLessonId: LESSON,
    absentTeacherId: A,
    removedTeachers: [{ teacherId: A, role: 'LEAD' }],
    decision: 'SUBSTITUTE',
    substituteId: S,
    previousNote: null,
    decidedAt: new Date('2026-10-13T12:00:00.000Z'),
    ...overrides,
  });

  /** The world: one absence of A over the day, the lesson, and the decisions on it. */
  const world = (lesson: Record<string, unknown> = {}, decisions: Record<string, unknown>[] = [], away: string[] = []) => {
    tx.teacherAbsence.findUnique.mockResolvedValue({
      id: ABSENCE,
      userId: A,
      startsAt: new Date('2026-10-13T22:00:00.000Z'),
      endsAt: new Date('2026-10-14T22:00:00.000Z'),
      status: 'ACTIVE',
    });
    tx.calendarLesson.findUnique.mockResolvedValue(lessonRow(lesson));
    tx.teacherAbsenceCover.findMany.mockResolvedValue(decisions);
    tx.teacherAbsence.findMany.mockResolvedValue(away.map((userId) => ({ id: `abs-${userId}`, userId, startsAt: START, endsAt: END })));
    tx.user.findUnique.mockResolvedValue({ id: S, role: 'TEACHER', isActive: true });
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    tx.calendarLesson.update.mockResolvedValue({ id: LESSON, status: 'SCHEDULED', note: null });
    // What the notices after the commit read of the lesson.
    tx.calendarLesson.findMany.mockResolvedValue([{ id: LESSON, startsAt: START, studentGroupId: 'grp', roomId: null, subjectId: 'subj' }]);
  };

  const codeOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    return (error as { getResponse?: () => { code?: string } } | null)?.getResponse?.().code ?? String(error);
  };

  describe('decide', () => {
    it('SUBSTITUTE replaces only the absent teacher, under the publication lock, and records the decision', async () => {
      world({ teachers: [{ teacherId: A, role: 'LEAD' }, { teacherId: B, role: 'ASSISTANT' }] });
      const order: string[] = [];
      tx.$queryRaw = jest.fn().mockImplementation(() => {
        order.push('publication');
        return Promise.resolve([]);
      });
      tx.$executeRaw = jest.fn().mockImplementation((sql: { sql: string }) => {
        order.push(sql.sql.includes('FOR UPDATE') ? 'lesson' : 'teacher');
        return Promise.resolve(1);
      });

      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, testUser());

      expect(order.slice(0, 3)).toEqual(['publication', 'lesson', 'teacher']);
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({
        where: { calendarLessonId: LESSON, teacherId: { in: [A] } },
      });
      expect(tx.teacherAbsenceCover.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          absenceId: ABSENCE,
          absentTeacherId: A,
          decision: 'SUBSTITUTE',
          removedTeachers: [{ teacherId: A, role: 'LEAD' }],
          substituteId: S,
        }),
      });
      // After the commit: the substitute's notice, the teacher apps, the board.
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, expect.objectContaining({ userIds: [S], type: 'LESSON_SUBSTITUTE' }));
      expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, [LESSON]);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-10-14', '2026-10-14');
    });

    it('a stale SUBSTITUTE decision (its substitute gone) is replaced in place, keeping the rows it removed', async () => {
      world({ teachers: [] }, [decision({ substituteId: T })]);

      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, testUser());

      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
      expect(tx.teacherAbsenceCover.update).toHaveBeenCalledWith({
        where: { id: 'dec-1' },
        data: expect.objectContaining({ decision: 'SUBSTITUTE', substituteId: S, removedTeachers: [{ teacherId: A, role: 'LEAD' }] }),
      });
    });

    it('a stale SUBSTITUTE decision whose substitute is away themself: the new substitute takes THEIR row, and they are told', async () => {
      world({ teachers: [{ teacherId: T, role: 'SUBSTITUTE' }] }, [decision({ substituteId: T })], [T]);

      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, testUser());

      // One vikarie on the lesson, not the away one beside the new one.
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({
        where: { calendarLessonId: LESSON, teacherId: { in: [T] } },
      });
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, expect.objectContaining({ userIds: [T], type: 'LESSON_COVER_WITHDRAWN' }));
    });

    it('COVER_STALE when the status the admin saw is not the status now, with the current one', async () => {
      world({ teachers: [] }, [decision({ decision: 'CO_TEACHER', substituteId: null })]);
      const error = await cover
        .decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }, testUser())
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'COVER_STALE', params: { current: 'HANDLED' } });
      expect(await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'HANDLED' }, testUser()))).toBe(
        'COVER_STALE',
      );
    });

    it('COVER_LESSON_HELD for a lesson that has ended; COVER_LESSON_STARTED for a cancel once it has begun', async () => {
      world({ startsAt: new Date('2026-10-14T04:00:00.000Z'), endsAt: new Date('2026-10-14T05:00:00.000Z') });
      expect(await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUPERVISED_STUDY', expected: 'OPEN' }, testUser()))).toBe(
        'COVER_LESSON_HELD',
      );
      world({ startsAt: new Date('2026-10-14T05:30:00.000Z'), endsAt: new Date('2026-10-14T06:30:00.000Z') });
      expect(await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }, testUser()))).toBe(
        'COVER_LESSON_STARTED',
      );
      // Självstudier is still possible until it ends.
      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUPERVISED_STUDY', expected: 'OPEN' }, testUser());
    });

    it('COVER_NOT_AFFECTED when the absent teacher is not on the lesson and nothing was decided; 404 for an unknown absence', async () => {
      world({ teachers: [{ teacherId: B, role: 'LEAD' }] });
      expect(await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }, testUser()))).toBe(
        'COVER_NOT_AFFECTED',
      );
      tx.teacherAbsence.findUnique.mockResolvedValue(null);
      await expect(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }, testUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('CANCELLED cancels with TEACHER_UNAVAILABLE and no reason, and records the decision removing nobody', async () => {
      world();
      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }, testUser());
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED', note: null, cancelCause: 'TEACHER_UNAVAILABLE' } }),
      );
      expect(tx.teacherAbsenceCover.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ decision: 'CANCELLED', removedTeachers: [], substituteId: null }),
      });
    });

    it('SUPERVISED_STUDY removes the absent row, writes the constant note and keeps the old one', async () => {
      world({ note: 'Ta med miniräknare' });
      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUPERVISED_STUDY', expected: 'OPEN' }, testUser());
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: LESSON, teacherId: A } });
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({ where: { id: LESSON }, data: { note: SUPERVISED_STUDY_NOTE } });
      expect(tx.teacherAbsenceCover.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ decision: 'SUPERVISED_STUDY', previousNote: 'Ta med miniräknare' }),
      });
      // No notice: the class reads the lesson and its note.
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('CO_TEACHER needs another teacher who is present; an absent co-teacher does not count', async () => {
      world({ teachers: [{ teacherId: A, role: 'LEAD' }, { teacherId: B, role: 'ASSISTANT' }] }, [], [B]);
      expect(await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CO_TEACHER', expected: 'OPEN' }, testUser()))).toBe(
        'CO_TEACHER_MISSING',
      );
      world({ teachers: [{ teacherId: A, role: 'LEAD' }, { teacherId: B, role: 'ASSISTANT' }] });
      await cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CO_TEACHER', expected: 'OPEN' }, testUser());
      expect(tx.teacherAbsenceCover.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ decision: 'CO_TEACHER', removedTeachers: [{ teacherId: A, role: 'LEAD' }] }),
      });
    });

    it('SUBSTITUTE needs its substitute; the others take none', async () => {
      world();
      expect(await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUBSTITUTE', expected: 'OPEN' }, testUser()))).toBe(
        'COVER_SUBSTITUTE_REQUIRED',
      );
      expect(
        await codeOf(cover.decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', substituteId: S, expected: 'OPEN' }, testUser())),
      ).toBe('COVER_SUBSTITUTE_REQUIRED');
    });

    it('maps a database refusal to a coded 4xx and logs no row (a CHECK carries reasonId in "Failing row contains")', async () => {
      world();
      const { Prisma } = jest.requireActual('@prisma/client');
      const failing = new Prisma.PrismaClientKnownRequestError('Failing row contains (secret-reason-id)', {
        code: 'P2039',
        clientVersion: 'x',
        meta: { driverAdapterError: { cause: { originalCode: '23514', originalMessage: 'violates check constraint "X_is_sane". Failing row contains (secret-reason-id)' } } },
      });
      tx.teacherAbsenceCover.create.mockRejectedValue(failing);
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        jest.spyOn((cover as unknown as { logger: Record<string, (m: string) => void> }).logger, level).mockImplementation((m: string) => {
          logged.push(m);
        });
      }
      const error = await cover
        .decide(LESSON, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }, testUser())
        .catch((e: unknown) => e);
      expect((error as { getStatus: () => number }).getStatus()).toBe(400);
      expect(JSON.stringify((error as { getResponse: () => unknown }).getResponse())).not.toContain('secret-reason-id');
      expect(logged.join('\n')).not.toContain('secret-reason-id');
    });
  });

  describe('undo', () => {
    it('a SUBSTITUTE decision: the substitute leaves (and is told), the removed rows come back, the decision goes', async () => {
      world({ teachers: [{ teacherId: B, role: 'ASSISTANT' }, { teacherId: S, role: 'SUBSTITUTE' }] }, [
        decision({ removedTeachers: [{ teacherId: A, role: 'LEAD' }] }),
      ]);

      await cover.undo(LESSON, ABSENCE, testUser());

      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({
        where: { calendarLessonId: LESSON, teacherId: S, role: 'SUBSTITUTE' },
      });
      expect(tx.calendarLessonTeacher.createMany).toHaveBeenCalledWith({
        data: [{ schoolId: SCHOOL, calendarLessonId: LESSON, teacherId: A, role: 'LEAD' }],
      });
      expect(tx.teacherAbsenceCover.delete).toHaveBeenCalledWith({ where: { id: 'dec-1' } });
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, expect.objectContaining({ userIds: [S], type: 'LESSON_COVER_WITHDRAWN' }));
    });

    it('an old-style wipe undone restores the co-teacher too', async () => {
      world({ teachers: [{ teacherId: S, role: 'SUBSTITUTE' }] }, [
        decision({ removedTeachers: [{ teacherId: A, role: 'LEAD' }, { teacherId: B, role: 'ASSISTANT' }] }),
      ]);
      await cover.undo(LESSON, ABSENCE, testUser());
      expect(tx.calendarLessonTeacher.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: SCHOOL, calendarLessonId: LESSON, teacherId: A, role: 'LEAD' },
          { schoolId: SCHOOL, calendarLessonId: LESSON, teacherId: B, role: 'ASSISTANT' },
        ],
      });
    });

    it('is LIFO per lesson: a decision with a later one on the lesson is COVER_UNDO_ORDER', async () => {
      world({ teachers: [{ teacherId: S, role: 'SUBSTITUTE' }] }, [
        decision(),
        decision({ id: 'dec-2', absenceId: 'other', absentTeacherId: B, decidedAt: new Date('2026-10-13T13:00:00.000Z') }),
      ]);
      expect(await codeOf(cover.undo(LESSON, ABSENCE, testUser()))).toBe('COVER_UNDO_ORDER');
      expect(tx.teacherAbsenceCover.delete).not.toHaveBeenCalled();
    });

    it('never a second LEAD: a lesson given a new lead since is COVER_UNDO_CONFLICT', async () => {
      world({ teachers: [{ teacherId: T, role: 'LEAD' }] }, [decision({ decision: 'SUPERVISED_STUDY', substituteId: null })]);
      expect(await codeOf(cover.undo(LESSON, ABSENCE, testUser()))).toBe('COVER_UNDO_CONFLICT');
    });

    it('never a teacher who now teaches elsewhere then: COVER_UNDO_CLASH', async () => {
      world({ teachers: [] }, [decision({ decision: 'CO_TEACHER', substituteId: null })]);
      tx.calendarLesson.findFirst.mockResolvedValue({ id: 'elsewhere' });
      expect(await codeOf(cover.undo(LESSON, ABSENCE, testUser()))).toBe('COVER_UNDO_CLASH');
    });

    it('a substitute shared by two decisions stays until the last of them is undone', async () => {
      world({ teachers: [{ teacherId: S, role: 'SUBSTITUTE' }] }, [
        decision({ id: 'dec-0', absenceId: 'abs-b', absentTeacherId: B, removedTeachers: [{ teacherId: B, role: 'ASSISTANT' }], decidedAt: new Date('2026-10-13T11:00:00.000Z') }),
        decision(),
      ]);
      await cover.undo(LESSON, ABSENCE, testUser());
      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLessonTeacher.createMany).toHaveBeenCalledWith({
        data: [{ schoolId: SCHOOL, calendarLessonId: LESSON, teacherId: A, role: 'LEAD' }],
      });
    });

    it('CANCELLED reinstates only its own cancellation; SUPERVISED_STUDY gives the note back only if it is still the constant', async () => {
      world({ status: 'CANCELLED', cancelCause: 'TEACHER_UNAVAILABLE', teachers: [{ teacherId: A, role: 'LEAD' }] }, [
        decision({ decision: 'CANCELLED', removedTeachers: [], substituteId: null }),
      ]);
      await cover.undo(LESSON, ABSENCE, testUser());
      expect(tx.calendarLesson.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SCHEDULED', cancelCause: null } }));

      tx.calendarLesson.update.mockClear();
      world({ status: 'CANCELLED', cancelCause: 'EVENT', teachers: [{ teacherId: A, role: 'LEAD' }] }, [
        decision({ decision: 'CANCELLED', removedTeachers: [], substituteId: null }),
      ]);
      await cover.undo(LESSON, ABSENCE, testUser());
      expect(tx.calendarLesson.update).not.toHaveBeenCalled();

      world({ note: SUPERVISED_STUDY_NOTE, teachers: [] }, [decision({ decision: 'SUPERVISED_STUDY', substituteId: null, previousNote: 'Gammal' })]);
      await cover.undo(LESSON, ABSENCE, testUser());
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({ where: { id: LESSON }, data: { note: 'Gammal' } });
    });

    it('404 COVER_NO_DECISION without one; COVER_LESSON_HELD once the lesson has ended', async () => {
      world({}, []);
      expect(await codeOf(cover.undo(LESSON, ABSENCE, testUser()))).toBe('COVER_NO_DECISION');
      world({ endsAt: new Date('2026-10-14T05:00:00.000Z'), startsAt: new Date('2026-10-14T04:00:00.000Z') }, [decision()]);
      expect(await codeOf(cover.undo(LESSON, ABSENCE, testUser()))).toBe('COVER_LESSON_HELD');
    });
  });

  describe('bulk', () => {
    it('is all or nothing: the second item’s refusal names its lesson, and nobody is told anything', async () => {
      world();
      tx.calendarLesson.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === LESSON
            ? lessonRow()
            : lessonRow({ id: LESSON_B, startsAt: new Date('2026-10-14T04:00:00.000Z'), endsAt: new Date('2026-10-14T05:00:00.000Z') }),
        ),
      );
      const error = await cover
        .bulk(
          {
            action: 'CANCELLED',
            items: [
              { lessonId: LESSON, absenceId: ABSENCE, expected: 'OPEN' },
              { lessonId: LESSON_B, absenceId: ABSENCE, expected: 'OPEN' },
            ],
          },
          testUser(),
        )
        .catch((e: unknown) => e);
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({ code: 'COVER_LESSON_HELD', params: { lessonId: LESSON_B } });
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
      expect(realtime.notifyCoverBoardChanged).not.toHaveBeenCalled();
    });

    it('UNDO takes the decisions on one lesson newest first, whatever order the board sent them in', async () => {
      const ABSENCE_B = '56565656-5656-4565-8565-565656565656';
      world({ teachers: [{ teacherId: S, role: 'SUBSTITUTE' }] });
      // A covered by S at 06:00, then B's "the co-teacher holds" at 06:30.
      let rows = [
        decision({ id: 'dec-a', decidedAt: new Date('2026-10-14T04:00:00.000Z') }),
        decision({
          id: 'dec-b',
          absenceId: ABSENCE_B,
          absentTeacherId: B,
          removedTeachers: [{ teacherId: B, role: 'ASSISTANT' }],
          decision: 'CO_TEACHER',
          substituteId: null,
          decidedAt: new Date('2026-10-14T04:30:00.000Z'),
        }),
      ];
      tx.teacherAbsenceCover.findMany.mockImplementation(() => Promise.resolve(rows));
      tx.teacherAbsenceCover.delete.mockImplementation(({ where }: { where: { id: string } }) => {
        rows = rows.filter((row) => row.id !== where.id);
        return Promise.resolve({});
      });

      await expect(
        cover.bulk(
          {
            action: 'UNDO',
            items: [
              { lessonId: LESSON, absenceId: ABSENCE, expected: 'COVERED' },
              { lessonId: LESSON, absenceId: ABSENCE_B, expected: 'HANDLED' },
            ],
          },
          testUser(),
        ),
      ).resolves.toEqual({ done: 2 });
      expect(tx.teacherAbsenceCover.delete.mock.calls.map(([arg]) => arg.where.id)).toEqual(['dec-b', 'dec-a']);
      expect(rows).toEqual([]);
    });

    it('locks every lesson, then every person an UNDO could restore, each in id order, before the first item', async () => {
      world({ teachers: [{ teacherId: S, role: 'SUBSTITUTE' }] }, [
        decision({ removedTeachers: [{ teacherId: B, role: 'ASSISTANT' }, { teacherId: A, role: 'LEAD' }] }),
      ]);
      const locks: string[] = [];
      tx.$executeRaw = jest.fn().mockImplementation((sql: { sql: string; values: unknown[] }) => {
        locks.push(`${sql.sql.includes('FOR UPDATE') ? 'lesson' : 'teacher'}:${String(sql.values[0])}`);
        return Promise.resolve(1);
      });
      await cover.bulk(
        {
          action: 'UNDO',
          items: [{ lessonId: LESSON, absenceId: ABSENCE, expected: 'COVERED' }],
        },
        testUser(),
      ).catch(() => undefined);
      expect(locks.slice(0, 3)).toEqual([`lesson:${LESSON}`, `teacher:${A}`, `teacher:${B}`]);
    });
  });

  it('the board refuses a window over seven days or backwards', async () => {
    expect(await codeOf(cover.board('2026-10-14', '2026-10-21', testUser()))).toBe('COVER_RANGE');
    expect(await codeOf(cover.board('2026-10-14', '2026-10-13', testUser()))).toBe('COVER_RANGE');
  });

  it('the board maps the pairs, the summary and the absences’ periods — never a reason', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        absenceId: ABSENCE,
        absentTeacherId: A,
        lessonId: LESSON,
        isLive: true,
        decisionId: null,
        decision: null,
        decidedAt: null,
        removedTeachers: null,
        date: '2026-10-14',
        startsAt: START,
        endsAt: END,
        subjectId: 'subj',
        studentGroupId: 'grp',
        roomId: null,
        lessonStatus: 'SCHEDULED',
        cancelCause: null,
        absenceStartsAt: new Date('2026-10-13T22:00:00.000Z'),
        absenceEndsAt: new Date('2026-10-14T22:00:00.000Z'),
        absenceStatus: 'ACTIVE',
        teachers: [{ teacherId: A, role: 'LEAD' }],
        extraGroupIds: [],
        coveringSubstituteIds: [],
      },
    ]);
    tx.teacherAbsence.findMany.mockResolvedValue([
      { id: ABSENCE, userId: A, startsAt: new Date('2026-10-13T22:00:00.000Z'), endsAt: new Date('2026-10-14T22:00:00.000Z') },
    ]);
    const board = await cover.board('2026-10-14', '2026-10-14', testUser());
    expect(board.summary).toEqual({ open: 1, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 });
    expect(board.absences).toEqual([
      { id: ABSENCE, userId: A, startsAt: '2026-10-13T22:00:00.000Z', endsAt: '2026-10-14T22:00:00.000Z' },
    ]);
    expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, userId: true, startsAt: true, endsAt: true } }),
    );
    expect(JSON.stringify(board)).not.toMatch(/"reason(Id)?":/);
  });

  it('after the commit a failing notice is logged by count and never fails the write', async () => {
    world();
    notifications.notifyUsers.mockRejectedValue(new Error('down'));
    await expect(
      cover.decide(LESSON, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, testUser()),
    ).resolves.toMatchObject({ lessonId: LESSON });
    expect(realtime.notifyCoverBoardChanged).toHaveBeenCalled();
  });

  it('a decision on a lesson nobody can reach is 404 before anything is written', async () => {
    world();
    tx.calendarLesson.findUnique.mockResolvedValue(null);
    await expect(cover.undo(LESSON, ABSENCE, testUser())).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.teacherAbsenceCover.delete).not.toHaveBeenCalled();
  });
});
