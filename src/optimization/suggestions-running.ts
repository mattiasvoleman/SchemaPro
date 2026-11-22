import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

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
 * An analysis that began less than this long ago is alive. It waits for the engine at most SUGGEST_WAIT_MS (200 s) after its fetch;
 * longer than this is a process that went away (a deploy of the API happens at every merge), and holds nobody off. A READ gives the
 * analysis up only after STALE_AFTER_MS (suggestions.ts, six minutes), which is longer on purpose: a start must not stay refused for
 * the whole of that for an analysis nobody is running.
 */
export const ANALYSIS_ALIVE_SECONDS = 240;

/**
 * Whether the year has an analysis that is RUNNING and alive, under the caller's RLS. The start time is compared as the text it is stored
 * as (an ISO-8601 time in UTC sorts as time does), so that a value nobody wrote through the service can never make a Generera start fail
 * on a cast.
 */
export async function yearHasRunningSuggestions(tx: PrismaClient, academicYearId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ active: number }[]>(
    Prisma.sql`SELECT count(*)::integer AS "active" FROM "OptimizationJobs"
                WHERE "academicYearId" = ${academicYearId}::uuid
                  AND "suggestions"->>'state' = 'RUNNING'
                  AND ("suggestions"->>'startedAt') COLLATE "C"
                      >= to_char((now() - make_interval(secs => ${ANALYSIS_ALIVE_SECONDS})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
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
