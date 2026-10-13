import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import { recordedReads } from '../../../test/utils/recorded-reads';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../database/prisma.service';
import { Ss12000SourceService } from './ss12000-source.service';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync.providers';
import { Ss12000SyncService, peopleInChanges } from './ss12000-sync.service';

const admin = {
  authId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  schoolId: '33333333-3333-4333-8333-333333333333',
  role: 'SCHOOL_ADMIN',
} as AuthenticatedUser;

describe('without INTEGRATION_SECRETS_KEY', () => {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const secrets = new Ss12000Secrets(undefined);
  const outbound = new Ss12000Outbound(undefined);

  it('refuses to save a credential (503) and stores nothing, rather than store it in plaintext', async () => {
    const sources = new Ss12000SourceService(prisma, secrets, outbound);
    await expect(sources.putSecret(admin, 'CLIENT_SECRET', 'abc')).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'SS12000_SECRETS_NOT_CONFIGURED' }),
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses "Synka nu" (503): the run could not read its credentials', async () => {
    const sync = new Ss12000SyncService(prisma, secrets, outbound);
    await expect(sync.startManualRun(admin, 'FULL')).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'SS12000_SECRETS_NOT_CONFIGURED' }),
    });
  });

  it('allows loopback only when the configuration says the test override is on', () => {
    expect(outbound.clientOptions().policy.allowLoopback).toBe(false);
    const on = new Ss12000Outbound({ get: () => ({ allowInsecureLocal: true }) } as never);
    expect(on.clientOptions().policy.allowLoopback).toBe(true);
  });
});

describe('the läslogg of the change review and the provisioning list', () => {
  const PUPIL = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  const GUARDIAN = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
  const TEACHER = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
  const OLD_HOLDER = 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
  const GROUP = 'e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5';
  const change = (entity: string, localId: string | null, before: unknown, after: unknown, seq: number) => ({
    id: `00000000-0000-4000-8000-00000000000${seq}`,
    runId: 'run',
    schoolId: admin.schoolId,
    seq,
    entity,
    op: 'UPDATE',
    externalId: null,
    localId,
    before,
    after,
    conflictCode: null,
    selected: true,
    autoApplicable: false,
    protectedIdentity: false,
    applied: false,
    createdAt: new Date(),
  });

  it('peopleInChanges: each entity under its kind, a guardian and a duty holder from the JSON, and nothing that is not a uuid', () => {
    const named = peopleInChanges([
      change('PERSON', PUPIL, { firstName: 'Ada' }, { firstName: 'Adah' }, 1),
      change('PERSON', null, null, { firstName: 'Ny' }, 2),
      change('CLASS_MEMBERSHIP', PUPIL, { studentGroupId: GROUP }, { groupLocalId: GROUP }, 3),
      change('GROUP_MEMBERSHIP', PUPIL, null, { groupLocalId: GROUP }, 4),
      change('RESPONSIBLE', PUPIL, null, { guardianLocalId: GUARDIAN, guardianName: 'Bo Ek' }, 5),
      change('RESPONSIBLE', PUPIL, null, { guardianLocalId: 'not-a-uuid' }, 6),
      change('DUTY_LINK', null, { userLocalId: OLD_HOLDER }, { userLocalId: TEACHER }, 7),
      change('GROUP', GROUP, null, { name: '7A' }, 8),
      change('ORGANISATION', admin.schoolId, null, {}, 9),
    ] as never);
    expect(named).toEqual({
      PEOPLE: [PUPIL],
      ROSTER: [PUPIL, PUPIL],
      GUARDIANS: [PUPIL, GUARDIAN, PUPIL],
      EMPLOYMENT: [OLD_HOLDER, TEACHER],
    });
  });

  it('a page of changes is read and recorded in one interactive transaction, one statement per kind it names', async () => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    tx.ss12000SyncChange.findMany.mockResolvedValue([
      change('PERSON', PUPIL, { email: 'a@x' }, { email: 'b@x' }, 1),
      change('RESPONSIBLE', PUPIL, null, { guardianLocalId: GUARDIAN }, 2),
      change('GROUP', GROUP, null, { name: '7A' }, 3),
    ]);
    const sync = new Ss12000SyncService(prisma as unknown as PrismaService, new Ss12000Secrets(undefined), new Ss12000Outbound(undefined));
    const page = await sync.listChanges({ ...admin, channel: 'WEB' }, 'run', {} as never);
    expect(page.data).toHaveLength(3);
    expect(prisma.withRls).toHaveBeenCalledTimes(1);
    expect(prisma.queryWithRls).not.toHaveBeenCalled();
    expect(recordedReads(tx)).toEqual([
      { kind: 'PEOPLE', channel: 'WEB', ids: [PUPIL] },
      { kind: 'GUARDIANS', channel: 'WEB', ids: [PUPIL, GUARDIAN] },
    ]);
  });

  it('the provisioning list records everyone it lists as PEOPLE', async () => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    tx.user.findMany.mockResolvedValue([
      { id: PUPIL, role: 'STUDENT', firstName: 'Ada', lastName: 'Ek', email: 'a@x', studentGroup: null },
      { id: TEACHER, role: 'TEACHER', firstName: 'Bo', lastName: 'Ek', email: 'b@x', studentGroup: null },
    ]);
    const sync = new Ss12000SyncService(prisma as unknown as PrismaService, new Ss12000Secrets(undefined), new Ss12000Outbound(undefined));
    await expect(sync.provisioning({ ...admin, channel: 'WEB' })).resolves.toHaveLength(2);
    expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: 'WEB', ids: [PUPIL, TEACHER] }]);
  });
});
