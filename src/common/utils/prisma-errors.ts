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
 *
 * Deleting a lokal timplan that a läsår's årskurs follows is refused by the
 * ON DELETE RESTRICT key of AcademicYearTimplans (migration 20261007130000),
 * and that refusal is a 409 TIMPLAN_IN_USE — the answer the timplan service
 * gives itself when it finds the years first — not the generic "references
 * a record that does not exist", which would be false. See
 * isTimplanInUseRefusal.
 *
 * The läsårsrullning link triggers (migration 20261007150000) answer SQLSTATE
 * LR409 with one of three reason tokens, each a 409 of the same name: a link
 * set, re-pointed or cleared by a writer (ROLLOVER_LINK_IS_FIXED), a group
 * whose predecessor is not in its year's predecessor year
 * (ROLLOVER_LINK_MISMATCH), and a linked group moved to another year
 * (ROLLOVER_GROUP_IS_LINKED) — the last one met by the groups PATCH, which
 * takes academicYearId. See rolloverLinkRefusal.
 */
export function rethrowPrismaError(error: unknown): never {
  const decided = decidedTimplanRefusal(error);
  if (decided) {
    throw decidedTimplanConflict(decided.planName === null ? [] : [decided.planName]);
  }
  if (isTimplanInUseRefusal(error)) {
    throw timplanInUseConflict([]);
  }
  const dutyBlock = teacherDutyBlockRefusal(error);
  if (dutyBlock) {
    throw teacherDutyBlockException(dutyBlock);
  }
  const rolloverLink = rolloverLinkRefusal(error);
  if (rolloverLink) {
    throw rolloverLinkConflict(rolloverLink);
  }
  const enrolmentKey = enrolmentClassKeyRefusal(error);
  if (enrolmentKey === 'CLASS_MOVED') {
    throw studentGroupHasEnrolmentHistory(null);
  }
  if (enrolmentKey === 'NOT_THE_SCHOOLS') {
    throw new BadRequestException('studentGroupId: klassen finns inte i skolan.');
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

/** The problem `code` of a refused delete of a plan some läsår follows. */
export const TIMPLAN_IN_USE = 'TIMPLAN_IN_USE';

/** The key that refuses deleting a plan a (läsår, årskurs) follows. */
const YEAR_TIMPLAN_PLAN_KEY = 'AcademicYearTimplans_localTimplanId_schoolId_fkey';

/**
 * Recognises the ON DELETE RESTRICT refusal of AcademicYearTimplans' plan key
 * (migration 20261007130000): a DELETE on LocalTimplans that a year still
 * points at. @prisma/adapter-pg reports it as P2003 with the constraint under
 * meta.driverAdapterError.cause.constraint.index and the driver's message
 * "update or delete on table "LocalTimplans" violates foreign key constraint
 * …" — measured against PostgreSQL 16 through the real adapter for delete and
 * deleteMany alike.
 *
 * The SAME constraint also refuses the other direction — an attachment
 * INSERTed or UPDATEd to name a plan that does not exist ("insert or update
 * on table "AcademicYearTimplans" …") — and that one is NOT in use: it is the
 * generic P2003. So the side is read off the message, and when the cause is
 * gone, off meta.modelName (the model whose operation failed: LocalTimplan
 * for the delete, AcademicYearTimplan for the write).
 */
export function isTimplanInUseRefusal(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2003') return false;
  const meta = error.meta as
    | { modelName?: unknown; driverAdapterError?: { cause?: DriverCause & { constraint?: { index?: unknown } } } }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const constraint =
    typeof cause?.constraint?.index === 'string'
      ? cause.constraint.index
      : (/constraint: `([^`]+)`/.exec(error.message)?.[1] ?? null);
  if (constraint !== YEAR_TIMPLAN_PLAN_KEY) return false;
  if (typeof cause?.originalMessage === 'string') {
    return cause.originalMessage.startsWith('update or delete on table "LocalTimplans"');
  }
  return meta?.modelName === 'LocalTimplan';
}

/**
 * The 409 for deleting a plan some läsår follows, naming the years when the
 * caller knows them (the service asks first; the key's refusal does not say).
 */
export function timplanInUseConflict(yearNames: string[]): ConflictException {
  const which =
    yearNames.length === 0
      ? 'Den lokala timplanen följs av minst ett läsår'
      : yearNames.length === 1
        ? `Den lokala timplanen följs av läsåret ${listNames(yearNames)}`
        : `Den lokala timplanen följs av läsåren ${listNames(yearNames)}`;
  return new ConflictException({
    message: `${which} och kan inte tas bort. Välj en annan timplan för de årskurserna under läsårets "Timplan per årskurs" först.`,
    code: TIMPLAN_IN_USE,
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
 * The lokal timplan CHECKs (migrations 20261006120000 and 20261007130000),
 * the Fas 2 tjänstefördelning CHECKs (20261007090000) and the lektionslängder
 * CHECK (20261008090000) by constraint name, as the field and the bound a 400 should state. The DTOs mirror each
 * bound, so this is the second line: a value a DTO counted differently from
 * the column (lengths are code points on both sides now, but the next
 * difference will not announce itself) answers 400 naming the field rather
 * than 500.
 */
const NAMED_CHECKS: Record<string, string> = {
  LocalTimplans_name_is_sane: 'name: timplanen behöver ett namn på högst 100 tecken.',
  LocalTimplans_planningWeeks_is_sane: 'planningWeeks: mellan 20,0 och 40,0 veckor.',
  LocalTimplans_decisionNote_is_sane:
    'decisionNote: beslutet behöver en anteckning på högst 500 tecken som identifierar det.',
  LocalTimplanEntries_gradeLevel_is_sane: 'gradeLevel: årskursen är 0 (förskoleklass) till 10.',
  LocalTimplanEntries_minutesPerWeek_is_sane: 'minutesPerWeek: 0 till 1200 minuter per vecka.',
  LocalTimplanEntries_note_is_sane: 'note: anteckningen kan vara högst 500 tecken.',
  AcademicYearTimplans_gradeLevel_is_sane: 'gradeLevel: årskursen är 0 (förskoleklass) till 10.',
  TeachingRequirements_teacher_load_percent_is_sane:
    'teacherLoadPercent: andelen som räknas för läraren är 0 till 200 %.',
  TeachingRequirements_co_teacher_load_percent_is_sane:
    'coTeacherLoadPercent: andelen som räknas för medläraren är 0 till 200 %.',
  TeacherDuties_label_is_sane: 'label: uppdraget behöver ett namn på högst 80 tecken.',
  TeacherDuties_minutesPerWeek_is_sane: 'minutesPerWeek: ett uppdrag är 1 till 2400 minuter per vecka.',
  TeacherDuties_note_is_sane: 'note: anteckningen kan vara högst 500 tecken.',
  TimplanCredits_minutes_is_sane: 'minutes: 1 till 600 minuter för dagen, i hela minuter.',
  TimplanCredits_grade_span_is_whole:
    'minGradeLevel: minGradeLevel och maxGradeLevel anges tillsammans, eller ingen av dem.',
  TimplanCredits_grade_span_is_ordered: 'minGradeLevel: årskurserna är 0 till 12, den lägsta först.',
  TimplanCredits_scope_is_one: 'studentGroupId: beslutet gäller en grupp eller ett årskursspann, inte båda.',
  TimplanCredits_name_is_sane: 'name: beslutet behöver ett namn på högst 80 tecken.',
  TimplanCredits_note_is_sane: 'note: anteckningen kan vara högst 500 tecken, och inte bara blanktecken.',
  TeachingRequirements_lesson_lengths_are_canonical:
    'lessonLengths: en längd per lektion, längsta först, 15–240 minuter i femminuterssteg och ' +
    'två eller tre olika längder — och lessonsPerWeek och minutesPerLesson ska vara antalet och den längsta.',
};

/** TimplanCredits' composite keys (migration 20261009100000) and the field each guards. */
const TIMPLAN_CREDIT_KEYS: Record<string, string> = {
  TimplanCredits_academicYearId_schoolId_fkey: 'academicYearId',
  TimplanCredits_subjectId_schoolId_fkey: 'subjectId',
  TimplanCredits_studentGroupId_schoolId_fkey: 'studentGroupId',
};

/**
 * The body field a TimplanCredits key refused (23503 on an INSERT or UPDATE of
 * a credit), or null. Read like isTimplanInUseRefusal: the constraint from the
 * driver's cause, else from the rendered message. Only the write side — none
 * of these keys is referenced FROM another table, so a delete never meets one.
 */
export function timplanCreditKeyField(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') return null;
  const cause = (
    error.meta as { driverAdapterError?: { cause?: DriverCause & { constraint?: { index?: unknown } } } } | undefined
  )?.driverAdapterError?.cause;
  const constraint =
    typeof cause?.constraint?.index === 'string'
      ? cause.constraint.index
      : (/constraint: `([^`]+)`/.exec(error.message)?.[1] ??
        /foreign key constraint "([^"]+)"/.exec(typeof cause?.originalMessage === 'string' ? cause.originalMessage : '')?.[1] ??
        null);
  return constraint ? (TIMPLAN_CREDIT_KEYS[constraint] ?? null) : null;
}

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

