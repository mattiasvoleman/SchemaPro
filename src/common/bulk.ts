import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { WRITE_CONFLICT, rethrowPrismaError } from './utils/prisma-errors';

/*
 * Massåtgärder: one write over many rows of the administrator's lists
 * (klasser, undervisningsgrupper, elever), in one transaction, under the
 * same rules as the write of one row.
 *
 * ALL OR NOTHING PER CALL. A call writes every row it names or none: when
 * any row is refused, nothing is written and the answer lists each refused
 * row with the single-row route's own sentence and code. The web asks first
 * with `dryRun` (the same work, rolled back), shows what would go, what
 * would not and why, and then sends only the rows that would. So "the rest
 * goes" is the administrator's decision on a list they have read, and what
 * is written is exactly what they confirmed: a row refused only at the real
 * call (somebody changed it meanwhile) writes nothing and is shown again.
 *
 * A 200 WITH THE REPORT, not a 409. The exception filter forwards a
 * problem's detail, code and flat params only (http-exception.filter.ts),
 * which cannot carry a list of rows. `applied` says whether anything was
 * written.
 *
 * THE SAME RULES. Each service reads its rows once and judges them with the
 * single-row route's own checks (shared functions, not copies), then writes
 * them in one statement. When the database refuses that statement — a
 * trigger or a key the checks did not foresee — writeAll tries the rows one
 * by one, each in a savepoint, to say which row it was. One statement in
 * the usual case, rather than a round trip per check per row: 500 pupils
 * cost a handful of statements, not thousands.
 */

/** The most rows one call may name: as InviteUsersDto and SetGroupMembersDto. */
export const BULK_MAX = 500;

/**
 * withRls's timeout for a bulk call. 15 s (withRls's own) is a single row's
 * transaction; a delete of 500 pupils cascades into every row that names
 * them, and a dry run does it twice over with the counts.
 */
export const BULK_TIMEOUT_MS = 60_000;

/** The problem code of a row that is not there, or not the caller's to see. */
export const BULK_ROW_NOT_FOUND = 'BULK_ROW_NOT_FOUND';

/** One row the call would not write, and why. */
export interface BulkRefusal {
  id: string;
  /** The single-row route's problem code, when it has one. */
  code: string | null;
  /** The single-row route's sentence. */
  message: string;
  /** The values the code's sentence is written from, when the route gives them. */
  params?: Record<string, string | number>;
}

/** What a bulk call did, or on a dry run would do. */
export interface BulkResult<Consequences = undefined> {
  /** True when every row was written and committed; false writes nothing. */
  applied: boolean;
  dryRun: boolean;
  /** The rows written, or on a dry run or a refusal, the rows that would be. */
  done: string[];
  refused: BulkRefusal[];
  /** What goes with the rows (a delete's dry run): counts by kind. */
  consequences?: Consequences;
}

/** The body every bulk call shares: the rows, and whether to only ask. */
export class BulkIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX)
  @IsUUID('4', { each: true })
  ids!: string[];

  /** Do the work and roll it back: what would go, what would not, and what goes with it. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** The ids once each, in id order: the order rows are locked and tried in. */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** A row the read did not find: gone since the list was drawn, or another school's. */
export function notFound(id: string): BulkRefusal {
  return {
    id,
    code: BULK_ROW_NOT_FOUND,
    message: 'Raden finns inte längre. Den kan ha tagits bort av någon annan.',
  };
}

/** Throws for a body whose `changes` name nothing. */
export function assertSomeChange(changes: object | undefined): void {
  if (!changes || Object.values(changes).every((value) => value === undefined)) {
    throw new BadRequestException('changes: ange minst ett fält att ändra.');
  }
}

/**
 * A row's refusal from what its check or write threw: the answer the
 * single-row route gives, as one line of the report. Null for what is no
 * refusal of the row — a deadlock (WRITE_CONFLICT, the whole call is to be
 * tried again), a 5xx, anything that is not an HTTP answer at all — which
 * the caller rethrows.
 */
