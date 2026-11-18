/*
 * THE ENGINE'S TIMES, AS THE API READS THEM (M1, Tidskedjan).
 *
 * Until the 2026-11-17 incident the chain of times a generation passes through
 * was set by hand in two Railway services: the engine's budget and probe
 * (SOLVER_MAX_TIME_SECONDS, SOLVER_PROBE_SECONDS) and the API's wait
 * (AI_ENGINE_TIMEOUT_MS), with a paragraph of docs/DEPLOYMENT.md holding them
 * together. The API's candidate calls also carried a 20 s probe of their own
 * (PROBE_SECONDS), which stayed true only as long as nobody changed the
 * engine's. Now the engine says its times (GET /api/v1/timing) and the API
 * reads them: the wait is counted from what the engine says, and the
 * configuration that disagrees is named.
 *
 * Everything here is a pure function of what the engine said, or of nothing:
 * the reading itself (HTTP, the cache, the boot check) is EngineTimingService.
 * An engine older than the route says nothing (a 404), and then every number
 * falls back on the one this gateway always used.
 */

/** The four routes of the engine the API calls, by the last segment of the path. */
export type EngineRoute = 'optimize' | 'optimize-rooms' | 'staff' | 'plan-exams';

export interface RouteTiming {
  budgetSeconds: number;
  /** What the route spends after its budget; zero for every route but the generator. */
  probeSeconds: number;
  headroomSeconds: number;
  /** Budget, probe and headroom: after it the route answers 503 (SOLVER_TIMEOUT). */
  ceilingSeconds: number;
}

export interface EngineTiming {
  version: number;
  /** What this engine can be sent that an older one refuses ("deadlineSeconds"). */
  capabilities: string[];
  /** Between the API's sending a request and the engine route's taking it. */
  transferMarginSeconds: number;
  routes: Partial<Record<EngineRoute, RouteTiming>>;
}

/** The engine's build headroom, before it said anything: what this gateway always assumed. */
export const LEGACY_HEADROOM_SECONDS = 30;
/** The engine's timeout probe, before it said anything (SOLVER_PROBE_SECONDS' default). */
export const LEGACY_PROBE_SECONDS = 20;
/**
 * What a candidate call waits beyond the engine's headroom: the transfer, and the
 * gateway's own margin. The engine's 30 s and this make the 45 s a candidate call
 * always waited beyond its budget.
 */
export const CALL_MARGIN_SECONDS = 15;
/** What a wait derived from the engine's ceiling has beyond it. The engine answers first. */
export const WAIT_MARGIN_SECONDS = 10;
/** The API's wait when AI_ENGINE_TIMEOUT_MS is unset and the engine has said nothing. */
export const FALLBACK_WAIT_MS = 120_000;
/** The engine's `transferMarginSeconds` before it said anything. */
export const LEGACY_TRANSFER_MARGIN_SECONDS = 5;
/** The engine takes a deadline of at most an hour (OptimizeScheduleRequest.deadlineSeconds). */
export const MAX_DEADLINE_SECONDS = 3600;

/** The route a path on the engine belongs to; null for a path the engine does not time. */
export function routeOf(path: string): EngineRoute | null {
  // `/v1/schedule` is the generator's legacy path: the same solve as /api/v1/optimize.
  if (path === '/v1/schedule' || path === '/api/v1/optimize') return 'optimize';
  if (path === '/api/v1/optimize-rooms') return 'optimize-rooms';
  if (path === '/api/v1/staff') return 'staff';
  if (path === '/api/v1/plan-exams') return 'plan-exams';
  return null;
}

