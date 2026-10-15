import { createPrismaMock, createTxMock, type TxMock } from '../../../test/utils/prisma-mock';
import { rawSql } from '../../../test/utils/locking-read';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../database/prisma.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { applyChanges } from './apply';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync.providers';
import { Ss12000SyncService } from './ss12000-sync.service';

// The apply itself and the local slice are their own specs' (apply.spec.ts,
// local-slice.spec.ts); here they answer as a run whose basis still holds.
jest.mock('./apply', () => ({ applyChanges: jest.fn() }));
jest.mock('./local-slice', () => ({
  ...jest.requireActual('./local-slice'),
  basisHash: jest.fn(() => 'basis'),
  readLocalSlice: jest.fn(async () => ({ users: [] })),
}));

const admin = {
  authId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  schoolId: '33333333-3333-4333-8333-333333333333',
  role: 'SCHOOL_ADMIN',
} as AuthenticatedUser;
const TELL = 'app.leave_requests_tell_new_mentors()';
const MENTOR = '77777777-7777-4777-8777-777777777777';
const NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

/**
 * A class move or a reactivation of a pupil or a teacher may give a mentor a
 * pending leave request (app.leave_mentors reads the pupil's class and the
 * teacher's isActive; Mentorns ledighetsbeslut).
 */
