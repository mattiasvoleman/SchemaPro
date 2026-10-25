import { createHash } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { HUVUDMAN_SCOPES, isScope, type Scope } from './ss12000-v2/scopes';

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

/** `sh_` and 48 hex digits: a huvudman's key (Huvudman, 20261212090000), told from a school's by its prefix. */
export const HUVUDMAN_KEY_SHAPE = /^sh_[0-9a-f]{48}$/;

/** The huvudman a key is of, as the provider's Organisation of type Huvudman names it. */
export interface KeyHuvudman {
  id: string;
  name: string;
  organisationNumber: string | null;
  municipalityCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A huvudman's key as the v2.0 provider acts on it: its row, its huvudman, its schools, its reach. */
export interface ResolvedHuvudmanKey {
  id: string;
  scopes: Scope[];
  huvudman: KeyHuvudman;
  /** The schools the huvudman owns now, by id: the order the key's lists walk. */
  schools: string[];
}

/**
 * Resolves a presented huvudman key to its live row (the key lookup's arm on
 * HuvudmanApiKeys, as for a school's key), then, under the key alone, its
 * huvudman and the schools it owns now. Null for an unknown or revoked key.
 * Only the provider's read scopes count (HUVUDMAN_SCOPES, which the
 * table's CHECK holds anyway).
 */
export async function resolveHuvudmanKey(
  prisma: Pick<PrismaService, 'withServiceKeyLookup' | 'withHuvudmanKey'>,
  key: string,
  options: { touch: boolean },
): Promise<ResolvedHuvudmanKey | null> {
  const keyHash = keyHashOf(key);
  const row = await prisma.withServiceKeyLookup((tx) =>
    tx.huvudmanApiKey.findFirst({ where: { keyHash, revokedAt: null }, select: { id: true, scopes: true } }),
  );
  if (!row) return null;
  if (options.touch) {
    void prisma
      .withServiceKeyLookup((tx) => tx.huvudmanApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }))
      .catch(() => undefined);
  }
  const reach = await prisma.withHuvudmanKey(row.id, async (tx) => {
    const owners = await tx.$queryRaw<
      Array<{ huvudman_id: string; name: string; organisation_number: string | null; municipality_code: string | null; created_at: Date; updated_at: Date }>
    >`SELECT huvudman_id, name, organisation_number, municipality_code, created_at, updated_at FROM app.huvudman_key_owner()`;
    const schools = await tx.$queryRaw<Array<{ school_id: string }>>`SELECT school_id FROM app.huvudman_key_schools()`;
    return { owner: owners[0], schools: schools.map((school) => school.school_id) };
  });
  // Revoked between the two transactions: no key.
  if (!reach.owner) return null;
  const allowed = new Set<string>(HUVUDMAN_SCOPES);
  return {
    id: row.id,
    scopes: (row.scopes ?? []).filter((scope): scope is Scope => isScope(scope) && allowed.has(scope)),
    huvudman: {
      id: reach.owner.huvudman_id,
      name: reach.owner.name,
      organisationNumber: reach.owner.organisation_number,
      municipalityCode: reach.owner.municipality_code,
      createdAt: reach.owner.created_at,
      updatedAt: reach.owner.updated_at,
    },
    schools: reach.schools,
  };
}
