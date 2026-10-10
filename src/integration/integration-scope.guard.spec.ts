import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { IntegrationScopeGuard } from './integration-scope.guard';

const KEY = `sp_${'ab'.repeat(24)}`;
const SCHOOL = '33333333-3333-4333-8333-333333333333';

function setup(scope: string | undefined, row: object | null) {
  const tx = createTxMock();
  tx['integrationApiKey']!['findFirst']!.mockResolvedValue(row);
  const prisma = createPrismaMock(tx);
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(scope) } as unknown as Reflector;
  const guard = new IntegrationScopeGuard(prisma as unknown as PrismaService, reflector);
  const context = (headers: Record<string, unknown>) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ headers, integrationSchoolId: SCHOOL }) }),
    }) as never;
  return { guard, context, tx };
}

describe('IntegrationScopeGuard', () => {
  it('passes a route that names no scope without a lookup', async () => {
    const { guard, context, tx } = setup(undefined, null);
    await expect(guard.canActivate(context({}))).resolves.toBe(true);
    expect(tx['integrationApiKey']!['findFirst']).not.toHaveBeenCalled();
  });

  it('admits a key holding the scope, through the narrow lookup, without stamping it twice', async () => {
    const { guard, context, tx } = setup('ss12000.v1', { id: 'k', schoolId: SCHOOL, scopes: ['ss12000.v1', 'ss12000.v1.import'] });
    await expect(guard.canActivate(context({ 'x-api-key': KEY }))).resolves.toBe(true);
    expect(tx['integrationApiKey']!['update']).not.toHaveBeenCalled();
  });

  it('refuses a key without the scope with a 403 naming it, and a key of another school or none at all with a 401', async () => {
    await expect(setup('ss12000.v1.import', { id: 'k', schoolId: SCHOOL, scopes: ['ss12000.v1'] }).guard.canActivate(setup('x', null).context({ 'x-api-key': KEY }))).rejects.toThrow(
      new ForbiddenException('This API key lacks the scope ss12000.v1.import.'),
    );
    const other = setup('ss12000.v1', { id: 'k', schoolId: '44444444-4444-4444-8444-444444444444', scopes: ['ss12000.v1'] });
    await expect(other.guard.canActivate(other.context({ 'x-api-key': KEY }))).rejects.toThrow(UnauthorizedException);
    const gone = setup('ss12000.v1', null);
    await expect(gone.guard.canActivate(gone.context({ 'x-api-key': KEY }))).rejects.toThrow(UnauthorizedException);
    await expect(gone.guard.canActivate(gone.context({}))).rejects.toThrow('Missing or malformed X-API-Key.');
  });
});
