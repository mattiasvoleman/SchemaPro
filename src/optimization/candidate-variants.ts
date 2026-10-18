import type { ObjectiveWeights, SearchOptions } from './interfaces/ai-engine-payload.interface';

/*
 * THE EMPHASES A SCHEMAFÖRSLAG RUN ASKS FOR (design §1), in one table so the
 * engine's benchmarks can retune them without touching the run.
 *
 * Every candidate is warm-started from the draft (previousLessons), so what
 * makes two candidates differ is how the objective weighs keeping the draft
 * against the other wishes, plus where CP-SAT starts looking (the seed).
 * Ordinal 1 asks what Generera asks: the school's weights as they are, the
 * same hints, no seed. It is not the timetable a press of Generera would
 * write: every candidate call carries `search` (the worker cap, the
 * candidate budget, and the engine's hint completion before its last phase),
 * but it is the candidate nearest the draft. The others lower the disruption
 * weight and move it to one other term.
 *
 * Every candidate is solved under the same budget, CANDIDATE_MAX_SECONDS,
 * KEEP's included. Measured (docs/verification-baseline.md, Schemaförslag):
 * with KEEP on the engine's 60 s against the others' 30 s, the comparison
 * measured the budget and not the emphasis — "Färre håltimmar för lärarna"
 * came back with more idle minutes than KEEP at both sizes, whatever its
 * weights — while at one budget each emphasis does what its label says.
 *
 * The overrides were chosen on the 500- and 1 000-pupil benchmarks
 * (optimization-engine/benchmarks/candidate_variants.py): each non-KEEP
 * variant has to differ from KEEP by a stated margin both in lessons moved
 * and in the teachers' idle minutes, or it is retuned here or dropped. A code
 * is an open name in the database (ScheduleCandidates_variant_is_a_name), so
 * changing this table needs no migration; the web shows a code it has never
 * heard of as "Förslag N".
 */

export interface CandidateVariant {
  /** 1..4: the variant's place in a run of `count`. */
  ordinal: number;
  /** The open code stored on the candidate (^[A-Z][A-Z0-9_]{0,31}$). */
  code: string;
  /** The Swedish label, as the safety version's name says it. */
  label: string;
  /** Laid over the run's own weights; empty for KEEP. */
  overrides: Readonly<ObjectiveWeights>;
  /** CP-SAT's random_seed; null for KEEP, which asks what Generera asks. Never shown. */
  seed: number | null;
}

export const CANDIDATE_VARIANTS: readonly CandidateVariant[] = [
  { ordinal: 1, code: 'KEEP', label: 'Behåll mest', overrides: {}, seed: null },
  { ordinal: 2, code: 'TEACHER_GAPS', label: 'Färre håltimmar för lärarna', overrides: { disruption: 2, teacherGap: 8 }, seed: 1 },
  { ordinal: 3, code: 'SPREAD', label: 'Jämnare veckor', overrides: { disruption: 2, spread: 9 }, seed: 2 },
  { ordinal: 4, code: 'FREE', label: 'Friare placering', overrides: { disruption: 0 }, seed: 3 },
];

/** How many candidates a new run asks for when the request names no count. */
export const DEFAULT_CANDIDATE_COUNT = 3;
export const MIN_CANDIDATE_COUNT = 2;
export const MAX_CANDIDATE_COUNT = 4;

/** The engine's build headroom (30 s) plus the transfer and the gateway's own margin. */
export const CALL_HEADROOM_SECONDS = 45;
/** The engine's timeout probe, paid only by a call that asks for probes. */
export const PROBE_SECONDS = 20;

/**
 * The disruption floor of a refresh ("Uppdatera förslagen"): the old
 * candidate's lessons become the hints and keeping them is weighted at least
 * this much, so the refreshed candidate comes back near-identical but valid
 * on today's draft. Five times the engine's default of 8.
 */
export const REFRESH_DISRUPTION_FLOOR = 40;

/** The lease's bounds (ScheduleCandidateRuns_lease_is_bounded). */
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 3600;

