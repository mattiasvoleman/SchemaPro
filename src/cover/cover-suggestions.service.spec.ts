import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { CoverService } from './cover.service';
import { basisOf, CoverSuggestionsService } from './cover-suggestions.service';

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
      decideInTransaction: jest.fn().mockResolvedValue({ lessonIds: [LESSON], dates: [D], notices: [], warnings: [] }),
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
  });
});
