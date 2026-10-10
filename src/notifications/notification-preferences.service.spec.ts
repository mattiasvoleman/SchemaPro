import { BadRequestException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  NOTIFICATION_TYPE_NOT_OFFERED,
  NOTIFICATION_TYPE_REQUIRED,
  NotificationPreferencesService,
} from './notification-preferences.service';
import { TYPES_BY_ROLE, deliveredRegardless, isChoosingRole } from './notification-types';

const USER = '22222222-2222-4222-8222-222222222222';
const SCHOOL = '33333333-3333-4333-8333-333333333333';

describe('NotificationPreferencesService', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: NotificationPreferencesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new NotificationPreferencesService(prisma as unknown as PrismaService);
  });

  const as = (role: string) => testUser({ role: role as never, userId: USER, schoolId: SCHOOL });

  it('lists a guardian’s types with the unreported absence required and on', async () => {
    tx.notificationOptOut.findMany.mockResolvedValue([{ type: 'SCHEDULE_CHANGED' }]);
    const { types } = await service.get(as('GUARDIAN'));
    expect(types).toEqual([
      { type: 'LESSON_CANCELLED', enabled: true, required: false },
      { type: 'LESSON_SUBSTITUTE', enabled: true, required: false },
      { type: 'LESSON_ROOM_CHANGED', enabled: true, required: false },
      { type: 'SCHEDULE_CHANGED', enabled: false, required: false },
      { type: 'LEAVE_DECIDED', enabled: true, required: false },
      { type: 'ABSENCE_UNREPORTED', enabled: true, required: true },
    ]);
    // Read by the caller's own id, under their RLS, in one statement.
    expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
    expect(tx.notificationOptOut.findMany).toHaveBeenCalledWith({ where: { userId: USER }, select: { type: true } });
  });

  it('lists staff the cover withdrawal as required, a pupil nothing required', async () => {
    const teacher = await service.get(as('TEACHER'));
    expect(teacher.types.filter((t) => t.required).map((t) => t.type)).toEqual(['LESSON_COVER_WITHDRAWN']);
    expect(teacher.types.map((t) => t.type)).toEqual(TYPES_BY_ROLE.TEACHER);
    const pupil = await service.get(as('STUDENT'));
    expect(pupil.types.some((t) => t.required)).toBe(false);
    expect(pupil.types.map((t) => t.type)).not.toContain('ABSENCE_UNREPORTED');
  });

  it('lists nothing for a role it does not know', async () => {
    await expect(service.get(as('SERVICE'))).resolves.toEqual({ types: [] });
  });

  it('replaces the caller’s own set: deletes by their id, then writes the new rows', async () => {
    const result = await service.put({ optOut: ['SCHEDULE_CHANGED', 'LESSON_ROOM_CHANGED'] }, as('GUARDIAN'));
    expect(tx.notificationOptOut.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(tx.notificationOptOut.createMany).toHaveBeenCalledWith({
      data: [
        { userId: USER, schoolId: SCHOOL, type: 'SCHEDULE_CHANGED' },
        { userId: USER, schoolId: SCHOOL, type: 'LESSON_ROOM_CHANGED' },
      ],
    });
    expect(result.types.find((t) => t.type === 'SCHEDULE_CHANGED')).toEqual({ type: 'SCHEDULE_CHANGED', enabled: false, required: false });
    // Never an unfiltered delete.
    for (const call of tx.notificationOptOut.deleteMany.mock.calls) expect(call[0]).toEqual({ where: { userId: USER } });
  });

  it('clears the set with an empty list and writes no rows', async () => {
    await service.put({ optOut: [] }, as('STUDENT'));
    expect(tx.notificationOptOut.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(tx.notificationOptOut.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['GUARDIAN', 'ABSENCE_UNREPORTED', NOTIFICATION_TYPE_REQUIRED],
    ['TEACHER', 'LESSON_COVER_WITHDRAWN', NOTIFICATION_TYPE_REQUIRED],
    ['SCHOOL_ADMIN', 'LESSON_COVER_WITHDRAWN', NOTIFICATION_TYPE_REQUIRED],
    ['STUDENT', 'ABSENCE_UNREPORTED', NOTIFICATION_TYPE_NOT_OFFERED],
    ['GUARDIAN', 'ROOM_BOOKING_DECIDED', NOTIFICATION_TYPE_NOT_OFFERED],
    ['TEACHER', 'SCHEDULE_CHANGED', NOTIFICATION_TYPE_NOT_OFFERED],
    ['SCHOOL_ADMIN', 'TEACHER_ABSENCE_REPORTED', NOTIFICATION_TYPE_NOT_OFFERED],
  ])('refuses a %s choosing %s with %s, writing nothing', async (role, type, code) => {
    const error = await service.put({ optOut: [type] }, as(role)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code, params: { type } });
    expect(prisma.withRls).not.toHaveBeenCalled();
  });

  it('knows which notices are delivered regardless', () => {
    expect(deliveredRegardless('ABSENCE_UNREPORTED', {})).toBe(true);
    expect(deliveredRegardless('LESSON_COVER_WITHDRAWN', {})).toBe(true);
    expect(deliveredRegardless('LESSON_SUBSTITUTE', { cover: true })).toBe(true);
    expect(deliveredRegardless('LESSON_SUBSTITUTE', {})).toBe(false);
    expect(deliveredRegardless('LESSON_SUBSTITUTE', { cover: 'true' })).toBe(false);
    expect(deliveredRegardless('LESSON_CANCELLED', {})).toBe(false);
    expect(isChoosingRole('GUARDIAN')).toBe(true);
    expect(isChoosingRole('constructor')).toBe(false);
  });
});
