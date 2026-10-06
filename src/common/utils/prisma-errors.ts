import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Maps well-known Prisma errors to HTTP exceptions. Under RLS a write against
 * a row outside the caller's tenant surfaces as P2025 (record not found),
 * which is exactly the semantics we want to expose.
 *
 * A decided lokal timplan's trigger refusal (SQLSTATE TP409) is mapped here
 * too, to the 409 TIMPLAN_IS_DECIDED the services answer with themselves:
 * every write path that reaches those tables — a subject delete cascading
 * into a decided plan's entries, an entry written while another request
 * decides the plan — then answers the same 409 and never a 500, whichever
 * service it went through. See decidedTimplanRefusal.
 *
 * A deadlock or a serialization failure (P2034; 40P01 / 40001 underneath) is
 * a 409 WRITE_CONFLICT that says to try again, not a 500: the database
 * aborted one of two concurrent writes and nothing was written. And a CHECK
 * on the lokal timplan or tjänstefördelning tables that a DTO bound failed to
 * anticipate is a 400 naming the field, not a 500 — see namedCheckViolation.
 *
 * A duty's slot-link triggers (migration 20261007090000) answer SQLSTATE
 * TD409 — a slot that is not the duty teacher's own weekly UNAVAILABLE time —
 * and TD403 — a teacher writing the slot an uppdrag holds. The first is a 409
 * TEACHER_DUTY_BLOCK_MISMATCH, met by an admin's constraint PATCH that would
 * move a linked slot; the second a 403. See teacherDutyBlockRefusal.
 */
export function rethrowPrismaError(error: unknown): never {
  const decided = decidedTimplanRefusal(error);
  if (decided) {
    throw decidedTimplanConflict(decided.planName === null ? [] : [decided.planName]);
  }
  const dutyBlock = teacherDutyBlockRefusal(error);
  if (dutyBlock) {
    throw teacherDutyBlockException(dutyBlock);
  }
  if (isWriteConflict(error)) {
    throw writeConflict();
  }
  const check = namedCheckViolation(error);
  if (check) {
    throw new BadRequestException(check);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') {
      throw new NotFoundException('The requested record does not exist.');
    }
    if (error.code === 'P2002') {
      throw new ConflictException('A record with these values already exists.');
    }
    if (error.code === 'P2003') {
      throw new ConflictException(
        'The operation references a record that does not exist.',
      );
    }
  }
  throw error;
}

/** The problem `code` every refusal to touch a decided timplan carries. */
export const TIMPLAN_IS_DECIDED = 'TIMPLAN_IS_DECIDED';

/** What the decided-plan triggers (migration 20261006120000) name. */
export interface DecidedTimplanRefusal {
  planId: string | null;
  planName: string | null;
}

interface DriverCause {
  originalCode?: unknown;
  originalMessage?: unknown;
  detail?: unknown;
}

/**
 * Recognises the decided-plan triggers' refusal, and reads which plan.
 *
 * The triggers RAISE with SQLSTATE 'TP409', a class PostgreSQL does not
 * define, a message starting TIMPLAN_IS_DECIDED that names the plan in
 * quotes, and DETAIL localTimplanId=<uuid>. @prisma/adapter-pg maps no Prisma
 * code to an unknown SQLSTATE, so it arrives as P2039 ("Database error") with
 * the driver's own fields under meta.driverAdapterError.cause — measured
 * against PostgreSQL 16 through the real adapter, for a subject delete, a plan
 * UPDATE and an entry INSERT alike. The meta is the primary reading; the
 * rendered message ("Code: `TP409`") is the fallback, so an adapter release
 * that stops carrying the cause degrades to a 409 without the plan's name
 * rather than to a 500.
 */
export function decidedTimplanRefusal(error: unknown): DecidedTimplanRefusal | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const byMeta = cause?.originalCode === 'TP409';
  const byMessage = error.code === 'P2039' && error.message.includes('Code: `TP409`');
  if (!byMeta && !byMessage) return null;

  const text =
    typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  const detail = typeof cause?.detail === 'string' ? cause.detail : '';
  return {
    planName: /lokal timplan "(.*)" är beslutad/.exec(text)?.[1] ?? null,
    planId: /localTimplanId=([0-9a-f-]{36})/i.exec(detail)?.[1] ?? null,
  };
}