/** The variants of a new run of `count`, in ordinal order. */
export function variantsFor(count: number): CandidateVariant[] {
  const bounded = Math.min(MAX_CANDIDATE_COUNT, Math.max(MIN_CANDIDATE_COUNT, Math.trunc(count)));
  return CANDIDATE_VARIANTS.slice(0, bounded);
}

export function variantOf(code: string): CandidateVariant | undefined {
  return CANDIDATE_VARIANTS.find((variant) => variant.code === code);
}

/** Whether this variant asks what Generera asks: the school's weights, no seed. */
export function isGenerateRequest(code: string): boolean {
  return code === CANDIDATE_VARIANTS[0]!.code;
}

/**
 * A candidate's weights: the run's base with the variant's overrides on top,
 * or null when both are empty, so a KEEP candidate of a run with no weights
 * sends none and the engine uses its defaults, as Generera does.
 */
export function weightsFor(base: ObjectiveWeights | null | undefined, variant: CandidateVariant): ObjectiveWeights | null {
  const merged: ObjectiveWeights = { ...(base ?? {}), ...variant.overrides };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** A refresh's weights: the old candidate's, with disruption raised to the floor. */
export function refreshWeights(old: ObjectiveWeights | null | undefined): ObjectiveWeights {
  return { ...(old ?? {}), disruption: Math.max(old?.disruption ?? 0, REFRESH_DISRUPTION_FLOOR) };
}

/** What one call of a run needs to know to be timed and searched. */
export interface CallShape {
  /** The variant's code. */
  variant: string;
  seed: number | null;
  /** The run's first call, the one that explains a refusal (probes on). */
  lead: boolean;
}

/** The candidate settings of the deployment (CANDIDATE_MAX_SECONDS, CANDIDATE_SOLVER_WORKERS). */
export interface SearchSettings {
  maxSeconds: number;
  workers: number;
}

/**
 * The `search` of one call. Sent on EVERY candidate call, KEEP's included, so
 * the workers cap holds for all of them and an engine older than the field
 * fails the run at its first call rather than its second. The lead asks for
 * the probes, so a first candidate that finds no timetable says why; the
 * others skip them, since the hard constraints are the same for every
 * variant. Every call gets the candidate budget, so the emphases are compared
 * at one budget (see the table above); KEEP alone sends no seed.
 */
export function searchFor(call: CallShape, settings: SearchSettings): SearchOptions {
  return {
    workers: settings.workers,
    probes: call.lead,
    maxSeconds: settings.maxSeconds,
    ...(call.seed !== null ? { seed: call.seed } : {}),
  };
}

/**
 * The whole wait for one call, overriding AI_ENGINE_TIMEOUT_MS: the solve
 * budget, the engine's build headroom and transfer, and the probe when one is
 * asked for. Longer than the engine's own ceiling for the request, so the
 * engine answers first (a TIMEOUT with its explanation) instead of the
 * gateway giving up on a thread that keeps solving.
 */
export function callTimeoutMs(call: CallShape, settings: SearchSettings): number {
  return (settings.maxSeconds + CALL_HEADROOM_SECONDS + (call.lead ? PROBE_SECONDS : 0)) * 1000;
}

/**
 * The run's lease: twice its longest call. The task bumps the heartbeat
 * before every call and after every stored candidate, so a live task never
 * goes a whole call without one; past the lease the sweep reads it as gone.
 */
export function leaseSecondsFor(calls: readonly CallShape[], settings: SearchSettings): number {
  const longest = Math.max(0, ...calls.map((call) => callTimeoutMs(call, settings)));
  const lease = Math.ceil((2 * longest) / 1000);
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, lease));
}

/** The safety version an apply saves first: "Före schemaförslag 2 – Färre håltimmar för lärarna". */
export function snapshotNameOf(ordinal: number, code: string): string {
  const label = variantOf(code)?.label;
  return label ? `Före schemaförslag ${ordinal} – ${label}` : `Före schemaförslag ${ordinal}`;
}
