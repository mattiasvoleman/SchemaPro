import type {
  CandidateBatch,
  CandidateCheck,
  CandidateConflict,
  CandidateLesson,
  CandidateMetrics,
  CandidateRun,
  CandidatesOverview,
  CandidatesUnplaced,
  CandidateView,
} from "../../../lib/candidates/types";
import type { MasterLesson, TeachingRequirement } from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { stockholmInstant, TODAY } from "./calendar";
import { CALENDAR_LESSON_TEACHERS_WITH_COVER, CALENDAR_LESSONS_WITH_COVER } from "./cover-world";
import { ago } from "./misc-school";
import { ATTENDANCE_RECORDS } from "./school-days";
import { ADMIN, MASTER_LESSONS, REQUIREMENTS, ROOMS } from "./world";

/**
 * Schemaförslag at Exempelskolan (design §3 and §6): yesterday's batch of
 * three, which the compare page shows by default, and the five states a spec
 * asks for by name in the x-stub-scenario header (SCENARIOS below; the
 * routes are gateway-candidates.ts). Ids are KIND.misc 9601–9699.
 *
 * Every candidate is the draft's generated lessons laid again, a few of them
 * elsewhere, and nothing more. The parked Bild 8A is among them: a parked
 * lesson is never sent to the solver, so its timplanspost is laid like any
 * other. Nothing more because the toy school's timplan asks for more than
 * its grundschema holds, and its solver lays what the grundschema has, as
 * the job history says (misc-school.ts, lessonsGenerated). The figures the
 * gateway stores with a candidate (moved "X av Y", room changes, the run's
 * unplaced lines) are counted here from those lessons by design §5's rules,
 * so the table, the moved list the browser works out and the week view tell
 * one story. Håltimmar are the browser's own (lib/gaps.ts) and stored
 * nowhere.
 */

const id = (n: number) => uid(KIND.misc, n);
const master = (n: number) => uid(KIND.masterLesson, n);

/** The states the one world does not hold, each asked for by a spec (e2e/signed-in.ts askForScenario). */
export const SCENARIOS = {
  /** A new run has stored its first candidate of three; yesterday's batch is still the one compared. */
  running: "candidates-running",
  /** Since yesterday's batch a lesson was moved by hand and a room changed: /check says so. */
  stale: "candidates-stale",
  /** This morning's run, the school's first, whose first candidate found no timetable. */
  failed: "candidates-failed",
  /** The same run, but the first candidate ran out of time and no relaxed rule helped. */
  timedOut: "candidates-timed-out",
  /** The school publishes directly, so an apply also takes the replaced lessons off the calendar. */
  direct: "candidates-direct",
} as const;
export type CandidatesScenario = (typeof SCENARIOS)[keyof typeof SCENARIOS];

// --- The draft the candidates replace ---------------------------------------------

/**
 * What an apply replaces and what it keeps, by the gateway's one rule
 * (PRESERVED_FROM_REGENERATION, lib/candidates/lessons.ts isPreserved): every
 * lesson of the grundschema is the solver's (tables.ts), so only the locked
 * Swedish on Monday morning stays. The parked Bild 8A is replaced too.
 */
const preserved = (lesson: MasterLesson) =>
  lesson.isLocked || lesson.extraGroupIds.length > 0 || lesson.studentIds.length > 0;
const REPLACED = MASTER_LESSONS.filter((lesson) => !preserved(lesson));
const KEPT = MASTER_LESSONS.filter(preserved);

/** Each (class, subject) has one timplanspost in world.ts, so a lesson's is the one it shares both with. */
const requirementOf = (lesson: Pick<MasterLesson, "studentGroupId" | "subjectId">): TeachingRequirement =>
  REQUIREMENTS.find((row) => row.studentGroupId === lesson.studentGroupId && row.subjectId === lesson.subjectId)!;

const clock = (time: string) => time.slice(0, 5);

/** Where a candidate puts a draft lesson instead: another day and time, or another room. */
type Move = Partial<Pick<CandidateLesson, "dayOfWeek" | "startTime" | "endTime" | "roomId">>;

/**
 * A candidate's lessons as GET candidates/:id/lessons answers them: every
 * replaced draft lesson, laid where `moves` says or where it was, with its
 * teacher, co-teacher and weeks read from the timplanspost (the gateway
 * resolves them at read time).
 */
function laid(moves: Record<string, Move>): CandidateLesson[] {
  return REPLACED.map((lesson) => {
    const requirement = requirementOf(lesson);
    return {
      requirementId: requirement.id,
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      teacherId: requirement.teacherId,
      coTeacherId: requirement.coTeacherId,
      roomId: lesson.roomId,
      dayOfWeek: lesson.dayOfWeek,
      startTime: clock(lesson.startTime),
      endTime: clock(lesson.endTime),
      recurrence: requirement.recurrence,
      startDate: requirement.startDate,
      endDate: requirement.endDate,
      ...moves[lesson.id],
    };
  });
}

