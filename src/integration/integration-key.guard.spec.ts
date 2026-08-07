import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  IntegrationKeyGuard,
  type IntegrationRequest,
} from './integration-key.guard';

const KEY = `sp_${'ab'.repeat(24)}`;
const KEY_HASH = createHash('sha256').update(KEY).digest('hex');
const KEY_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('IntegrationKeyGuard', () => {
  let guard: IntegrationKeyGuard;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    guard = new IntegrationKeyGuard(prisma as unknown as PrismaService);
  });

  /** Crafts an ExecutionContext around a bare request with the given headers. */
  const makeContext = (headers: Record<string, unknown>) => {
    const request = { headers } as unknown as IntegrationRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { request, context };
  };

  const arrangeValidKey = () => {
    tx.integrationApiKey.findFirst.mockResolvedValue({
      id: KEY_ID,
      schoolId: SCHOOL_ID,
    });
    tx.integrationApiKey.update.mockResolvedValue({ id: KEY_ID });
  };

  it('rejects a missing X-API-Key without touching the database', async () => {
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Missing or malformed X-API-Key.',
    );
    expect(prisma.withServiceKeyLookup).not.toHaveBeenCalled();
  });

  it('rejects a key without the sp_ prefix before hashing it', async () => {
    const { context } = makeContext({ 'x-api-key': 'pk_wrong-family' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.withServiceKeyLookup).not.toHaveBeenCalled();
  });

  it('rejects a repeated header (string[] is not a key)', async () => {
    const { context } = makeContext({ 'x-api-key': [KEY, KEY] });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Missing or malformed X-API-Key.',
    );
  });

  it('resolves the key via the service-key lookup, never a user or system transaction', async () => {
    arrangeValidKey();
    const { context } = makeContext({ 'x-api-key': KEY });

    await guard.canActivate(context);

    // Tenancy: this is the one pre-tenant lookup; it must run under the
    // narrow service_key_lookup policy, not withRls (no principal exists yet)
    // and not withSystemTransaction (which returns zero rows under RLS and
    // would reject every valid key).
    expect(prisma.withServiceKeyLookup).toHaveBeenCalled();
    expect(prisma.withRls).not.toHaveBeenCalled();
    expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
    expect(prisma.withServicePrincipal).not.toHaveBeenCalled();
  });

  it('looks up the SHA-256 hash of the key, restricted to non-revoked rows', async () => {
    arrangeValidKey();
    const { context } = makeContext({ 'x-api-key': KEY });

    await guard.canActivate(context);

    expect(tx.integrationApiKey.findFirst).toHaveBeenCalledWith({
      where: { keyHash: KEY_HASH, revokedAt: null },
      select: { id: true, schoolId: true },
    });
  });

  it('admits a valid key and scopes the request to its school', async () => {
    arrangeValidKey();
    const { request, context } = makeContext({ 'x-api-key': KEY });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.integrationSchoolId).toBe(SCHOOL_ID);
  });

  it('rejects an unknown or revoked key and leaves the request unscoped', async () => {
    tx.integrationApiKey.findFirst.mockResolvedValue(null);
    const { request, context } = makeContext({ 'x-api-key': KEY });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Invalid API key.',
    );
    expect(request.integrationSchoolId).toBeUndefined();
    expect(tx.integrationApiKey.update).not.toHaveBeenCalled();
  });

  it('stamps lastUsedAt on the matched key', async () => {
    arrangeValidKey();
    const { context } = makeContext({ 'x-api-key': KEY });

    await guard.canActivate(context);

    expect(tx.integrationApiKey.update).toHaveBeenCalledWith({
      where: { id: KEY_ID },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('still admits the key when the usage stamp fails (best-effort)', async () => {
    tx.integrationApiKey.findFirst.mockResolvedValue({
      id: KEY_ID,
      schoolId: SCHOOL_ID,
    });
    tx.integrationApiKey.update.mockRejectedValue(new Error('db unavailable'));
    const { request, context } = makeContext({ 'x-api-key': KEY });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.integrationSchoolId).toBe(SCHOOL_ID);
  });
});
