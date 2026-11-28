import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ANALYSIS_LEASE_SECONDS } from './suggestions';

/*
 * THE ANALYSIS AS A THIRD SOLVE STREAM OF THE YEAR (omgång 13, G6, part 2).
 *
 * The analysis of a refused run (suggestions.service.ts) puts the engine's cores to work for up to a minute and a half, exactly as a
 * Generera and a schemaförslag run do, and the design (D2) says it never runs beside either for the year. Its own start refuses to begin
 * beside them. This file is the other half: Generera's start and a schemaförslag run's start refuse to begin beside a live analysis, under
 * the same year start lock (regeneration-lock.ts lockYearForSolveStart) that the analysis's claim now takes too, so that two starts that
 * meet are not both let through.
 */

/** 409: an analysis of the year is going; the engine's cores are its. */
export const SUGGESTIONS_RUNNING = 'SUGGESTIONS_RUNNING';

/**
 * A RUNNING analysis that carries no lease (one an API from before the lease wrote, still in the column when the new one starts) is
 * alive when it began less than this long ago. It waits for the engine at most SUGGEST_WAIT_MS (200 s) after its fetch; longer than this
 * is a process that went away (a deploy of the API happens at every merge), and holds nobody off. A READ gives it up only after
 * STALE_AFTER_MS (suggestions.ts, six minutes), which is longer on purpose: a start must not stay refused for the whole of that for an
 * analysis nobody is running. One with a lease is alive until its lease ends (suggestions.ts ANALYSIS_LEASE_SECONDS).
 */
export const ANALYSIS_ALIVE_SECONDS = 240;

/** The text an analysis's times are stored as (an ISO-8601 time in UTC), as to_char writes it: JavaScript's toISOString. */
const ISO_TEXT = Prisma.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
/**
 * What a lease looks like in the column: the time the service writes, to the millisecond. Anything else is no lease and the old rule judges
 * the analysis (the sweep of 20270313090000 reads it the same way). Not a cast: a value nobody wrote through the service cannot fail a start.
 */
const LEASE_SHAPE = Prisma.raw(String.raw`'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'`);

/**
 * SQL for "the column's analysis still holds its place", for a row that is RUNNING: its lease has not ended, or, with no lease, it
 * began less than `legacySeconds` ago. The times are compared as the text they are stored as (an ISO-8601 time in UTC sorts as time
 * does), so that a value nobody wrote through the service can never make a start fail on a cast.
 */
export function analysisHoldsSql(legacySeconds: number): Prisma.Sql {
  return Prisma.sql`(CASE WHEN "suggestions"->>'leaseUntil' ~ ${LEASE_SHAPE}
                          THEN ("suggestions"->>'leaseUntil') COLLATE "C" >= to_char(now() AT TIME ZONE 'UTC', ${ISO_TEXT})
                          ELSE ("suggestions"->>'startedAt') COLLATE "C"
                               >= to_char((now() - make_interval(secs => ${legacySeconds})) AT TIME ZONE 'UTC', ${ISO_TEXT})
                     END)`;
}

/** SQL for the end of a lease taken now: the database's clock plus ANALYSIS_LEASE_SECONDS, as the text an analysis's times are. */
export function leaseEndSql(): Prisma.Sql {
  return Prisma.sql`to_char((now() + make_interval(secs => ${ANALYSIS_LEASE_SECONDS})) AT TIME ZONE 'UTC', ${ISO_TEXT})`;
}

/**
 * Whether the year has an analysis that is RUNNING and holds its place, under the caller's RLS.
 */
export async function yearHasRunningSuggestions(tx: PrismaClient, academicYearId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ active: number }[]>(
    Prisma.sql`SELECT count(*)::integer AS "active" FROM "OptimizationJobs"
                WHERE "academicYearId" = ${academicYearId}::uuid
                  AND "suggestions"->>'state' = 'RUNNING'
                  AND ${analysisHoldsSql(ANALYSIS_ALIVE_SECONDS)}`,
  );
  return Number(rows?.[0]?.active ?? 0) > 0;
}

/** Generera's and a schemaförslag run's refusal while an analysis holds the year. */
export function suggestionsRunning(): ConflictException {
  return new ConflictException({
    message: 'Förslag på vad som ska ändras tas fram för läsåret just nu. Försök igen när de är klara.',
    code: SUGGESTIONS_RUNNING,
  });
}