// --- The figures the gateway stores (design §5) ---------------------------------------

const slotKey = (lesson: Pick<CandidateLesson, "studentGroupId" | "subjectId" | "dayOfWeek" | "startTime" | "endTime">) =>
  `${lesson.studentGroupId}|${lesson.subjectId}|${lesson.dayOfWeek}|${clock(lesson.startTime)}|${clock(lesson.endTime)}`;

/**
 * moved / movedOf / roomChanges / kept: a multiset match on (class, subject,
 * day, start, end) between the draft's replaced lessons and the candidate's.
 * A match is kept; a kept slot in another room is a room change.
 */
function metricsOf(lessons: readonly CandidateLesson[]): CandidateMetrics {
  const open = new Map<string, MasterLesson[]>();
  for (const lesson of REPLACED) open.set(slotKey(lesson), [...(open.get(slotKey(lesson)) ?? []), lesson]);
  let kept = 0;
  let roomChanges = 0;
  for (const lesson of lessons) {
    const match = open.get(slotKey(lesson))?.shift();
    if (!match) continue;
    kept++;
    if (match.roomId !== lesson.roomId) roomChanges++;
  }
  return { moved: REPLACED.length - kept, movedOf: REPLACED.length, roomChanges, kept, sameAs: null };
}

const minutesOf = (lesson: { startTime: string; endTime: string }) => {
  const at = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return at(lesson.endTime) - at(lesson.startTime);
};
/** A post with lektionslängder is those lessons (60 + 40), otherwise lessons × minutes, as timplan-coverage.ts reads it. */
const weeklyMinutes = (row: TeachingRequirement) =>
  (row.lessonLengths ?? []).length > 0
    ? (row.lessonLengths ?? []).reduce((sum, minutes) => sum + minutes, 0)
    : row.lessonsPerWeek * row.minutesPerLesson;

/**
 * Timplansposter a week leaves short and the minutes a week they miss —
 * computeScheduledCoverage's UNSCHEDULED and SHORT lines, counted the plain
 * way this school allows: every post runs all weeks and no class is split.
 */
function unplacedOf(week: ReadonlyArray<Pick<CandidateLesson, "studentGroupId" | "subjectId" | "startTime" | "endTime">>) {
  let lines = 0;
  let minutes = 0;
  for (const row of REQUIREMENTS) {
    const scheduled = week
      .filter((lesson) => lesson.studentGroupId === row.studentGroupId && lesson.subjectId === row.subjectId)
      .reduce((sum, lesson) => sum + minutesOf(lesson), 0);
    const missing = weeklyMinutes(row) - scheduled;
    if (missing > 0) {
      lines++;
      minutes += missing;
    }
  }
  return { lines, minutes };
}

// --- The candidates -----------------------------------------------------------------------

/** The generate page's profile as it stands until somebody changes it: the engine's defaults. */
const BASE_WEIGHTS = { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 };

/**
 * The three emphases of a run of three (src/optimization/candidate-variants.ts),
 * each with the lessons it lays differently from the draft:
 *
 *  1. Behåll mest: 7B's Tuesday maths on Wednesday morning, and 7B's Monday
 *     Swedish in Sal 201 — one move, one room change.
 *  2. Färre håltimmar för lärarna: Anna's Monday closes up (7B's Swedish and
 *     7A's mentorstid beside her 7A Swedish), and 7A's Wednesday maths moves
 *     to the morning, which closes 7A's lunch gap that day too.
 *  3. Jämnare veckor: Friday gets lessons, Monday and Tuesday fewer — and
 *     Anna's Thursday a long gap, the price a spread pays (Blir sämre för).
 */