describe('the leave requests an SS12000 apply gives a mentor (Mentorns ledighetsbeslut)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let deliver: jest.Mock;
  let deliverCommitted: jest.Mock;
  let queryRaw: jest.Mock;
  let sync: Ss12000SyncService;

  const change = (seq: number, entity: string, op: string, autoApplicable = false) => ({
    id: `00000000-0000-4000-8000-00000000000${seq}`,
    runId: 'run',
    schoolId: admin.schoolId,
    seq,
    entity,
    op,
    externalId: `ext-${seq}`,
    localId: `10000000-0000-4000-8000-00000000000${seq}`,
    before: null,
    after: {},
    conflictCode: null,
    selected: true,
    autoApplicable,
    protectedIdentity: false,
    applied: false,
    createdAt: new Date(),
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    deliver = jest.fn();
    deliverCommitted = jest.fn();
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(
        rawSql(call).includes(TELL)
          ? [{ notificationId: NOTICE, userId: MENTOR, email: null, meta: { leaveRequestId: 'r1', schoolDays: 2 } }]
          : [{ id: 'source' }],
      ),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
    tx.ss12000SyncRun.findFirst.mockResolvedValue({
      id: 'run',
      sourceId: 'source',
      status: 'DIFF_READY',
      basisHash: 'basis',
      mode: 'INCREMENTAL',
      errors: [],
      counts: {},
      cursorTo: null,
      startedAt: new Date(),
    });
    tx.ss12000Source.findFirst.mockResolvedValue({ id: 'source' });
    tx.ss12000SyncRun.update.mockResolvedValue({ id: 'run' });
    sync = new Ss12000SyncService(
      prisma as unknown as PrismaService,
      new Ss12000Secrets(undefined),
      new Ss12000Outbound(undefined),
      { deliver, deliverCommitted } as unknown as NotificationsService,
    );
  });

  const given = (changes: ReturnType<typeof change>[], applied: number[]) => {
    tx.ss12000SyncChange.findMany.mockResolvedValue(changes);
    (applyChanges as jest.Mock).mockResolvedValue({
      applied: changes.filter((row) => applied.includes(row.seq)).map((row) => row.id),
      skipped: [],
    });
  };
  const told = () => queryRaw.mock.calls.filter((call) => rawSql(call).includes(TELL));

  it.each([
    ['a class move', 'CLASS_MEMBERSHIP', 'MOVE'],
    ['a reactivation', 'PERSON', 'REACTIVATE'],
    ['a relink, which reactivates', 'PERSON', 'RELINK'],
  ])('tells the mentors once after the admin’s apply of %s, however many, in a transaction of its own after the commit', async (_what, entity, op) => {
    // Not inside the apply (20261101090000): the apply may hold a person's
    // row FOR UPDATE (an e-mail change) while the catch-up waits for the
    // school's leave lock, which a filing that checks that row may hold.
    given([change(1, 'PERSON', 'UPDATE'), change(2, entity, op), change(3, entity, op)], [1, 2, 3]);
    await sync.apply(admin, 'run', { basisHash: 'basis' });
    expect(told()).toHaveLength(1);
    expect(prisma.withRls).toHaveBeenCalledTimes(2);
    const at = queryRaw.mock.invocationCallOrder[queryRaw.mock.calls.findIndex((call) => rawSql(call).includes(TELL))]!;
    expect(at).toBeGreaterThan(tx.ss12000Source.update.mock.invocationCallOrder.at(-1)!);
    expect(at).toBeGreaterThan(prisma.withRls.mock.invocationCallOrder[1]!);
    expect(deliver).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ schoolId: admin.schoolId, type: 'LEAVE_REQUESTED', recipients: [{ userId: MENTOR, notificationId: NOTICE }] }),
    );
  });

  it('leaves the apply applied when the catch-up after it fails: the notice stays owed for the next one', async () => {
    given([change(1, 'CLASS_MEMBERSHIP', 'MOVE')], [1]);
    queryRaw.mockImplementation((...call: unknown[]) =>
      rawSql(call).includes(TELL) ? Promise.reject(new Error('could not serialize')) : Promise.resolve([{ id: 'source' }]),
    );
    await expect(sync.apply(admin, 'run', { basisHash: 'basis' })).resolves.toEqual({ id: 'run' });
    expect(told()).toHaveLength(1);
    expect(tx.ss12000SyncRun.updateMany).not.toHaveBeenCalled();
  });

  it('asks nothing of an apply that moved nobody: names, a deactivation, a move it skipped', async () => {
    given([change(1, 'PERSON', 'UPDATE'), change(2, 'PERSON', 'DEACTIVATE'), change(3, 'CLASS_MEMBERSHIP', 'MOVE')], [1, 2]);
    await sync.apply(admin, 'run', { basisHash: 'basis' });
    expect(told()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('the night’s auto-apply of a move asks once, as the sync principal, and hands the notices to the delivery after its transaction', async () => {
    // app.leave_requests_tell_new_mentors answers the sync principal for its
    // own school (20261101090000); withSyncPrincipal has no outbox, so the
    // e-mail and the push wait for the transaction to resolve.
    let open = false;
    prisma.withSyncPrincipal.mockImplementation(async (_school: string, fn: (client: unknown) => Promise<unknown>) => {
      open = true;
      try {
        return await fn(tx);
      } finally {
        open = false;
      }
    });
    deliverCommitted.mockImplementation(() => expect(open).toBe(false));
    given([change(1, 'PERSON', 'UPDATE', true), change(2, 'CLASS_MEMBERSHIP', 'MOVE', true), change(3, 'CLASS_MEMBERSHIP', 'MOVE', true)], [1, 2, 3]);

    await sync.autoApply('run', admin.schoolId!);

    expect(told()).toHaveLength(1);
    const at = queryRaw.mock.invocationCallOrder[queryRaw.mock.calls.findIndex((call) => rawSql(call).includes(TELL))]!;
    expect(at).toBeGreaterThan((applyChanges as jest.Mock).mock.invocationCallOrder.at(-1)!);
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverCommitted).toHaveBeenCalledTimes(1);
    expect(deliverCommitted).toHaveBeenCalledWith([
      expect.objectContaining({ schoolId: admin.schoolId, type: 'LEAVE_REQUESTED', recipients: [{ userId: MENTOR, notificationId: NOTICE }] }),
    ]);
  });

  it('the night asks nothing of a run that moved nobody, and delivers nothing', async () => {
    given([change(1, 'PERSON', 'UPDATE', true), change(2, 'CLASS_MEMBERSHIP', 'MOVE', true)], [1]);
    await sync.autoApply('run', admin.schoolId!);
    expect(applyChanges).toHaveBeenCalled();
    expect(told()).toEqual([]);
    expect(deliverCommitted).not.toHaveBeenCalled();
  });

  it('the night delivers nothing when its transaction fails after the catch-up', async () => {
    given([change(1, 'CLASS_MEMBERSHIP', 'MOVE', true)], [1]);
    tx.ss12000SyncRun.update.mockRejectedValue(new Error('rolled back'));
    await expect(sync.autoApply('run', admin.schoolId!)).rejects.toThrow('rolled back');
    expect(told()).toHaveLength(1);
    expect(deliverCommitted).not.toHaveBeenCalled();
  });
});