/** The reason tokens the läsårsrullning link triggers (migration 20261007150000) raise, each a 409 code. */
export const ROLLOVER_LINK_IS_FIXED = 'ROLLOVER_LINK_IS_FIXED';
export const ROLLOVER_LINK_MISMATCH = 'ROLLOVER_LINK_MISMATCH';
export const ROLLOVER_GROUP_IS_LINKED = 'ROLLOVER_GROUP_IS_LINKED';

export type RolloverLinkReason =
  | typeof ROLLOVER_LINK_IS_FIXED
  | typeof ROLLOVER_LINK_MISMATCH
  | typeof ROLLOVER_GROUP_IS_LINKED;

/** What the link triggers report: the reason, and the written row's own id. */
export interface RolloverLinkRefusal {
  reason: RolloverLinkReason;
  academicYearId: string | null;
  studentGroupId: string | null;
}

const ROLLOVER_REASON = /\b(ROLLOVER_LINK_IS_FIXED|ROLLOVER_LINK_MISMATCH|ROLLOVER_GROUP_IS_LINKED)\b/;

/**
 * Recognises the link triggers' refusal. LR409, like TP409 and TD409, is a
 * SQLSTATE class PostgreSQL does not define, so the adapter hands it over as
 * P2039 with the driver's fields under meta.driverAdapterError.cause; the
 * rendered message ("Code: `LR409`. Message: `ROLLOVER_…`") is the fallback
 * for both the code and the reason. An LR409 whose reason cannot be read is
 * still a 409, under ROLLOVER_LINK_IS_FIXED: all three say that a written
 * link stays as written. DETAIL carries the written row's own id only.
 */
