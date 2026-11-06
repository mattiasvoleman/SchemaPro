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
const PUPIL3 = '44444444-4444-4444-8444-444444444443';
const OTHER_CALL = '88888888-8888-4888-8888-888888888889';
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
      // Allowed to start, the moment, and no exercise to cut short (the row lock finds none).
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]).mockResolvedValueOnce([]);
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
        // Every active pupil of the school: the third is on no lesson.
        if (args.where['role'] === 'STUDENT' && !args.where['studentGroupId']) return [{ id: PUPIL }, { id: PUPIL2 }, { id: PUPIL3 }];
        if (args.where['studentGroupId']) return [{ id: PUPIL, studentGroupId: GROUP }, { id: PUPIL2, studentGroupId: GROUP }];
        // The staff, as the query asks for them: everyone but the one who started the alarm.
        if (args.where['role']) return [{ id: ADMIN }, { id: TEACHER }, { id: TEACHER2 }].filter((row) => row.id !== (args.where['id'] as { not?: string }).not);
        return [];
      });
      // The first pupil was marked absent by this morning's register.
      tx.attendanceRecord.findMany.mockResolvedValue([{ studentId: PUPIL, status: 'ABSENT', calendarLesson: { startsAt: new Date('2027-01-12T07:00:00Z') } }]);
      tx.crisisAlarm.create.mockResolvedValue(alarmRow());
      tx.crisisAlarm.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => alarmRow(data));
      // None going; then detail() reads the alarm back, and nothing else of it matters here.
      tx.crisisAlarm.findFirst.mockResolvedValueOnce(null).mockResolvedValue(alarmRow({ listsSealedAt: NOW }));
      tx.crisisCall.findMany.mockResolvedValue([]);

      await service.start({ kind: 'EVACUATION', mode: 'LIVE' }, admin);

      const calls = (tx.crisisCall.createMany.mock.calls[0]![0] as { data: Array<Record<string, unknown>> }).data;
      expect(calls).toHaveLength(2);
      // Every active pupil is on the roll call: the one no lesson has stands on a group of her own, with no teacher.
      expect(calls[1]).toMatchObject({
        schoolId: SCHOOL,
        alarmId: ALARM,
        calendarLessonId: null,
        basis: 'NO_LESSON',
        groupName: 'Ej i lektion just nu',
        lessonStartsAt: NOW,
        lessonEndsAt: NOW,
      });
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
      expect(pupils.map((p) => [p['studentId'], p['priorAbsentSource'], p['callId'] === calls[1]!['id']])).toEqual([
        [PUPIL, 'ATTENDANCE', false],
        [PUPIL2, null, false],
        [PUPIL3, null, true],
      ]);
      // One start at a time in a school.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
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

    it('refuses an exercise while a real alarm is going, naming the real one', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]);
      // No exercise is going; a real alarm is.
      tx.crisisAlarm.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ALARM });
      const error = await service.start({ kind: 'EVACUATION', mode: 'DRILL' }, admin).then(() => null, (e: unknown) => e);
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({ code: 'CRISIS_ALARM_OPEN', params: { alarmId: ALARM } });
      expect(tx.crisisAlarm.create).not.toHaveBeenCalled();
    });

    it('is the same refusal for the exercise a real alarm beat to the insert (the database\'s KL412)', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]);
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      tx.crisisAlarm.findFirst.mockResolvedValue(null);
      tx.crisisAlarm.create.mockRejectedValue(sqlError('KL412'));
      expect(await code(service.start({ kind: 'EVACUATION', mode: 'DRILL' }, admin))).toBe('CRISIS_ALARM_OPEN');
    });

    it('goes on when the exercise it would cut short ended in the same moment: its row lock waits for the end and finds nothing to cut', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]).mockResolvedValueOnce([]);
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      tx.crisisAlarm.findFirst.mockResolvedValueOnce(null).mockResolvedValue(alarmRow());
      tx.crisisAlarm.create.mockResolvedValue(alarmRow());
      tx.crisisAlarm.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => alarmRow(data));
      tx.crisisCall.findMany.mockResolvedValue([]);
      await service.start({ kind: 'EVACUATION', mode: 'LIVE' }, admin);
      expect(tx.crisisAlarm.create).toHaveBeenCalledTimes(1);
      expect(tx.crisisAlarm.update).toHaveBeenCalledTimes(1); // the seal alone
    });

    it('cuts an exercise that is going short when a real alarm starts', async () => {
      // Nothing of the real kind is going; an exercise is, and its row is locked before it is ended.
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ now: NOW }]).mockResolvedValueOnce([{ id: 'drill-1' }]);
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      tx.crisisAlarm.findFirst.mockResolvedValueOnce(null).mockResolvedValue(alarmRow());
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
      // That it happened and ended, and when: no kind of alarm, no alarm to open, no pupil.
      expect(Object.keys(guardian.meta).sort()).toEqual(['endedAt', 'startedAt']);
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

    beforeEach(() => {
      // Both pupils are on the list of the call the marks are made on, unless a test says otherwise.
      tx.crisisPupil.findMany.mockResolvedValue([
        { callId: CALL, studentId: PUPIL },
        { callId: 'older', studentId: PUPIL },
        { callId: 'newer', studentId: PUPIL },
      ]);
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
      const skewed = '99999999-9999-4999-8999-999999999997';
      const result = await service.markMine(
        [
          { id: MARK, lessonId: LESSON, studentId: PUPIL, state: 'FOUND', at },
          // Made long before either alarm started: it belongs to neither.
          { id: lost, lessonId: LESSON, studentId: PUPIL, state: 'FOUND', at: '2027-01-12T07:00:00.000Z' },
          // Made by a phone whose clock is three minutes behind the gateway's, just before the newer alarm began: it is that alarm's.
          { id: skewed, lessonId: LESSON, studentId: PUPIL, state: 'FOUND', at: '2027-01-12T08:57:00.000Z' },
        ],
        teacher,
      );
      expect(result.unresolved).toEqual([lost]);
      expect((tx.crisisReport.createMany.mock.calls[0]![0] as { data: Array<{ callId: string }> }).data.map((row) => row.callId)).toEqual(['newer', 'newer']);
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

    it('stores a found mark for a pupil who is not on the list as found with the teacher\'s call, on the pupil\'s own', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      tx.$queryRaw.mockResolvedValueOnce([{ alarmId: ALARM, studentId: PUPIL2, callId: OTHER_CALL }]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      await service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL2, state: 'FOUND', at }], teacher);
      expect(tx.crisisReport.createMany).toHaveBeenCalledWith({
        data: [{ id: MARK, schoolId: SCHOOL, alarmId: ALARM, callId: OTHER_CALL, foundInCallId: CALL, studentId: PUPIL2, state: 'FOUND', at: new Date(at) }],
        skipDuplicates: true,
      });
    });

    it('refuses a missing mark for a pupil who is not on the list, and a pupil who is in no part of the alarm', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      expect(await code(service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL2, state: 'MISSING', at }], teacher))).toBe('CRISIS_MARK_INVALID');
      tx.$queryRaw.mockResolvedValueOnce([{ alarmId: ALARM, studentId: PUPIL2, callId: null }]);
      expect(await code(service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL2, state: 'FOUND', at }], teacher))).toBe('CRISIS_MARK_INVALID');
      expect(tx.crisisReport.createMany).not.toHaveBeenCalled();
    });

    it('sends a batch in (call, pupil) order, whatever order the teacher marked them in', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      tx.crisisPupil.findMany.mockResolvedValue([{ callId: CALL, studentId: PUPIL }, { callId: CALL, studentId: PUPIL2 }, { callId: CALL, studentId: PUPIL3 }]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 3 });
      const id = (n: number) => `99999999-9999-4999-8999-99999999990${n}`;
      await service.markMine(
        [
          { id: id(1), callId: CALL, studentId: PUPIL3, state: 'FOUND', at },
          { id: id(2), callId: CALL, studentId: PUPIL, state: 'FOUND', at },
          { id: id(3), callId: CALL, studentId: PUPIL2, state: 'MISSING', at },
        ],
        teacher,
      );
      expect((tx.crisisReport.createMany.mock.calls[0]![0] as { data: Array<{ studentId: string }> }).data.map((row) => row.studentId)).toEqual([PUPIL, PUPIL2, PUPIL3]);
    });

    it('answers a deadlock between two batches as a 409 that says to send again', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      tx.crisisReport.createMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'x' }));
      expect(await code(service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL, state: 'FOUND', at }], teacher))).toBe('WRITE_CONFLICT');
    });

    it('lets only the administration say a pupil is not in the building, and only a teacher take back a found mark', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      expect(await code(service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL, state: 'AWAY', at }], teacher))).toBe('CRISIS_MARK_INVALID');
      expect(await code(service.markAsAdministration(ALARM, [{ id: MARK, callId: CALL, studentId: PUPIL, state: 'RETRACTED', at }], admin))).toBe('CRISIS_MARK_INVALID');
      expect(tx.crisisReport.createMany).not.toHaveBeenCalled();
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      await service.markAsAdministration(ALARM, [{ id: MARK, callId: CALL, studentId: PUPIL, state: 'AWAY', at }], admin);
      expect((tx.crisisReport.createMany.mock.calls[0]![0] as { data: Array<{ state: string }> }).data[0]!.state).toBe('AWAY');
    });

    it('takes a mark that names the alarm alone from a teacher with no group: found, on the pupil\'s own group, with no group to find them with', async () => {
      tx.crisisAlarm.findMany.mockResolvedValue([{ id: ALARM }]);
      tx.crisisCall.findMany.mockResolvedValue([]);
      tx.$queryRaw.mockResolvedValueOnce([{ alarmId: ALARM, studentId: PUPIL2, callId: OTHER_CALL }]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      await service.markMine([{ id: MARK, alarmId: ALARM, studentId: PUPIL2, state: 'FOUND', at }], teacher);
      expect(tx.crisisReport.createMany).toHaveBeenCalledWith({
        data: [{ id: MARK, schoolId: SCHOOL, alarmId: ALARM, callId: OTHER_CALL, studentId: PUPIL2, state: 'FOUND', at: new Date(at) }],
        skipDuplicates: true,
      });
      // Not missing, not away; an alarm the teacher cannot read belongs to none of theirs; a pupil who is in no part of it is refused.
      expect(await code(service.markMine([{ id: MARK, alarmId: ALARM, studentId: PUPIL2, state: 'MISSING', at }], teacher))).toBe('CRISIS_MARK_INVALID');
      tx.crisisAlarm.findMany.mockResolvedValue([]);
      const gone = '99999999-9999-4999-8999-999999999996';
      expect((await service.markMine([{ id: gone, alarmId: ALARM, studentId: PUPIL2, state: 'FOUND', at }], teacher)).unresolved).toEqual([gone]);
      tx.crisisAlarm.findMany.mockResolvedValue([{ id: ALARM }]);
      tx.$queryRaw.mockResolvedValueOnce([{ alarmId: ALARM, studentId: PUPIL2, callId: null }]);
      expect(await code(service.markMine([{ id: MARK, alarmId: ALARM, studentId: PUPIL2, state: 'FOUND', at }], teacher))).toBe('CRISIS_MARK_INVALID');
    });

    it('names the group in exactly one way, the alarm too', async () => {
      expect(await code(service.markMine([{ id: MARK, callId: CALL, alarmId: ALARM, studentId: PUPIL, state: 'FOUND', at }], teacher))).toBe('CRISIS_MARK_INVALID');
    });

    it('sends a withdrawal like a found mark, and answers one with nothing to withdraw as a coded refusal', async () => {
      tx.crisisCall.findMany.mockResolvedValue([call()]);
      tx.$queryRaw.mockResolvedValueOnce([{ alarmId: ALARM, studentId: PUPIL2, callId: OTHER_CALL }]);
      tx.crisisReport.createMany.mockResolvedValue({ count: 1 });
      await service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL2, state: 'RETRACTED', at }], teacher);
      expect((tx.crisisReport.createMany.mock.calls[0]![0] as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({ callId: OTHER_CALL, foundInCallId: CALL, state: 'RETRACTED' });
      tx.$queryRaw.mockResolvedValueOnce([{ alarmId: ALARM, studentId: PUPIL2, callId: OTHER_CALL }]);
      tx.crisisReport.createMany.mockRejectedValue(sqlError('KL413'));
      expect(await code(service.markMine([{ id: MARK, callId: CALL, studentId: PUPIL2, state: 'RETRACTED', at }], teacher))).toBe('CRISIS_MARK_INVALID');
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
      // This teacher found two pupils with the call (one of them withdrawn again), and one with no group.
      const find = (extra: Record<string, unknown>) => ({ alarmId: ALARM, callId: OTHER_CALL, foundInCallId: null, byUserId: TEACHER, state: 'FOUND', ...extra });
      tx.crisisReport.findMany.mockResolvedValue([
        find({ foundInCallId: CALL, studentId: PUPIL3, at: new Date('2027-01-12T09:13:00Z') }),
        find({ foundInCallId: CALL, studentId: 'p5', at: new Date('2027-01-12T09:13:30Z') }),
        find({ foundInCallId: CALL, studentId: 'p5', state: 'RETRACTED', at: new Date('2027-01-12T09:14:00Z') }),
        find({ studentId: 'p4', at: new Date('2027-01-12T09:15:00Z') }),
        // An ordinary mark of the teacher's own list is not a find.
        find({ callId: CALL, studentId: PUPIL2, at: new Date('2027-01-12T09:12:00Z') }),
      ]);
      const people = [
        { id: TEACHER, firstName: 'Anna', lastName: 'Lind', studentGroup: null },
        { id: TEACHER2, firstName: 'Bo', lastName: 'Berg', studentGroup: null },
        { id: PUPIL, firstName: 'Zeb', lastName: 'Öst', studentGroup: { name: '7A' } },
        { id: PUPIL2, firstName: 'Al', lastName: 'Ek', studentGroup: { name: '7A' } },
        { id: PUPIL3, firstName: 'Cy', lastName: 'Dal', studentGroup: { name: '8B' } },
        { id: 'p4', firstName: 'Di', lastName: 'Bro', studentGroup: null },
        { id: 'p5', firstName: 'Ed', lastName: 'Sol', studentGroup: { name: '9C' } },
      ];
      tx.user.findMany.mockImplementation(async (args: { where: { id?: { in?: string[] } } }) => people.filter((person) => !args.where.id?.in || args.where.id.in.includes(person.id)));
      const result = await service.mine(teacher);
      expect(result.alarms).toHaveLength(1);
      const mine = result.alarms[0]!.calls[0]!;
      expect(mine.colleagues).toEqual(['Bo Berg']);
      expect(mine.basis).toBe('NEXT_LESSON');
      expect(mine.counts).toEqual({ pupils: 2, found: 1, missing: 0, away: 0, absentBefore: 1, unreported: 0 });
      // Surname order in Swedish, and a phone is not told who made a mark.
      expect(mine.pupils.map((p) => p.lastName)).toEqual(['Ek', 'Öst']);
      expect(mine.pupils.every((p) => p.markedBy === null)).toBe(true);
      // Found with this call: named, with their own class; the withdrawn one is gone. Found with no group: listed on the alarm.
      expect(mine.foundHere).toEqual([{ studentId: PUPIL3, firstName: 'Cy', lastName: 'Dal', className: '8B', markedAt: '2027-01-12T09:13:00.000Z' }]);
      expect(result.alarms[0]!.foundFree).toEqual([{ studentId: 'p4', firstName: 'Di', lastName: 'Bro', className: null, markedAt: '2027-01-12T09:15:00.000Z' }]);
      expect(result.alarms[0]).not.toHaveProperty('others');
      // The call is complete: the second pupil has a mark, the first was absent before and needs none.
      expect(mine.completedAt).toBe('2027-01-12T09:12:00.000Z');
      expect(new Date(result.asOf).getTime()).toBeGreaterThan(0);
    });
  });

  describe('searchPupils', () => {
    it('finds pupils of the school who are not on the teacher\'s lists by every word of the name or the class, at most 25, and records the read', async () => {
      tx.crisisAlarm.findFirst.mockResolvedValue({ id: ALARM });
      tx.crisisPupil.findMany.mockResolvedValue([{ studentId: PUPIL }]);
      tx.user.findMany.mockResolvedValue([{ id: PUPIL3, firstName: 'Cy', lastName: 'Dal', studentGroup: { name: '8B' } }]);
      const found = await service.searchPupils(ALARM, 'cy 8b', teacher);
      expect(found).toEqual([{ studentId: PUPIL3, firstName: 'Cy', lastName: 'Dal', className: '8B' }]);
      const query = tx.user.findMany.mock.calls[0]![0] as { where: { id: { notIn: string[] }; AND: unknown[]; role: string; isActive: boolean; schoolId: string }; take: number };
      expect(query.where).toMatchObject({ schoolId: SCHOOL, role: 'STUDENT', isActive: true, id: { notIn: [PUPIL] } });
      expect(query.where.AND).toHaveLength(2); // one clause per word
      expect(query.take).toBe(25);
    });

    it('is a 404 for an alarm the teacher may not read', async () => {
      tx.crisisAlarm.findFirst.mockResolvedValue(null);
      expect(await code(service.searchPupils(ALARM, 'cy', teacher))).toBe('CRISIS_ALARM_NOT_FOUND');
      expect(tx.user.findMany).not.toHaveBeenCalled();
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
