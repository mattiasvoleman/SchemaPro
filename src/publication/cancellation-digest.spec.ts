import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { NotificationsService } from '../notifications/notifications.service';
import { digestAudience, digestEmail, sendDigest } from './cancellation-digest';

describe('the avbokning digest', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;
  // Three lessons over two days: 9A Mon and Tue, the Ma9 group on Tue.
  const lessons = [
    { id: 'mon-9a', date: '2026-10-19', studentGroupId: '9A', extraGroups: [] },
    { id: 'tue-9a', date: '2026-10-20', studentGroupId: '9A', extraGroups: [] },
    { id: 'tue-ma9', date: '2026-10-20', studentGroupId: 'Ma9', extraGroups: [] },
  ];

  beforeEach(() => {
    tx = createTxMock();
    tx.user.findMany.mockResolvedValue([
      { id: 'ada', studentGroupId: '9A' },
      { id: 'bo', studentGroupId: '9A' },
    ]);
    // Cy is in Ma9 only; Ada in both.
    tx.studentGroupMember.findMany.mockResolvedValue([
      { studentId: 'ada', studentGroupId: 'Ma9' },
      { studentId: 'cy', studentGroupId: 'Ma9' },
    ]);
    tx.calendarLessonStudent.findMany.mockResolvedValue([]);
    // One guardian for Ada and Cy, one for Bo.
    tx.guardianStudent.findMany.mockResolvedValue([
      { guardianId: 'g1', studentId: 'ada' },
      { guardianId: 'g1', studentId: 'cy' },
      { guardianId: 'g2', studentId: 'bo' },
    ]);
    tx.calendarLessonTeacher.findMany.mockResolvedValue([
      { calendarLessonId: 'mon-9a', teacherId: 't1' },
      { calendarLessonId: 'tue-ma9', teacherId: 't1' },
      { calendarLessonId: 'tue-9a', teacherId: 't2' },
    ]);
  });

  it('gives each person their own lessons once — a guardian their children’s, a teacher what they teach', async () => {
    const audience = await digestAudience(client(), lessons);
    const shares = Object.fromEntries(
      [...audience.people].map(([userId, share]) => [userId, [share.lessons.size, share.first, share.last]]),
    );
    expect(shares).toEqual({
      ada: [3, '2026-10-19', '2026-10-20'],
      bo: [2, '2026-10-19', '2026-10-20'],
      cy: [1, '2026-10-20', '2026-10-20'],
      // Ada's three and Cy's one: tue-ma9 counted once.
      g1: [3, '2026-10-19', '2026-10-20'],
      g2: [2, '2026-10-19', '2026-10-20'],
      t1: [2, '2026-10-19', '2026-10-20'],
      t2: [1, '2026-10-20', '2026-10-20'],
    });
    expect(audience.counts).toEqual({ pupils: 3, guardians: 2, teachers: 2 });
  });

  it('reaches nobody and asks nothing for no lesson', async () => {
    await expect(digestAudience(client(), [])).resolves.toEqual({ people: new Map(), counts: { pupils: 0, guardians: 0, teachers: 0 } });
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.calendarLessonTeacher.findMany).not.toHaveBeenCalled();
  });

  it('sends one notifyUsers per count and days, each person once, with the meta a push may read', async () => {
    const notifyUsers = jest.fn(async (_tx: unknown, options: { userIds: string[] }) => options.userIds.length);
    const notifications = { notifyUsers } as unknown as NotificationsService;
    const told = await sendDigest(notifications, client(), 'school', { id: 'batch', name: 'Prao åk 9' }, await digestAudience(client(), lessons), false);
    expect(told).toBe(7);
    const calls = notifyUsers.mock.calls.map(([, options]) => options as unknown as { userIds: string[]; type: string; meta: Record<string, unknown>; email: { subject: string } });
    expect(calls.map((call) => [call.userIds.sort(), call.meta.lessonCount, call.meta.startDate, call.meta.endDate])).toEqual([
      [['ada', 'g1'], 3, '2026-10-19', '2026-10-20'],
      [['bo', 'g2', 't1'], 2, '2026-10-19', '2026-10-20'],
      [['cy', 't2'], 1, '2026-10-20', '2026-10-20'],
    ]);
    expect(calls.every((call) => call.type === 'CANCELLATION_DIGEST')).toBe(true);
    expect(calls[0]!.meta).toEqual({ batchId: 'batch', name: 'Prao åk 9', lessonCount: 3, startDate: '2026-10-19', endDate: '2026-10-20', reversed: false });
    expect(calls[2]!.email.subject).toBe('Inställda lektioner: Prao åk 9');
  });

  it('writes its e-mail in Swedish, for one lesson or several, one day or a span, and for the reversal', () => {
    expect(digestEmail('Prao åk 9', { count: 12, first: '2026-10-19', last: '2026-10-23' }, false)).toEqual({
      subject: 'Inställda lektioner: Prao åk 9',
      body: 'Prao åk 9: 12 lektioner mellan 19 okt och 23 okt är inställda.\n\nSe schemat i Rastra Schema.',
    });
    expect(digestEmail('Friluftsdag', { count: 1, first: '2026-10-19', last: '2026-10-19' }, false).body).toBe(
      'Friluftsdag: En lektion den 19 okt är inställd.\n\nSe schemat i Rastra Schema.',
    );
    expect(digestEmail('Prao åk 9', { count: 12, first: '2026-10-19', last: '2026-10-23' }, true)).toEqual({
      subject: 'Avbokningen är ångrad: Prao åk 9',
      body: 'Avbokningen Prao åk 9 är ångrad. 12 lektioner mellan 19 okt och 23 okt blir av som planerat.\n\nSe schemat i Rastra Schema.',
    });
  });
});