export function refusalOf(id: string, error: unknown): BulkRefusal | null {
  let http: HttpException | null = error instanceof HttpException ? error : null;
  if (!http) {
    try {
      rethrowPrismaError(error);
    } catch (mapped) {
      if (mapped instanceof HttpException) http = mapped;
    }
  }
  if (!http || http.getStatus() >= 500) return null;
  const body = http.getResponse();
  if (typeof body === 'string') return { id, code: null, message: body };
  const record = body as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : null;
  if (code === WRITE_CONFLICT) return null;
  const message =
    typeof record.message === 'string'
      ? record.message
      : Array.isArray(record.message)
        ? record.message.map(String).join(' ')
        : http.message;
  const params = record.params;
  return {
    id,
    // A 404 from the single route carries no code; the report names it.
    code: code ?? (http instanceof NotFoundException ? BULK_ROW_NOT_FOUND : null),
    message,
    ...(code && params && typeof params === 'object' && !Array.isArray(params)
      ? { params: params as Record<string, string | number> }
      : {}),
  };
}

/**
 * Writes `rows` with `whole` (one statement), and when the database refuses
 * that, row by row with `one`, each in a savepoint, to say which row was
 * refused and why. Answers the refusals; empty when everything was written.
 *
 * After a refusal the rows that passed alone ARE written in the
 * transaction, and the caller rolls it back (runBulk does). `rows` is the
 * order to try them one by one: a class before its own half would take the
 * half with it and then not find it, so a caller puts halves first.
 *
 * When every row passes alone but not together, that is no row's refusal
 * and the whole statement's error is rethrown, as the single route would.
 */
export async function writeAll(
  tx: PrismaClient,
  rows: readonly string[],
  whole: (ids: string[]) => Promise<unknown>,
  one: (id: string) => Promise<unknown>,
): Promise<BulkRefusal[]> {
  if (rows.length === 0) return [];
  await tx.$executeRaw`SAVEPOINT bulk_whole`;
  try {
    await whole([...rows]);
    await tx.$executeRaw`RELEASE SAVEPOINT bulk_whole`;
    return [];
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_whole`;
    if (refusalOf('', error) === null) throw error;
    const refused: BulkRefusal[] = [];
    for (const id of rows) {
      await tx.$executeRaw`SAVEPOINT bulk_row`;
      try {
        await one(id);
        await tx.$executeRaw`RELEASE SAVEPOINT bulk_row`;
      } catch (rowError) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_row`;
        const refusal = refusalOf(id, rowError);
        if (!refusal) throw rowError;
        refused.push(refusal);
      }
    }
    if (refused.length === 0) throw error;
    return refused;
  }
}

/** Thrown inside the transaction to roll it back with the report in hand. */
class RollBack<T> extends Error {
  constructor(readonly result: T) {
    super('bulk: rolled back on purpose');
  }
}

/**
 * Runs one bulk call in `transaction` (the service's withRls) and commits it
 * only when it is no dry run and no row was refused. `work` judges and
 * writes the rows and answers what it did; on a dry run or a refusal the
 * transaction is rolled back and the same report comes back with
 * `applied: false`. Anything else `work` throws fails the call as usual.
 */
export async function runBulk<C>(
  transaction: <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T>,
  dryRun: boolean,
  work: (tx: PrismaClient) => Promise<{ done: string[]; refused: BulkRefusal[]; consequences?: C }>,
): Promise<BulkResult<C>> {
  try {
    return await transaction(async (tx) => {
      const report = await work(tx);
      const result: BulkResult<C> = {
        applied: !dryRun && report.refused.length === 0,
        dryRun,
        done: report.done,
        refused: report.refused,
        ...(report.consequences !== undefined ? { consequences: report.consequences } : {}),
      };
      if (!result.applied) throw new RollBack(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RollBack) return error.result as BulkResult<C>;
    throw error;
  }
}