const ROUTES: readonly EngineRoute[] = ['optimize', 'optimize-rooms', 'staff', 'plan-exams'];

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * What GET /api/v1/timing answered, or null when it is not a body this gateway
 * understands (a proxy's HTML, an engine of another version). Null is "older
 * engine", never an error: nothing depends on the engine saying it.
 */
export function parseEngineTiming(body: unknown): EngineTiming | null {
  if (typeof body !== 'object' || body === null) return null;
  const shape = body as Record<string, unknown>;
  const version = finiteNumber(shape.version);
  const margin = finiteNumber(shape.transferMarginSeconds);
  if (version === null || margin === null || version < 1 || margin < 0) return null;
  if (!Array.isArray(shape.capabilities) || !shape.capabilities.every((entry) => typeof entry === 'string')) return null;
  if (typeof shape.routes !== 'object' || shape.routes === null) return null;
  const routes: Partial<Record<EngineRoute, RouteTiming>> = {};
  for (const route of ROUTES) {
    const entry = (shape.routes as Record<string, unknown>)[route];
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const parts = [row.budgetSeconds, row.probeSeconds, row.headroomSeconds, row.ceilingSeconds].map(finiteNumber);
    if (parts.some((part) => part === null || part < 0)) continue;
    const [budgetSeconds, probeSeconds, headroomSeconds, ceilingSeconds] = parts as number[];
    routes[route] = { budgetSeconds: budgetSeconds!, probeSeconds: probeSeconds!, headroomSeconds: headroomSeconds!, ceilingSeconds: ceilingSeconds! };
  }
  // A body with no route we know is an engine we know nothing about.
  if (Object.keys(routes).length === 0) return null;
  return { version, capabilities: shape.capabilities as string[], transferMarginSeconds: margin, routes };
}

/** Whether the engine said it can be sent a deadline in the request. */
export function supportsDeadline(timing: EngineTiming | null): boolean {
  return timing !== null && timing.capabilities.includes('deadlineSeconds');
}

/**
 * How long the API waits for one call to a route, in milliseconds.
 *
 * AI_ENGINE_TIMEOUT_MS when it is set: the operator's number is a ceiling the
 * API enforces, and what it does to the engine is carried in the request (the
 * engine answers inside it). Otherwise what the engine says its route needs,
 * and a margin: the engine answers first. An engine that has said nothing is
 * waited for as a gateway without this module waited, 120 s.
 */
export function waitMsFor(route: EngineRoute | null, timing: EngineTiming | null, configuredMs?: number): number {
  if (configuredMs !== undefined) return configuredMs;
  const row = route === null ? undefined : timing?.routes[route];
  if (row === undefined) return FALLBACK_WAIT_MS;
  return (row.ceilingSeconds + WAIT_MARGIN_SECONDS) * 1000;
}

/**
 * A route's wait for a caller that has a floor of its own (the exam planner's 90 s): the floor, or what the
 * engine says the route needs and a margin when that is more. Never the configured AI_ENGINE_TIMEOUT_MS:
 * a caller with a floor of its own was never waiting by it.
 */
export function waitMsAtLeast(route: EngineRoute | null, timing: EngineTiming | null, floorMs: number): number {
  const row = route === null ? undefined : timing?.routes[route];
  return Math.max(floorMs, row === undefined ? 0 : (row.ceilingSeconds + WAIT_MARGIN_SECONDS) * 1000);
}

/** The `deadlineSeconds` a call carries: its whole wait, in whole seconds, never past the engine's hour. */
export function deadlineSecondsOf(waitMs: number): number {
  return Math.min(MAX_DEADLINE_SECONDS, Math.max(1, Math.floor(waitMs / 1000)));
}

/**
 * What a schemaförslag call waits, in milliseconds: the budget it asked for, the
 * engine's build headroom, the transfer and this gateway's margin, and the
 * engine's probe when the call asks for probes (the run's first). Longer than the
 * engine's own ceiling for the request, so the engine answers first.
 *
 * With the engine's defaults (probe 20 s, headroom 30 s) these are exactly the
 * `+45 s` and `+20 s` this wait has always been.
 */
export function candidateCallMs(maxSeconds: number, lead: boolean, times?: CandidateTimes): number {
  const probe = times?.probeSeconds ?? LEGACY_PROBE_SECONDS;
  const headroom = times?.headroomSeconds ?? LEGACY_HEADROOM_SECONDS;
  return (maxSeconds + headroom + CALL_MARGIN_SECONDS + (lead ? probe : 0)) * 1000;
}

/** What a candidate call needs of the engine's times: the generator's probe and headroom. */
export interface CandidateTimes {
  probeSeconds: number;
  headroomSeconds: number;
}

/** The generator's probe and headroom as the engine said them; undefined for an engine that said nothing. */
export function candidateTimesOf(timing: EngineTiming | null): CandidateTimes | undefined {
  const row = timing?.routes.optimize;
  return row === undefined ? undefined : { probeSeconds: row.probeSeconds, headroomSeconds: row.headroomSeconds };
}

export interface WaitShortfall {
  /** The sentence for the log and for a refused start: which number to change. */
  sentence: string;
  /** The shortest wait that holds the engine's ceiling and the transfer, in milliseconds. */
  minimumMs: number;
}

/**
 * Whether an AI_ENGINE_TIMEOUT_MS that was SET is shorter than the engine can
 * need, and the sentence that says which number to change. Null when it holds,
 * and for an engine that has not said its generator's times.
 *
 * "Holds" is the ceiling and the engine's transfer margin: a caller that waits
 * that long is answered by the engine itself (a schema, a TIMEOUT with its
 * probe, an INFEASIBLE with its explanation) and not by its own timeout. A wait
 * shorter than that still gets an answer inside it, because the request carries
 * its deadline, but a shorter search than the one the engine was set to give, and
 * that is a setting that says one thing and does another.
 */
export function waitShortfall(timing: EngineTiming | null, configuredMs: number | undefined): WaitShortfall | null {
  const row = timing?.routes.optimize;
  if (timing === null || row === undefined || configuredMs === undefined) return null;
  const minimumMs = (row.ceilingSeconds + timing.transferMarginSeconds) * 1000;
  if (configuredMs >= minimumMs) return null;
  const roundedUpMs = Math.ceil(minimumMs / 10_000) * 10_000;
  // The budget that would fit the wait: what is left of it after the transfer, the probe and the headroom.
  const fits = Math.floor(configuredMs / 1000 - timing.transferMarginSeconds - row.probeSeconds - row.headroomSeconds);
  const lower = fits >= 1 ? `, or lower SOLVER_MAX_TIME_SECONDS on the engine to ${fits} or less` : '';
  const sentence =
    `AI_ENGINE_TIMEOUT_MS=${configuredMs} is shorter than the engine can need: it searches for up to ` +
    `SOLVER_MAX_TIME_SECONDS=${row.budgetSeconds} s, explains for SOLVER_PROBE_SECONDS=${row.probeSeconds} s ` +
    `and needs up to ${row.headroomSeconds} s to build, ${row.ceilingSeconds} s in all, and the API must wait at least ` +
    `${minimumMs / 1000} s. Set AI_ENGINE_TIMEOUT_MS to ${roundedUpMs} or more, or remove it so that the API waits as long ` +
    `as the engine says${lower}.`;
  return { sentence, minimumMs };
}

/**
 * CANDIDATE_MAX_SECONDS above the engine's budget is a setting that does nothing:
 * the engine takes the smaller of the two for every candidate. Said once, because
 * a deployment that raised it believes it has given the candidates more time
 * (the same silent death SOLVER_TIMEOUT_SECONDS had). Null when it holds.
 */
export function candidateBudgetNote(timing: EngineTiming | null, candidateMaxSeconds: number | undefined): string | null {
  const row = timing?.routes.optimize;
  if (row === undefined || candidateMaxSeconds === undefined || candidateMaxSeconds <= row.budgetSeconds) return null;
  return (
    `CANDIDATE_MAX_SECONDS=${candidateMaxSeconds} is above the engine's SOLVER_MAX_TIME_SECONDS=${row.budgetSeconds}: ` +
    `the engine gives every schemaförslag candidate ${row.budgetSeconds} s, not ${candidateMaxSeconds}. ` +
    `Raise SOLVER_MAX_TIME_SECONDS or lower CANDIDATE_MAX_SECONDS.`
  );
}

/** What a route's 503 looks like when the route stopped waiting for its own solve (app/exceptions.py). */
export const ENGINE_CEILING_CODE = 'SOLVER_TIMEOUT';

/**
 * The sentences each route answered with before the code existed, word for word:
 * an engine older than SOLVER_TIMEOUT sends only these, and the gateway matches
 * the sentence for it. optimization-engine/tests/data/solver_timeout_body.json
 * is the one place both sides' tests read them from.
 */
export const ENGINE_CEILING_SENTENCES: readonly string[] = [
  'Optimization timed out.',
  'Room optimization timed out.',
  'Staffing proposal timed out.',
  'Exam planning timed out.',
];

/** Whether the body of an engine 503 says its route stopped waiting for its own solve. */
export function isEngineCeilingBody(body: { message?: unknown; code?: unknown } | null | undefined): boolean {
  if (body === null || body === undefined) return false;
  if (body.code === ENGINE_CEILING_CODE) return true;
  return typeof body.message === 'string' && ENGINE_CEILING_SENTENCES.includes(body.message);
}