const VARIANTS: Array<{ n: number; ordinal: number; variant: string; overrides: Record<string, number>; moves: Record<string, Move> }> = [
  {
    n: 9611,
    ordinal: 1,
    variant: "KEEP",
    overrides: {},
    moves: {
      [master(10)]: { dayOfWeek: 3, startTime: "09:25", endTime: "10:25" },
      [master(9)]: { roomId: ROOMS.r201.id },
    },
  },
  {
    n: 9612,
    ordinal: 2,
    variant: "TEACHER_GAPS",
    overrides: { disruption: 2, teacherGap: 8 },
    moves: {
      [master(9)]: { dayOfWeek: 1, startTime: "09:25", endTime: "10:25" },
      [master(8)]: { dayOfWeek: 1, startTime: "10:40", endTime: "11:10" },
      [master(7)]: { dayOfWeek: 3, startTime: "09:25", endTime: "10:25" },
    },
  },
  {
    n: 9613,
    ordinal: 3,
    variant: "SPREAD",
    overrides: { disruption: 2, spread: 9 },
    moves: {
      [master(2)]: { dayOfWeek: 5, startTime: "09:25", endTime: "10:25" },
      [master(4)]: { dayOfWeek: 4, startTime: "13:00", endTime: "14:00" },
      [master(9)]: { dayOfWeek: 5, startTime: "08:10", endTime: "09:10" },
      [master(11)]: { dayOfWeek: 3, startTime: "08:10", endTime: "09:10" },
      [master(12)]: { dayOfWeek: 1, startTime: "13:00", endTime: "14:00" },
      [master(6)]: { roomId: ROOMS.r102.id },
    },
  },
];

/** Every stored candidate's lessons, by candidate id: what GET candidates/:id/lessons answers. */
export const CANDIDATE_LESSONS = new Map<string, CandidateLesson[]>();

function solved(n: number, ordinal: number, variant: string, overrides: Record<string, number>, moves: Record<string, Move>): CandidateView {
  const lessons = laid(moves);
  CANDIDATE_LESSONS.set(id(n), lessons);
  return {
    id: id(n),
    ordinal,
    variant,
    weights: { ...BASE_WEIGHTS, ...overrides },
    solverStatus: ordinal === 1 ? "OPTIMAL" : "FEASIBLE",
    lessonCount: lessons.length,
    errorCode: null,
    errorParams: null,
    metrics: metricsOf(lessons),
    conflicts: [],
  };
}

const run = (n: number, extra: Partial<CandidateRun>): CandidateRun => ({
  id: id(n),
  status: "SUCCEEDED",
  requested: 3,
  progress: 3,
  createdAt: ago(1, "15:40"),
  startedAt: ago(1, "15:40"),
  finishedAt: ago(1, "15:42"),
  error: null,
  errorCode: null,
  errorParams: null,
  createdById: ADMIN.id,
  // Always null from the gateway: the run names nobody (ScheduleCandidatesService's view).
  createdByName: null,
  appliedCandidateId: null,
  appliedAt: null,
  refreshOfId: null,
  ...extra,
});

/** Yesterday afternoon's batch: three candidates, none applied. */
export const BATCH: CandidateBatch = {
  run: run(9601, {}),
  candidates: VARIANTS.map(({ n, ordinal, variant, overrides, moves }) => solved(n, ordinal, variant, overrides, moves)),
};

/**
 * The batch's unplaced figure beside the draft's, measured as the gateway
 * stores it: the first candidate with the lessons an apply keeps, against
 * the grundschema as it stands, parked lessons apart.
 */
export const UNPLACED: CandidatesUnplaced = (() => {
  const first = unplacedOf([...KEPT.filter((lesson) => !lesson.isParked), ...CANDIDATE_LESSONS.get(BATCH.candidates[0]!.id)!]);
  const draft = unplacedOf(MASTER_LESSONS.filter((lesson) => !lesson.isParked));
  return { lines: first.lines, minutes: first.minutes, draftLines: draft.lines, draftMinutes: draft.minutes };
})();

/** A run started two minutes before the fixture school's now: its first candidate stored, two to go. */
export const RUNNING: CandidateBatch = {
  run: run(9602, {
    status: "RUNNING",
    progress: 1,
    createdAt: stockholmInstant(TODAY, "09:58"),
    startedAt: stockholmInstant(TODAY, "09:58"),
    finishedAt: null,
  }),
  candidates: [solved(9621, 1, VARIANTS[0]!.variant, VARIANTS[0]!.overrides, VARIANTS[0]!.moves)],
};

/**
 * A requirement too many for 7A's week, as the job history's refused run
 * had (misc-school.ts): the hard rules are every variant's, so the run
 * stopped after the first and kept it for its conflicts, under the
 * engine's summary of them (CONFLICT_CORE_SUMMARY, which has no values:
 * the gateway stores no params for it).
 */
const TOO_MUCH_FOR_7A: CandidateConflict = {
  category: "REQUIREMENT_DEMAND",
  message: "The lessons of 6 requirements need 1560 minutes a week, and the week holds 1500.",
  code: "DEMAND_REQUIREMENTS_EXCEED_WEEK",
  params: { requirements: 6, demandMinutes: 1560, capacityMinutes: 1500 },
  resourceNames: ["7A"],
};

