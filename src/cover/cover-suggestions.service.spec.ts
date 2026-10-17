import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import type { CoverService } from './cover.service';
import { basisOf, CoverSuggestionsService } from './cover-suggestions.service';
import { yearTargetMinutesPerWeek } from '../staffing/teacher-load';

jest.mock('../staffing/staffing-enforcement', () => ({
  attendanceSpan: jest.fn().mockResolvedValue({ min: 7, max: 7 }),
}));

const D = '2026-10-14';
const LESSON = '44444444-4444-4444-8444-444444444444';
const ABSENCE = '55555555-5555-4555-8555-555555555555';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BUSY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const START = new Date('2026-10-14T08:00:00.000Z'); // 10:00 Stockholm
const END = new Date('2026-10-14T09:00:00.000Z');
const NOW = new Date('2026-10-14T05:00:00.000Z');

describe('CoverSuggestionsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let cover: { now: jest.Mock; write: jest.Mock; decideInTransaction: jest.Mock; afterCommit: jest.Mock };
  let service: CoverSuggestionsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    cover = {
      now: jest.fn().mockReturnValue(NOW),
      write: jest.fn((_user, body: (client: unknown) => unknown) => Promise.resolve(body(tx))),
      decideInTransaction: jest.fn().mockResolvedValue({ lessonIds: [LESSON], dates: [D], notices: [], classNotices: [], warnings: [] }),
      afterCommit: jest.fn().mockResolvedValue(undefined),
    };
    service = new CoverSuggestionsService(prisma as unknown as PrismaService, cover as unknown as CoverService);

    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.academicYear.findFirst.mockResolvedValue({
      id: 'year',
      isActive: true,
      predecessorId: null,
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
    });
    tx.calendarLesson.findMany.mockImplementation((query: { where: { id?: unknown; date?: unknown } }) =>
      Promise.resolve(
        query.where.id
          ? [
              {
                id: LESSON,
                schoolId: 'school',
                date: new Date(`${D}T00:00:00.000Z`),
                startsAt: START,
                endsAt: END,
                subjectId: 'ma',
                studentGroupId: '7a',
                teachers: [{ teacherId: A }],
                extraGroups: [],
                participants: [],
              },
            ]
          : [{ id: LESSON, startsAt: START, endsAt: END, status: 'SCHEDULED', teachers: [{ teacherId: A, role: 'LEAD' }] }],
      ),
    );
    tx.user.findMany.mockResolvedValue([
      { id: A, role: 'TEACHER', isActive: true },
      { id: BUSY, role: 'TEACHER', isActive: true },
      { id: P, role: 'TEACHER', isActive: true },
      { id: S, role: 'TEACHER', isActive: true },
    ]);
    tx.calendarLessonTeacher.findMany.mockImplementation((query: { where: { teacherId?: unknown; role?: string } }) => {
      if (query.where.teacherId) {
        return Promise.resolve([
          { teacherId: A, calendarLesson: { id: LESSON, date: new Date(`${D}T00:00:00Z`), startsAt: START, endsAt: END, status: 'SCHEDULED', studentGroupId: '7a', subjectId: 'ma' } },
          { teacherId: BUSY, calendarLesson: { id: 'other', date: new Date(`${D}T00:00:00Z`), startsAt: START, endsAt: END, status: 'SCHEDULED', studentGroupId: '8a', subjectId: 'sv' } },
          { teacherId: S, calendarLesson: { id: 'early', date: new Date(`${D}T00:00:00Z`), startsAt: new Date('2026-10-14T06:00:00Z'), endsAt: new Date('2026-10-14T07:00:00Z'), status: 'SCHEDULED', studentGroupId: '8a', subjectId: 'ma' } },
        ]);
      }
      if (query.where.role === 'SUBSTITUTE') {
        return Promise.resolve([{ teacherId: S, calendarLesson: { date: new Date(`${D}T00:00:00Z`), startsAt: START, endsAt: END } }]);
      }
      return Promise.resolve([{ teacherId: S, calendarLesson: { startsAt: START, endsAt: END } }]);
    });
    tx.teacherAbsence.findMany.mockResolvedValue([
      { id: ABSENCE, userId: A, startsAt: new Date('2026-10-13T22:00:00Z'), endsAt: new Date('2026-10-14T22:00:00Z') },
    ]);
    tx.substitutePoolMember.findMany.mockResolvedValue([{ userId: P }]);
    tx.substituteAvailability.findMany.mockResolvedValue([
      { userId: P, startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T16:00:00Z') },
    ]);
    tx.teacherEmployment.findMany.mockResolvedValue([
      { userId: S, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: 900, signature: null },
    ]);
    tx.teacherSubjectQualification.findMany.mockResolvedValue([
      { userId: S, subjectId: 'ma', minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    ]);
    tx.teachingRequirement.findMany.mockResolvedValue([{ teacherId: S, coTeacherId: null, studentGroupId: '7a', subjectId: 'ma' }]);
    tx.teacherDuty.findMany.mockResolvedValue([]);
    tx.staffingPolicy.findUnique.mockResolvedValue({ fullTimeTeachingMinutesPerWeek: 900, overAllocationTolerancePercent: 10 });
    tx.coverSettings.findUnique.mockResolvedValue({ poolPreference: 'LAST_RESORT' });
    tx.subject.findMany.mockResolvedValue([{ id: 'ma', name: 'Matematik' }]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: '7a', name: '7A' }]);
  });

  describe('a post that changes during the year', () => {
    const period = (validFrom: string, teachingTargetMinutesPerWeek: number) => ({
      userId: S,
      validFrom: new Date(`${validFrom}T00:00:00Z`),
      validTo: null,
      employmentPercent: 50,
      reductionPercent: 0,
      teachingTargetMinutesPerWeek,
    });

    it('judges the lesson’s week by the post in force on its Monday: a period from then sets the target', async () => {
      // From Monday 12 October, a post with an own target of 30: 60 this week and the cover's 60 are over it.
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([period('2026-10-12', 30)]);
      const s = (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === S)!;
      expect(s.load).toEqual({ weekMinutes: 60, targetMinutes: 30 });
      expect(s.reasons.map((r) => r.code)).toContain('OVER_TARGET');
      expect(tx.teacherEmploymentPeriod.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ academicYearId: expect.any(String) }) }),
      );
    });

    it("states a changing post by the year's target to a reader without HR-läs, as the load report does (Roller i skolan)", async () => {
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([period('2026-10-12', 30)]);
      // Two weeks' break in the spring: the year weighs teaching weeks, as the report does.
      tx.schoolBreak.findMany.mockResolvedValue([
        { startDate: new Date('2027-02-15T00:00:00Z'), endDate: new Date('2027-02-26T00:00:00Z'), minGradeLevel: null, maxGradeLevel: null },
      ]);
      const planner = testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false });
      const yearOf = (closures: { startDate: string; endDate: string }[]) =>
        yearTargetMinutesPerWeek(
          {
            year: { startDate: '2026-08-17', endDate: '2027-06-11' },
            closures,
            requirements: [],
            duties: [],
            policy: { fullTimeTeachingMinutesPerWeek: 900, overAllocationTolerancePercent: 10, fullTimeRegulatedHoursPerYear: 1360, workDaysPerYear: 194, qualificationMode: 'WARN' },
          },
          {
            userId: S,
            employmentPercent: 100,
            reductionPercent: 0,
            contractKind: 'FERIE',
            teachingTargetMinutesPerWeek: 900,
            signature: null,
            periods: [{ validFrom: '2026-10-12', validTo: null, employmentPercent: 50, reductionPercent: 0, teachingTargetMinutesPerWeek: 30 }],
          },
        )!;
      const year = yearOf([{ startDate: '2027-02-15', endDate: '2027-02-26' }]);
      // The year lies between the autumn's 900 and the period's 30: not the week's.
      expect(year).toBeGreaterThan(30);
      expect(year).toBeLessThan(900);
      expect(year).not.toBe(yearOf([]));

      const s = (await service.candidates(LESSON, planner)).candidates.find((c) => c.userId === S)!;
      expect(s.load).toEqual({ weekMinutes: 60, targetMinutes: year });
      // The reason's minutes are read off the year's target as well, not the week's 30.
      expect(s.reasons.find((r) => r.code === 'UNDER_TARGET')?.params).toEqual({ minutes: year - 60 });
      expect(s.reasons.map((r) => r.code)).not.toContain('OVER_TARGET');

      // With HR-läs the week's period, as for a full administrator, and the
      // breaks are read only for the masked reader.
      tx.schoolBreak.findMany.mockClear();
      const withHr = (await service.candidates(LESSON, { ...planner, hrRead: true })).candidates.find((c) => c.userId === S)!;
      expect(withHr.load).toEqual({ weekMinutes: 60, targetMinutes: 30 });
      expect(tx.schoolBreak.findMany).not.toHaveBeenCalled();
    });

    it('leaves a week to the post it began with when a period starts mid-week, as the load report does', async () => {
      // From Wednesday 14 October, the lesson's own day: its week's Monday is still the post's own 900.
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([period('2026-10-14', 30)]);
      const s = (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === S)!;
      expect(s.load).toEqual({ weekMinutes: 60, targetMinutes: 900 });
      expect(s.reasons.map((r) => r.code)).toContain('UNDER_TARGET');
    });
  });

  it('candidates: the hard rules exclude with their codes; the rest ranked with reasons, behörig colleague before the pool', async () => {
    const answer = await service.candidates(LESSON, testUser());
    expect(answer.excluded).toEqual([
      { userId: A, codes: [{ code: 'ON_LESSON', params: {} }, { code: 'ABSENT', params: {} }] },
      { userId: BUSY, codes: [{ code: 'BUSY_LESSON', params: { lessonId: 'other' } }] },
    ]);
    expect(answer.candidates.map((c) => [c.userId, c.kind, c.qualificationKind])).toEqual([
      [S, 'STAFF', 'LEGITIMATION'],
      [P, 'POOL', null],
    ]);
    const s = answer.candidates[0]!;
    expect(s.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['QUAL_LEGITIMATION', 'TEACHES_GROUP_SUBJECT', 'ON_SITE', 'COUNTER_WEEK', 'UNDER_TARGET']),
    );
    expect(s.reasons.find((r) => r.code === 'QUAL_LEGITIMATION')?.params).toEqual({ subject: 'Matematik', grades: '7' });
    expect(s.counter).toEqual({ weekLessons: 1, termLessons: 1 });
    expect(s.load).toEqual({ weekMinutes: 60, targetMinutes: 900 });
    expect(answer.candidates[1]!.reasons.map((r) => r.code)).toContain('POOL_LAST');
    // The constraints and the absences are read without their free text and reasons.
    expect(tx.availabilityConstraint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, userId: true, startTime: true, endTime: true, type: true } }),
    );
    expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { userId: true, startsAt: true, endsAt: true } }),
    );
  });

  it('candidates record each candidate’s load and counter as EMPLOYMENT and the absent one as STAFF_ABSENCES, never one busy elsewhere', async () => {
    await service.candidates(LESSON, testUser({ channel: 'WEB' }));
    // A is excluded as ABSENT (and on the lesson); BUSY only for another lesson, the timetable's.
    expect(recordedReads(tx)).toEqual([
      { kind: 'EMPLOYMENT', channel: 'WEB', ids: [S, P] },
      { kind: 'STAFF_ABSENCES', channel: 'WEB', ids: [A] },
    ]);
  });

  it('candidates: a colleague whose own lesson then is cancelled is free and on site; one cancelled for an activity is ranked down, not up', async () => {
    const cancelled = (cancelCause: string) =>
      tx.calendarLessonTeacher.findMany.mockImplementation((query: { where: { teacherId?: unknown; role?: string } }) =>
        Promise.resolve(
          query.where.teacherId
            ? [
                { teacherId: A, calendarLesson: { id: LESSON, date: new Date(`${D}T00:00:00Z`), startsAt: START, endsAt: END, status: 'SCHEDULED', cancelCause: null, studentGroupId: '7a', subjectId: 'ma' } },
                { teacherId: BUSY, calendarLesson: { id: 'other', date: new Date(`${D}T00:00:00Z`), startsAt: START, endsAt: END, status: 'CANCELLED', cancelCause, studentGroupId: '8a', subjectId: 'sv' } },
              ]
            : [],
        ),
      );
    tx.studentGroup.findMany.mockResolvedValue([{ id: '7a', name: '7A' }, { id: '8a', name: '8A' }]);

    cancelled('MANUAL');
    const freed = (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === BUSY)!;
    expect(freed.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['ON_SITE', 'RELEASED']));
    expect(freed.reasons.map((r) => r.code)).not.toContain('NOT_ON_SITE');

    cancelled('EVENT');
    const away = (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === BUSY)!;
    expect(away.reasons.find((r) => r.code === 'AT_EVENT')).toEqual({ code: 'AT_EVENT', params: { group: '8A' }, points: -20 });
    expect(away.reasons.map((r) => r.code)).not.toContain('RELEASED');
  });

  it('candidates: a colleague whose lesson before ends at the other site too close to the cover is told so, and still offered', async () => {
    const NORRA = '10000000-0000-4000-8000-0000000000c1';
    const SODRA = '20000000-0000-4000-8000-0000000000c2';
    // The cover is in a room on Södra; S's own lesson before it, on Norra, ends at 09:55 Stockholm.
    tx.calendarLesson.findMany.mockImplementation((query: { where: { id?: unknown } }) =>
      Promise.resolve(
        query.where.id
          ? [{ id: LESSON, schoolId: 'school', date: new Date(`${D}T00:00:00.000Z`), startsAt: START, endsAt: END, subjectId: 'ma',
               studentGroupId: '7a', roomId: 'room-s', teachers: [{ teacherId: A }], extraGroups: [], participants: [] }]
          : [{ id: LESSON, startsAt: START, endsAt: END, status: 'SCHEDULED', teachers: [{ teacherId: A, role: 'LEAD' }] }],
      ),
    );
    tx.calendarLessonTeacher.findMany.mockImplementation((query: { where: { teacherId?: unknown } }) =>
      Promise.resolve(
        query.where.teacherId
          ? [
              { teacherId: A, calendarLesson: { id: LESSON, date: new Date(`${D}T00:00:00Z`), startsAt: START, endsAt: END, status: 'SCHEDULED', studentGroupId: '7a', subjectId: 'ma', roomId: 'room-s' } },
              { teacherId: S, calendarLesson: { id: 'early', date: new Date(`${D}T00:00:00Z`), startsAt: new Date('2026-10-14T07:00:00Z'), endsAt: new Date('2026-10-14T07:55:00Z'), status: 'SCHEDULED', studentGroupId: '8a', subjectId: 'ma', roomId: 'room-n' } },
            ]
          : [],
      ),
    );
    tx.siteTravelTime.findMany.mockResolvedValue([{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }]);
    tx.site.findMany.mockResolvedValue([{ id: NORRA, name: 'Norra' }, { id: SODRA, name: 'Södra' }]);
    tx.room.findMany.mockResolvedValue([{ id: 'room-n', siteId: NORRA }, { id: 'room-s', siteId: SODRA }]);

    const s = (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === S)!;
    expect(s.reasons[0]).toEqual({ code: 'TRAVEL_TOO_SHORT', params: { from: 'Norra', to: 'Södra', minutes: 15, gap: 5 }, points: -20 });

    // The same day with the pair given no figure: nothing is known, and nothing is said.
    tx.siteTravelTime.findMany.mockResolvedValue([]);
    const unknown = (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === S)!;
    expect(unknown.reasons.map((r) => r.code)).not.toContain('TRAVEL_TOO_SHORT');
  });

  it('candidates: the class’s mentor is the one holding the mentorskap on the lesson’s day, not one whose Till has passed', async () => {
    // 2026-10-14: S was 7A's mentor until 2026-09-30, a mentorship that names
    // nobody that day; from 2026-10-01 it is S again under a new uppdrag.
    const mentorship = (validFrom: string | null, validTo: string | null) => ({
      userId: S,
      studentGroupId: '7a',
      validFrom: validFrom ? new Date(`${validFrom}T00:00:00Z`) : null,
      validTo: validTo ? new Date(`${validTo}T00:00:00Z`) : null,
    });
    const reasonsOfS = async () =>
      (await service.candidates(LESSON, testUser())).candidates.find((c) => c.userId === S)!.reasons.map((r) => r.code);

    tx.teacherDuty.findMany.mockResolvedValue([mentorship(null, '2026-09-30')]);
    expect(await reasonsOfS()).not.toContain('MENTOR');
    tx.teacherDuty.findMany.mockResolvedValue([mentorship('2026-10-14', null)]);
    expect(await reasonsOfS()).toContain('MENTOR');
    tx.teacherDuty.findMany.mockResolvedValue([mentorship(null, null)]);
    expect(await reasonsOfS()).toContain('MENTOR');
    expect(tx.teacherDuty.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ select: { userId: true, studentGroupId: true, validFrom: true, validTo: true } }),
    );
  });

  describe('Lärarens dag', () => {
    const planner = (hrRead: boolean) => testUser({ adminProfile: 'SCHEMALAGGARE', hrRead, channel: 'WEB' });
    const isWeek = (query: { where: { teacherId?: unknown; calendarLesson?: { status?: unknown } } }) =>
      Boolean(query.where.teacherId && query.where.calendarLesson?.status);
    const rule = (userId: string, extra: Record<string, unknown>) => ({
      userId,
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
      ...extra,
    });
    /** S's post allows one teaching day a week, and S taught on Monday: the lesson's Wednesday would be a second. */
    const oneDayPost = () => {
      tx.teacherEmployment.findMany.mockResolvedValue([
        { userId: S, employmentPercent: 20, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: 900, signature: null, maxTeachingDaysPerWeek: 1 },
      ]);
      const dayRows = tx.calendarLessonTeacher.findMany.getMockImplementation()!;
      tx.calendarLessonTeacher.findMany.mockImplementation((query: Parameters<typeof isWeek>[0]) =>
        isWeek(query) ? Promise.resolve([{ teacherId: S, calendarLesson: { date: new Date('2026-10-12T00:00:00Z') } }]) : dayRows(query),
      );
    };
    const codesOf = (answer: { excluded: { userId: string; codes: unknown[] }[] }, userId: string) =>
      answer.excluded.find((entry) => entry.userId === userId)?.codes;

    it('the deltid in days excludes with its figure for a reader with HR-läs and without it for one without; logged as the post either way', async () => {
      oneDayPost();
      const full = await service.candidates(LESSON, testUser({ channel: 'WEB' }));
      expect(codesOf(full, S)).toEqual([{ code: 'WORK_DAYS', params: { days: 1 } }]);
      expect(full.candidates.map((c) => c.userId)).toEqual([P]);
      expect(recordedReads(tx)).toEqual([
        { kind: 'EMPLOYMENT', channel: 'WEB', ids: [P, S] },
        { kind: 'STAFF_ABSENCES', channel: 'WEB', ids: [A] },
      ]);

      tx.$executeRaw.mockClear();
      const hidden = await service.candidates(LESSON, planner(false));
      expect(codesOf(hidden, S)).toEqual([{ code: 'WORK_DAYS_HIDDEN', params: {} }]);
      expect(JSON.stringify(hidden)).not.toContain('"days"');
      // The same verdict, and the same read of S's post behind it.
      expect(hidden.candidates.map((c) => c.userId)).toEqual([P]);
      expect(recordedReads(tx)[0]).toEqual({ kind: 'EMPLOYMENT', channel: 'WEB', ids: [P, S] });

      expect(codesOf(await service.candidates(LESSON, planner(true)), S)).toEqual([{ code: 'WORK_DAYS', params: { days: 1 } }]);
      // The week asked of S alone, the one post with a limit.
      expect(tx.calendarLessonTeacher.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ teacherId: { in: [S] } }) }),
      );
    });

    it('a school whose posts set no limit asks no week', async () => {
      await service.candidates(LESSON, testUser());
      expect(tx.calendarLessonTeacher.findMany.mock.calls.filter(([query]) => isWeek(query))).toEqual([]);
    });

    it('the daily cap excludes with its minutes for every reader (staff read the work rule) and is not logged', async () => {
      // S's 08:00 lesson and the cover are 120 minutes; the cap is 90.
      tx.teacherWorkRule.findMany.mockResolvedValue([rule(S, { maxTeachingMinutesPerDay: 90 })]);
      const answer = await service.candidates(LESSON, planner(false));
      expect(codesOf(answer, S)).toEqual([{ code: 'DAILY_CAP', params: { minutes: 90 } }]);
      expect(recordedReads(tx)[0]).toEqual({ kind: 'EMPLOYMENT', channel: 'WEB', ids: [P] });
    });

    it('the free-day wish ranks down one who teaches nothing that Wednesday, not one who teaches then', async () => {
      tx.teacherWorkRule.findMany.mockResolvedValue([rule(S, { preferredFreeDayOfWeek: 3 }), rule(P, { preferredFreeDayOfWeek: 3 })]);
      const answer = await service.candidates(LESSON, testUser());
      const reasons = (userId: string) => answer.candidates.find((c) => c.userId === userId)!.reasons;
      expect(reasons(P)).toContainEqual({ code: 'FREE_DAY_WISH', params: {}, points: -10 });
      expect(reasons(S).map((r) => r.code)).not.toContain('FREE_DAY_WISH');
      // Thursday's wish is not Wednesday's.
      tx.teacherWorkRule.findMany.mockResolvedValue([rule(P, { preferredFreeDayOfWeek: 4 })]);
      const thursday = await service.candidates(LESSON, testUser());
      expect(thursday.candidates.find((c) => c.userId === P)!.reasons.map((r) => r.code)).not.toContain('FREE_DAY_WISH');
    });

    it('the proposal leaves the limited post out without naming it, and apply refuses an item the limit now refuses', async () => {
      oneDayPost();
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
          date: D,
          startsAt: START,
          endsAt: END,
          subjectId: 'ma',
          studentGroupId: '7a',
          roomId: null,
          lessonStatus: 'SCHEDULED',
          cancelCause: null,
          absenceStartsAt: new Date('2026-10-13T22:00:00Z'),
          absenceEndsAt: new Date('2026-10-14T22:00:00Z'),
          absenceStatus: 'ACTIVE',
          teachers: [{ teacherId: A, role: 'LEAD' }],
          extraGroupIds: [],
          coveringSubstituteIds: [],
        },
      ]);
      const proposal = await service.proposal(D, [], testUser({ channel: 'WEB' }));
      expect(proposal.items.map((item) => item.userId)).toEqual([P]);
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [P] }]);

      const basis = await basisOf(tx as never, D, 'Europe/Stockholm');
      await expect(
        service.apply(D, { basis, items: [{ lessonId: LESSON, absenceId: ABSENCE, userId: S }] }, testUser()),
      ).rejects.toMatchObject({ response: { code: 'COVER_PROPOSAL_STALE', params: { lessonId: LESSON } } });
      expect(cover.decideInTransaction).not.toHaveBeenCalled();
    });
  });

  it('candidates under LAST_RESORT: the pool after every colleague, whatever the points', async () => {
    const answer = await service.candidates(LESSON, testUser());
    expect(answer.candidates.map((c) => c.kind)).toEqual(['STAFF', 'POOL']);
  });

  it('candidates 404 for a lesson the caller cannot see', async () => {
    tx.calendarLesson.findMany.mockResolvedValue([]);
    await expect(service.candidates(LESSON, testUser())).rejects.toThrow('Lesson not found.');
  });

  describe('Fördela dagen', () => {
    const pair = {
      absenceId: ABSENCE,
      absentTeacherId: A,
      lessonId: LESSON,
      isLive: true,
      decisionId: null,
      decision: null,
      decidedAt: null,
      removedTeachers: null,
      date: D,
      startsAt: START,
      endsAt: END,
      subjectId: 'ma',
      studentGroupId: '7a',
      roomId: null,
      lessonStatus: 'SCHEDULED',
      cancelCause: null,
      absenceStartsAt: new Date('2026-10-13T22:00:00Z'),
      absenceEndsAt: new Date('2026-10-14T22:00:00Z'),
      absenceStatus: 'ACTIVE',
      teachers: [{ teacherId: A, role: 'LEAD' }],
      extraGroupIds: [],
      coveringSubstituteIds: [],
    };

    it("scores a changing post by the year's target for a reader without HR-läs, and by the week's for one with it (Roller i skolan)", async () => {
      tx.$queryRaw.mockResolvedValue([pair]);
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([
        { userId: S, validFrom: new Date('2026-10-12T00:00:00Z'), validTo: null, employmentPercent: 50, reductionPercent: 0, teachingTargetMinutesPerWeek: 30 },
      ]);
      tx.schoolBreak.findMany.mockResolvedValue([]);
      const planner = testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false });
      const reasonsOf = async (user: ReturnType<typeof testUser>) =>
        (await service.proposal(D, [], user)).items.find((item) => item.userId === S)!.reasons;
      const shown = (await service.candidates(LESSON, planner)).candidates.find((c) => c.userId === S)!;
      // The same year's figure as the lesson's candidates, never the week's 30.
      expect((await reasonsOf(planner)).find((r) => r.code === 'UNDER_TARGET')).toEqual(
        shown.reasons.find((r) => r.code === 'UNDER_TARGET'),
      );
      expect((await reasonsOf(planner)).map((r) => r.code)).not.toContain('OVER_TARGET');
      expect((await reasonsOf({ ...planner, hrRead: true })).map((r) => r.code)).toContain('OVER_TARGET');
    });

    it('proposes the open lessons of the day with a basis, writing nothing', async () => {
      tx.$queryRaw.mockResolvedValue([pair]);
      const proposal = await service.proposal(D, [], testUser());
      expect(proposal.items.map((item) => [item.lessonId, item.absenceId, item.userId])).toEqual([[LESSON, ABSENCE, S]]);
      expect(proposal.basis).toMatch(/^[0-9a-f]{64}$/);
      expect(tx.teacherAbsenceCover.create).not.toHaveBeenCalled();
      // Leaving the best one out gives the next.
      const without = await service.proposal(D, [S], testUser());
      expect(without.items.map((item) => item.userId)).toEqual([P]);
      // Nothing open: nothing proposed, nothing more read.
      tx.$queryRaw.mockResolvedValue([{ ...pair, lessonStatus: 'CANCELLED' }]);
      expect((await service.proposal(D, [], testUser())).items).toEqual([]);
    });

    it('records the substitutes it would book as EMPLOYMENT (each comes with their counter and load), and the absences, ids only, not at all', async () => {
      tx.$queryRaw.mockResolvedValue([pair]);
      const proposal = await service.proposal(D, [], testUser({ channel: 'WEB' }));
      expect(proposal.items.map((item) => item.userId)).toEqual([S]);
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [S] }]);
      // Nothing open, nobody proposed: no further row.
      tx.$queryRaw.mockResolvedValue([{ ...pair, lessonStatus: 'CANCELLED' }]);
      expect((await service.proposal(D, [], testUser())).items).toEqual([]);
      expect(recordedReads(tx)).toHaveLength(1);
    });

    it('apply: a basis that moved is a 409 writing nothing; the same basis writes every item as a decision, in one transaction', async () => {
      const basis = await basisOf(tx as never, D, 'Europe/Stockholm');
      const items = [{ lessonId: LESSON, absenceId: ABSENCE, userId: S }];
      await expect(service.apply(D, { basis: '0'.repeat(64), items }, testUser())).rejects.toMatchObject({
        response: { code: 'COVER_PROPOSAL_STALE' },
      });
      expect(cover.decideInTransaction).not.toHaveBeenCalled();

      tx.$executeRaw.mockClear();
      await expect(service.apply(D, { basis, items }, testUser())).resolves.toEqual({ applied: 1 });
      expect(cover.decideInTransaction).toHaveBeenCalledWith(
        tx,
        { lessonId: LESSON, absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' },
        expect.anything(),
      );
      expect(cover.afterCommit).toHaveBeenCalledTimes(1);
      // The day's lock, then the lessons', then the people's.
      const locks = tx.$executeRaw.mock.calls.map(([sql]) => (sql as { sql: string }).sql);
      expect(locks[0]).toContain("'cover:'");
      expect(locks[1]).toContain('FOR UPDATE');
      expect(locks[2]).toContain('cover-teacher');
    });

    it('apply re-checks every item against the rules with the earlier ones applied', async () => {
      const basis = await basisOf(tx as never, D, 'Europe/Stockholm');
      // S twice at one hour: the second breaks BUSY_LESSON against the first.
      tx.calendarLesson.findMany.mockImplementation((query: { where: { id?: { in: string[] }; date?: unknown } }) =>
        Promise.resolve(
          query.where.id
            ? query.where.id.in.map((id) => ({
                id,
                schoolId: 'school',
                date: new Date(`${D}T00:00:00.000Z`),
                startsAt: START,
                endsAt: END,
                subjectId: 'ma',
                studentGroupId: '7a',
                teachers: [{ teacherId: A }],
                extraGroups: [],
                participants: [],
              }))
            : [{ id: LESSON, startsAt: START, endsAt: END, status: 'SCHEDULED', teachers: [{ teacherId: A, role: 'LEAD' }] }],
        ),
      );
      const second = '46464646-4646-4646-8646-464646464646';
      await expect(
        service.apply(
          D,
          { basis, items: [{ lessonId: LESSON, absenceId: ABSENCE, userId: S }, { lessonId: second, absenceId: ABSENCE, userId: S }] },
          testUser(),
        ),
      ).rejects.toMatchObject({ response: { code: 'COVER_PROPOSAL_STALE', params: { lessonId: second } } });
      expect(cover.decideInTransaction).not.toHaveBeenCalled();
    });

    describe('two pairs of one lesson', () => {
      const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const ABSENCE_B = '56565656-5656-4565-8565-565656565656';
      const ABSENCE_S = '57575757-5757-4575-8575-575757575757';
      const lessonWith = (teacherIds: string[], roles: string[]) =>
        tx.calendarLesson.findMany.mockImplementation((query: { where: { id?: unknown } }) =>
          Promise.resolve(
            query.where.id
              ? [
                  {
                    id: LESSON,
                    schoolId: 'school',
                    date: new Date(`${D}T00:00:00.000Z`),
                    startsAt: START,
                    endsAt: END,
                    subjectId: 'ma',
                    studentGroupId: '7a',
                    teachers: teacherIds.map((teacherId) => ({ teacherId })),
                    extraGroups: [],
                    participants: [],
                  },
                ]
              : [
                  {
                    id: LESSON,
                    startsAt: START,
                    endsAt: END,
                    status: 'SCHEDULED',
                    teachers: teacherIds.map((teacherId, i) => ({ teacherId, role: roles[i] })),
                  },
                ],
          ),
        );

      it('both co-teachers away: two different people, and the apply takes the proposal as it is', async () => {
        lessonWith([A, B], ['LEAD', 'ASSISTANT']);
        tx.user.findMany.mockResolvedValue([
          { id: A, role: 'TEACHER', isActive: true },
          { id: B, role: 'TEACHER', isActive: true },
          { id: BUSY, role: 'TEACHER', isActive: true },
          { id: P, role: 'TEACHER', isActive: true },
          { id: S, role: 'TEACHER', isActive: true },
        ]);
        tx.teacherAbsence.findMany.mockResolvedValue([
          { id: ABSENCE, userId: A, startsAt: new Date('2026-10-13T22:00:00Z'), endsAt: new Date('2026-10-14T22:00:00Z') },
          { id: ABSENCE_B, userId: B, startsAt: new Date('2026-10-13T22:00:00Z'), endsAt: new Date('2026-10-14T22:00:00Z') },
        ]);
        const teachers = [{ teacherId: A, role: 'LEAD' }, { teacherId: B, role: 'ASSISTANT' }];
        tx.$queryRaw.mockResolvedValue([
          { ...pair, teachers },
          { ...pair, absenceId: ABSENCE_B, absentTeacherId: B, teachers },
        ]);
        const proposal = await service.proposal(D, [], testUser());
        expect(proposal.items.map((item) => [item.absenceId, item.userId]).sort()).toEqual(
          [
            [ABSENCE, S],
            [ABSENCE_B, P],
          ].sort(),
        );
        const basis = await basisOf(tx as never, D, 'Europe/Stockholm');
        await expect(
          service.apply(D, { basis, items: proposal.items.map(({ lessonId, absenceId, userId }) => ({ lessonId, absenceId, userId })) }, testUser()),
        ).resolves.toEqual({ applied: 2 });
      });

      it('apply refuses one person on two pairs of one lesson, naming the lesson, before anything is written', async () => {
        lessonWith([A, B], ['LEAD', 'ASSISTANT']);
        const basis = await basisOf(tx as never, D, 'Europe/Stockholm');
        await expect(
          service.apply(
            D,
            {
              basis,
              items: [
                { lessonId: LESSON, absenceId: ABSENCE, userId: S },
                { lessonId: LESSON, absenceId: ABSENCE_B, userId: S },
              ],
            },
            testUser(),
          ),
        ).rejects.toMatchObject({ response: { code: 'COVER_PROPOSAL_STALE', params: { lessonId: LESSON } } });
        expect(cover.decideInTransaction).not.toHaveBeenCalled();
      });

      it('a substitute who is away beside the stale decision they held: only their pair is proposed, which covers both', async () => {
        lessonWith([S], ['SUBSTITUTE']);
        tx.teacherAbsence.findMany.mockResolvedValue([
          { id: ABSENCE, userId: A, startsAt: new Date('2026-10-13T22:00:00Z'), endsAt: new Date('2026-10-14T22:00:00Z') },
          { id: ABSENCE_S, userId: S, startsAt: new Date('2026-10-13T22:00:00Z'), endsAt: new Date('2026-10-14T22:00:00Z') },
        ]);
        const teachers = [{ teacherId: S, role: 'SUBSTITUTE' }];
        tx.$queryRaw.mockResolvedValue([
          {
            ...pair,
            isLive: false,
            decisionId: 'd-a',
            decision: 'SUBSTITUTE',
            decidedAt: new Date('2026-10-13T12:00:00Z'),
            removedTeachers: [{ teacherId: A, role: 'LEAD' }],
            teachers,
          },
          { ...pair, absenceId: ABSENCE_S, absentTeacherId: S, teachers },
        ]);
        const proposal = await service.proposal(D, [], testUser());
        expect(proposal.items.map((item) => [item.absenceId, item.userId])).toEqual([[ABSENCE_S, P]]);
        expect(proposal.unassigned).toEqual([]);
      });

      it('an item the board refuses during the apply names its lesson, as a bulk does', async () => {
        const basis = await basisOf(tx as never, D, 'Europe/Stockholm');
        const { ConflictException } = await import('@nestjs/common');
        cover.decideInTransaction.mockRejectedValueOnce(new ConflictException({ message: 'x', code: 'COVER_STALE', params: { current: 'COVERED' } }));
        await expect(
          service.apply(D, { basis, items: [{ lessonId: LESSON, absenceId: ABSENCE, userId: S }] }, testUser()),
        ).rejects.toMatchObject({ response: { code: 'COVER_STALE', params: { current: 'COVERED', lessonId: LESSON } } });
      });
    });
  });
});
