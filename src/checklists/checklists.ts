import { HttpException, HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { profileWrites } from '../auth/admin-areas';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Checklistor (F5): the numbers and the codes of the instruction proofs and the consent lists. The rules are the
 * database's (migration 20270129091000): who may tick whom is app.checklist_taught_ids and app.ack_mentee_ids, what
 * a template or a list may hold is the tables' checks, and who gave a consent is the latest answer on the list
 * (consent-state.ts is the one place that says what that means).
 */

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
/** A proof's note. */
export const PROOF_NOTE_MAX = 500;
/** An answer's note, and who gave it. */
export const ENTRY_NOTE_MAX = 300;
export const GIVEN_BY_MAX = 120;
export const REASON_MAX = 300;
/**
 * The text of a list. The database holds 2 000, and the request to the guardians is the text and one sentence
 * more (CONSENT_FOOTER), which has to fit the request's own 2 000.
 */
export const LIST_BODY_MAX = 1700;
/** Pupils in one tick, one answer or one ask. */
export const TICK_MAX = 300;
export const ASK_MAX = 2000;

/** What the guardian reads under the list's text: that a confirmation is the consent, and that it can be taken back. */
export const CONSENT_FOOTER =
  'Genom att bekräfta ger du ditt samtycke. Du kan ta tillbaka det när som helst genom att kontakta skolan.';
export const CONSENT_TITLE_PREFIX = 'Samtycke: ';

export const CHECKLIST_NOT_FOUND = 'CHECKLIST_NOT_FOUND';
export const CHECKLIST_NOT_STAFF = 'CHECKLIST_NOT_STAFF';
export const CHECKLIST_NOT_YOUR_PUPIL = 'CHECKLIST_NOT_YOUR_PUPIL';
export const CHECKLIST_UNKNOWN_PUPIL = 'CHECKLIST_UNKNOWN_PUPIL';
export const CHECKLIST_TEMPLATE_RETIRED = 'CHECKLIST_TEMPLATE_RETIRED';
export const CHECKLIST_TEMPLATE_EXISTS = 'CHECKLIST_TEMPLATE_EXISTS';
export const CHECKLIST_UNKNOWN_SUBJECT = 'CHECKLIST_UNKNOWN_SUBJECT';
export const CHECKLIST_DATE_IN_THE_FUTURE = 'CHECKLIST_DATE_IN_THE_FUTURE';
/** A day that does not exist (30 February). */
export const CHECKLIST_DATE_INVALID = 'CHECKLIST_DATE_INVALID';
export const CONSENT_ASK_NEEDS_ALL = 'CONSENT_ASK_NEEDS_ALL';
export const CONSENT_ASK_ALREADY_ANSWERED = 'CONSENT_ASK_ALREADY_ANSWERED';
export const CHECKLIST_INSTRUCTOR_IS_NOT_STAFF = 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF';
export const CHECKLIST_REASON_NEEDED = 'CHECKLIST_REASON_NEEDED';
export const CONSENT_LIST_CLOSED = 'CONSENT_LIST_CLOSED';
export const CONSENT_LIST_EXISTS = 'CONSENT_LIST_EXISTS';
export const CONSENT_NOT_A_CLASS = 'CONSENT_NOT_A_CLASS';
/** A teacher makes a list for a class they have no mentee in (403). */
export const CONSENT_NOT_YOUR_CLASS = 'CONSENT_NOT_YOUR_CLASS';
export const CONSENT_NOBODY_TO_ASK = 'CONSENT_NOBODY_TO_ASK';
export const CONSENT_KVITTENS_OFF = 'ACK_DISABLED';

/**
 * The SQLSTATE a function, trigger or constraint raised, as the adapter reports it: a raw refusal is P2010 with the
 * code in driverAdapterError.cause, and a model query that a trigger refuses reports the code in its message.
 */
export function sqlStateOf(error: unknown): string | null {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  const message = error instanceof Error ? error.message : '';
  return /Code: `([0-9A-Z]{5})`/.exec(message)?.[1] ?? /\b(CL4(?:03|04|09|22))\b/.exec(message)?.[1] ?? null;
}

/** The name the database gave a refusal (CHECKLIST_NOT_A_PUPIL, CONSENT_LIST_CLOSED ...), when the message carries it. */
export function refusalName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  return /\b((?:CHECKLIST|CONSENT)_[A-Z_]+)\b/.exec(message)?.[1] ?? null;
}

