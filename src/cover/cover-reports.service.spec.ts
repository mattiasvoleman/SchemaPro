import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { CoverService } from './cover.service';
import { CoverReportsService } from './cover-reports.service';

const NOW = new Date('2026-10-14T05:00:00.000Z');
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('CoverReportsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: CoverReportsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new CoverReportsService(prisma as unknown as PrismaService, { now: () => NOW } as unknown as CoverService);
    tx.substitutePoolMember.findMany.mockResolvedValue([{ userId: P }]);
  });

  describe('hours', () => {
    const row = (userId: string, date: string, minutes: number) => ({
      lessonId: `l-${date}`,
      userId,
      date,
      startsAt: new Date(`${date}T08:00:00.000Z`),
      endsAt: new Date(`${date}T09:00:00.000Z`),
      minutes,
      subjectId: 'ma',
      studentGroupId: '7a',
      roomId: null,
    });

    it('splits a range by the läsår it crosses, runs the statement per year clamped, and sums per substitute', async () => {
      tx.academicYear.findMany.mockResolvedValue([
        { id: 'y1', startDate: new Date('2025-08-18T00:00:00Z'), endDate: new Date('2026-06-12T00:00:00Z') },
        { id: 'y2', startDate: new Date('2026-08-17T00:00:00Z'), endDate: new Date('2027-06-11T00:00:00Z') },
      ]);
      tx.teacherEmployment.findMany.mockResolvedValue([]);
      tx.$queryRaw
        .mockResolvedValueOnce([row(S, '2026-06-10', 60)])
        .mockResolvedValueOnce([row(S, '2026-08-20', 45), row(P, '2026-08-21', 60)]);
      tx.calendarLessonTeacher.findMany.mockResolvedValue([
        { teacherId: S, calendarLesson: { startsAt: new Date('2026-10-20T08:00:00Z'), endsAt: new Date('2026-10-20T08:40:00Z') } },
      ]);

      const answer = await service.hours('2026-06-01', '2026-08-31', undefined, testUser());

      const values = tx.$queryRaw.mock.calls.map(([sql]) => (sql as { values: unknown[] }).values);
      // y1 clamped to its end, y2 to its start.
      expect(values[0]).toEqual(expect.arrayContaining(['y1', '2026-06-01', '2026-06-12']));
      expect(values[1]).toEqual(expect.arrayContaining(['y2', '2026-08-17', '2026-08-31']));
      expect(answer.summary).toEqual([
        { userId: S, kind: 'STAFF', lessons: 2, minutes: 105 },
        { userId: P, kind: 'POOL', lessons: 1, minutes: 60 },
      ].sort((a, b) => a.userId.localeCompare(b.userId)));
      expect(answer.planned).toEqual([{ userId: S, lessons: 1, minutes: 40 }]);
      // Who covered what when; never who was away or why.
      expect(JSON.stringify(answer)).not.toMatch(/absen|reason/i);
    });

    it('a cover held by a substitute who was themself away is left out of the payroll rows and listed to check — never saying why', async () => {
      tx.academicYear.findMany.mockResolvedValue([
        { id: 'y2', startDate: new Date('2026-08-17T00:00:00Z'), endDate: new Date('2027-06-11T00:00:00Z') },
      ]);
      tx.teacherEmployment.findMany.mockResolvedValue([]);
      tx.$queryRaw.mockResolvedValue([row(S, '2026-09-01', 60), row(S, '2026-09-02', 60)]);
      // S fell ill on 1 September and nobody re-covered the lesson before it ended.
      tx.teacherAbsence.findMany.mockResolvedValue([
        { userId: S, startsAt: new Date('2026-08-31T22:00:00Z'), endsAt: new Date('2026-09-01T22:00:00Z') },
      ]);

      const answer = await service.hours('2026-09-01', '2026-09-30', undefined, testUser());

      expect(answer.rows.map((r) => r.date)).toEqual(['2026-09-02']);
      expect(answer.summary).toEqual([{ userId: S, kind: 'STAFF', lessons: 1, minutes: 60 }]);
      expect(answer.toCheck.map((r) => [r.userId, r.date, r.minutes])).toEqual([[S, '2026-09-01', 60]]);
      expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ACTIVE', userId: { in: [S] } }),
          select: { userId: true, startsAt: true, endsAt: true },
        }),
      );
      expect(JSON.stringify(answer)).not.toMatch(/absen|reason/i);
    });

    it('a pool member with a post that year is STAFF', async () => {
      tx.academicYear.findMany.mockResolvedValue([
        { id: 'y2', startDate: new Date('2026-08-17T00:00:00Z'), endDate: new Date('2027-06-11T00:00:00Z') },
      ]);
      tx.teacherEmployment.findMany.mockResolvedValue([{ userId: P }]);
      tx.$queryRaw.mockResolvedValue([row(P, '2026-09-01', 60)]);
      const answer = await service.hours('2026-09-01', '2026-09-30', P, testUser());
      expect(answer.rows.map((r) => r.kind)).toEqual(['STAFF']);
      expect((tx.$queryRaw.mock.calls[0]![0] as { values: unknown[] }).values).toContain(P);
    });

    it('refuses more than 93 days', async () => {
      await expect(service.hours('2026-01-01', '2026-04-05', undefined, testUser())).rejects.toMatchObject({
        response: { code: 'COVER_RANGE' },
      });
    });
  });

  it('counter: the year’s term and the week, pool members listed even at zero, most covers first', async () => {
    tx.academicYear.findFirst.mockResolvedValue({
      id: 'y2',
      startDate: new Date('2026-08-17T00:00:00Z'),
      endDate: new Date('2027-06-11T00:00:00Z'),
    });
    tx.teacherEmployment.findMany.mockResolvedValue([]);
    tx.calendarLessonTeacher.findMany.mockResolvedValue([
      { teacherId: S, calendarLesson: { date: new Date('2026-10-13T00:00:00Z'), startsAt: new Date('2026-10-13T08:00:00Z'), endsAt: new Date('2026-10-13T09:00:00Z') } },
      { teacherId: S, calendarLesson: { date: new Date('2026-09-01T00:00:00Z'), startsAt: new Date('2026-09-01T08:00:00Z'), endsAt: new Date('2026-09-01T08:30:00Z') } },
    ]);
    const answer = await service.counter('2026-10-14', testUser());
    expect(answer.rows).toEqual([
      { userId: S, kind: 'STAFF', weekLessons: 1, weekMinutes: 60, termLessons: 2, termMinutes: 90, heldTermMinutes: 90 },
      { userId: P, kind: 'POOL', weekLessons: 0, weekMinutes: 0, termLessons: 0, termMinutes: 0, heldTermMinutes: 0 },
    ]);
    // HT runs from the year's start (17 Aug, after 1 Aug).
    expect(tx.calendarLessonTeacher.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: 'SUBSTITUTE',
          calendarLesson: {
            status: { in: ['SCHEDULED', 'COMPLETED'] },
            date: { gte: new Date('2026-08-17T00:00:00Z'), lte: new Date('2026-12-31T00:00:00Z') },
          },
        },
      }),
    );
  });
});
