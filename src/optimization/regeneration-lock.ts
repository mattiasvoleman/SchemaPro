import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { isLockTimeout } from '../publication/publish-mode';

/*
 * THE YEAR'S REGENERATION LOCK (Schemaförslag, design §4).
 *
 * Three writers replace a year's grundschema wholesale: Generera's persist,
 * the apply of a schemaförslag and a version restore. Each used to take only
 * the shared publication lock, which every grundschema writer holds at once,
 * so two of them could interleave on one year: a restore's delete skipped the
 * rows an apply had just inserted and then recreated its own on top of them,
 * and a generate that read the draft before an apply wrote its own answer over
 * the applied candidate. They now queue on one exclusive advisory lock per
 * year, taken straight after enterGrundschemaWrite (publication first, this
 * second — the order room and staffing apply already use).
 *
 * A 5 s lock_timeout, SET LOCAL for the rest of the transaction: a writer
 * queued behind a 20-second apply answers 409 instead of running into its own
 * transaction's 15 s and an unexplained 500 after a whole solve. Later waits
 * in the same transaction (a row a hand edit holds) are held to the same 5 s,
 * and a writer maps those to the same 409 — see isLockTimeout.
 *
 * Hand edits of the grundschema (MasterLessonsService) take it SHARED, at
 * most 5 s, before their first row lock (lockYearForGrundschemaEdit): edits
 * run beside each other as before, and an edit meeting a rewrite in progress
 * answers 409 SCHEDULE_BUSY within 5 s instead of waiting on the apply's row
 * locks into its own 15 s and a 500. Both sides take the advisory lock before
 * any row, so an apply and a hand edit cannot deadlock. The apply's FOR
 * UPDATE on the year's master rows stays, for any writer that takes no lock.
 *
 * Every key built from a year hashes the uuid's canonical text
 * (`${id}::uuid::text`), not the string the caller holds: a request body may
 * spell the year in upper case (class-validator's IsUUID accepts it), the
 * database prints it in lower case, and two spellings of one year must meet on
 * one key. The room and staffing applies key their own locks the same way.
 */

/** Generera's persist and a version restore queued behind another rewrite for 5 s. */
export const SCHEDULE_BUSY = 'SCHEDULE_BUSY';
/** The same wait for an apply, under the apply's own code. */
export const SCHEDULE_CANDIDATE_BUSY = 'SCHEDULE_CANDIDATE_BUSY';
/** The draft a candidate was solved from is not the draft any more. */
export const SCHEDULE_CANDIDATE_STALE = 'SCHEDULE_CANDIDATE_STALE';
/** A generate whose draft changed between its read and its write. */
export const GENERATE_STALE = 'GENERATE_STALE';

/**
 * The year's regeneration lock, exclusive, waited for at most 5 s. Call it
 * after enterGrundschemaWrite and before the first read the write depends on.
 */
export async function lockYearForRegeneration(
  tx: PrismaClient,
  academicYearId: string,
  busyCode: string = SCHEDULE_BUSY,
): Promise<void> {
  try {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext(${academicYearId}::uuid::text))`;
  } catch (error) {
    if (isLockTimeout(error)) throw scheduleBusy(busyCode);
    throw error;
  }
}

/**
 * The year's start lock, for the two starts that put a solve in motion:
 * Generera's POST jobs and a candidate run's start. Each asks whether the
 * other is running and then inserts its own row; under this lock the second
 * of two simultaneous clicks reads the first one's row instead of passing the
 * same check beside it, so the engine never gets two solve streams for one
 * year. Taken before any other advisory lock of the start, and held only for
 * the check and the insert. A wait past 5 s is answered with `busyCode`.
 */
export async function lockYearForSolveStart(
  tx: PrismaClient,
  academicYearId: string,
  busyCode: string,
): Promise<void> {
  try {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('grundschema-solve-start'), hashtext(${academicYearId}::uuid::text))`;
  } catch (error) {
    if (isLockTimeout(error)) throw scheduleBusy(busyCode);
    throw error;
  }
}

/**
 * The apply's three year locks, always in this order: the regeneration lock,
 * the room optimisation's, the staffing proposal's. Nothing else takes two of
 * them, so the order cannot cycle; holding all three makes a room or staffing
 * apply of the same year wait for the candidate's (each of those reads a basis
 * of its own afterwards and is refused as stale if the candidate changed it).
 */
