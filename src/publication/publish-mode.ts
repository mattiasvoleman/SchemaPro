import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * PUBLICERINGSLÄGE, as a writer and a reader see it (20261011100000).
 *
 * DIRECT — the default, and the absence of a settings row — is today's
 * behaviour: an edit to the grundschema reaches the calendar at once. DRAFT
 * keeps the edit a draft until an admin publishes it.
 */
export type PublishMode = 'DIRECT' | 'DRAFT';

/** The problem `code` of a writer that waited longer than 5 s for a publish. */
export const PUBLISH_IN_PROGRESS = 'PUBLISH_IN_PROGRESS';

/**
 * The FIRST statement of every grundschema writer: the shared publication
 * lock and the school's mode, in one statement (app.enter_grundschema_write).
 * A DRAFT publish holds the lock exclusively while it carries the draft over,
 * so a writer either lands before the publish reads the masters or after it
 * has snapshotted them — never in between, where the edit would be in the
 * calendar and missing from the snapshot, or the other way round.
 *
 * DIRECT pays this one statement and never waits on a publish: only a DRAFT
 * school's publish, a discard, a refill and a mode switch take the lock
 * exclusively. A writer that waits 5 s answers 409 PUBLISH_IN_PROGRESS.
 */
export async function enterGrundschemaWrite(tx: PrismaClient, schoolId: string): Promise<PublishMode> {
  try {
    const rows = await tx.$queryRaw<{ mode: string }[]>(
      Prisma.sql`SELECT app.enter_grundschema_write(${schoolId}::uuid) AS "mode"`,
    );
    return rows?.[0]?.mode === 'DRAFT' ? 'DRAFT' : 'DIRECT';
  } catch (error) {
    if (isLockTimeout(error)) throw publishInProgress();
    throw error;
  }
}

/** The exclusive side, for the publish, its preview, discard, refill and the mode switch. */
export async function enterPublication(tx: PrismaClient, schoolId: string): Promise<PublishMode> {
  try {
    const rows = await tx.$queryRaw<{ mode: string }[]>(
      Prisma.sql`SELECT app.enter_publication(${schoolId}::uuid) AS "mode"`,
    );
    return rows?.[0]?.mode === 'DRAFT' ? 'DRAFT' : 'DIRECT';
  } catch (error) {
    if (isLockTimeout(error)) throw publishInProgress();
    throw error;
  }
}

/**
 * The mode, read without a lock, through the one-word definer function: for
 * readers (a TEACHER cannot read the settings row, and needs only this).
 */
export async function publishModeOf(tx: PrismaClient, schoolId: string): Promise<PublishMode> {
  const rows = await tx.$queryRaw<{ mode: string }[]>(
    Prisma.sql`SELECT app.school_publish_mode(${schoolId}::uuid) AS "mode"`,
  );
  return rows?.[0]?.mode === 'DRAFT' ? 'DRAFT' : 'DIRECT';
}

export function publishInProgress(): ConflictException {
  return new ConflictException({
    message: 'Schemat publiceras just nu. Försök igen om en stund.',
    code: PUBLISH_IN_PROGRESS,
  });
}

/** 55P03 lock_not_available: a lock_timeout that ran out. */
export function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return error instanceof Error && /lock timeout|55P03/.test(error.message);
  }
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '55P03' || /55P03|lock timeout/.test(error.message);
}
