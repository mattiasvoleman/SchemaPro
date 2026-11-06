import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AckService } from './ack.service';

const admin = testUser({ schoolId: 'school-1', userId: 'admin-1' });
const teacher = testUser({ schoolId: 'school-1', userId: 'teacher-1', role: 'TEACHER' as never });
const guardian = testUser({ schoolId: 'school-1', userId: 'guardian-1', role: 'GUARDIAN' as never });
const REQ = '44444444-4444-4444-8444-444444444444';

/** The SQL a tagged template or Prisma.sql carries, as one string. */
const sqlOf = (arg: unknown): string =>
  Array.isArray(arg) ? arg.join('?') : typeof arg === 'object' && arg !== null && 'sql' in arg ? String((arg as { sql: string }).sql) : String(arg);

/** Answers $queryRaw by a fragment of its SQL, in the order the keys are given. */
function raw(tx: TxMock, answers: Record<string, unknown>): void {
  tx.$queryRaw.mockImplementation((strings: unknown) => {
    const sql = sqlOf(strings);
    for (const [fragment, answer] of Object.entries(answers)) {
      if (sql.includes(fragment)) return Promise.resolve(typeof answer === 'function' ? (answer as () => unknown)() : answer);
    }
    return Promise.resolve([]);
  });
}

function setup() {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const notifications = { notifyUsers: jest.fn().mockResolvedValue(0), deliverCommitted: jest.fn() };
  const service = new AckService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  return { tx, prisma, notifications, service };
}

/** The refusal the database raises from app.ack_confirm, as the adapter reports a raw statement's (P2010). */
function sqlState(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: code } } },
  });
}

