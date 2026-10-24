import { Prisma } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import { isoWeekOf, readPersonDays, termOf } from './cover-context';
import { mergeRemoved, parseRemoved } from './cover-decisions';
import { mapCoverErrors, rethrowCoverError, sqlStateOf } from './cover-errors';
import { coverEmail, sendNotices, settleNotices, swedishWhen, withdrawnEmail } from './cover-notices';

const refusal = (code: string, extra: Record<string, unknown> = {}) =>
  new Prisma.PrismaClientKnownRequestError('refused', {
    code: 'P2039',
    clientVersion: 'x',
    meta: { driverAdapterError: { cause: { originalCode: code, ...extra } } },
  });

describe('cover support', () => {
  describe('errors', () => {
    it.each([
      ['23P01', 409, 'ABSENCE_OVERLAPS'],
      ['TA403', 403, 'ABSENCE_SELF_EDIT_NARROW'],
      ['TA409', 409, 'ABSENCE_PERSON_IS_FIXED'],
      ['SP409', 409, 'POOL_MEMBER_MUST_BE_TEACHER'],
      ['42501', 403, 'ABSENCE_SELF_REPORT_OFF'],
      ['23514', 400, 'COVER_INVALID'],
      ['23505', 409, 'COVER_DUPLICATE'],
    ])('%s is a %i %s', (state, status, code) => {
      const error = (() => {
        try {
          rethrowCoverError(refusal(state, { originalMessage: 'violates check constraint "X_is_sane" Failing row contains (secret)' }));
        } catch (e) {
          return e as { getStatus: () => number; getResponse: () => Record<string, unknown> };
        }
      })()!;
      expect([error.getStatus(), error.getResponse().code]).toEqual([status, code]);
      expect(JSON.stringify(error.getResponse())).not.toContain('secret');
    });

    it('reads the SQLSTATE from the rendered message too, and passes anything else through', async () => {
      expect(sqlStateOf(new Prisma.PrismaClientKnownRequestError('Code: `TA403`. x', { code: 'P2039', clientVersion: 'x' }))).toBe('TA403');
      expect(sqlStateOf(new Error('x'))).toBeNull();
      const plain = new Error('boom');
      await expect(mapCoverErrors(() => Promise.reject(plain))).rejects.toBe(plain);
      await expect(
        mapCoverErrors(() => Promise.reject(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'x' }))),
      ).rejects.toThrow('does not exist');
      await expect(
        mapCoverErrors(() => Promise.reject(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2003', clientVersion: 'x' }))),
      ).rejects.toMatchObject({ response: { code: 'COVER_INVALID' } });
      await expect(mapCoverErrors(() => Promise.resolve(7))).resolves.toBe(7);
    });
  });

  describe('decisions', () => {
    it('reads removedTeachers defensively and merges by person', () => {
      expect(parseRemoved(null)).toEqual([]);
      expect(parseRemoved([{ teacherId: 'a', role: 'LEAD' }, { teacherId: 'b', role: 'BOSS' }, 'x'])).toEqual([{ teacherId: 'a', role: 'LEAD' }]);
      expect(mergeRemoved([{ teacherId: 'a', role: 'LEAD' }], [{ teacherId: 'a', role: 'ASSISTANT' }, { teacherId: 'b', role: 'ASSISTANT' }])).toEqual([
        { teacherId: 'a', role: 'LEAD' },
        { teacherId: 'b', role: 'ASSISTANT' },
      ]);
    });
  });

  describe('notices', () => {
    const lesson = { id: 'l', startsAt: new Date('2026-10-26T08:00:00.000Z'), subjectName: 'Matematik', groupName: '7A', roomName: 'Sal 12', noted: false };

    it('formats the school’s clock in Swedish, across the change to winter time', () => {
      expect(swedishWhen(lesson.startsAt, 'Europe/Stockholm')).toBe('mån 26 okt 09:00');
      expect(coverEmail(lesson, 'Europe/Stockholm')).toEqual({
        subject: 'Vikariepass: Matematik mån 26 okt 09:00',
        body: 'Du är inbokad som vikarie: Matematik, 7A, Sal 12, mån 26 okt 09:00.',
      });
      expect(withdrawnEmail(lesson, 'Europe/Stockholm').subject).toBe('Vikariepasset är avbokat: Matematik mån 26 okt 09:00');
    });

    it('says there is a note to the substitute, and never what it says (Lektionslogg)', () => {
      const email = coverEmail({ ...lesson, noted: true }, 'Europe/Stockholm');
      expect(email.body).toBe(
        'Du är inbokad som vikarie: Matematik, 7A, Sal 12, mån 26 okt 09:00. Lektionens lärare har lämnat en notis till dig. Du läser den på lektionen i Rastra.',
      );
      expect(withdrawnEmail({ ...lesson, noted: true }, 'Europe/Stockholm').body).not.toContain('notis');
    });

    it('a booking and its withdrawal in one write cancel out; the last word stands otherwise', () => {
      expect(
        settleNotices([
          { kind: 'COVER', userId: 's', lessonId: 'l' },
          { kind: 'WITHDRAWN', userId: 's', lessonId: 'l' },
          { kind: 'WITHDRAWN', userId: 't', lessonId: 'l' },
          { kind: 'COVER', userId: 'u', lessonId: 'l' },
          { kind: 'COVER', userId: 'u', lessonId: 'l' },
        ]),
      ).toEqual([
        { kind: 'WITHDRAWN', userId: 't', lessonId: 'l' },
        { kind: 'COVER', userId: 'u', lessonId: 'l' },
      ]);
    });

    it('sends one notice per person, meta whitelisted, skipping a lesson that is gone', async () => {
      const tx = createTxMock();
      tx.calendarLesson.findMany.mockResolvedValue([{ id: 'l', startsAt: lesson.startsAt, studentGroupId: 'g', roomId: 'r', subjectId: 's' }]);
      tx.subject.findMany.mockResolvedValue([{ id: 's', name: 'Matematik' }]);
      tx.studentGroup.findMany.mockResolvedValue([{ id: 'g', name: '7A' }]);
      tx.room.findMany.mockResolvedValue([{ id: 'r', name: 'Sal 12' }]);
      const notifyUsers = jest.fn().mockResolvedValue(1);
      await sendNotices({ notifyUsers } as never, tx as never, 'school', 'Europe/Stockholm', [
        { kind: 'WITHDRAWN', userId: 's', lessonId: 'l' },
        { kind: 'COVER', userId: 't', lessonId: 'gone' },
      ]);
      expect(notifyUsers).toHaveBeenCalledTimes(1);
      expect(notifyUsers.mock.calls[0][1]).toMatchObject({
        userIds: ['s'],
        type: 'LESSON_COVER_WITHDRAWN',
        meta: { subjectName: 'Matematik', startsAt: lesson.startsAt.toISOString(), groupName: '7A', roomName: 'Sal 12' },
      });
      expect(Object.keys(notifyUsers.mock.calls[0][1].meta).sort()).toEqual(['groupName', 'roomName', 'startsAt', 'subjectName']);
      await sendNotices({ notifyUsers } as never, tx as never, 'school', 'Europe/Stockholm', []);
      expect(notifyUsers).toHaveBeenCalledTimes(1);
    });

    it('reads which lessons have a note to the substitute, and the booking’s e-mail says so; the meta does not change', async () => {
      const tx = createTxMock();
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: 'l', startsAt: lesson.startsAt, studentGroupId: 'g', roomId: 'r', subjectId: 's' },
        { id: 'm', startsAt: lesson.startsAt, studentGroupId: 'g', roomId: 'r', subjectId: 's' },
      ]);
      tx.subject.findMany.mockResolvedValue([{ id: 's', name: 'Matematik' }]);
      tx.studentGroup.findMany.mockResolvedValue([{ id: 'g', name: '7A' }]);
      tx.room.findMany.mockResolvedValue([{ id: 'r', name: 'Sal 12' }]);
      tx.lessonSubstituteNote.findMany.mockResolvedValue([{ calendarLessonId: 'l' }]);
      const notifyUsers = jest.fn().mockResolvedValue(1);
      await sendNotices({ notifyUsers } as never, tx as never, 'school', 'Europe/Stockholm', [
        { kind: 'COVER', userId: 's', lessonId: 'l' },
        { kind: 'COVER', userId: 't', lessonId: 'm' },
      ]);
      expect(tx.lessonSubstituteNote.findMany).toHaveBeenCalledWith({
        where: { calendarLessonId: { in: ['l', 'm'] } },
        select: { calendarLessonId: true },
      });
      const [first, second] = notifyUsers.mock.calls.map((call) => call[1]);
      expect(first.email.body).toContain('Lektionens lärare har lämnat en notis till dig.');
      expect(second.email.body).not.toContain('notis');
      expect(Object.keys(first.meta).sort()).toEqual(['cover', 'groupName', 'roomName', 'startsAt', 'subjectName']);
    });
  });

  describe('context', () => {
    it('the Swedish termin: HT from the year’s start or 1 Aug, VT to its end or 31 Jul, else the half-year', () => {
      const year = { startDate: '2026-08-17', endDate: '2027-06-11' };
      expect(termOf('2026-10-14', year)).toEqual({ from: '2026-08-17', to: '2026-12-31' });
      expect(termOf('2027-03-01', year)).toEqual({ from: '2027-01-01', to: '2027-06-11' });
      expect(termOf('2027-07-01', year)).toEqual({ from: '2027-01-01', to: '2027-07-31' });
      expect(termOf('2026-10-14', null)).toEqual({ from: '2026-08-01', to: '2026-12-31' });
    });

    it('the ISO week runs Monday to Sunday', () => {
      expect(isoWeekOf('2026-10-14')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
      expect(isoWeekOf('2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    });

    it('reads every day for a school-wide set, a duty of another läsår leaving the time free, odd rows skipped', async () => {
      const tx = createTxMock();
      tx.user.findMany.mockResolvedValue([{ id: 'a', role: 'TEACHER', isActive: true }, null]);
      tx.calendarLessonTeacher.findMany.mockResolvedValue([{ teacherId: 'a', calendarLesson: null }]);
      tx.availabilityConstraint.findMany.mockResolvedValue([
        { id: 'c1', userId: 'a', startTime: new Date('1970-01-01T10:00:00Z'), endTime: new Date('1970-01-01T11:00:00Z'), type: 'UNAVAILABLE' },
        { id: 'c2', userId: 'a', startTime: new Date('1970-01-01T12:00:00Z'), endTime: new Date('1970-01-01T13:00:00Z'), type: 'UNAVAILABLE' },
        { id: 'c3', userId: 'a', startTime: new Date('1970-01-01T14:00:00Z'), endTime: new Date('1970-01-01T15:00:00Z'), type: 'PREFERRED_FREE' },
      ]);
      tx.teacherDutySlot.findMany.mockResolvedValue([
        { availabilityConstraintId: 'c1', teacherDuty: { label: 'Rastvakt', academicYearId: 'y', validFrom: null, validTo: null } },
        { availabilityConstraintId: 'c2', teacherDuty: { label: 'Förra årets', academicYearId: 'old', validFrom: null, validTo: null } },
      ]);
      tx.teacherWorkRule.findMany.mockResolvedValue([
        { userId: 'a', lunchMinutes: 30, lunchStartTime: new Date('1970-01-01T11:00:00Z'), lunchEndTime: new Date('1970-01-01T13:00:00Z'), minDailyRestMinutes: 660 },
      ]);
      tx.roomBooking.findMany.mockResolvedValue([{ bookedById: 'a', startsAt: new Date('2026-10-14T13:00:00Z'), endsAt: new Date('2026-10-14T14:00:00Z') }]);
      const read = await readPersonDays(tx as never, { date: '2026-10-14', timezone: 'Europe/Stockholm', academicYearId: 'y' });
      const day = read.days.get('a')!;
      expect(day.closures.map((c) => [c.kind, c.label])).toEqual([['DUTY', 'Rastvakt']]);
      expect(day.preferredFree).toHaveLength(1);
      expect(day.bookings).toHaveLength(1);
      expect(day.lunch?.minutes).toBe(30);
      expect(day.minDailyRestMinutes).toBe(660);
      expect(day.lessons).toEqual([]);
      // Nobody to read: nothing more is asked.
      const empty = createTxMock();
      empty.user.findMany.mockResolvedValue([]);
      expect((await readPersonDays(empty as never, { date: '2026-10-14', timezone: 'Europe/Stockholm', academicYearId: null })).days.size).toBe(0);
      expect(empty.calendarLessonTeacher.findMany).not.toHaveBeenCalled();
    });

    describe('Lärarens dag', () => {
      const post = (userId: string, extra: Record<string, unknown> = {}) => ({
        userId,
        employmentPercent: 60,
        reductionPercent: 0,
        contractKind: 'FERIE',
        teachingTargetMinutesPerWeek: null,
        signature: null,
        ...extra,
      });
      /** The week's read is the one that asks for a status with the people. */
      const isWeek = (query: { where: { teacherId?: unknown; calendarLesson?: { status?: unknown } } }) =>
        Boolean(query.where.teacherId && query.where.calendarLesson?.status);

      it('reads the cap and the wish with the lunch, the limit with the post, and the week only of a post with a limit', async () => {
        const tx = createTxMock();
        tx.user.findMany.mockResolvedValue([
          { id: 'a', role: 'TEACHER', isActive: true },
          { id: 'b', role: 'TEACHER', isActive: true },
          { id: 'c', role: 'TEACHER', isActive: true },
        ]);
        tx.teacherWorkRule.findMany.mockResolvedValue([
          { userId: 'a', lunchMinutes: null, lunchStartTime: null, lunchEndTime: null, minDailyRestMinutes: null, maxTeachingMinutesPerDay: 240, preferredFreeDayOfWeek: 5 },
        ]);
        // A post with a limit, one with none, one read before the column was
        // (no key at all), and one of somebody not asked about.
        tx.teacherEmployment.findMany.mockResolvedValue([
          post('a', { maxTeachingDaysPerWeek: 3 }),
          post('b', { maxTeachingDaysPerWeek: null }),
          post('c'),
          post('ghost', { maxTeachingDaysPerWeek: 2 }),
        ]);
        tx.calendarLessonTeacher.findMany.mockImplementation((query: Parameters<typeof isWeek>[0]) =>
          Promise.resolve(
            isWeek(query)
              ? [
                  { teacherId: 'a', calendarLesson: { date: new Date('2026-10-15T00:00:00Z') } },
                  { teacherId: 'a', calendarLesson: { date: new Date('2026-10-12T00:00:00Z') } },
                  { teacherId: 'a', calendarLesson: { date: new Date('2026-10-15T00:00:00Z') } },
                  { teacherId: 'a', calendarLesson: null },
                  { teacherId: 'ghost', calendarLesson: { date: new Date('2026-10-13T00:00:00Z') } },
                ]
              : [],
          ),
        );

        const read = await readPersonDays(tx as never, { date: '2026-10-14', timezone: 'Europe/Stockholm', academicYearId: 'y' });

        const a = read.days.get('a')!;
        expect([a.dailyCapMinutes, a.preferredFreeDay, a.maxTeachingDaysPerWeek]).toEqual([240, 5, 3]);
        // Once each, in date order, and nobody else's.
        expect(a.weekTeachingDates).toEqual(['2026-10-12', '2026-10-15']);
        for (const id of ['b', 'c']) {
          const other = read.days.get(id)!;
          expect([other.dailyCapMinutes, other.preferredFreeDay, other.maxTeachingDaysPerWeek, other.weekTeachingDates]).toEqual([null, null, null, []]);
        }
        // The rule reads the limit; the load never carries it.
        expect(read.employments.get('a')).not.toHaveProperty('maxTeachingDaysPerWeek');
        // Two columns more on the statements there were, and the week of the
        // one post with a limit: the ISO week, every role, held lessons.
        expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ select: expect.objectContaining({ maxTeachingMinutesPerDay: true, preferredFreeDayOfWeek: true }) }),
        );
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ select: expect.objectContaining({ maxTeachingDaysPerWeek: true }) }),
        );
        expect(tx.calendarLessonTeacher.findMany).toHaveBeenCalledTimes(2);
        expect(tx.calendarLessonTeacher.findMany).toHaveBeenLastCalledWith({
          where: {
            teacherId: { in: ['a'] },
            calendarLesson: {
              status: { in: ['SCHEDULED', 'COMPLETED'] },
              date: { gte: new Date('2026-10-12T00:00:00.000Z'), lte: new Date('2026-10-18T00:00:00.000Z') },
            },
          },
          select: { teacherId: true, calendarLesson: { select: { date: true } } },
        });
      });

      it('a school whose posts set no limit asks no week: the statements it sent before', async () => {
        const tx = createTxMock();
        tx.user.findMany.mockResolvedValue([{ id: 'b', role: 'TEACHER', isActive: true }, { id: 'c', role: 'TEACHER', isActive: true }]);
        tx.teacherEmployment.findMany.mockResolvedValue([post('b', { maxTeachingDaysPerWeek: null }), post('c')]);
        await readPersonDays(tx as never, { date: '2026-10-14', timezone: 'Europe/Stockholm', academicYearId: 'y' });
        expect(tx.calendarLessonTeacher.findMany).toHaveBeenCalledTimes(1);
        expect(isWeek(tx.calendarLessonTeacher.findMany.mock.calls[0][0])).toBe(false);
      });
    });

    it('keeps a teacher busy for an uppdrag’s time only on the days the uppdrag runs (Från and Till, both inclusive)', async () => {
      // Anna is 7B's mentor until the jullov; the same weekly row on a
      // Wednesday in March keeps nobody busy. The rastvakt from January keeps
      // her busy from its first day, and not the day before.
      const read = async (date: string) => {
        const tx = createTxMock();
        tx.user.findMany.mockResolvedValue([{ id: 'a', role: 'TEACHER', isActive: true }]);
        tx.calendarLessonTeacher.findMany.mockResolvedValue([]);
        tx.availabilityConstraint.findMany.mockResolvedValue([
          { id: 'c1', userId: 'a', startTime: new Date('1970-01-01T10:00:00Z'), endTime: new Date('1970-01-01T11:00:00Z'), type: 'UNAVAILABLE' },
          { id: 'c2', userId: 'a', startTime: new Date('1970-01-01T12:00:00Z'), endTime: new Date('1970-01-01T13:00:00Z'), type: 'UNAVAILABLE' },
        ]);
        tx.teacherDutySlot.findMany.mockResolvedValue([
          { availabilityConstraintId: 'c1', teacherDuty: { label: 'Mentor 7B', academicYearId: 'y', validFrom: null, validTo: new Date('2026-12-18T00:00:00Z') } },
          { availabilityConstraintId: 'c2', teacherDuty: { label: 'Rastvakt', academicYearId: 'y', validFrom: new Date('2027-01-07T00:00:00Z'), validTo: null } },
        ]);
        const days = await readPersonDays(tx as never, { date, timezone: 'Europe/Stockholm', academicYearId: 'y' });
        return days.days.get('a')!.closures.map((closure) => closure.label);
      };
      expect(await read('2026-12-16')).toEqual(['Mentor 7B']);
      expect(await read('2026-12-18')).toEqual(['Mentor 7B']);
      expect(await read('2027-01-06')).toEqual([]);
      expect(await read('2027-01-07')).toEqual(['Rastvakt']);
      expect(await read('2027-03-03')).toEqual(['Rastvakt']);
    });
  });
});