/** "A", "A" och "B", "A", "B" och "C" — each name in quotes. */
export function listNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} och ${quoted[quoted.length - 1]}`;
}

/**
 * The 409 for a write that would change a decided plan, naming it when the
 * caller knows which. One sentence for every door — the timplan service's own
 * check, the trigger's refusal arriving through any service — so an admin
 * reads the same thing however they got there.
 */
export function decidedTimplanConflict(planNames: string[]): ConflictException {
  const which =
    planNames.length === 0
      ? 'Den lokala timplanen är beslutad'
      : planNames.length === 1
        ? `Den lokala timplanen ${listNames(planNames)} är beslutad`
        : `De lokala timplanerna ${listNames(planNames)} är beslutade`;
  const reopen =
    planNames.length > 1
      ? 'Öppna dem igen som nya utkast för att göra ändringar.'
      : 'Öppna den igen som ett nytt utkast för att göra ändringar.';
  return new ConflictException({
    message: `${which} och kan inte ändras. ${reopen}`,
    code: TIMPLAN_IS_DECIDED,
  });
}

/** The problem `code` of a write the database aborted for a concurrent one. */
export const WRITE_CONFLICT = 'WRITE_CONFLICT';

/**
 * A deadlock (40P01) or a serialization failure (40001). @prisma/adapter-pg
 * reports both as the TransactionWriteConflict kind, which Prisma surfaces as
 * P2034 — measured for a deadlock between a timplan save and a subject delete
 * in scripts/test/prisma-adapter-probe.ts. The SQLSTATE under a P2039 is the
 * fallback, for an adapter release that stops mapping them.
 */
export function isWriteConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '40P01' || cause?.originalCode === '40001';
}

/** The 409 for a write the database aborted because another one ran at once. */
export function writeConflict(): ConflictException {
  return new ConflictException({
    message:
      'En annan ändring pågick samtidigt, och databasen avbröt den här för att de inte skulle skriva över varandra. ' +
      'Inget sparades. Försök igen.',
    code: WRITE_CONFLICT,
  });
}

/**
 * The lokal timplan CHECKs (migration 20261006120000) and the Fas 2
 * tjänstefördelning CHECKs (20261007090000) by constraint name, as the field
 * and the bound a 400 should state. The DTOs mirror each bound, so this is the
 * second line: a value a DTO counted differently from the column (lengths are
 * code points on both sides now, but the next difference will not announce
 * itself) answers 400 naming the field rather than 500.
 */
const NAMED_CHECKS: Record<string, string> = {
  LocalTimplans_name_is_sane: 'name: timplanen behöver ett namn på högst 100 tecken.',
  LocalTimplans_planningWeeks_is_sane: 'planningWeeks: mellan 20,0 och 40,0 veckor.',
  LocalTimplans_decisionNote_is_sane:
    'decisionNote: beslutet behöver en anteckning på högst 500 tecken som identifierar det.',
  LocalTimplanEntries_gradeLevel_is_sane: 'gradeLevel: årskursen är 0 (förskoleklass) till 10.',
  LocalTimplanEntries_minutesPerWeek_is_sane: 'minutesPerWeek: 0 till 1200 minuter per vecka.',
  LocalTimplanEntries_note_is_sane: 'note: anteckningen kan vara högst 500 tecken.',
  TeachingRequirements_teacher_load_percent_is_sane:
    'teacherLoadPercent: andelen som räknas för läraren är 0 till 200 %.',
  TeachingRequirements_co_teacher_load_percent_is_sane:
    'coTeacherLoadPercent: andelen som räknas för medläraren är 0 till 200 %.',
  TeacherDuties_label_is_sane: 'label: uppdraget behöver ett namn på högst 80 tecken.',
  TeacherDuties_minutesPerWeek_is_sane: 'minutesPerWeek: ett uppdrag är 1 till 2400 minuter per vecka.',
  TeacherDuties_note_is_sane: 'note: anteckningen kan vara högst 500 tecken.',
};

/**
 * The 400 sentence for a CHECK violation (23514) named in NAMED_CHECKS, or
 * null. The adapter maps no Prisma code to 23514, so it arrives as P2039 with
 * the constraint's name in the driver's message.
 */
export function namedCheckViolation(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)
    ?.driverAdapterError?.cause;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  if (cause?.originalCode !== '23514' && !text.includes('violates check constraint')) return null;
  const constraint = /check constraint "([^"]+)"/.exec(text)?.[1];
  return constraint ? (NAMED_CHECKS[constraint] ?? null) : null;
}

/** The problem `code` of a duty slot that is not the duty teacher's own weekly UNAVAILABLE time. */
export const TEACHER_DUTY_BLOCK_MISMATCH = 'TEACHER_DUTY_BLOCK_MISMATCH';
/** The problem `code` of a teacher writing the slot an uppdrag holds. */
export const TEACHER_DUTY_BLOCK_IS_THE_ADMINS = 'TEACHER_DUTY_BLOCK_IS_THE_ADMINS';

/** What the slot-link triggers (migration 20261007090000) report. */
export interface TeacherDutyBlockRefusal {
  sqlState: 'TD409' | 'TD403';
  teacherDutyId: string | null;
  availabilityConstraintId: string | null;
}

/**
 * Recognises the slot-link triggers' refusal. Like TP409 it is a SQLSTATE
 * class PostgreSQL does not define, so the adapter hands it over as P2039 with
 * the driver's fields under meta.driverAdapterError.cause; the rendered
 * message is the fallback. DETAIL carries the two ids, never a person.
 */
export function teacherDutyBlockRefusal(error: unknown): TeacherDutyBlockRefusal | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)
    ?.driverAdapterError?.cause;
  const original = typeof cause?.originalCode === 'string' ? cause.originalCode : null;
  const rendered =
    error.code === 'P2039' ? (/Code: `(TD409|TD403)`/.exec(error.message)?.[1] ?? null) : null;
  const sqlState = original === 'TD409' || original === 'TD403' ? original : rendered;
  if (sqlState !== 'TD409' && sqlState !== 'TD403') return null;
  const detail = typeof cause?.detail === 'string' ? cause.detail : '';
  return {
    sqlState,
    teacherDutyId: /teacherDutyId=([0-9a-f-]{36})/i.exec(detail)?.[1] ?? null,
    availabilityConstraintId: /availabilityConstraintId=([0-9a-f-]{36})/i.exec(detail)?.[1] ?? null,
  };
}

/** The 409 or 403 for a write that would break a duty's slot link. */
export function teacherDutyBlockException(
  refusal: TeacherDutyBlockRefusal,
): ConflictException | ForbiddenException {
  if (refusal.sqlState === 'TD403') {
    return new ForbiddenException({
      message:
        'Tiden är blockerad av ett uppdrag och ändras av en administratör, genom uppdraget.',
      code: TEACHER_DUTY_BLOCK_IS_THE_ADMINS,
    });
  }
  return new ConflictException({
    message:
      'Tiden är blockerad av ett uppdrag och måste förbli en återkommande otillgänglighet för uppdragets egen lärare. ' +
      'Ändra eller ta bort den genom uppdraget.',
    code: TEACHER_DUTY_BLOCK_MISMATCH,
  });
}
