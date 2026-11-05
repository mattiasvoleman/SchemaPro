import { Prisma } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CrisisService } from './crisis.service';

const SCHOOL = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const TEACHER = '33333333-3333-4333-8333-333333333333';
const TEACHER2 = '33333333-3333-4333-8333-333333333334';
const PUPIL = '44444444-4444-4444-8444-444444444441';
const PUPIL2 = '44444444-4444-4444-8444-444444444442';
const GROUP = '55555555-5555-4555-8555-555555555555';
const LESSON = '66666666-6666-4666-8666-666666666666';
const ALARM = '77777777-7777-4777-8777-777777777777';
const CALL = '88888888-8888-4888-8888-888888888888';
const MARK = '99999999-9999-4999-8999-999999999999';

const admin = testUser({ role: Role.SCHOOL_ADMIN, userId: ADMIN, schoolId: SCHOOL, adminProfile: 'FULL' });
const teacher = testUser({ role: Role.TEACHER, userId: TEACHER, schoolId: SCHOOL });

const sqlError = (state: string) =>
  new Prisma.PrismaClientKnownRequestError('refused', {
    code: 'P2010',
    clientVersion: 'x',
    meta: { driverAdapterError: { cause: { originalCode: state } } },
  });

const code = async (promise: Promise<unknown>): Promise<unknown> => {
  const error = await promise.then(() => null, (e: unknown) => e);
  return (error as { getResponse?: () => { code?: string } } | null)?.getResponse?.().code ?? String(error);
};

