import { createHash } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { isScope, type Scope } from './ss12000-v2/scopes';

/** A key as the integration routes act on it: its row, its school, its reach. */
export interface ResolvedIntegrationKey {
  id: string;
  schoolId: string;
  scopes: Scope[];
}

/** `sp_` and 48 hex digits, as IntegrationKeysController issues them. */
export const KEY_SHAPE = /^sp_[0-9a-f]{48}$/;

export function keyHashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Resolves a presented key to its live row, under the narrow key-lookup
 * principal (SELECT and the lastUsedAt stamp on non-revoked keys, nothing
 * else — 20260806010000, and since 20261014120000 a guard that refuses the
 * lookup any other column). Null for an unknown or revoked key.
 *
 * The v2.0 guard reads the key and its scopes in this one statement. The v1
 * guard (IntegrationKeyGuard) keeps its own statement unchanged, and v1's
 * scope check (IntegrationScopeGuard) asks this function afterwards.
 */
export async function resolveIntegrationKey(
  prisma: Pick<PrismaService, 'withServiceKeyLookup'>,
  key: string,
  options: { touch: boolean },
): Promise<ResolvedIntegrationKey | null> {
  const keyHash = keyHashOf(key);
  const row = await prisma.withServiceKeyLookup((tx) =>
    tx.integrationApiKey.findFirst({
      where: { keyHash, revokedAt: null },
      select: { id: true, schoolId: true, scopes: true },
    }),
  );
  if (!row) return null;
  if (options.touch) {
    // Best-effort usage timestamp; never blocks the request.
    void prisma
      .withServiceKeyLookup((tx) =>
        tx.integrationApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }),
      )
      .catch(() => undefined);
  }
  return { id: row.id, schoolId: row.schoolId, scopes: (row.scopes ?? []).filter(isScope) };
}
