import type { PublishMode, StartCandidatesRequest } from "../../../lib/candidates/types";
import { Reply, route, type GatewayRoute } from "../gateway-routes";
import {
  CANDIDATE_LESSONS,
  checkOf,
  overviewOf,
  RUNS,
  SAFETY_VERSION_ID,
  SCENARIOS,
  STARTED_RUN_ID,
} from "./candidates";
import { NEXT_YEAR, YEAR } from "./world";

/**
 * Schemaförslag's paths on OptimizationController (design §3), answered from
 * candidates.ts. The reads answer the state a spec names in the
 * x-stub-scenario header, or yesterday's batch when it names none. The three
 * writes answer as the gateway does and keep nothing, as the stub's
 * PostgREST writes keep nothing: a start is 202 with a run that never
 * appears, an apply is the outcome the toast names, a discard is 204. Their
 * refusals are the gateway's own codes, so a page that sends the wrong body
 * (the mode the dialog was not opened in, a refresh of a batch that is not
 * the year's) meets the refusal it would meet in production.
 */

const TITLES = { 404: "Not Found", 409: "Conflict" } as const;

/**
 * A refusal as the gateway's HttpExceptionFilter sends it (problem+json):
 * the thrower's sentence, its code, and its params when they are a flat map
 * of names to strings and numbers. Whatever else a thrower puts in its body
 * is dropped there, so it is not sent here either.
 */
const refusal = (status: 404 | 409, code: string | null, detail: string, params?: Record<string, string | number>) =>
  new Reply(status, {
    type: "about:blank",
    title: TITLES[status],
    status,
    detail,
    ...(code ? { code } : {}),
    ...(code && params ? { params } : {}),
  });
const candidateGone = () => refusal(404, "CANDIDATE_GONE", "Förslaget finns inte längre.");
const noYear = () => refusal(404, null, "Läsåret finns inte.");

/** This year has the candidates; next year has never been generated, so it has none and no draft to start from. */
const yearOf = (id: string | null | undefined) => (id === YEAR.id ? YEAR : id === NEXT_YEAR.id ? NEXT_YEAR : null);

const runOf = (runId: string | undefined) => RUNS.find((entry) => entry.run.id === runId) ?? null;
const candidateOf = (candidateId: string | undefined) => {
  for (const entry of RUNS) {
    const candidate = entry.candidates.find((row) => row.id === candidateId);
    if (candidate) return { run: entry.run, candidate };
  }
  return null;
};

/** The mode /check reports and the apply holds the dialog to (PUBLICATION_SETTINGS says DRAFT). */
const modeOf = (scenario: string | null): PublishMode => (scenario === SCENARIOS.direct ? "DIRECT" : "DRAFT");

export const candidateRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/optimization/candidates", ({ query, scenario }) => {
    const year = yearOf(query.get("academicYearId"));
    if (!year) return noYear();
    return year.id === YEAR.id ? overviewOf(scenario) : { latest: null, batch: null, unplaced: null };
  }),

  route("POST", "/api/v1/optimization/candidates", ({ body, scenario }) => {
    const request = body as StartCandidatesRequest;
    const year = yearOf(request.academicYearId);
    if (!year) return noYear();
    if (scenario === SCENARIOS.running) {
      return refusal(409, "CANDIDATES_RUNNING", "Schemaförslag tas fram för läsåret just nu. Försök igen när de är klara.");
    }
    if (year.id !== YEAR.id) {
      return refusal(409, "CANDIDATES_NEED_A_DRAFT", "Generera ett första schema, sedan kan du ta fram förslag utifrån det.");
    }
    // A refresh mirrors the year's newest batch; the failed state has none.
    const batch = overviewOf(scenario).batch;
    if (request.refreshOf !== undefined && request.refreshOf !== batch?.run.id) {
      return refusal(404, "REFRESH_GONE", "Förslagen som skulle uppdateras finns inte längre.");
    }
    return new Reply(202, { runId: STARTED_RUN_ID });
  }),

  route("DELETE", "/api/v1/optimization/candidates", ({ query }) => (yearOf(query.get("academicYearId")) ? undefined : noYear())),

  route("GET", "/api/v1/optimization/candidates/runs/:runId/check", ({ params, scenario }) =>
    runOf(params.runId) ? checkOf(scenario) : candidateGone(),
  ),

  route("GET", "/api/v1/optimization/candidates/:id/lessons", ({ params }) => CANDIDATE_LESSONS.get(params.id!) ?? candidateGone()),

  // ScheduleCandidatesService.apply's refusals in its own order: gone, the mode, the run and candidate, the basis.
  route("POST", "/api/v1/optimization/candidates/:id/apply", ({ params, body, scenario }) => {
    const found = candidateOf(params.id);
    if (!found) return candidateGone();
    const { expectedMode } = (body ?? {}) as { expectedMode?: PublishMode };
    if (expectedMode !== modeOf(scenario)) {
      return refusal(409, "PUBLISH_MODE_CHANGED", "Skolans publiceringsläge har ändrats sedan förslaget öppnades.", {
        mode: modeOf(scenario),
      });
    }
    const applicable = found.candidate.solverStatus === "OPTIMAL" || found.candidate.solverStatus === "FEASIBLE";
    if (found.run.status !== "SUCCEEDED" || !applicable) {
      return refusal(
        409,
        "SCHEDULE_CANDIDATE_NOT_APPLICABLE",
        "Förslaget går inte att tillämpa: körningen är inte klar, eller förslaget fick inget schema.",
      );
    }
    if (checkOf(scenario).stale) {
      // regeneration-lock.ts puts the changed parts beside the code, where
      // the filter drops them, so the page hears the code alone.
      return refusal(409, "SCHEDULE_CANDIDATE_STALE", "Grundschemat har ändrats sedan förslagen togs fram. Uppdatera förslagen och välj igen.");
    }
    return { lessonsCreated: CANDIDATE_LESSONS.get(found.candidate.id)!.length, versionId: SAFETY_VERSION_ID };
  }),
];
