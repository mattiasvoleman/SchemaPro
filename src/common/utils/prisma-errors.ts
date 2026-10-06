import { ConflictException, NotFoundException } from '@nestjs/common';
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
 */
export function rethrowPrismaError(error: unknown): never {
  const decided = decidedTimplanRefusal(error);
  if (decided) {
    throw decidedTimplanConflict(decided.planName === null ? [] : [decided.planName]);
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
