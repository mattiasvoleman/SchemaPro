import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsObject, IsOptional, IsUUID } from 'class-validator';
import { WRITE_CONFLICT, rethrowPrismaError } from './utils/prisma-errors';

/*
 * Massåtgärder: one write over many rows of the administrator's lists
 * (klasser, undervisningsgrupper, elever), in one transaction, under the
 * same rules as the write of one row.
 *
 * ALL OR NOTHING PER CALL. A call writes every row it names or none: when
 * any row is refused, nothing is written and the answer lists each refused
 * row with the single-row route's own sentence and code. The web asks a
 * delete first with `dryRun`, shows what would go, what would not and why,
 * and then sends only the rows that would. So "the rest goes" is the
 * administrator's decision on a list they have read, and what is written is
 * exactly what they confirmed: a row refused only at the real call
 * (somebody changed it meanwhile, or the database refused what no check
 * foresaw) writes nothing and is shown with its reason, and a delete whose
 * consequences grew since its dry run (removal-inventory.ts, grownSince)
 * deletes nothing either.
 *
 * A DELETE'S DRY RUN DELETES NOTHING. It reads the rows, judges them with
 * the real call's checks and counts what hangs on them, without a row lock
 * and without the delete. The delete itself visits every table with a key
 * to the rows and removes what hangs on them: the pupils' own marks go with
 * them, seconds for 500 pupils over 1.5 million marks. It also scanned
 * AttendanceRecords for recordedById, 74 ms a pupil over that many marks,
 * until that key had an index (20261220090000). Rolled back, a dry run costs
 * what the delete costs and holds the pupils FOR UPDATE for it, and a
 * teacher saving attendance for one of them waits. An update's dry run (no
 * client asks one) is still the write, rolled back.
 *
 * ONE LOCK ORDER (lock-order.ts): the school's people lock, every group
 * row the call writes in id order, then the pupils, as every other write of
 * groups and pupils takes them.
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
 * them. The database's statement_timeout is the same (bulkTransaction): a
 * statement still running when the transaction expires is cancelled and its
 * locks released, rather than run on unseen after the answer.
 */
export const BULK_TIMEOUT_MS = 60_000;

/** A call that ran out of BULK_TIMEOUT_MS. Nothing was written. */
export const BULK_TIMED_OUT = 'BULK_TIMED_OUT';

/**
 * A call whose transaction could not start: every connection of the pool
 * was taken for as long as Prisma waits for one (maxWait). Nothing was
 * written, and fewer rows would not have helped; a moment later may.
 */
export const BULK_BUSY = 'BULK_BUSY';

/**
 * The problem code of a row that is not there, or not the caller's to change
 * (RLS hides it from the write: P2025, which the single route answers 404).
 * The two cannot be told apart, so the sentence names neither cause alone.
 */
export const BULK_ROW_NOT_FOUND = 'BULK_ROW_NOT_FOUND';
/** A row the write would make a second of what may exist once (P2002). */
export const BULK_ROW_TAKEN = 'BULK_ROW_TAKEN';
/** A row the write would point at something that is not there (P2003). */
export const BULK_ROW_REFERENCE_GONE = 'BULK_ROW_REFERENCE_GONE';

const NOT_FOUND_SENTENCE = 'Raden finns inte längre, eller får inte ändras härifrån.';

/**
 * The single routes' generic Prisma answers (rethrowPrismaError), which carry
 * no code and an English sentence for a log. In a report they become a code
 * the web says in the reader's language, and a Swedish sentence for any
 * other client. A refusal with a code or a sentence of its own keeps it.
 */
const GENERIC_ANSWERS: Record<string, { code: string; message: string }> = {
  'The requested record does not exist.': { code: BULK_ROW_NOT_FOUND, message: NOT_FOUND_SENTENCE },
  'A record with these values already exists.': {
    code: BULK_ROW_TAKEN,
    message: 'Raden skulle krocka med en annan rad som redan har samma värden.',
  },
  'The operation references a record that does not exist.': {
    code: BULK_ROW_REFERENCE_GONE,
    message: 'Raden skulle peka på något som inte längre finns.',
  },
};

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
  /**
   * The kinds whose count grew since the dry run the delete confirmed
   * (`expected`): nothing is deleted, and `consequences` has the new counts.
   */
  consequencesGrew?: string[];
}

/** A uuid as the database answers it, lower case: ids are compared as strings here. */
export const lowerCaseIds = Transform(({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((id) => (typeof id === 'string' ? id.toLowerCase() : id)) : value,
);
/** The same for one uuid of a body (a class, a subject). */
export const lowerCaseId = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value,
);

/** The body every bulk call shares: the rows, and whether to only ask. */
export class BulkIdsDto {
  @lowerCaseIds
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX)
  @IsUUID('4', { each: true })
  ids!: string[];

  /**
   * True: do the work and roll it back, saying what would go, what would not,
   * and what goes with it. Required, and a boolean: a null or a missing field
   * that read as "no" would delete for real.
   */
  @IsBoolean()
  dryRun!: boolean;
}

