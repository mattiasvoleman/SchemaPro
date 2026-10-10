import { Prisma, type PrismaClient, type Ss12000SecretKind, type Ss12000Source } from '@prisma/client';
import type { SourceConnection } from './client';
import { Ss12000SourceError } from './errors';
import { originOf } from './outbound';
import { SecretBoxError, type SecretBox, type SecretBinding } from './secret-box';

/** A ciphertext row as app.ss12000_source_secrets hands it out. */
export interface SealedRow {
  kind: Ss12000SecretKind;
  ciphertext: Buffer | Uint8Array;
  iv: Buffer | Uint8Array;
  auth_tag: Buffer | Uint8Array;
  key_id: string;
}

type SourceShape = Pick<Ss12000Source, 'id' | 'schoolId' | 'baseUrl' | 'tokenUrl'>;

/** Where a credential is sent: tokenUrl's origin for the client secret, baseUrl's for the rest. */
export function secretOrigin(source: Pick<Ss12000Source, 'baseUrl' | 'tokenUrl'>, kind: Ss12000SecretKind): string | null {
  if (kind === 'CLIENT_SECRET') return source.tokenUrl ? originOf(source.tokenUrl) : null;
  return originOf(source.baseUrl);
}

export function bindingFor(source: SourceShape, kind: Ss12000SecretKind): SecretBinding | null {
  const origin = secretOrigin(source, kind);
  return origin ? { schoolId: source.schoolId, sourceId: source.id, kind, origin } : null;
}

/**
 * The ciphertexts of `sourceId`, through the one function that hands them
 * out: to the school's sync principal or its SCHOOL_ADMIN, SS403 to anyone
 * else (20261014090000).
 */
export async function readSealed(tx: PrismaClient, sourceId: string): Promise<SealedRow[]> {
  return tx.$queryRaw<SealedRow[]>(
    Prisma.sql`SELECT kind, ciphertext, iv, auth_tag, key_id FROM app.ss12000_source_secrets(${sourceId}::uuid)`,
  );
}

/** The plaintexts, for this process and this run only. A row that does not open is a code. */
export function openSecrets(box: SecretBox, source: SourceShape, rows: SealedRow[]): Partial<Record<Ss12000SecretKind, string>> {
  const secrets: Partial<Record<Ss12000SecretKind, string>> = {};
  for (const row of rows) {
    const binding = bindingFor(source, row.kind);
    if (!binding) continue;
    try {
      secrets[row.kind] = box.open(
        { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.auth_tag), keyId: row.key_id },
        binding,
      );
    } catch (error) {
      throw new Ss12000SourceError(error instanceof SecretBoxError ? error.code : 'SS12000_SECRET_UNREADABLE');
    }
  }
  return secrets;
}

export function connectionOf(source: Ss12000Source, secrets: Partial<Record<Ss12000SecretKind, string>>): SourceConnection {
  return {
    sourceId: source.id,
    baseUrl: source.baseUrl,
    authKind: source.authKind,
    tokenUrl: source.tokenUrl,
    clientId: source.clientId,
    tokenScope: source.tokenScope,
    tokenAuthStyle: source.tokenAuthStyle,
    secrets,
  };
}

/** The calendar date at `now` in `timezone`, as YYYY-MM-DD. */
export function localDate(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
