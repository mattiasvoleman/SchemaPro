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
    const lesson = { id: 'l', startsAt: new Date('2026-10-26T08:00:00.000Z'), subjectName: 'Matematik', groupName: '7A', roomName: 'Sal 12' };

    it('formats the school’s clock in Swedish, across the change to winter time', () => {
      expect(swedishWhen(lesson.startsAt, 'Europe/Stockholm')).toBe('mån 26 okt 09:00');
      expect(coverEmail(lesson, 'Europe/Stockholm')).toEqual({
        subject: 'Vikariepass: Matematik mån 26 okt 09:00',
        body: 'Du är inbokad som vikarie: Matematik, 7A, Sal 12, mån 26 okt 09:00.',
      });
      expect(withdrawnEmail(lesson, 'Europe/Stockholm').subject).toBe('Vikariepasset är avbokat: Matematik mån 26 okt 09:00');
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
      tx.teacherDuty.findMany.mockResolvedValue([
        { blockedConstraintId: 'c1', label: 'Rastvakt', academicYearId: 'y' },
        { blockedConstraintId: 'c2', label: 'Förra årets', academicYearId: 'old' },
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
  });
});
