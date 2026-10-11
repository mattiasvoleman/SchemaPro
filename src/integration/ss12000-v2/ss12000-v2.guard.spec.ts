import type { ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service';
import { keyHashOf } from '../integration-key';
import { PER_ADDRESS, PER_KEY, Ss12000V2Guard } from './ss12000-v2.guard';

/**
 * The v2 guard's two limits (A5.10): per key, and per address for attempts
 * that FAIL to authenticate. One consumer address serving many schools —
 * a Vklass egress IP with a key per school — is limited per key alone.
 */
const keyOf = (n: number) => `sp_${n.toString(16).padStart(2, '0').repeat(24)}`;

function guardWith(keys: string[]) {
  const rows = new Map(
    keys.map((key, i) => [keyHashOf(key), { id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, schoolId: `school-${i}`, scopes: ['persons.read'] }]),
  );
  const prisma = {
    withServiceKeyLookup: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        integrationApiKey: {
          findFirst: async ({ where }: { where: { keyHash: string } }) => rows.get(where.keyHash) ?? null,
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
      }),
  } as unknown as PrismaService;
  return new Ss12000V2Guard(prisma);
}

async function attempt(guard: Ss12000V2Guard, ip: string, key: string | null): Promise<number> {
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const request = { ip, headers } as unknown as Record<string, unknown>;
  const response = { setHeader: () => undefined };
  const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ExecutionContext;
  try {
    await guard.canActivate(context);
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
}

describe('Ss12000V2Guard', () => {
  beforeEach(() => Ss12000V2Guard.resetCounters());

  it('limits one address serving many schools per key only: six keys under 120 a minute each are never refused', async () => {
    const keys = Array.from({ length: 6 }, (_, i) => keyOf(i + 1));
    const guard = guardWith(keys);
    const refused: number[] = [];
    for (let round = 0; round < 110; round++) {
      for (const key of keys) refused.push(await attempt(guard, '203.0.113.7', key));
    }
    expect(110 * 6).toBeGreaterThan(PER_ADDRESS.limit);
    expect(refused.filter((status) => status !== 200)).toEqual([]);
  });

  it('still refuses a key past its own 120 a minute', async () => {
    const guard = guardWith([keyOf(1)]);
    const statuses: number[] = [];
    for (let i = 0; i <= PER_KEY.limit; i++) statuses.push(await attempt(guard, '203.0.113.7', keyOf(1)));
    expect(statuses.slice(0, PER_KEY.limit).every((status) => status === 200)).toBe(true);
    expect(statuses[PER_KEY.limit]).toBe(429);
  });

  it('counts failed attempts per address, and then refuses that address before any lookup, a valid key too', async () => {
    const guard = guardWith([keyOf(1)]);
    const statuses: number[] = [];
    for (let i = 0; i <= PER_ADDRESS.limit; i++) statuses.push(await attempt(guard, '198.51.100.9', i % 2 === 0 ? keyOf(9) : null));
    expect(statuses.slice(0, PER_ADDRESS.limit).every((status) => status === 401)).toBe(true);
    expect(statuses[PER_ADDRESS.limit]).toBe(429);
    expect(await attempt(guard, '198.51.100.9', keyOf(1))).toBe(429);
    // Another address is not affected.
    expect(await attempt(guard, '203.0.113.7', keyOf(1))).toBe(200);
  });
});
