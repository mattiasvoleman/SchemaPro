import type { LessonRecurrence } from "@/lib/types";

/*
 * Schemaförslag: what the gateway answers on /api/v1/optimization/candidates
 * (OptimizationController, design §3), field for field. Types only, so the
 * pure modules beside this one and the page-local hooks share one reading of
 * the wire without either importing the other at runtime.
 *
 * Every id is a real one and no pupil is ever named: the gateway turns the
 * engine's answer back into requirement, room and group ids before it stores
 * a candidate, and every NAME on the pages comes from the school's own lists.
 */

/** PENDING → RUNNING → SUCCEEDED | FAILED; CANCELLING while a DELETE waits for the task. */
export type CandidateRunStatus = "PENDING" | "RUNNING" | "CANCELLING" | "SUCCEEDED" | "FAILED";

/** The engine's verdict, and REJECTED when the gateway's own demand check refused the answer. */
export type CandidateSolverStatus = "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIMEOUT" | "REJECTED";

/**
 * The emphasis a candidate was asked with. An open code on purpose: the
 * engine's benchmarks may retune or drop a variant, and a code this build has
 * never heard of is shown as "Förslag N" rather than refused.
 */
export type CandidateVariant = "KEEP" | "TEACHER_GAPS" | "SPREAD" | "FREE" | (string & {});

export interface CandidateRun {
  id: string;
  status: CandidateRunStatus;
  /** How many candidates the run was asked for (2–4; a refresh mirrors the old batch). */
  requested: number;
  /** How many it has stored so far. */
  progress: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The English for a log; the page renders `errorCode` in its own language. */
  error: string | null;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  createdById: string | null;
  createdByName: string | null;
  appliedCandidateId: string | null;
  appliedAt: string | null;
  refreshOfId: string | null;
}

/** As the generate page's own conflicts: category, the engine's sentence, the school's names. */
export interface CandidateConflict {
  category: string;
  message: string;
  code?: string | null;
  params?: Record<string, string | number> | null;
  resourceNames?: string[];
}

/**
 * The comparison the gateway can make without the browser: lessons moved
 * against the draft the candidate was generated from, measured once, when it
 * was stored. Null unless the candidate is OPTIMAL or FEASIBLE.
 */
export interface CandidateMetrics {
  /** Draft lessons (non-preserved) the candidate does not keep at the same slot. */
  moved: number;
  /** How many non-preserved lessons the draft had: the "of Y" in "X av Y". */
  movedOf: number;
  /** Kept slots whose room changed. */
  roomChanges: number;
  kept: number;
  /** The ordinal of an earlier candidate this one differs from in under 1 % of its lessons. */
  sameAs: number | null;
}

export interface CandidateView {
  id: string;
  ordinal: number;
  variant: CandidateVariant;
  weights: Record<string, number> | null;
  solverStatus: CandidateSolverStatus | null;
  lessonCount: number;
  /**
   * The engine's summary of a candidate without a timetable, by name
   * (CONFLICT_CORE_SUMMARY, PROBE_NOTHING_HELPED, or a gateway refusal such
   * as STAFF_UNSTAFFED_REQUIREMENTS), with the values its sentence is
   * written from: the job row's conflictSummaryCode and conflictSummaryParams.
   */
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  metrics: CandidateMetrics | null;
  conflicts: CandidateConflict[];
}

export interface CandidateBatch {
  run: CandidateRun;
  candidates: CandidateView[];
}

/**
 * Timplan lines left UNSCHEDULED or SHORT, and the minutes a week they miss —
 * the candidates' figure and the current draft's, computed when the batch was
 * stored. Equal across the feasible candidates in practice, so it is shown
 * once for the run.
 */
export interface CandidatesUnplaced {
  lines: number;
  minutes: number;
  draftLines: number;
  draftMinutes: number;
}

/** GET candidates?academicYearId= */
export interface CandidatesOverview {
  /** The newest run, any status, with whatever candidates it has stored so far. */
  latest: CandidateBatch | null;
  /** The newest SUCCEEDED run: the batch the comparison is made of. */
  batch: CandidateBatch | null;
  unplaced: CandidatesUnplaced | null;
}

export type PublishMode = "DRAFT" | "DIRECT";

/** GET candidates/runs/:runId/check: the batch against today's basis. */
export interface CandidateCheck {
  stale: boolean;
  /** The basis parts that differ: requirements, preserved, draft, rooms, rules, rosters. */
  changed: string[];
  /** A refusal today's basis would meet (unstaffed posts, a partly locked block). */
  refusalCode: string | null;
  mode: PublishMode;
  /** DIRECT: upcoming scheduled calendar lessons the apply would delete; 0 in DRAFT. */
  futureCalendarLessons: number;
  /** DIRECT: cover assignments on those calendar lessons; 0 in DRAFT. */
  coverAssignments: number;
}

/** GET candidates/:id/lessons: one stored lesson, resolved from its requirement at read time. */
export interface CandidateLesson {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  /** "HH:MM". */
  startTime: string;
  endTime: string;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
}

export interface StartCandidatesRequest {
  academicYearId: string;
  /** 2..4; the gateway's default is 3. */
  count?: number;
  weights?: Record<string, number>;
  /** "Uppdatera förslagen": re-solve this SUCCEEDED run's candidates on today's basis. */
  refreshOf?: string;
}

export interface CandidateApplyResult {
  lessonsCreated: number;
  /** The safety version saved before the write ("Före schemaförslag N – …"). */
  versionId: string;
}