export function rolloverLinkRefusal(error: unknown): RolloverLinkRefusal | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)
    ?.driverAdapterError?.cause;
  const byMeta = cause?.originalCode === 'LR409';
  const byMessage = error.code === 'P2039' && error.message.includes('Code: `LR409`');
  if (!byMeta && !byMessage) return null;
  const text =
    typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  const reason = (ROLLOVER_REASON.exec(text)?.[1] ?? ROLLOVER_LINK_IS_FIXED) as RolloverLinkReason;
  const detail = typeof cause?.detail === 'string' ? cause.detail : '';
  return {
    reason,
    academicYearId: /academicYearId=([0-9a-f-]{36})/i.exec(detail)?.[1] ?? null,
    studentGroupId: /studentGroupId=([0-9a-f-]{36})/i.exec(detail)?.[1] ?? null,
  };
}

const ROLLOVER_LINK_MESSAGES: Record<RolloverLinkReason, string> = {
  ROLLOVER_LINK_IS_FIXED:
    'Kopplingen till förra läsårets läsår eller grupp sätts när läsåret rullas vidare och kan inte ändras i efterhand.',
  ROLLOVER_LINK_MISMATCH:
    'En grupps föregångare måste ligga i läsåret före gruppens eget läsår, i samma skola.',
  ROLLOVER_GROUP_IS_LINKED:
    'Gruppen är kopplad till en grupp i förra eller nästa läsår och kan inte flyttas till ett annat läsår.',
};

/** The 409 for a write the link triggers refused, coded by its reason. */
export function rolloverLinkConflict(refusal: Pick<RolloverLinkRefusal, 'reason'>): ConflictException {
  return new ConflictException({
    message: ROLLOVER_LINK_MESSAGES[refusal.reason],
    code: refusal.reason,
  });
}

