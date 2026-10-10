import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { IntegrationKeysController } from './integration.controller';
import { Ss12000Secrets } from './ss12000-sync/ss12000-sync.providers';

/** The key routes the provider added (20261014120000); the original three stay in integration.controller.spec.ts. */
const KEY = '66666666-6666-4666-8666-666666666666';
const SUB = '77777777-7777-4777-8777-777777777777';

function setup(configured = true): { controller: IntegrationKeysController; tx: TxMock } {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const secrets = new Ss12000Secrets({ get: () => ({ secretsKey: configured ? Buffer.alloc(32, 3) : undefined }) } as unknown as ConfigService);
  return { controller: new IntegrationKeysController(prisma as unknown as PrismaService, secrets), tx };
}

describe('IntegrationKeysController — the provider\'s routes', () => {
  it('creates a key with exactly the chosen scopes, and refuses unknown ones before the database', async () => {
    const { controller, tx } = setup();
    tx['integrationApiKey']!['create']!.mockResolvedValue({ id: KEY, name: 'Vklass', createdAt: new Date() });
    await controller.create({ name: 'Vklass', scopes: ['calendarEvents.read', 'activities.read'] }, testUser());
    expect(tx['integrationApiKey']!['create']!.mock.calls[0][0].data.scopes).toEqual(['activities.read', 'calendarEvents.read']);
    await expect(controller.create({ scopes: ['everything'] }, testUser())).rejects.toThrow(BadRequestException);
    expect(tx['integrationApiKey']!['create']).toHaveBeenCalledTimes(1);
  });

  it('lists each key\'s scopes, signing secret and subscriptions by host — never a hash, a key or a target\'s path', async () => {
    const { controller, tx } = setup();
    tx['integrationApiKey']!['findMany']!.mockResolvedValue([
      { id: KEY, name: 'Vklass', scopes: ['groups.read'], lastUsedAt: null, revokedAt: null, createdAt: new Date(), keyHash: 'x'.repeat(64) },
      { id: '88888888-8888-4888-8888-888888888888', name: 'Old', scopes: ['ss12000.v1'], lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    ]);
    (tx.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ key_id: KEY, set_at: new Date('2026-10-10T08:00:00Z'), previous_valid_until: null }]);
    tx['ss12000Subscription']!['findMany']!.mockResolvedValue([
      { id: SUB, keyId: KEY, name: 'n', target: 'https://hooks.vklass.example/a/b?token=secret', resourceTypes: ['Room'], expiresAt: new Date(), suspendedAt: null, suspendedReason: null, lastNotifiedAt: null, failingSince: null, attempts: 0, createdAt: new Date() },
      { id: SUB, keyId: KEY, name: 'broken', target: 'not a url', resourceTypes: ['Room'], expiresAt: new Date(), suspendedAt: null, suspendedReason: null, lastNotifiedAt: null, failingSince: null, attempts: 0, createdAt: new Date() },
    ]);
    const view = await controller.provider(testUser());
    expect(view[0]).toMatchObject({ id: KEY, scopes: ['groups.read'], webhookSecret: { setAt: expect.any(Date), previousValidUntil: null } });
    expect(view[0]!.subscriptions.map((row) => row.targetHost)).toEqual(['hooks.vklass.example', '']);
    expect(view[1]).toMatchObject({ webhookSecret: null, subscriptions: [] });
    expect(JSON.stringify(view)).not.toMatch(/keyHash|token=secret|\/a\/b/);
  });

  it('edits scopes of a live key only', async () => {
    const { controller, tx } = setup();
    tx['integrationApiKey']!['updateMany']!.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(controller.updateScopes(KEY, { scopes: ['rooms.read'] }, testUser())).resolves.toEqual({ id: KEY, scopes: ['rooms.read'] });
    expect(tx['integrationApiKey']!['updateMany']).toHaveBeenCalledWith({ where: { id: KEY, revokedAt: null }, data: { scopes: ['rooms.read'] } });
    await expect(controller.updateScopes(KEY, { scopes: ['rooms.read'] }, testUser())).rejects.toThrow(NotFoundException);
    await expect(controller.updateScopes(KEY, {}, testUser())).rejects.toThrow(BadRequestException);
  });

  it('makes a signing secret shown once and stored sealed; 503 without the key, 404 for a key the school lacks', async () => {
    const { controller, tx } = setup();
    (tx.$queryRaw as unknown as jest.Mock).mockResolvedValueOnce([{ set_at: new Date() }]);
    const made = await controller.webhookSecret(KEY, testUser());
    expect(made.secret).toMatch(/^whsec_/);
    const statement = (tx.$queryRaw as unknown as jest.Mock).mock.calls[0][0] as { values: unknown[] };
    expect(JSON.stringify(statement.values)).not.toContain(made.secret);
    (tx.$queryRaw as unknown as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('x'), { meta: { driverAdapterError: { cause: { originalCode: 'SS404' } } } }));
    await expect(controller.webhookSecret(KEY, testUser())).rejects.toThrow(NotFoundException);
    (tx.$queryRaw as unknown as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(controller.webhookSecret(KEY, testUser())).rejects.toThrow('db down');
    await expect(setup(false).controller.webhookSecret(KEY, testUser())).rejects.toThrow(ServiceUnavailableException);
    await expect(new IntegrationKeysController(createPrismaMock(createTxMock()) as unknown as PrismaService).webhookSecret(KEY, testUser())).rejects.toThrow(ServiceUnavailableException);
  });

  it('pauses and resumes a key\'s live subscription, and nothing else', async () => {
    const { controller, tx } = setup();
    tx['ss12000Subscription']!['updateMany']!.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(controller.subscriptionState(KEY, SUB, 'pause', testUser())).resolves.toEqual({ id: SUB, state: 'PAUSED' });
    expect(tx['ss12000Subscription']!['updateMany']!.mock.calls[0][0].data).toMatchObject({ suspendedReason: 'ADMIN' });
    await expect(controller.subscriptionState(KEY, SUB, 'resume', testUser())).resolves.toEqual({ id: SUB, state: 'ACTIVE' });
    await expect(controller.subscriptionState(KEY, SUB, 'resume', testUser())).rejects.toThrow(NotFoundException);
    await expect(controller.subscriptionState(KEY, SUB, 'delete', testUser())).rejects.toThrow(NotFoundException);
  });
});