describe('AckService', () => {
  describe('settings', () => {
    it('says off with two days for a school with no row, to an administrator', async () => {
      const { tx, service } = setup();
      tx['ackSetting']!['findUnique']!.mockResolvedValue(null);
      expect(await service.settings(admin)).toEqual({ enabled: false, remindAfterDays: 2 });
    });

    it('reads the row, and a null reminder is none', async () => {
      const { tx, service } = setup();
      tx['ackSetting']!['findUnique']!.mockResolvedValue({ enabled: true, remindAfterDays: null });
      expect(await service.settings(admin)).toEqual({ enabled: true, remindAfterDays: null });
    });

    it('tells a teacher what the database says, since a teacher reads no row', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true, days: 3 }] });
      expect(await service.settings(teacher)).toEqual({ enabled: true, remindAfterDays: 3 });
      expect(tx['ackSetting']!['findUnique']).not.toHaveBeenCalled();
      raw(tx, {});
      expect(await service.settings(teacher)).toEqual({ enabled: false, remindAfterDays: null });
    });

    it('refuses a login with no school', async () => {
      const { service } = setup();
      await expect(service.settings(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('saves only what is named, and null clears the reminder', async () => {
      const { tx, service } = setup();
      tx['ackSetting']!['findUnique']!.mockResolvedValue({ enabled: true, remindAfterDays: null });
      await service.updateSettings({ remindAfterDays: null }, admin);
      expect(tx['ackSetting']!['upsert']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', remindAfterDays: null },
        update: { remindAfterDays: null },
      });
      await service.updateSettings({ enabled: true }, admin);
      expect(tx['ackSetting']!['upsert']).toHaveBeenLastCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', enabled: true },
        update: { enabled: true },
      });
    });
  });

  describe('pupils', () => {
    const pupil = (id: string, last: string) => ({ id, firstName: 'Elev', lastName: last, studentGroup: { name: '7A' } });

    it('lists a teacher’s mentees only, with how many guardians could be asked, and records the read', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: ['p-1', 'p-2'] }] });
      tx['user']!['findMany']!.mockResolvedValue([pupil('p-1', 'Ett'), pupil('p-2', 'Två')]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1' }, { studentId: 'p-1' }]);
      const pupils = await service.pupils(teacher);
      expect(pupils).toEqual([
        { id: 'p-1', name: 'Elev Ett', className: '7A', guardians: 2 },
        { id: 'p-2', name: 'Elev Två', className: '7A', guardians: 0 },
      ]);
      expect(tx['user']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['p-1', 'p-2'] } }) }));
      expect(tx.$executeRaw).toHaveBeenCalled();
    });

    it('is empty, and reads nobody, for a teacher who mentors nobody', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: [] }] });
      expect(await service.pupils(teacher)).toEqual([]);
      expect(tx['user']!['findMany']).not.toHaveBeenCalled();
    });

    it('is every active pupil of the school for an administrator', async () => {
      const { tx, service } = setup();
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-9', firstName: 'Elev', lastName: 'Nio', studentGroup: null }]);
      expect(await service.pupils(admin)).toEqual([{ id: 'p-9', name: 'Elev Nio', className: null, guardians: 0 }]);
      expect(tx['user']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: 'school-1', role: 'STUDENT', isActive: true } }));
    });
  });

  describe('create', () => {
    const dto = { title: 'Utflykt', body: 'Vi åker kl. 8.', rule: 'ALL' as const, studentIds: ['p-1', 'p-2', 'p-1'] };

    it('refuses while the school has kvittens off', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: false }] });
      await expect(service.create(dto, admin)).rejects.toMatchObject({ response: { code: 'ACK_DISABLED' } });
      expect(tx['ackRequest']!['createMany']).not.toHaveBeenCalled();
    });

    it('refuses a pupil who is not an active pupil of the school', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }]);
      await expect(service.create(dto, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(service.create(dto, admin)).rejects.toMatchObject({ response: { code: 'ACK_UNKNOWN_PUPIL' } });
    });

    it('refuses a teacher asking about a pupil she does not mentor', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }], 'app.ack_mentee_ids()': [{ ids: ['p-1'] }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      await expect(service.create(dto, teacher)).rejects.toMatchObject({ response: { code: 'ACK_NOT_YOUR_PUPIL' } });
      expect(tx['ackRequest']!['createMany']).not.toHaveBeenCalled();
    });

    it('refuses a request nobody can be asked about', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([]);
      await expect(service.create(dto, admin)).rejects.toMatchObject({ response: { code: 'ACK_NO_GUARDIANS' } });
    });

    it('writes the request, a receipt per guardian and pupil, and tells each guardian once; the pupil without a guardian is said', async () => {
      const { tx, notifications, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([
        { studentId: 'p-1', guardianId: 'g-1' },
        { studentId: 'p-1', guardianId: 'g-2' },
      ]);
      const created = await service.create(dto, admin);
      expect(created).toMatchObject({ pupils: 1, guardians: 2, withoutGuardian: ['p-2'] });
      const request = tx['ackRequest']!['createMany']!.mock.calls[0]![0].data[0];
      expect(request).toMatchObject({ id: created.id, schoolId: 'school-1', authorId: 'admin-1', title: 'Utflykt', body: 'Vi åker kl. 8.', rule: 'ALL' });
      expect(request).not.toHaveProperty('authorName');
      expect(tx['ackReceipt']!['createMany']).toHaveBeenCalledWith({
        data: [
          { requestId: created.id, schoolId: 'school-1', studentId: 'p-1', guardianId: 'g-1' },
          { requestId: created.id, schoolId: 'school-1', studentId: 'p-1', guardianId: 'g-2' },
        ],
      });
      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
      const told = notifications.notifyUsers.mock.calls[0]![1];
      expect(told).toMatchObject({ schoolId: 'school-1', userIds: ['g-1', 'g-2'], type: 'ACK_REQUESTED', meta: { requestId: created.id, title: 'Utflykt' } });
      expect(told.email.body).not.toContain('Utflykt');
    });

    it('tells a guardian with two children once, and writes receipts in chunks of a thousand', async () => {
      const { tx, notifications, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      const links = Array.from({ length: 1500 }, (_, i) => ({ studentId: 'p-1', guardianId: `g-${i}` })).concat([{ studentId: 'p-2', guardianId: 'g-0' }]);
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue(links);
      const created = await service.create(dto, admin);
      expect(created.guardians).toBe(1500);
      expect(tx['ackReceipt']!['createMany']).toHaveBeenCalledTimes(2);
      expect(tx['ackReceipt']!['createMany']!.mock.calls[0]![0].data).toHaveLength(1000);
      expect(tx['ackReceipt']!['createMany']!.mock.calls[1]![0].data).toHaveLength(501);
      expect(notifications.notifyUsers.mock.calls[0]![1].userIds).toHaveLength(1500);
    });

    it('lets a teacher ask about her mentees', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }], 'app.ack_mentee_ids()': [{ ids: ['p-1', 'p-2'] }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1', guardianId: 'g-1' }]);
      await expect(service.create(dto, teacher)).resolves.toMatchObject({ pupils: 1, guardians: 1 });
    });
  });

  describe('list', () => {
    it('counts pupils, those who are met and the guardians who wait, and names nobody', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findMany']!.mockResolvedValue([
        { id: 'r-1', title: 'A', rule: 'ALL', authorName: 'Mentor A', createdAt: new Date('2026-11-02T08:00:00Z'), remindAt: new Date('2026-11-04T08:00:00Z'), reminderSentAt: null },
        { id: 'r-2', title: 'B', rule: 'ANY', authorName: 'Mentor A', createdAt: new Date('2026-11-01T08:00:00Z'), remindAt: null, reminderSentAt: new Date('2026-11-03T08:00:00Z') },
      ]);
      raw(tx, {
        'app.ack_status': [
          { request_id: 'r-1', student_id: 'p-1', asked: 2, acked: 1, waiting: 1, met: false },
          { request_id: 'r-1', student_id: 'p-2', asked: 1, acked: 1, waiting: 0, met: true },
        ],
      });
      const list = await service.list(admin);
      expect(list).toEqual([
        { id: 'r-1', title: 'A', rule: 'ALL', authorName: 'Mentor A', createdAt: '2026-11-02T08:00:00.000Z', pupils: 2, met: 1, waiting: 1, remindAt: '2026-11-04T08:00:00.000Z', reminderSent: false },
        { id: 'r-2', title: 'B', rule: 'ANY', authorName: 'Mentor A', createdAt: '2026-11-01T08:00:00.000Z', pupils: 0, met: 0, waiting: 0, remindAt: null, reminderSent: true },
      ]);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('asks nothing of the database when there is nothing to count', async () => {
      const { tx, service } = setup();
      expect(await service.list(admin)).toEqual([]);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('detail', () => {
    const request = {
      id: REQ,
      title: 'Utflykt',
      body: 'Vi åker kl. 8.',
      rule: 'ALL',
      authorName: 'Mentor A',
      createdAt: new Date('2026-11-02T08:00:00Z'),
      remindAt: new Date('2026-11-04T08:00:00Z'),
      reminderSentAt: new Date('2026-11-04T08:15:00Z'),
    };
    const receipt = (studentId: string, guardianId: string, ackedAt: Date | null, last = 'Ett') => ({
      studentId,
      guardianId,
      ackedAt,
      remindedAt: ackedAt ? null : new Date('2026-11-04T08:15:00Z'),
      student: { firstName: 'Elev', lastName: last, studentGroup: { name: '7A' } },
      guardian: { firstName: 'Vård', lastName: guardianId },
    });

    it('is not found for a request the caller may not read', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findUnique']!.mockResolvedValue(null);
      await expect(service.detail(REQ, teacher)).rejects.toBeInstanceOf(NotFoundException);
      expect(tx['ackReceipt']!['findMany']).not.toHaveBeenCalled();
    });

    it('says per guardian whether they confirmed, wait, or can no longer, per pupil whether it is met, and records the read', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findUnique']!.mockResolvedValue(request);
      tx['ackReceipt']!['findMany']!.mockResolvedValue([
        receipt('p-2', 'g-3', new Date('2026-11-02T09:00:00Z'), 'Två'),
        receipt('p-1', 'g-1', new Date('2026-11-02T10:00:00Z')),
        receipt('p-1', 'g-2', null),
        receipt('p-1', 'g-4', null),
      ]);
      raw(tx, {
        'app.ack_status': [
          { request_id: REQ, student_id: 'p-1', asked: 3, acked: 1, waiting: 1, met: false },
          { request_id: REQ, student_id: 'p-2', asked: 1, acked: 1, waiting: 0, met: true },
        ],
        'app.ack_open_pairs': [{ student_id: 'p-1', guardian_id: 'g-2' }],
      });
      const detail = await service.detail(REQ, admin);
      expect(detail).toMatchObject({ id: REQ, title: 'Utflykt', body: 'Vi åker kl. 8.', rule: 'ALL', authorName: 'Mentor A', reminderSentAt: '2026-11-04T08:15:00.000Z' });
      expect(detail.pupils.map((p) => [p.name, p.met])).toEqual([['Elev Ett', false], ['Elev Två', true]]);
      expect(detail.pupils[0]!.guardians.map((g) => [g.id, g.state, g.ackedAt, g.remindedAt])).toEqual([
        ['g-1', 'CONFIRMED', '2026-11-02T10:00:00.000Z', null],
        ['g-2', 'WAITING', null, '2026-11-04T08:15:00.000Z'],
        ['g-4', 'ENDED', null, '2026-11-04T08:15:00.000Z'],
      ]);
      // PEOPLE for the pupils and the guardians, GUARDIANS for whose guardian is whose.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('mine', () => {
    const row = (id: string, receipts: Array<{ studentId: string; ackedAt: Date | null; name: string }>) => ({
      id,
      title: `T ${id}`,
      body: 'Text',
      rule: 'ANY',
      authorName: 'Mentor A',
      createdAt: new Date('2026-11-02T08:00:00Z'),
      receipts: receipts.map((r) => ({ studentId: r.studentId, ackedAt: r.ackedAt, student: { firstName: r.name, lastName: 'Barn' } })),
    });

    it('lists the children a request asks about and, when all are confirmed, the first time', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findMany']!.mockResolvedValue([
        row('r-1', [
          { studentId: 'p-1', ackedAt: new Date('2026-11-03T10:00:00Z'), name: 'Anna' },
          { studentId: 'p-2', ackedAt: new Date('2026-11-03T09:00:00Z'), name: 'Erik' },
        ]),
        row('r-2', [{ studentId: 'p-1', ackedAt: null, name: 'Anna' }]),
        row('r-3', []),
      ]);
      const mine = await service.mine(guardian);
      expect(mine.map((m) => m.id)).toEqual(['r-1', 'r-2']);
      expect(mine[0]).toMatchObject({ children: [{ id: 'p-1', name: 'Anna Barn' }, { id: 'p-2', name: 'Erik Barn' }], ackedAt: '2026-11-03T09:00:00.000Z' });
      expect(mine[1]).toMatchObject({ ackedAt: null, authorName: 'Mentor A' });
      expect(JSON.stringify(mine)).not.toMatch(/guardianId/);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('is not confirmed while one of the guardian’s children is not', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findMany']!.mockResolvedValue([
        row('r-1', [
          { studentId: 'p-1', ackedAt: new Date('2026-11-03T10:00:00Z'), name: 'Anna' },
          { studentId: 'p-2', ackedAt: null, name: 'Erik' },
        ]),
      ]);
      expect((await service.mine(guardian))[0]!.ackedAt).toBeNull();
    });
  });

  describe('confirm', () => {
    it('answers the time the database stamped', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_confirm': [{ at: new Date('2026-11-03T10:00:00Z') }] });
      expect(await service.confirm(REQ, guardian)).toEqual({ ackedAt: '2026-11-03T10:00:00.000Z' });
    });

    it.each([
      ['KV403', ForbiddenException, 'ACK_NOT_A_GUARDIAN'],
      ['KV404', NotFoundException, 'ACK_NOT_FOUND'],
      ['KV410', ConflictException, 'ACK_CUSTODY_ENDED'],
    ])('answers %s with its own code', async (state, type, code) => {
      const { tx, service } = setup();
      tx.$queryRaw.mockRejectedValue(sqlState(state));
      const error = await service.confirm(REQ, guardian).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect((error as { response: { code: string } }).response.code).toBe(code);
    });

    it('reads the state from the message when the adapter puts it there', async () => {
      const { tx, service } = setup();
      tx.$queryRaw.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `KV410`. Message: `ACK_CUSTODY_ENDED`', { code: 'P2010', clientVersion: 'test' }));
      await expect(service.confirm(REQ, guardian)).rejects.toBeInstanceOf(ConflictException);
    });

    it('lets any other failure through as it was', async () => {
      const { tx, service } = setup();
      const boom = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(boom);
      await expect(service.confirm(REQ, guardian)).rejects.toBe(boom);
      tx.$queryRaw.mockRejectedValue(sqlState('40P01'));
      await expect(service.confirm(REQ, guardian)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('remind', () => {
    it('hands what the database wrote to the delivery, once per school', async () => {
      const { tx, notifications, service } = setup();
      tx.$queryRaw.mockResolvedValue([
        { notification_id: 'n-1', user_id: 'g-1', school_id: 'school-1', email: 'g1@example.invalid', meta: { requestId: REQ, title: 'T' } },
        { notification_id: 'n-2', user_id: 'g-2', school_id: 'school-2', email: null, meta: { requestId: REQ, title: 'T' } },
      ]);
      expect(await service.remind()).toEqual({ reminded: 2 });
      expect(notifications.deliverCommitted).toHaveBeenCalledTimes(1);
      expect(notifications.deliverCommitted.mock.calls[0]![0]).toHaveLength(2);
    });

    it('delivers nothing when nobody is due', async () => {
      const { tx, notifications, service } = setup();
      tx.$queryRaw.mockResolvedValue([]);
      expect(await service.remind()).toEqual({ reminded: 0 });
      expect(notifications.deliverCommitted).not.toHaveBeenCalled();
    });
  });
});