/** A delete's body: the rows, and the counts of the dry run it confirms. */
export class BulkDeleteDto extends BulkIdsDto {
  /**
   * The consequences the dry run answered, sent back with the real delete:
   * a kind whose count has grown since refuses it (consequencesGrew). Counts
   * by kind; a kind not named is not compared.
   */
  @IsOptional()
  @IsObject()
  expected?: Record<string, unknown>;
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
    message: NOT_FOUND_SENTENCE,
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
  const generic = code === null ? GENERIC_ANSWERS[message] : undefined;
  if (generic) return { id, ...generic };
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
 *
 * A WHOLE THAT WROTE FEWER ROWS THAN IT NAMED is tried row by row too. An
 * updateMany or deleteMany passes over a row it does not find: one deleted
 * by another request since the caller read it (a group's rows are read
 * without a lock), or one RLS lets the caller read but not write. The
 * single route answers both with a 404 (P2025), and so does `one` here, so
 * the row is refused by name and nothing is applied, rather than counted as
 * done unwritten. Should every row then pass alone, all of them are written.
 */
export async function writeAll(
  tx: PrismaClient,
  rows: readonly string[],
  whole: (ids: string[]) => Promise<{ count: number }>,
  one: (id: string) => Promise<unknown>,
): Promise<BulkRefusal[]> {
  if (rows.length === 0) return [];
  await tx.$executeRaw`SAVEPOINT bulk_whole`;
  let failure: { error: unknown } | null = null;
  try {
    const written = await whole([...rows]);
    if (written.count === rows.length) {
      await tx.$executeRaw`RELEASE SAVEPOINT bulk_whole`;
      return [];
    }
  } catch (error) {
    failure = { error };
  }
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_whole`;
  if (failure && refusalOf('', failure.error) === null) throw failure.error;
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
  if (refused.length === 0 && failure) throw failure.error;
  return refused;
}

/**
 * A bulk call's transaction: withRls with BULK_TIMEOUT_MS, and the same as
 * the database's statement_timeout. A call that runs out of either (P2028
 * from Prisma, 57014 from the database) is a 409 BULK_TIMED_OUT saying that
 * nothing was written and to try fewer rows at a time, rather than a 500.
 * A call whose transaction never started (P2028 too, for a full pool) is a
 * 503 BULK_BUSY saying to try again in a moment: fewer rows would wait for
 * a connection just as long.
 */
export function bulkTransaction<U>(
  prisma: { withRls<T>(user: U, fn: (tx: PrismaClient) => Promise<T>, options?: { timeoutMs?: number }): Promise<T> },
  user: U,
): <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T> {
  return async (fn) => {
    try {
      return await prisma.withRls(
        user,
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(BULK_TIMEOUT_MS)}, true)`;
          return fn(tx);
        },
        { timeoutMs: BULK_TIMEOUT_MS },
      );
    } catch (error) {
      const out = outOfTime(error);
      if (out === 'never started') throw bulkBusy();
      if (out === 'ran out') throw bulkTimedOut();
      throw error;
    }
  };
}

/**
 * Prisma's message for a transaction that found no connection within
 * maxWait (TransactionManagerError, P2028). Every other P2028 is a
 * transaction that started: expired, or closed by its timeout.
 */
const NEVER_STARTED = 'Unable to start a transaction in the given time';

/**
 * How a call ran out of time, if it did: 'never started' (P2028 with
 * NEVER_STARTED), 'ran out' (any other P2028, Prisma's transaction expired,
 * or 57014, the statement cancelled by statement_timeout), or null.
 */
export function outOfTime(error: unknown): 'never started' | 'ran out' | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === 'P2028') return error.message.includes(NEVER_STARTED) ? 'never started' : 'ran out';
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '57014' ? 'ran out' : null;
}

function bulkTimedOut(): ConflictException {
  return new ConflictException({
    message: `Ändringen tog längre tid än ${BULK_TIMEOUT_MS / 1000} sekunder, så ingenting sparades. Försök med färre rader åt gången.`,
    code: BULK_TIMED_OUT,
    params: { seconds: BULK_TIMEOUT_MS / 1000 },
  });
}

function bulkBusy(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'Servern är upptagen just nu, så ingenting sparades. Försök igen om en stund.',
    code: BULK_BUSY,
  });
}

/** Thrown inside the transaction to roll it back with the report in hand. */
class RollBack<T> extends Error {
  constructor(readonly result: T) {
    super('bulk: rolled back on purpose');
  }
}

/**
 * Runs one bulk call in `transaction` (the service's withRls) and commits it
 * only when it is no dry run, no row was refused and no consequence grew
 * since the dry run the call confirms. `work` judges and
 * writes the rows and answers what it did; on a dry run or a refusal the
 * transaction is rolled back and the same report comes back with
 * `applied: false`. Anything else `work` throws fails the call as usual.
 */
export async function runBulk<C>(
  transaction: <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T>,
  dryRun: boolean,
  work: (
    tx: PrismaClient,
  ) => Promise<{ done: string[]; refused: BulkRefusal[]; consequences?: C; consequencesGrew?: string[] }>,
): Promise<BulkResult<C>> {
  try {
    return await transaction(async (tx) => {
      const report = await work(tx);
      const grew = report.consequencesGrew ?? [];
      const result: BulkResult<C> = {
        applied: !dryRun && report.refused.length === 0 && grew.length === 0,
        dryRun,
        done: report.done,
        refused: report.refused,
        ...(report.consequences !== undefined ? { consequences: report.consequences } : {}),
        ...(grew.length > 0 ? { consequencesGrew: grew } : {}),
      };
      if (!result.applied) throw new RollBack(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RollBack) return error.result as BulkResult<C>;
    throw error;
  }
}