describe('CrisisService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { notifyUsers: jest.Mock; guardiansOf: jest.Mock };
  let realtime: { notifyCrisisChanged: jest.Mock };
  let service: CrisisService;

  const alarmRow = (extra: Record<string, unknown> = {}) => ({
    id: ALARM,
    schoolId: SCHOOL,
    kind: 'EVACUATION',
    mode: 'LIVE',
    startedAt: new Date('2027-01-12T09:10:00Z'),
    startedByUserId: ADMIN,
    endedAt: null,
    endedByUserId: null,
    autoEnded: false,
    endNote: null,
    guardiansNotifiedAt: null,
    listsSealedAt: null,
    ...extra,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), guardiansOf: jest.fn().mockResolvedValue([]) };
    realtime = { notifyCrisisChanged: jest.fn() };
    service = new CrisisService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService, realtime as unknown as RealtimeService);
  });

  describe('settings', () => {
    it('are the defaults when the school has set nothing: every profile that writes Drift, and the guardians not told', async () => {
      tx.crisisSettings.findUnique.mockResolvedValue(null);
      expect(await service.settings(admin)).toEqual({ startProfiles: ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'], notifyGuardiansAfter: false });
    });

    it('are written as one row for the school', async () => {
      tx.crisisSettings.upsert.mockResolvedValue({ startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true });
      expect(await service.updateSettings({ startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true }, admin)).toEqual({
        startProfiles: ['EXPEDITION'],
        notifyGuardiansAfter: true,
      });
      expect(tx.crisisSettings.upsert).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL },
        create: { schoolId: SCHOOL, startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true },
        update: { startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true },
      });
    });
  });

  describe('start', () => {
    const NOW = new Date('2027-01-12T09:10:00Z');

    it('is refused, with the school\'s rule in the answer, to an administrator the school did not let start an alarm', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: false }]);
      expect(await code(service.start({ kind: 'EVACUATION', mode: 'LIVE' }, admin))).toBe('CRISIS_NOT_YOURS');
      expect(tx.crisisAlarm.create).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('takes the lists from the timetable at the transaction\'s time, writes them with the alarm, seals them and tells the staff but the starter', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]);
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      // One lesson going on at 09:10Z (10:10 in Stockholm in January), its teacher, and two pupils on its class.
      tx.calendarLesson.findMany.mockResolvedValue([
        {
          id: LESSON,
          subjectId: 's1',
          studentGroupId: GROUP,
          startsAt: new Date('2027-01-12T09:00:00Z'),
          endsAt: new Date('2027-01-12T09:45:00Z'),
          subject: { name: 'Matematik' },
          studentGroup: { name: '7A' },
          room: { name: 'Sal 101' },
          extraGroups: [],
          teachers: [{ teacherId: TEACHER, role: 'LEAD' }],
        },
      ]);
      tx.user.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
        if (args.where['studentGroupId']) return [{ id: PUPIL, studentGroupId: GROUP }, { id: PUPIL2, studentGroupId: GROUP }];
        // The staff, as the query asks for them: everyone but the one who started the alarm.
        if (args.where['role']) return [{ id: ADMIN }, { id: TEACHER }, { id: TEACHER2 }].filter((row) => row.id !== (args.where['id'] as { not?: string }).not);
        return [];
      });
      // The first pupil was marked absent by this morning's register.
      tx.attendanceRecord.findMany.mockResolvedValue([{ studentId: PUPIL, status: 'ABSENT', calendarLesson: { startsAt: new Date('2027-01-12T07:00:00Z') } }]);
      tx.crisisAlarm.create.mockResolvedValue(alarmRow());
      tx.crisisAlarm.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => alarmRow(data));
      // No exercise to cut short; then detail() reads the alarm back, and nothing else of it matters here.
      tx.crisisAlarm.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(alarmRow({ listsSealedAt: NOW }));
      tx.crisisCall.findMany.mockResolvedValue([]);

      await service.start({ kind: 'EVACUATION', mode: 'LIVE' }, admin);

      const calls = (tx.crisisCall.createMany.mock.calls[0]![0] as { data: Array<Record<string, unknown>> }).data;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        schoolId: SCHOOL,
        alarmId: ALARM,
        calendarLessonId: LESSON,
        basis: 'LESSON',
        groupName: '7A',
        subjectName: 'Matematik',
        roomName: 'Sal 101',
      });
      expect(tx.crisisCallTeacher.createMany).toHaveBeenCalledWith({
        data: [{ schoolId: SCHOOL, callId: calls[0]!['id'], teacherId: TEACHER, role: 'LEAD' }],
      });
      const pupils = (tx.crisisPupil.createMany.mock.calls[0]![0] as { data: Array<Record<string, unknown>> }).data;
      expect(pupils.map((p) => [p['studentId'], p['priorAbsentSource']])).toEqual([
        [PUPIL, 'ATTENDANCE'],
        [PUPIL2, null],
      ]);
      // Sealed in the same transaction, and the alarm is the first thing written.
      expect(tx.crisisAlarm.update).toHaveBeenCalledWith({ where: { id: ALARM }, data: { listsSealedAt: NOW } });
      expect(tx.crisisAlarm.create.mock.invocationCallOrder[0]).toBeLessThan(tx.crisisCall.createMany.mock.invocationCallOrder[0]!);
      expect(tx.crisisAlarm.update.mock.invocationCallOrder[0]).toBeGreaterThan(tx.crisisPupil.createMany.mock.invocationCallOrder[0]!);
      // The staff but the starter are told, after the commit, in words that name nobody.
      await new Promise((resolve) => setImmediate(resolve));
      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
      const told = notifications.notifyUsers.mock.calls[0]![1] as { type: string; userIds: string[]; meta: Record<string, unknown> };
      expect(told.type).toBe('CRISIS_ALARM');
      expect(told.userIds).toEqual([TEACHER, TEACHER2]);
      expect(Object.keys(told.meta).sort()).toEqual(['alarmId', 'kind', 'mode', 'startedAt']);
      expect(realtime.notifyCrisisChanged).toHaveBeenCalledWith(SCHOOL, ALARM, 'staff');
    });

    it('is a 409 that names the alarm already going when the mode is taken, and writes nothing', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]);
      tx.crisisAlarm.findFirst.mockResolvedValue({ id: ALARM });
      const error = await service.start({ kind: 'LOCKDOWN', mode: 'LIVE' }, admin).then(() => null, (e: unknown) => e);
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({ code: 'CRISIS_ALARM_OPEN', params: { alarmId: ALARM } });
      expect(tx.crisisAlarm.create).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('is the same 409 for the administrator who lost a race, without the id (the winner is not committed yet)', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]);
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      tx.crisisAlarm.findFirst.mockResolvedValue(null);
      tx.crisisAlarm.create.mockRejectedValue(sqlError('23505'));
      const error = await service.start({ kind: 'LOCKDOWN', mode: 'LIVE' }, admin).then(() => null, (e: unknown) => e);
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({ code: 'CRISIS_ALARM_OPEN' });
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('cuts an exercise that is going short when a real alarm starts', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]);
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      // Nothing of the real kind is going; an exercise is.
      tx.crisisAlarm.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'drill-1' }).mockResolvedValue(alarmRow());
      tx.crisisAlarm.create.mockResolvedValue(alarmRow());
      tx.crisisAlarm.update.mockResolvedValue(alarmRow());
      await service.start({ kind: 'EVACUATION', mode: 'LIVE' }, admin).catch(() => undefined);
      expect(tx.crisisAlarm.update).toHaveBeenCalledWith({ where: { id: 'drill-1' }, data: { endedAt: NOW, endNote: 'Avbröts av ett skarpt larm.' } });
    });
  });

  describe('end', () => {
    const open = alarmRow({ listsSealedAt: new Date('2027-01-12T09:10:00Z') });

    it('tells the guardians of the pupils on the lists only after a real alarm and only when the school chose to', async () => {
      tx.crisisAlarm.findFirst.mockResolvedValue(open);
      tx.crisisSettings.findUnique.mockResolvedValue({ notifyGuardiansAfter: true });
      tx.crisisPupil.findMany.mockResolvedValue([{ studentId: PUPIL }]);
      notifications.guardiansOf.mockResolvedValue(['g1', 'g1', 'g2']);
      tx.crisisAlarm.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => alarmRow({ ...data, listsSealedAt: new Date() }));
      tx.user.findMany.mockResolvedValue([{ id: TEACHER }]);
      await service.end(ALARM, { note: 'Falsklarm' }, admin).catch(() => undefined);
      const update = tx.crisisAlarm.update.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(update.data['endNote']).toBe('Falsklarm');
      expect(update.data['guardiansNotifiedAt']).toBeInstanceOf(Date);
      await new Promise((resolve) => setImmediate(resolve));
      const types = notifications.notifyUsers.mock.calls.map((call) => (call[1] as { type: string }).type);
      expect(types).toEqual(['CRISIS_ENDED', 'CRISIS_GUARDIAN_AFTER']);
      const guardian = notifications.notifyUsers.mock.calls[1]![1] as { userIds: string[]; meta: Record<string, unknown> };
      expect(guardian.userIds).toEqual(['g1', 'g2']);
      expect(Object.keys(guardian.meta).sort()).toEqual(['endedAt', 'kind', 'startedAt']);
    });

    it('tells no guardian after an exercise, or when the school did not choose to', async () => {
      tx.crisisAlarm.findFirst.mockResolvedValue({ ...open, mode: 'DRILL' });
      tx.crisisSettings.findUnique.mockResolvedValue({ notifyGuardiansAfter: true });
      tx.crisisAlarm.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => alarmRow({ ...data, mode: 'DRILL' }));
      await service.end(ALARM, {}, admin).catch(() => undefined);
      expect(notifications.guardiansOf).not.toHaveBeenCalled();
      expect((tx.crisisAlarm.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data['guardiansNotifiedAt']).toBeUndefined();
    });

    it('is a 409 when the alarm has ended already, whether the service saw it or the database did', async () => {
      tx.crisisAlarm.findFirst.mockResolvedValue({ ...open, endedAt: new Date() });
      expect(await code(service.end(ALARM, {}, admin))).toBe('CRISIS_ALARM_ENDED');
      tx.crisisAlarm.findFirst.mockResolvedValue(open);
      tx.crisisAlarm.update.mockRejectedValue(sqlError('KL409'));
      expect(await code(service.end(ALARM, {}, admin))).toBe('CRISIS_ALARM_ENDED');
      tx.crisisAlarm.findFirst.mockResolvedValue(null);
      expect(await code(service.end(ALARM, {}, admin))).toBe('CRISIS_ALARM_NOT_FOUND');
    });
  });

  describe('marks', () => {
    const at = '2027-01-12T09:12:00.000Z';
    const call = (extra: Record<string, unknown> = {}) => ({
      id: CALL,
      alarmId: ALARM,
      calendarLessonId: LESSON,
      alarm: { startedAt: new Date('2027-01-12T09:10:00Z') },
      ...extra,
    });

    it('names the group by its call or by its lesson, not both and not neither', async () => {
      expect(await code(service.markMine([{ id: MARK, callId: CALL, lessonId: LESSON, studentId: PUPIL, state: 'FOUND', at }], teacher))).toBe('CRISIS_MARK_INVALID');
      expect(await code(service.markMine([{ id: MARK, studentId: PUPIL, state: 'FOUND', at }], teacher))).toBe('CRISIS_MARK_INVALID');
      expect(tx.crisisReport.createMany).not.toHaveBeenCalled();
    });

    it('stores a mark once however often it is sent, and tells the admins\' live view', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      expect(await service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL, state: 'FOUND', at }], teacher)).toEqual({ stored: 1, duplicates: 0, unresolved: [] });
      expect(tx.crisisReport.createMany).toHaveBeenCalledWith({
        data: [{ id: MARK, schoolId: SCHOOL, alarmId: ALARM, callId: CALL, studentId: PUPIL, state: 'FOUND', at: new Date(at) }],
        skipDuplicates: true,
      });
      expect(realtime.notifyCrisisChanged).toHaveBeenCalledWith(SCHOOL, ALARM, 'admin');
      tx.crisisReport.createMany.mockResolvedValue({ count: 0 });
      expect(await service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL, state: 'FOUND', at }], teacher)).toEqual({ stored: 0, duplicates: 1, unresolved: [] });
    });

    it('finds a lesson\'s call in the alarm that was going when the mark was made, and says which marks belong to none', async () => {
      const older = call({ id: 'older', alarmId: 'alarm-older', alarm: { startedAt: new Date('2027-01-12T08:00:00Z') } });
      const newer = call({ id: 'newer', alarmId: 'alarm-newer', alarm: { startedAt: new Date('2027-01-12T09:00:00Z') } });
      tx.crisisCall.findMany.mockResolvedValue([older, newer]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      const lost = '99999999-9999-4999-8999-999999999998';
      const result = await service.markMine(
        [
          { id: MARK, lessonId: LESSON, studentId: PUPIL, state: 'FOUND', at },
          // Made before either alarm started: it belongs to neither.
          { id: lost, lessonId: LESSON, studentId: PUPIL, state: 'FOUND', at: '2027-01-12T07:00:00.000Z' },
        ],
        teacher,
      );
      expect(result.unresolved).toEqual([lost]);
      expect((tx.crisisReport.createMany.mock.calls[0]![0] as { data: Array<{ callId: string }> }).data.map((row) => row.callId)).toEqual(['newer']);
    });

    it('answers the database\'s refusals as coded answers', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      const send = () => service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL, state: 'FOUND', at }], teacher);
      tx.crisisReport.createMany.mockRejectedValue(sqlError('KL410'));
      expect(await code(send())).toBe('CRISIS_ALARM_ENDED');
      tx.crisisReport.createMany.mockRejectedValue(sqlError('KL404'));
      expect(await code(send())).toBe('CRISIS_ALARM_NOT_FOUND');
      tx.crisisReport.createMany.mockRejectedValue(sqlError('23503'));
      expect(await code(send())).toBe('CRISIS_MARK_INVALID');
      tx.crisisReport.createMany.mockRejectedValue(sqlError('42501'));
      expect(await code(send())).toBe('CRISIS_NOT_YOURS');
    });

    it('reaches only the alarm the administration names', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      await service.markAsAdministration(ALARM, [{ id: MARK, callId: CALL, studentId: PUPIL, state: 'MISSING', at }], admin);
      expect((tx.crisisCall.findMany.mock.calls[0]![0] as { where: { alarmId: string } }).where.alarmId).toBe(ALARM);
    });
  });

  describe('mine', () => {
    it('hands the phone its groups with the colleagues named and the count worked out, and the moment it was read', async () => {
      tx.crisisAlarm.findMany.mockResolvedValue([alarmRow()]);
      tx.crisisCall.findMany.mockResolvedValue([
        {
          id: CALL,
          alarmId: ALARM,
          calendarLessonId: LESSON,
          basis: 'NEXT_LESSON',
          groupName: '7A',
          subjectName: 'Svenska',
          roomName: null,
          lessonStartsAt: new Date('2027-01-12T09:20:00Z'),
          lessonEndsAt: new Date('2027-01-12T10:05:00Z'),
          completedAt: null,
          teachers: [
            { teacherId: TEACHER, role: 'LEAD', answeredAt: null },
            { teacherId: TEACHER2, role: 'ASSISTANT', answeredAt: null },
          ],
          pupils: [
            { studentId: PUPIL, priorAbsentSource: 'ATTENDANCE', state: null, stateAt: null, stateByUserId: null },
            { studentId: PUPIL2, priorAbsentSource: null, state: 'FOUND', stateAt: new Date('2027-01-12T09:12:00Z'), stateByUserId: TEACHER },
          ],
        },
      ]);
      tx.user.findMany.mockResolvedValue([
        { id: TEACHER, firstName: 'Anna', lastName: 'Lind' },
        { id: TEACHER2, firstName: 'Bo', lastName: 'Berg' },
        { id: PUPIL, firstName: 'Zeb', lastName: 'Öst' },
        { id: PUPIL2, firstName: 'Al', lastName: 'Ek' },
      ]);
      const result = await service.mine(teacher);
      expect(result.alarms).toHaveLength(1);
      const mine = result.alarms[0]!.calls[0]!;
      expect(mine.colleagues).toEqual(['Bo Berg']);
      expect(mine.basis).toBe('NEXT_LESSON');
      expect(mine.counts).toEqual({ pupils: 2, found: 1, missing: 0, absentBefore: 1, unreported: 0 });
      // Surname order in Swedish, and a phone is not told who made a mark.
      expect(mine.pupils.map((p) => p.lastName)).toEqual(['Ek', 'Öst']);
      expect(mine.pupils.every((p) => p.markedBy === null)).toBe(true);
      expect(new Date(result.asOf).getTime()).toBeGreaterThan(0);
    });
  });

  describe('settle', () => {
    it('asks the database to end the alarms left open and answers how many it did', async () => {
      tx.$queryRaw.mockResolvedValue([{ n: 2 }]);
      expect(await service.settle()).toBe(2);
      expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);
    });
  });
});
