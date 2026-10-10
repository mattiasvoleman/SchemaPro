import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../database/prisma.service';
import { Ss12000SourceService } from './ss12000-source.service';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync.providers';
import { Ss12000SyncService } from './ss12000-sync.service';

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