const MESSAGES: Readonly<Record<string, string>> = {
  [CHECKLIST_NOT_FOUND]: 'Det finns inte, eller är inte ditt att se.',
  [CHECKLIST_NOT_STAFF]: 'Bara personal kan göra det.',
  [CHECKLIST_NOT_YOUR_PUPIL]: 'Du kan bara bocka av elever i dina egna grupper och lektioner, och skriva samtycken för dina mentorselever.',
  [CHECKLIST_UNKNOWN_PUPIL]: 'En av eleverna finns inte i skolan, eller har slutat.',
  [CHECKLIST_TEMPLATE_RETIRED]: 'Mallen är avvecklad. Ta fram den igen för att bocka av i den.',
  [CHECKLIST_TEMPLATE_EXISTS]: 'Det momentet finns redan i det ämnet.',
  [CHECKLIST_UNKNOWN_SUBJECT]: 'Ämnet finns inte i skolan.',
  [CHECKLIST_DATE_IN_THE_FUTURE]: 'Datumet har inte kommit.',
  [CHECKLIST_DATE_INVALID]: 'Datumet finns inte.',
  [CONSENT_ASK_NEEDS_ALL]: 'Förfrågan till vårdnadshavarna måste kräva att alla bekräftar.',
  [CONSENT_ASK_ALREADY_ANSWERED]: 'Förfrågan har redan bekräftats av en vårdnadshavare och gäller något annat.',
  [CHECKLIST_INSTRUCTOR_IS_NOT_STAFF]: 'Den som gav instruktionen måste vara personal vid skolan.',
  [CHECKLIST_REASON_NEEDED]: 'Skriv varför bocken upphävs (högst 300 tecken).',
  [CONSENT_LIST_CLOSED]: 'Listan är avslutad. Det går inte att skriva mer i den.',
  [CONSENT_LIST_EXISTS]: 'Klassen har redan en öppen lista med det namnet.',
  [CONSENT_NOT_A_CLASS]: 'Klassen finns inte i skolan.',
  [CONSENT_NOT_YOUR_CLASS]: 'Du kan bara göra samtyckeslistor för klasser du är mentor för.',
  [CONSENT_NOBODY_TO_ASK]: 'Det finns ingen att fråga: ingen av eleverna har en vårdnadshavare, eller så saknar ingen samtycke.',
};

export function messageOf(code: string): string {
  return MESSAGES[code] ?? code;
}

/** A refusal the database raised, as the HTTP answer it is; null for anything that is not one of ours. */
export function translateRefusal(error: unknown): HttpException | null {
  const state = sqlStateOf(error);
  const name = refusalName(error);
  switch (state) {
    case 'CL403':
      return new HttpException({ code: CHECKLIST_NOT_STAFF, message: messageOf(CHECKLIST_NOT_STAFF) }, HttpStatus.FORBIDDEN);
    case 'CL404':
      return new HttpException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) }, HttpStatus.NOT_FOUND);
    case 'CL409': {
      const code = name === CONSENT_LIST_CLOSED ? CONSENT_LIST_CLOSED : CHECKLIST_TEMPLATE_RETIRED;
      return new HttpException({ code, message: messageOf(code) }, HttpStatus.CONFLICT);
    }
    case 'CL422': {
      const code = name && MESSAGES[name] ? name : CHECKLIST_UNKNOWN_PUPIL;
      return new HttpException({ code, message: messageOf(code) }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    default:
      return null;
  }
}

/**
 * Whether an administrator writes here: every profile that writes Drift does, the läsare does not. A login whose profile
 * the request does not carry is taken as one that does (the database asks for itself either way; this only decides
 * which buttons the screen offers).
 */
export function adminWrites(user: AuthenticatedUser): boolean {
  return user.role === Role.SCHOOL_ADMIN && (user.adminProfile === undefined || profileWrites(user.adminProfile, 'DRIFT'));
}

/**
 * The pupils among `ids` whom the school has marked as having a protected identity: the ones a sheet for paper leaves out (and
 * counts). Asked of the database (app.checklist_protected_ids), since the register of the marks is the administrators' to read and
 * a teacher prints a list too. The ids are never sent on.
 */
export async function protectedAmong(tx: PrismaClient, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [row] = await tx.$queryRaw<Array<{ ids: string[] | null }>>`SELECT app.checklist_protected_ids(${[...ids]}::uuid[]) AS "ids"`;
  return new Set(row?.ids ?? []);
}

/**
 * The staff of the school whom it has marked as having a protected identity, for a teacher or an administrator
 * (app.school_day_protected_staff, Skolans dag's rule): a list of the whole staff leaves them out for a teacher.
 */
export async function protectedStaff(tx: PrismaClient): Promise<Set<string>> {
  const rows = (await tx.$queryRaw<Array<{ id: string }>>`SELECT app.school_day_protected_staff() AS "id"`) ?? [];
  return new Set(rows.map((row) => row.id));
}

/** May the caller void a tick: the one who wrote it, or an administrator who writes Drift (app.checklist_void_proof says the same). */
export function canVoidProof(user: AuthenticatedUser, recordedById: string | null): boolean {
  if (user.role === Role.SCHOOL_ADMIN) return adminWrites(user);
  return user.role === Role.TEACHER && recordedById !== null && recordedById === user.userId;
}