export const FAILED: CandidateBatch = {
  run: run(9603, {
    status: "FAILED",
    progress: 1,
    createdAt: stockholmInstant(TODAY, "08:30"),
    startedAt: stockholmInstant(TODAY, "08:30"),
    finishedAt: stockholmInstant(TODAY, "08:31"),
    error: "The first candidate found no timetable, and the others would have met the same rules.",
    errorCode: "CANDIDATES_FIRST_FAILED",
  }),
  candidates: [
    {
      id: id(9631),
      ordinal: 1,
      variant: "KEEP",
      weights: { ...BASE_WEIGHTS },
      solverStatus: "INFEASIBLE",
      lessonCount: 0,
      errorCode: "CONFLICT_CORE_SUMMARY",
      errorParams: null,
      metrics: null,
      conflicts: [TOO_MUCH_FOR_7A],
    },
  ],
};
CANDIDATE_LESSONS.set(id(9631), []);

/**
 * The same morning, where the first candidate ran out of time instead. The
 * engine's timeout probe switched each relaxable rule off in turn and none
 * let the week solve within its slice, so it answered its summary with the
 * values it measured and no conflict to list (PROBE_NOTHING_HELPED).
 */
export const TIMED_OUT: CandidateBatch = {
  run: run(9605, {
    status: "FAILED",
    progress: 1,
    createdAt: stockholmInstant(TODAY, "08:30"),
    startedAt: stockholmInstant(TODAY, "08:30"),
    finishedAt: stockholmInstant(TODAY, "08:33"),
    error: "The first candidate found no timetable, and the others would have met the same rules.",
    errorCode: "CANDIDATES_FIRST_FAILED",
  }),
  candidates: [
    {
      id: id(9632),
      ordinal: 1,
      variant: "KEEP",
      weights: { ...BASE_WEIGHTS },
      solverStatus: "TIMEOUT",
      lessonCount: 0,
      errorCode: "PROBE_NOTHING_HELPED",
      errorParams: { budget: 60, rules: 3, slice: 8 },
      metrics: null,
      conflicts: [],
    },
  ],
};
CANDIDATE_LESSONS.set(id(9632), []);

/** Every run the stub knows, for the routes that take a run's or a candidate's id. */
export const RUNS: CandidateBatch[] = [BATCH, RUNNING, FAILED, TIMED_OUT];

/** The run a new start or a refresh answers with, and the safety version an apply saves. */
export const STARTED_RUN_ID = id(9604);
export const SAFETY_VERSION_ID = id(9641);

/** GET candidates?academicYearId= for this year, in each state. */
export function overviewOf(scenario: string | null): CandidatesOverview {
  switch (scenario) {
    case SCENARIOS.running:
      return { latest: RUNNING, batch: BATCH, unplaced: UNPLACED };
    case SCENARIOS.failed:
      // The school's first run: there has never been a batch to fall back on.
      return { latest: FAILED, batch: null, unplaced: null };
    case SCENARIOS.timedOut:
      return { latest: TIMED_OUT, batch: null, unplaced: null };
    default:
      return { latest: BATCH, batch: BATCH, unplaced: UNPLACED };
  }
}

// --- The check ------------------------------------------------------------------------------

/**
 * In DIRECT, the calendar rows an apply would delete: the replaced lessons'
 * dated lessons from today on, SCHEDULED and with no register taken
 * (calendarSweepWhere), and the substitutes put on them. The stub's
 * calendar is this week, so these are this week's.
 */
const replacedIds = new Set(REPLACED.map((lesson) => lesson.id));
const registered = new Set(ATTENDANCE_RECORDS.map((record) => record.calendarLessonId));
const SWEPT = CALENDAR_LESSONS_WITH_COVER.filter(
  (lesson) =>
    replacedIds.has(lesson.masterLessonId) && lesson.status === "SCHEDULED" && lesson.date >= TODAY && !registered.has(lesson.id),
);
const sweptIds = new Set(SWEPT.map((lesson) => lesson.id));
const COVER_ON_SWEPT = CALENDAR_LESSON_TEACHERS_WITH_COVER.filter(
  (row) => row.role === "SUBSTITUTE" && sweptIds.has(row.calendarLessonId),
);

const CURRENT: CandidateCheck = {
  stale: false,
  changed: [],
  refusalCode: null,
  mode: "DRAFT",
  futureCalendarLessons: 0,
  coverAssignments: 0,
};

/** GET candidates/runs/:runId/check in each state. */
export function checkOf(scenario: string | null): CandidateCheck {
  switch (scenario) {
    case SCENARIOS.stale:
      return { ...CURRENT, stale: true, changed: ["draft", "rooms"] };
    case SCENARIOS.direct:
      return { ...CURRENT, mode: "DIRECT", futureCalendarLessons: SWEPT.length, coverAssignments: COVER_ON_SWEPT.length };
    default:
      return CURRENT;
  }
}