/** The problem `code` of a class with pupils' history moved to another läsår. */
export const STUDENT_GROUP_HAS_ENROLMENT_HISTORY = 'STUDENT_GROUP_HAS_ENROLMENT_HISTORY';

/**
 * The 409 for moving a class that has class history (StudentEnrollments,
 * migration 20261010120000) to another läsår. The history's class key is ON
 * UPDATE NO ACTION, because a cascade would carry the segments into the other
 * year while their dates stayed in the first; StudentGroupsService.update asks
 * first and names the year, and the key's refusal of a race lands here without
 * it.
 */
export function studentGroupHasEnrolmentHistory(yearName: string | null): ConflictException {
  return new ConflictException({
    message:
      `Klassen har elevhistorik${yearName ? ` i läsåret ${yearName}` : ''}. ` +
      'Flytta eleverna till en klass i rätt läsår; en flytt samma dag som de placerades lämnar ingen historik.',
    code: STUDENT_GROUP_HAS_ENROLMENT_HISTORY,
    params: yearName ? { year: yearName } : {},
  });
}

/** The class key of a segment of class history (migration 20261010120000). */
const ENROLMENT_CLASS_KEY = 'StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey';
/**
 * Its year key. A segment the trigger opens carries the pupil's school and the
 * class's year, so another school's class fails here first — measured through
 * the real adapter: "insert or update on table "StudentEnrollments" violates
 * foreign key constraint "StudentEnrollments_academicYearId_schoolId_fkey"".
 */
const ENROLMENT_YEAR_KEY = 'StudentEnrollments_academicYearId_schoolId_fkey';

/**
 * Users' own class key. The class-history trigger refuses another school's
 * class in this key's exact words (migration 20261010120000), so a class id
 * of another school and one that exists nowhere are one refusal — and one
 * answer here, the 400 naming the field.
 */
const USERS_CLASS_KEY = 'Users_studentGroupId_fkey';

/**
 * Which side of the class-history key refused (23503), or null.
 *
 * 'NOT_THE_SCHOOLS': a pupil's class was written as a group that is not a
 * class of the pupil's school — none at all, or another school's
 * (Users."studentGroupId" references the group's id alone, and the history
 * trigger refuses it in the same words) — "insert or update on table
 * "Users"", or a segment the history could not name, "insert or update on
 * table "StudentEnrollments"". 'CLASS_MOVED': a class with segments moved to
 * another year, "update or delete on table "StudentGroups"". Read like
 * isTimplanInUseRefusal: the constraint from the driver's cause, else from
 * the rendered message; the side from the driver's message, else from the
 * model whose operation failed.
 */
export function enrolmentClassKeyRefusal(error: unknown): 'NOT_THE_SCHOOLS' | 'CLASS_MOVED' | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') return null;
  const meta = error.meta as
    | { modelName?: unknown; driverAdapterError?: { cause?: DriverCause & { constraint?: { index?: unknown } } } }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : '';
  const constraint =
    typeof cause?.constraint?.index === 'string'
      ? cause.constraint.index
      : (/constraint: `([^`]+)`/.exec(error.message)?.[1] ?? /foreign key constraint "([^"]+)"/.exec(message)?.[1] ?? null);
  if (constraint === USERS_CLASS_KEY) {
    const written = message
      ? message.startsWith('insert or update on table "Users"')
      : meta?.modelName === 'User';
    return written ? 'NOT_THE_SCHOOLS' : null;
  }
  if (constraint !== ENROLMENT_CLASS_KEY && constraint !== ENROLMENT_YEAR_KEY) return null;
  const moved = message
    ? message.startsWith('update or delete on table "StudentGroups"')
    : meta?.modelName === 'StudentGroup';
  if (moved) return constraint === ENROLMENT_CLASS_KEY ? 'CLASS_MOVED' : null;
  // Only the trigger writes a segment, so a refused write is a class it
  // cannot record — never a delete of a year, which cascades.
  return message === '' || message.startsWith('insert or update on table "StudentEnrollments"') ? 'NOT_THE_SCHOOLS' : null;
}
