import { ConflictException, ForbiddenException, HttpStatus, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
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

    it.each([
      ['KV429', 'ACK_TOO_MANY_REQUESTS'],
      ['KV427', 'ACK_SENDER_DAY_LIMIT'],
      ['KV428', 'ACK_TOO_MANY_RECIPIENTS'],
    ])('answers the database’s %s with a 429 and its own code, and nothing else', async (state, code) => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1', guardianId: 'g-1' }]);
      tx['ackRequest']!['createMany']!.mockRejectedValue(sqlState(state));
      const error = await service.create(dto, admin).catch((e: unknown) => e);
      expect((error as { getStatus(): number }).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((error as { response: { code: string } }).response.code).toBe(code);
      // The receipts' own statement can be the one over the day's limit.
      tx['ackRequest']!['createMany']!.mockResolvedValue({ count: 1 });
      tx['ackReceipt']!['createMany']!.mockRejectedValue(sqlState(state));
      await expect(service.create(dto, admin)).rejects.toMatchObject({ response: { code } });
      const other = new Error('connection reset');
      tx['ackReceipt']!['createMany']!.mockRejectedValue(other);
      await expect(service.create(dto, admin)).rejects.toBe(other);
    });

    it('tells the sender over the day’s share that another administrator can send the request, in the text a log keeps', async () => {
      // The web shows its own catalogue's text for the code; this one is what the gateway answers, for a log and for a
      // client that shows the message. Without it the sentence was in no test (the web's test took the old text as a part).
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1', guardianId: 'g-1' }]);
      tx['ackRequest']!['createMany']!.mockRejectedValue(sqlState('KV427'));
      const error = await service.create(dto, admin).catch((e: unknown) => e);
      const message = (error as { response: { message: string } }).response.message;
      expect(message).toContain('Inget har skickats.');
      expect(message).toContain('Måste förfrågan gå ut nu kan en annan administratör skicka den, eftersom var och en har en egen andel.');
    });

    it.each([
      ['ACK_TOO_MANY_REQUESTS', 'ACK_TOO_MANY_REQUESTS'],
      ['ACK_SENDER_DAY_LIMIT', 'ACK_SENDER_DAY_LIMIT'],
      ['ACK_TOO_MANY_RECIPIENTS', 'ACK_TOO_MANY_RECIPIENTS'],
    ])('answers a model query that the trigger refused in another class of error, by the text it raised (%s)', async (text, code) => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1', guardianId: 'g-1' }]);
      tx['ackRequest']!['createMany']!.mockRejectedValue(new Error(`Invalid \`prisma.ackRequest.createMany()\` invocation: ${text}`));
      await expect(service.create(dto, admin)).rejects.toMatchObject({ response: { code } });
    });

    it('lets a teacher ask about her mentees', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }], 'app.ack_mentee_ids()': [{ ids: ['p-1', 'p-2'] }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1', guardianId: 'g-1' }]);
      await expect(service.create(dto, teacher)).resolves.toMatchObject({ pupils: 1, guardians: 1 });
    });
  });

  /**
   * Checklistor's consent list asks the guardians through create (the rule ALL) and links the request to its list in
   * the same transaction: createThen is create with a callback that runs before the commit.
   */
  describe('createThen', () => {
    const dto = { title: 'Samtycke: Fotografering', body: 'Vi får fotografera.', rule: 'ALL' as const, studentIds: ['p-1', 'p-2', 'p-1'] };

    /** Kvittens on, two pupils, and one guardian for the first of them. */
    function ready(tx: TxMock) {
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }] });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      tx['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: 'p-1', guardianId: 'g-1' }]);
    }
    const firstCall = (mock: jest.Mock) => mock.mock.invocationCallOrder[0]!;

    it('runs the callback in the same transaction, with the request just written, after the receipts and the notices', async () => {
      const { tx, prisma, notifications, service } = setup();
      ready(tx);
      const then = jest.fn().mockResolvedValue('linked');
      const { created, result } = await service.createThen(dto, admin, then);
      expect(result).toBe('linked');
      expect(created).toMatchObject({ pupils: 1, guardians: 1, withoutGuardian: ['p-2'] });
      // The callback is handed the transaction and the very request that was written.
      expect(then).toHaveBeenCalledTimes(1);
      expect(then).toHaveBeenCalledWith(tx, created);
      expect(tx['ackRequest']!['createMany']!.mock.calls[0]![0].data[0].id).toBe(created.id);
      // One transaction for all of it.
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(firstCall(tx['ackRequest']!['createMany']!)).toBeLessThan(firstCall(tx['ackReceipt']!['createMany']!));
      expect(firstCall(tx['ackReceipt']!['createMany']!)).toBeLessThan(firstCall(notifications.notifyUsers));
      expect(firstCall(notifications.notifyUsers)).toBeLessThan(firstCall(then));
    });

    it('leaves create as it was: the same four fields, and no callback to wait for', async () => {
      const { tx, prisma, service } = setup();
      ready(tx);
      const created = await service.create(dto, admin);
      expect(created).toEqual({ id: expect.any(String), pupils: 1, guardians: 1, withoutGuardian: ['p-2'] });
      expect(Object.keys(created).sort()).toEqual(['guardians', 'id', 'pupils', 'withoutGuardian']);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx['ackRequest']!['createMany']!.mock.calls[0]![0].data[0].id).toBe(created.id);
    });

    it('does not run the callback when the request is refused before it is written', async () => {
      const { tx, service } = setup();
      const then = jest.fn();
      raw(tx, { 'app.ack_enabled()': [{ enabled: false }] });
      await expect(service.createThen(dto, admin, then)).rejects.toMatchObject({ response: { code: 'ACK_DISABLED' } });
      ready(tx);
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }]);
      await expect(service.createThen(dto, admin, then)).rejects.toMatchObject({ response: { code: 'ACK_UNKNOWN_PUPIL' } });
      tx['user']!['findMany']!.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      raw(tx, { 'app.ack_enabled()': [{ enabled: true }], 'app.ack_mentee_ids()': [{ ids: ['p-1'] }] });
      await expect(service.createThen(dto, teacher, then)).rejects.toMatchObject({ response: { code: 'ACK_NOT_YOUR_PUPIL' } });
      tx['guardianStudent']!['findMany']!.mockResolvedValue([]);
      await expect(service.createThen(dto, admin, then)).rejects.toMatchObject({ response: { code: 'ACK_NO_GUARDIANS' } });
      expect(then).not.toHaveBeenCalled();
    });

    it.each([
      ['KV429', 'ACK_TOO_MANY_REQUESTS'],
      ['KV428', 'ACK_TOO_MANY_RECIPIENTS'],
    ])('answers the database’s %s with a 429 and its own code, as create does, and does not run the callback', async (state, code) => {
      const { tx, service } = setup();
      ready(tx);
      const then = jest.fn();
      tx['ackRequest']!['createMany']!.mockRejectedValue(sqlState(state));
      const error = await service.createThen(dto, admin, then).catch((e: unknown) => e);
      expect((error as { getStatus(): number }).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((error as { response: { code: string } }).response.code).toBe(code);
      // The receipts' own statement can be the one over the day's limit.
      tx['ackRequest']!['createMany']!.mockResolvedValue({ count: 1 });
      tx['ackReceipt']!['createMany']!.mockRejectedValue(sqlState(state));
      await expect(service.createThen(dto, admin, then)).rejects.toMatchObject({ response: { code } });
      expect(then).not.toHaveBeenCalled();
    });

    it('lets an error from the callback through as it is, so that the transaction rolls back with the request', async () => {
      const { tx, service } = setup();
      ready(tx);
      const refused = new Error('CONSENT_LIST_CLOSED');
      await expect(service.createThen(dto, admin, async () => Promise.reject(refused))).rejects.toBe(refused);
    });
  });

  describe('list', () => {
    it('counts pupils, those who are met and the guardians who wait, says where each reminder stands, and names nobody', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findMany']!.mockResolvedValue([
        { id: 'r-1', title: 'A', rule: 'ALL', authorName: 'Mentor A', createdAt: new Date('2026-11-02T08:00:00Z'), remindAt: new Date('2026-11-04T08:00:00Z'), reminderOutcome: null },
        { id: 'r-2', title: 'B', rule: 'ANY', authorName: 'Mentor A', createdAt: new Date('2026-11-01T08:00:00Z'), remindAt: null, reminderOutcome: null },
        { id: 'r-3', title: 'C', rule: 'ANY', authorName: 'Mentor A', createdAt: new Date('2026-10-30T08:00:00Z'), remindAt: new Date('2026-11-01T08:00:00Z'), reminderOutcome: 'NOT_NEEDED' },
      ]);
      raw(tx, {
        'app.ack_status': [
          { request_id: 'r-1', student_id: 'p-1', asked: 2, acked: 1, waiting: 1, met: false },
          { request_id: 'r-1', student_id: 'p-2', asked: 1, acked: 1, waiting: 0, met: true },
        ],
      });
      const page = await service.list(admin);
      expect(page.next).toBeNull();
      expect(page.items).toEqual([
        { id: 'r-1', title: 'A', rule: 'ALL', authorName: 'Mentor A', createdAt: '2026-11-02T08:00:00.000Z', pupils: 2, met: 1, waiting: 1, remindAt: '2026-11-04T08:00:00.000Z', reminder: 'SCHEDULED' },
        { id: 'r-2', title: 'B', rule: 'ANY', authorName: 'Mentor A', createdAt: '2026-11-01T08:00:00.000Z', pupils: 0, met: 0, waiting: 0, remindAt: null, reminder: 'NONE' },
        { id: 'r-3', title: 'C', rule: 'ANY', authorName: 'Mentor A', createdAt: '2026-10-30T08:00:00.000Z', pupils: 0, met: 0, waiting: 0, remindAt: '2026-11-01T08:00:00.000Z', reminder: 'NOT_NEEDED' },
      ]);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each(['NOT_NEEDED', 'LAPSED', 'STOPPED', 'OFF'] as const)('says %s when that is how the reminder ended', async (outcome) => {
      const { tx, service } = setup();
      tx['ackRequest']!['findMany']!.mockResolvedValue([
        { id: 'r-1', title: 'A', rule: 'ANY', authorName: 'M', createdAt: new Date('2026-11-02T08:00:00Z'), remindAt: new Date('2026-11-04T08:00:00Z'), reminderOutcome: outcome },
      ]);
      expect((await service.list(admin)).items[0]!.reminder).toBe(outcome);
    });

    it('asks for one more than a page, shows a page, and says where the next one starts', async () => {
      const { tx, service } = setup();
      const row = (id: string) => ({ id, title: id, rule: 'ANY', authorName: 'M', createdAt: new Date('2026-11-02T08:00:00Z'), remindAt: null, reminderOutcome: null });
      tx['ackRequest']!['findMany']!.mockResolvedValue([row('r-1'), row('r-2'), row('r-3')]);
      const page = await service.list(admin, { limit: 2 });
      expect(page.items.map((item) => item.id)).toEqual(['r-1', 'r-2']);
      expect(page.next).toBe('r-2');
      expect(tx['ackRequest']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ take: 3, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
      expect(tx['ackRequest']!['findMany']!.mock.calls[0]![0]).not.toHaveProperty('cursor');
      await service.list(admin, { after: 'r-2', limit: 2 });
      expect(tx['ackRequest']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: 'r-2' }, skip: 1, take: 3 }));
      // A page that fills exactly is the last one.
      tx['ackRequest']!['findMany']!.mockResolvedValue([row('r-4'), row('r-5')]);
      expect((await service.list(admin, { limit: 2 })).next).toBeNull();
    });

    it('takes fifty by default, and asks nothing of the database when there is nothing to count', async () => {
      const { tx, service } = setup();
      expect(await service.list(admin)).toEqual({ items: [], next: null });
      expect(tx['ackRequest']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('list: a reminder that went', () => {
    const row = (reminderMirroredAt: Date | null) => ({
      id: 'r-1', title: 'A', rule: 'ANY', authorName: 'M', createdAt: new Date('2026-11-02T08:00:00Z'), remindAt: new Date('2026-11-04T08:00:00Z'),
      reminderOutcome: 'SENT', reminderMirroredAt,
    });

    it('says SENT only when the delivery has said the e-mail and the push were taken, and WRITTEN while it has not', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_status': [] });
      tx['ackRequest']!['findMany']!.mockResolvedValue([row(new Date('2026-11-04T08:16:00Z'))]);
      expect((await service.list(admin)).items[0]!.reminder).toBe('SENT');
      tx['ackRequest']!['findMany']!.mockResolvedValue([row(null)]);
      expect((await service.list(admin)).items[0]!.reminder).toBe('WRITTEN');
    });

    it('reads the column it needs', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_status': [] });
      tx['ackRequest']!['findMany']!.mockResolvedValue([]);
      await service.list(admin);
      expect(tx['ackRequest']!['findMany']!.mock.calls[0]![0].select).toMatchObject({ reminderMirroredAt: true });
    });
  });

  describe('detail', () => {
    const request = {
      id: REQ,
      authorId: 'teacher-1',
      title: 'Utflykt',
      body: 'Vi åker kl. 8.',
      rule: 'ALL',
      authorName: 'Mentor A',
      createdAt: new Date('2026-11-02T08:00:00Z'),
      remindAt: new Date('2026-11-04T08:00:00Z'),
      reminderSentAt: new Date('2026-11-04T08:15:00Z'),
      reminderOutcome: 'SENT',
      reminderMirroredAt: new Date('2026-11-04T08:16:00Z'),
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

    it('says WRITTEN, with no time for the mail, while the delivery has not said the e-mail and the push were taken', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findUnique']!.mockResolvedValue({ ...request, reminderMirroredAt: null });
      tx['ackReceipt']!['findMany']!.mockResolvedValue([]);
      raw(tx, { 'app.ack_status': [], 'app.ack_open_pairs': [] });
      expect(await service.detail(REQ, admin)).toMatchObject({ reminder: 'WRITTEN', reminderSentAt: '2026-11-04T08:15:00.000Z', reminderMirroredAt: null, mayStopReminder: false });
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
      expect(detail).toMatchObject({
        id: REQ,
        title: 'Utflykt',
        body: 'Vi åker kl. 8.',
        rule: 'ALL',
        authorName: 'Mentor A',
        reminderSentAt: '2026-11-04T08:15:00.000Z',
        reminderMirroredAt: '2026-11-04T08:16:00.000Z',
        reminder: 'SENT',
        mayStopReminder: false,
      });
      expect(JSON.stringify(detail)).not.toContain('authorId');
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

  describe('detail: who may stop the reminder', () => {
    const scheduled = {
      id: REQ,
      authorId: 'teacher-1',
      title: 'Utflykt',
      body: 'Text',
      rule: 'ANY',
      authorName: 'Mentor A',
      createdAt: new Date('2026-11-02T08:00:00Z'),
      remindAt: new Date('2026-11-09T08:00:00Z'),
      reminderSentAt: null,
      reminderOutcome: null,
    };

    it('lets the author, and an administrator who writes Drift, stop a scheduled reminder, and nobody else', async () => {
      const { tx, service } = setup();
      tx['ackRequest']!['findUnique']!.mockResolvedValue(scheduled);
      expect((await service.detail(REQ, teacher)).mayStopReminder).toBe(true);
      expect((await service.detail(REQ, testUser({ schoolId: 'school-1', userId: 'teacher-2', role: 'TEACHER' as never }))).mayStopReminder).toBe(false);
      raw(tx, { 'app.current_user_may': [{ may: true }] });
      expect((await service.detail(REQ, admin)).mayStopReminder).toBe(true);
      raw(tx, { 'app.current_user_may': [{ may: false }] });
      expect((await service.detail(REQ, admin)).mayStopReminder).toBe(false);
    });

    it('lets nobody stop a reminder that has ended or was never chosen, and does not ask the database whether an administrator may', async () => {
      const { tx, service } = setup();
      for (const [remindAt, reminderOutcome] of [
        [new Date('2026-11-04T08:00:00Z'), 'STOPPED'],
        [new Date('2026-11-04T08:00:00Z'), 'LAPSED'],
        [null, null],
      ] as const) {
        tx['ackRequest']!['findUnique']!.mockResolvedValue({ ...scheduled, remindAt, reminderOutcome });
        expect((await service.detail(REQ, teacher)).mayStopReminder).toBe(false);
      }
      expect(tx.$queryRaw.mock.calls.some(([query]) => sqlOf(query).includes('current_user_may'))).toBe(false);
    });
  });

  describe('stopReminder', () => {
    it('answers where the reminder stands afterwards', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_stop_reminder': [{ outcome: 'STOPPED' }] });
      expect(await service.stopReminder(REQ, teacher)).toEqual({ reminder: 'STOPPED' });
      raw(tx, { 'app.ack_stop_reminder': [{ outcome: 'SENT' }] });
      expect(await service.stopReminder(REQ, teacher)).toEqual({ reminder: 'SENT' });
      raw(tx, { 'app.ack_stop_reminder': [{ outcome: null }] });
      expect(await service.stopReminder(REQ, admin)).toEqual({ reminder: 'NONE' });
    });

    it.each([
      ['KV403', ForbiddenException, 'ACK_NOT_STAFF'],
      ['KV404', NotFoundException, 'ACK_NOT_FOUND'],
    ])('answers %s with its own code', async (state, type, code) => {
      const { tx, service } = setup();
      tx.$queryRaw.mockRejectedValue(sqlState(state));
      const error = await service.stopReminder(REQ, teacher).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect((error as { response: { code: string } }).response.code).toBe(code);
    });

    it('lets any other failure through as it was', async () => {
      const { tx, service } = setup();
      const boom = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(boom);
      await expect(service.stopReminder(REQ, teacher)).rejects.toBe(boom);
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
      const page = await service.mine(guardian);
      const mine = page.items;
      expect(page.next).toBeNull();
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
      expect((await service.mine(guardian)).items[0]!.ackedAt).toBeNull();
    });

    it('pages the same way, newest first from after the request it is given, so an old unconfirmed one can be reached', async () => {
      const { tx, service } = setup();
      const many = ['r-1', 'r-2', 'r-3'].map((id) => row(id, [{ studentId: 'p-1', ackedAt: null, name: 'Anna' }]));
      tx['ackRequest']!['findMany']!.mockResolvedValue(many);
      const first = await service.mine(guardian, { limit: 2 });
      expect(first.items.map((m) => m.id)).toEqual(['r-1', 'r-2']);
      expect(first.next).toBe('r-2');
      expect(tx['ackRequest']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ take: 3, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
      await service.mine(guardian, { after: 'r-2', limit: 2 });
      expect(tx['ackRequest']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: 'r-2' }, skip: 1 }));
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
    const notice = (id: string, user: string, school = 'school-1') => ({
      notification_id: id,
      user_id: user,
      school_id: school,
      email: `${user}@example.invalid`,
      meta: { requestId: REQ, title: 'T' },
    });

    /** The queue the database lists, and what each request's pass answers (an Error: that request fails). */
    function due(tx: TxMock, ids: string[], answers: Record<string, unknown[] | Error>): void {
      tx.$queryRaw.mockImplementation((query: unknown) => {
        const q = query as { sql?: string; values?: unknown[] };
        if ((q.sql ?? '').includes('app.ack_remind_queue')) return Promise.resolve(ids.map((request_id) => ({ request_id })));
        const answer = answers[String(q.values?.[0])] ?? [];
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      });
    }

    it('takes the requests one at a time, each in a transaction of its own, and hands the delivery what each wrote', async () => {
      const { tx, prisma, notifications, service } = setup();
      due(tx, ['r-1', 'r-2', 'r-3'], { 'r-1': [notice('n-1', 'g-1'), notice('n-2', 'g-2', 'school-2')], 'r-2': [], 'r-3': [notice('n-3', 'g-3')] });
      expect(await service.remind()).toEqual({ reminded: 3, requests: 3, failed: 0, left: 0 });
      // One door for the queue and one for each request: a request that fails or times out rolls back alone.
      expect(prisma.withDeliveryService).toHaveBeenCalledTimes(4);
      expect(notifications.deliverCommitted).toHaveBeenCalledTimes(2);
      expect(notifications.deliverCommitted.mock.calls[0]![0]).toHaveLength(2);
      expect(notifications.deliverCommitted.mock.calls[1]![0]).toHaveLength(1);
    });

    it('goes on with the next request when one fails, says so, and leaves the failed one in the queue', async () => {
      const { tx, notifications, service } = setup();
      const warn = jest.spyOn((service as unknown as { logger: { warn(m: string): void } }).logger, 'warn').mockImplementation(() => undefined);
      due(tx, ['r-1', 'r-2'], { 'r-1': sqlState('57014'), 'r-2': [notice('n-2', 'g-2')] });
      expect(await service.remind()).toEqual({ reminded: 1, requests: 1, failed: 1, left: 0 });
      expect(notifications.deliverCommitted).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sqlstate=57014'));
      expect(warn.mock.calls[0]![0]).not.toContain('r-1');
    });

    describe('what the delivery says about the batch', () => {
      /** The pass with one request due, and the listener the delivery was given for it. */
      async function passWithListener(): Promise<{ tx: TxMock; service: AckService; settle: (delivered: boolean) => Promise<void>; warn: jest.SpyInstance }> {
        const { tx, notifications, service } = setup();
        const warn = jest.spyOn((service as unknown as { logger: { warn(m: string): void } }).logger, 'warn').mockImplementation(() => undefined);
        due(tx, ['r-1'], { 'r-1': [notice('n-1', 'g-1')] });
        await service.remind();
        const listener = notifications.deliverCommitted.mock.calls[0]![1] as ((delivered: boolean) => void) | undefined;
        expect(listener).toEqual(expect.any(Function));
        tx.$executeRaw.mockClear();
        return { tx, service, warn, settle: async (delivered) => { listener!(delivered); await new Promise((resolve) => setImmediate(resolve)); } };
      }

      it('marks the request as taken by its channels when the delivery says so, in its own transaction, and not before', async () => {
        const { tx, settle } = await passWithListener();
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        await settle(true);
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
        const asked = tx.$executeRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
        expect(asked.sql).toContain('app.ack_reminder_mirrored(');
        expect(asked.values).toEqual(['r-1']);
      });

      it('marks the request it was told of, not the last one the pass worked on', async () => {
        const { tx, notifications, service } = setup();
        due(tx, ['r-1', 'r-2'], { 'r-1': [notice('n-1', 'g-1')], 'r-2': [notice('n-2', 'g-2')] });
        await service.remind();
        tx.$executeRaw.mockClear();
        (notifications.deliverCommitted.mock.calls[0]![1] as (delivered: boolean) => void)(true);
        await new Promise((resolve) => setImmediate(resolve));
        expect((tx.$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual(['r-1']);
      });

      // The first listener alone cannot tell the request of its own from the first of the queue: both are r-1. Each
      // listener marks the request it was made for, whichever one the pass reached it from and whatever order the
      // delivery answers in (the e-mail lane and the alarm lane do not finish in the order they were queued).
      it('marks each request by its own listener, in whatever order the delivery answers', async () => {
        const { tx, notifications, service } = setup();
        due(tx, ['r-1', 'r-2', 'r-3'], { 'r-1': [notice('n-1', 'g-1')], 'r-2': [notice('n-2', 'g-2')], 'r-3': [notice('n-3', 'g-3')] });
        await service.remind();
        expect(notifications.deliverCommitted).toHaveBeenCalledTimes(3);
        tx.$executeRaw.mockClear();
        const listeners = notifications.deliverCommitted.mock.calls.map((call) => call[1] as (delivered: boolean) => void);
        for (const at of [2, 0, 1]) {
          listeners[at]!(true);
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(tx.$executeRaw.mock.calls.map((call) => (call[0] as { values: unknown[] }).values[0])).toEqual(['r-3', 'r-1', 'r-2']);
      });

      it('marks nothing, and says so without naming anyone, when a channel did not take the batch: the request stays WRITTEN', async () => {
        const { tx, settle, warn } = await passWithListener();
        await settle(false);
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('A reminder was written to the inboxes but its e-mail or push was not taken by its channel');
      });

      it('does not let a mark that fails reach anyone: it is logged, and the request stays WRITTEN', async () => {
        const { tx, settle, warn } = await passWithListener();
        tx.$executeRaw.mockRejectedValue(sqlState('57014'));
        await expect(settle(true)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('stays WRITTEN [PrismaClientKnownRequestError, sqlstate=57014]'));
      });

      it('hands the delivery nothing to hear about for a request that wrote no notice', async () => {
        const { tx, notifications, service } = setup();
        due(tx, ['r-1'], { 'r-1': [] });
        await service.remind();
        expect(notifications.deliverCommitted).not.toHaveBeenCalled();
      });
    });

    it('stops at its budget and counts what it left for the next pass', async () => {
      const { tx, notifications, service } = setup();
      due(tx, ['r-1', 'r-2', 'r-3'], { 'r-1': [notice('n-1', 'g-1')] });
      // Out of time before the first.
      expect(await service.remind(0)).toEqual({ reminded: 0, requests: 0, failed: 0, left: 3 });
      expect(notifications.deliverCommitted).not.toHaveBeenCalled();
    });

    it('asks for the queue with a bound', async () => {
      const { tx, service } = setup();
      due(tx, [], {});
      await service.remind();
      const asked = tx.$queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
      expect(asked.sql).toContain('app.ack_remind_queue(');
      expect(asked.values).toEqual([200]);
    });

    it('delivers nothing when nobody is due', async () => {
      const { tx, notifications, service } = setup();
      due(tx, [], {});
      expect(await service.remind()).toEqual({ reminded: 0, requests: 0, failed: 0, left: 0 });
      expect(notifications.deliverCommitted).not.toHaveBeenCalled();
    });

    it('lets a failure of the queue itself through: nothing was tried, so the pass failed', async () => {
      const { tx, service } = setup();
      const boom = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(boom);
      await expect(service.remind()).rejects.toBe(boom);
    });
  });
  describe('usage', () => {
    /** The rows as the database answers them: the ME row carries the caller's person id, a SENDER row the sender's. */
    const answer = (...rows: Array<[string, string | null, number, number]>) =>
      rows.map(([scope, author_name, used, cap]) => ({ scope, author_id: scope === 'SCHOOL' ? null : scope === 'ME' ? 'person-1' : `sender-${author_name}`, author_name, used, cap }));

    it('gives an administrator the school, their own share and the largest senders, as the database counted them', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_usage': answer(['SCHOOL', null, 15000, 20000], ['ME', null, 100, 8000], ['SENDER', 'Anna Rektor', 9000, 8000], ['SENDER', 'Bo Mentor', 1500, 2000]) });
      expect(await service.usage(admin)).toEqual({
        school: { used: 15000, limit: 20000 },
        mine: { used: 100, limit: 8000 },
        senders: [{ name: 'Anna Rektor', used: 9000, limit: 8000 }, { name: 'Bo Mentor', used: 1500, limit: 2000 }],
      });
      const asked = tx.$queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
      // The column list is the contract: without author_id the gateway cannot tell a person's share from a reader's none.
      expect(asked.sql.replace(/\s+/g, ' ')).toContain('SELECT scope, author_id, author_name, used, cap FROM app.ack_usage(');
      expect(asked.values).toEqual([5]);
    });

    it('says an administrator with no sender yet has none (an empty list, not a missing one)', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_usage': answer(['SCHOOL', null, 0, 20000], ['ME', null, 0, 8000]) });
      expect(await service.usage(admin)).toMatchObject({ school: { used: 0, limit: 20000 }, senders: [] });
    });

    it('gives a teacher their own share and nothing of the school or of the others', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_usage': answer(['ME', null, 66, 2000]) });
      expect(await service.usage(teacher)).toEqual({ school: null, mine: { used: 66, limit: 2000 }, senders: null });
    });

    // The huvudman's reader and the school's läsare are staff who can read the usage and cannot send: the database gives
    // them an ME row of nothing used, but with no person id, since there is no person. "Your share 0 of 8 000" would
    // be a share they do not have; the answer has none (the card shows nothing of it).
    it('gives a login with no person no share of its own: mine is null, the school and the senders as they are', async () => {
      const { tx, service } = setup();
      tx.$queryRaw.mockResolvedValue([
        { scope: 'SCHOOL', author_id: null, author_name: null, used: 15, cap: 20000 },
        { scope: 'ME', author_id: null, author_name: null, used: 0, cap: 8000 },
        { scope: 'SENDER', author_id: 'sender-1', author_name: 'Anna Rektor', used: 15, cap: 8000 },
      ]);
      expect(await service.usage(admin)).toEqual({
        school: { used: 15, limit: 20000 },
        mine: null,
        senders: [{ name: 'Anna Rektor', used: 15, limit: 8000 }],
      });
    });

    it('gives a person their share even when nothing is used, and a share is never null for them', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_usage': answer(['ME', null, 0, 2000]) });
      expect(await service.usage(teacher)).toEqual({ school: null, mine: { used: 0, limit: 2000 }, senders: null });
    });

    it('turns the database’s refusal of a person who is no staff into a 403, and lets another failure through', async () => {
      const { tx, service } = setup();
      tx.$queryRaw.mockRejectedValue(sqlState('KV403'));
      await expect(service.usage(guardian)).rejects.toBeInstanceOf(ForbiddenException);
      const boom = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(boom);
      await expect(service.usage(admin)).rejects.toBe(boom);
    });
  });
});