export async function lockYearForCandidateApply(tx: PrismaClient, academicYearId: string): Promise<void> {
  await lockYearForRegeneration(tx, academicYearId, SCHEDULE_CANDIDATE_BUSY);
  try {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('room-optimization'), hashtext(${academicYearId}::uuid::text))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('staffing-proposal'), hashtext(${academicYearId}::uuid::text))`;
  } catch (error) {
    if (isLockTimeout(error)) throw scheduleBusy(SCHEDULE_CANDIDATE_BUSY);
    throw error;
  }
}

/**
 * The room or staffing apply's own year key, waited for at most 5 s. Those
 * keys used to be held only by another apply of the same kind, a moment; a
 * candidate apply now holds both for its whole transaction (up to a minute),
 * and an unbounded wait ran into the waiter's own 15 s and a 500. Answered
 * with SCHEDULE_BUSY, whose sentence the room and staffing dialogs show as
 * the gateway's message. Only this statement is bounded: the transaction's
 * lock_timeout is put back after it, so the apply's later row waits stay as
 * they were.
 */
export async function lockApplyYearKey(
  tx: PrismaClient,
  key: 'room-optimization' | 'staffing-proposal',
  academicYearId: string,
): Promise<void> {
  try {
    const [setting] = await tx.$queryRaw<{ previous: string }[]>(
      Prisma.sql`SELECT current_setting('lock_timeout') AS "previous"`,
    );
    await tx.$executeRaw`SELECT set_config('lock_timeout', '5s', true)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}), hashtext(${academicYearId}::uuid::text))`;
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${setting?.previous ?? '0'}, true)`;
  } catch (error) {
    if (isLockTimeout(error)) throw scheduleBusy(SCHEDULE_BUSY);
    throw error;
  }
}

/**
 * A hand edit's share of the year's regeneration lock (see the header): taken
 * after the edit has read which year it touches and before it locks or writes
 * any row. One statement, app.lock_years_for_grundschema_edit
 * (20261125090000): the years in sorted order, waited for at most 5 s with
 * the transaction's own lock_timeout put back after — then 409
 * SCHEDULE_BUSY with a sentence that says why.
 */
export async function lockYearForGrundschemaEdit(
  tx: PrismaClient,
  academicYearIds: string | readonly string[],
): Promise<void> {
  const years = [...new Set(typeof academicYearIds === 'string' ? [academicYearIds] : academicYearIds)];
  if (years.length === 0) return;
  try {
    await tx.$executeRaw`SELECT app.lock_years_for_grundschema_edit(${years}::uuid[])`;
  } catch (error) {
    if (isLockTimeout(error)) throw grundschemaBeingRewritten();
    throw error;
  }
}

/** A hand edit that met a rewrite of the year: what is rewriting it, and what to do. */
export function grundschemaBeingRewritten(): ConflictException {
  return new ConflictException({
    message:
      'Grundschemat skrivs om just nu: ett schemaförslag tillämpas, Generera sparar eller en version återställs. Försök igen om en stund.',
    code: SCHEDULE_BUSY,
  });
}

/**
 * Every master lesson of the year, locked FOR UPDATE until commit, in id
 * order so two lockers meet the rows in the same order. Blocks a hand update
 * or delete of any of them and the KEY SHARE a new MasterLessonGroups or
 * MasterLessonStudents row's foreign key takes, so no lesson can become
 * preserved (or stop being) under the apply. Returns the ids, sorted.
 */
export async function lockYearMasters(tx: PrismaClient, academicYearId: string): Promise<string[]> {
  try {
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id"::text AS "id" FROM "MasterLessons" WHERE "academicYearId" = ${academicYearId}::uuid ORDER BY "id" FOR UPDATE`,
    );
    return (rows ?? []).map((row) => row.id);
  } catch (error) {
    if (isLockTimeout(error)) throw scheduleBusy(SCHEDULE_CANDIDATE_BUSY);
    throw error;
  }
}

export function scheduleBusy(code: string = SCHEDULE_BUSY): ConflictException {
  return new ConflictException({
    message: 'Grundschemat skrivs om av en annan körning just nu. Försök igen om en stund.',
    code,
  });
}

/**
 * A candidate that no longer fits the draft. `changed` names the basis parts
 * that differ (candidate-basis.ts), `refusalCode` the pre-flight refusal the
 * draft now meets (STAFF_UNSTAFFED_REQUIREMENTS, BLOCK_PARTLY_LOCKED_SUMMARY),
 * if any.
 *
 * Both twice: as fields of the body, for the gateway's own callers, and as
 * flat `params`, because the problem filter (http-exception.filter.ts) sends
 * a refusal's code and flat params and nothing else. The web reads the parts
 * from params.changed, comma-joined.
 */
export function scheduleCandidateStale(
  changed: readonly string[],
  refusalCode: string | null = null,
): ConflictException {
  return new ConflictException({
    message: 'Grundschemat har ändrats sedan förslagen togs fram. Uppdatera förslagen och välj igen.',
    code: SCHEDULE_CANDIDATE_STALE,
    changed: [...changed],
    refusalCode,
    params: {
      ...(changed.length > 0 ? { changed: changed.join(',') } : {}),
      ...(refusalCode ? { refusalCode } : {}),
    },
  });
}

export function generateStale(): ConflictException {
  return new ConflictException({
    message:
      'Grundschemat ändrades medan schemat genererades, så resultatet sparades inte. Generera igen.',
    code: GENERATE_STALE,
  });
}
