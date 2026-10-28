import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { Prisma, type LessonRecurrence, type PrismaClient } from '@prisma/client';
import { firstValueFrom, TimeoutError } from 'rxjs';
import { timeout, catchError } from 'rxjs/operators';
import type { AiEngineConfig } from '../config/configuration';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { RecurrenceWindow } from '../calendar/lesson-recurrence';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { isWriteConflict } from '../common/utils/prisma-errors';
import { todayInZone } from '../common/utils/time';
import { schoolTimezone } from '../cover/cover-context';
import { gradeSpanOf, loadRosters, roomNeedsOf, type RoomNeeds } from './room-eligibility';
import { fromNioarig, toNioarig, toNioarigSpan, type GradeNumbering } from '../common/grade-numbering';
import { dayNumberingOf, yearNumberingOf } from '../common/year-numbering';
import { coverLockedLessons, coverLockedSharedLessons } from './locked-coverage';
import { judgeBlocks, partlyLockedRefusal } from './parallel-blocks';
import {
  BLOCK_MEMBERS_SHARE_TEACHER,
  BLOCK_SAME_TIMES_DIFFER,
  BLOCK_SAME_TIMES_SPLIT_LESSONS,
  BLOCK_MEMBERS_SPLIT,
  mirrorLessons,
  planMirror,
  sameTimesLinks,
  type Mirror,
  type MirrorPlan,
  type SameTimesLink,
  type SameTimesRow,
} from './same-times';
import { canonicalShape, lessonMinutesOf } from '../common/lesson-lengths';
import { canonicalShares, hasShares, lessonTeachersOf, type LessonShare } from '../common/lesson-shares';
import { effectiveDistribution, hasDistributionRule, type DistributionRule } from '../common/subject-distribution';
import { minutesOf } from '../common/solver-grid';
import {
  keptByOf,
  parseDerivedKey,
  pupilKeyOf,
  pupilKeysOf,
  replacedSubjectOf,
  replacementPairs,
  replacingBySubject,
  replacingGroupsOfNamed,
} from '../common/replacing-groups';
import { lockedWeekdaySets, type YearSpan } from '../common/teacher-day';
import { computeScheduledCoverage, type ScheduledLessonInput } from '../common/timplan-scheduled';
import type { PlannedGroup, PlannedRequirement, PlannedSubject } from '../common/timplan-planned';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';
import { readPlannedRows } from '../timplan/timplan-coverage.service';
import {
  basisInputsOf,
  basisOf,
  basisPartsOf,
  clockOf,
  dayOf,
  preservedPartOf,
  type BasisParts,
  type DraftContent,
  type MirroredRow,
} from './candidate-basis';
import {
  generateStale,
  lockYearForRegeneration,
  scheduleBusy,
  scheduleCandidateStale,
  SCHEDULE_BUSY,
  SCHEDULE_CANDIDATE_BUSY,
} from './regeneration-lock';

/** A @db.Time column (midnight-anchored UTC) as minutes since midnight. */
const clockMinutes = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();

/** A hand-placed lesson's length, from its two @db.Time columns (midnight-anchored UTC). */
const lessonMinutes = (start: Date, end: Date): number => {
  const clock = (time: Date): number =>
    time instanceof Date ? time.getUTCHours() * 60 + time.getUTCMinutes() : 0;
  return clock(end) - clock(start);
};
import { readUnstaffedRequirements } from '../staffing/unstaffed-requirements';
import { enterGrundschemaWrite, isLockTimeout, type PublishMode } from '../publication/publish-mode';
import { STAFF_UNSTAFFED_REQUIREMENTS } from '../staffing/staffing-checks';
import { recordRead, type AccessChannel } from '../access-log/access-log';
import { WORK_DAYS_HIDDEN_MESSAGE, WorkDaysRefusal, isDaysBearing, withoutDays } from './work-days';
import { unkeptFreeDayWishes, type FreeDayWish, type TeachersOnDay } from './free-day-wishes';
import { TRAVEL_TEACHERS_CODE } from './stored-conflicts';
import type {
  AiEngineConflictAnalysis,
  AiEngineLesson,
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
  AnonymousConstraint,
  AiEngineLunch,
  AnonymousFixedLesson,
  AnonymousFrameTime,
  AnonymousLunchPlacement,
  AnonymousLunchServing,
  AnonymousRast,
  AnonymousGroup,
  AnonymousPreviousLesson,
  AnonymousRequirement,
  AnonymousRoom,
  AnonymousRoomPreference,
  AnonymousTeacherDayLimit,
  AnonymousSiteTravelTime,
  AnonymousTeacherWorkRule,
  ConstraintKind,
  DayOfWeek,
  ObjectiveWeights,
  ResourceKind,
  ScheduleRules,
  SearchOptions,
} from './interfaces/ai-engine-payload.interface';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import { rostersOfYear, type RosterBasis } from '../year-rollover/projected-rosters';

/**
 * Masking proxy between NestJS and the Python AI engine.
 *
 * ## PII stripping contract
 *
 * 1. Fetch raw scheduling data from Prisma under the caller's RLS session.
 * 2. Re-map every record to a **new anonymous UUID** — never use real DB ids
 *    for resources that could be correlated back to a person (teachers are
 *    Users, and Users is the PII table). A fresh `anonymousId` map is built
 *    per-request and discarded after the response is processed.
 * 3. Drop every text field (names, codes, reasons, notes).
 * 4. Forward the sanitized payload to the AI engine over HTTPS with a
 *    pre-shared service API key (never the caller's JWT).
 * 5. Map the AI engine's anonymous response back to real DB ids using the
 *    retained anon→real id map before persisting master lessons.
 */
/**
 * Master lessons a regeneration leaves alone, expressed once.
 *
 * The first shape is the whole rule: `isGenerated` is false on everything the
 * optimizer did not produce, and nothing else in the timetable is the
 * machine's to replace. The other three are what a human has since done to a
 * lesson the machine did produce — locked it into place, opened it to a second
 * class, filled it with named students — each an intent the solver cannot
 * express and therefore could never put back.
 *
 * Ownership used to be inferred from the row looking untouched: default
 * recurrence and no dates, so nobody has been here, so it is ours. That held
 * only while nothing but a human ever set those columns. A generated lesson
 * now inherits its requirement's window, so "kemi bara på vårterminen"
 * describes the optimizer's own output exactly as well as a handmade lesson —
 * and read as handmade it was preserved, its requirement still counted as
 * unmet, and the next run stacked a second copy on top of it. Every press of
 * generate added another layer. The three window conditions are gone from this
 * list for that reason, and a handmade lesson carrying a window is caught by
 * `isGenerated: false` like every other handmade lesson.
 *
 * Referenced from the two places that must agree exactly: the fetch that
 * forwards these to the engine as immovable placements, and the delete that
 * clears the machine-owned remainder. One constant, because a lesson that is
 * in one list and not the other is either sent twice or thrown away.
 */
const PRESERVED_FROM_REGENERATION = [
  { isGenerated: false },
  { isLocked: true },
  { extraGroups: { some: {} } },
  { participants: { some: {} } },
];

/** The maps an engine refusal can name something through. */
export interface AnonMaps {
  /**
   * The scheduled läsår's numbering. The payload states every class span in
   * NIOARIG (grade-numbering.ts), so a refusal that echoes one in `grades`
   * names it in the year's own numbering again (yearGrades). Absent is NIOARIG.
   */
  gradeNumbering?: GradeNumbering;
  /**
   * The numbering of the läsår a day falls in, for a dated årskursregel: sent
   * in NIOARIG too, and stated in its own day's läsår (dayNumberingOf), so a
   * refusal that echoes its span names it so again (yearGrades). Absent reads
   * every day as NIOARIG.
   */
  numberingOnDay?: (day: string) => GradeNumbering;
  requirementAnonMap: Map<string, string>;
  roomAnonMap: Map<string, string>;
  groupAnonMap: Map<string, string>;
  /**
   * Room types too. "No room satisfies capacity/type/years for requirement X
   * (…, required type Y, …)" names an anonymised TYPE, and leaving it out left
   * the one part of that sentence a school would actually look up untranslated.
   */
  roomTypeAnonMap: Map<string, string>;
  /** And the reservation an engine refusal names. */
  constraintAnonMap: Map<string, string>;
  /**
   * And the teacher's arbetstid one names.
   *
   * REQUIRED, not optional like `lessonAnonMap` below, although the room route
   * sends no work rules and passes an empty map. A refusal here says "this
   * teacher's lunch has nowhere to go" and can name nobody — the teacher map is
   * discarded on purpose, because no person's name may enter the stored
   * conflicts (the walk's line, which names teachers when it is read, gets
   * only the teachers' Users ids: travelTeacherIds) — so the RULE's id is the
   * only thing a school can look the refusal up by. Left optional, a route that forgot it would answer with a uuid that
   * exists in no table and nothing would report it.
   */
  workRuleAnonMap: Map<string, string>;
  /**
   * And the parallel block a refusal names (BLOCK_CANNOT_BE_PLACED and the
   * block's other sentences). Optional like `lessonAnonMap`: only the
   * generator's route sends blocks, and a route that sends none has no block
   * a refusal could name.
   */
  blockAnonMap?: Map<string, string>;
  /**
   * And the post a deltid sentence names (TEACHER_WORK_DAYS_*): the post's
   * real id -> its anonymous one, kept and reversed like the work rule's, so
   * `limit` comes back as a row and not as a uuid in no table. Optional like
   * `blockAnonMap`, for its reason: only the generator's route sends a days
   * limit, and a route that sends none has none a refusal could name.
   */
  dayLimitAnonMap?: Map<string, string>;
  /**
   * The post's real id -> its teacher's Users id. Never reversed into text:
   * it is how a days sentence's `subjectIds` and `resourceIds` come to say
   * WHOSE post it is (work-days.ts) — which the gateway must know to show the
   * days to a reader with HR-läs and to write that read to the Läslogg, and
   * which no answer carries.
   */
  dayLimitTeacherIds?: Map<string, string>;
  /**
   * Restid i generatorn: a teacher's anonymous id -> their Users id, for the
   * one sentence that names teachers (TEACHER_TRAVEL_CANNOT_BE_KEPT). Turned
   * into the sentence's server-only `subjectIds` and never into text: the
   * view names them when read, as a free-day note's teacher is
   * (stored-conflicts.ts). Optional and empty unless the walk was sent.
   */
  travelTeacherIds?: Map<string, string>;
  /** Real group id -> the school's own name, the last step out of id space. */
  nameById: Map<string, string>;
  /**
   * Master lessons, for the room optimisation: its payload names placed
   * lessons rather than requirements, and a refusal that names one should come
   * back naming the row the school can find.
   */
  lessonAnonMap?: Map<string, string>;
}

/**
 * A timplanspost by the name the Timplan page gives its cell
 * (`requirements.cellLabel`, "{subject} för {group}"), or the subject alone
 * when the group has none. One function for every refusal that names a row,
 * the engine's and the staffing pre-flight's alike.
 */
export function requirementName(subject: string, group: string | undefined | null): string {
  return group ? `${subject} för ${group}` : subject;
}

/*
 * ---------------------------------------------------------------------------
 * The shared steps of a regeneration (Generera and Schemaförslag, design §3–§4)
 * ---------------------------------------------------------------------------
 *
 * Generera is one fetch, one engine call and one write. A schemaförslag run is
 * one fetch, two to four engine calls whose answers are stored, and — days
 * later, perhaps — one write of the answer an administrator picked. The three
 * steps are the same code in both: prepareSchedule (the fetch, its refusals and
 * the basis), the engine call, and writeRegeneration (the guard, the deletes,
 * the creates, the sittings, the change log). What differs is passed in: the
 * weights and search of a call, and the DELETE SCOPE of a write.
 */

/** A timplanspost as a regeneration stamps its lessons from it. */
export interface RegenerationRequirementRow {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  /**
   * Delade lektioner: the row's shares as this read found them, longest
   * first. Absent on a row nobody shares. A write compares them with the
   * ones its answer was asked for (RegenerationDemand.shareKey).
   */
  shares?: LessonShare[];
}

/** What an answer must place for one timplanspost, in real ids. */
export interface RegenerationDemand {
  requirementId: string;
  lessonsPerWeek: number;
  /** A split remainder's lengths; the placed lengths must equal them. Absent when uniform. */
  lessonLengths?: number[];
  /**
   * Delade lektioner: each remaining lesson's teacher, as sent
   * (lessonTeacherIds) in real ids; the placed lessons' teachers must be
   * exactly these. Absent on every entry sent without the list.
   */
  lessonTeachers?: (string | null)[];
  /**
   * The row's shares as the fetch read them (shareKeyOf), present only on a
   * shared row: a write whose rows say otherwise — shares changed while the
   * solver ran — is answering another request.
   */
  shareKey?: string;
}

/** A placed lesson in real ids: what a candidate stores and an apply writes. */
export interface CandidateLesson {
  requirementId: string;
  roomId: string | null;
  dayOfWeek: DayOfWeek;
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
  /**
   * Delade lektioner: the lesson's own teacher, null for one whose teacher was
   * deleted. Only on a lesson of a post sent with lessonTeacherIds; every
   * other lesson takes its post's teachers, as it always did.
   */
  teacherId?: string | null;
}

/**
 * A placed lesson on its way to being checked: the requirement is null when
 * the engine named one this request never sent, and stays in the list so the
 * guard counts it as unmatched rather than never seeing it.
 */
interface ResolvedLesson {
  requirementId: string | null;
  roomId: string | null;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  /** See CandidateLesson.teacherId. */
  teacherId?: string | null;
}

/**
 * Delade lektioner: the posts sent with lessonTeacherIds, by anonymous id,
 * and the teachers those lists name, anonymous → real — the one part of the
 * teacher map an answer is turned back through. Not in AnonMaps, which keeps
 * no teacher map at all (see there); empty for a school that shares nothing.
 */
export interface SplitLessons {
  requirementIds: ReadonlySet<string>;
  realTeacher: ReadonlyMap<string, string>;
  /**
   * A shared post sent without the list, its lessons left all one teacher's
   * (the lead's locked, say): anonymous post → that teacher in real ids.
   * Every lesson of it is that teacher's, which the engine is not asked to say.
   */
  soleTeacher: ReadonlyMap<string, string | null>;
}

const NO_SPLIT: SplitLessons = { requirementIds: new Set(), realTeacher: new Map(), soleTeacher: new Map() };

/** The SplitLessons of a payload, through the fetch's teacher map. */
function splitLessonsOf(
  sent: readonly AnonymousRequirement[],
  teacherAnonMap: ReadonlyMap<string, string>,
  soleTeacher: ReadonlyMap<string, string | null>,
): SplitLessons {
  const split = sent.filter((requirement) => requirement.lessonTeacherIds !== undefined);
  if (split.length === 0 && soleTeacher.size === 0) return NO_SPLIT;
  const real = reversed(teacherAnonMap);
  const realTeacher = new Map<string, string>();
  for (const requirement of split) {
    for (const anon of requirement.lessonTeacherIds ?? []) {
      if (anon !== null && real.has(anon)) realTeacher.set(anon, real.get(anon)!);
    }
  }
  return { requirementIds: new Set(split.map((requirement) => requirement.id)), realTeacher, soleTeacher };
}

/**
 * A row's shares as one string, '' for none: what a write compares with its
 * demand's. Canonical first (canonicalShares), since the read's order does not
 * decide between two teacherless shares of one length, which two deleted
 * teachers leave behind: two reads of the same rows must give one key.
 */
export function shareKeyOf(shares: readonly LessonShare[] | undefined): string {
  return canonicalShares(shares ?? [])
    .map((share) => `${share.teacherId ?? '-'}:${share.lessons}x${share.minutes}`)
    .join(',');
}

/** A preserved master as the fetch reads it, minus its named pupils. */
interface PreservedLessonRow {
  id: string;
  subjectId: string;
  studentGroupId: string;
  /** The two adults and the weekday: what the free-day wishes are read against (timetableWith). */
  teacherId: string | null;
  coTeacherId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  extraGroups: { studentGroupId: string }[];
}

/** One of the draft's own (non-preserved) lessons: what "moved" and the draft's coverage read. */
export interface DraftLesson extends DraftContent {
  id: string;
  isParked: boolean;
}

/** The payload a fetch builds, before a request adds its weights, rules and search. */
export type PreparedPayload = Omit<AiEngineScheduleRequest, 'weights' | 'rules' | 'search'>;

/**
 * What computeScheduledCoverage needs to say what a timetable leaves
 * unplaced (timplan layer 2, the PUB_UNPLACED figure), minus the lessons whose
 * placement is the question. Group lines only: no pupils are read or carried.
 */
export interface CoverageBase {
  year: YearBounds;
  closures: ClosedRange[];
  subjects: PlannedSubject[];
  groups: PlannedGroup[];
  requirements: PlannedRequirement[];
  /** The preserved, non-parked masters, which every candidate keeps as they are. */
  preservedLessons: ScheduledLessonInput[];
  /** The draft's own lessons, parked ones flagged: the "Nuvarande" figure's other half. */
  draftLessons: ScheduledLessonInput[];
}

/** The pre-flight refused: nothing to solve, and the refusal is the answer. */
export interface PreparedRefusal {
  ready: false;
  requestId: string;
  academicYearId: string;
  /** INFEASIBLE with no lessons and the refusal realised, as triggerScheduling answers it. */
  refusal: AiEngineScheduleResponse;
  /**
   * STAFF_UNSTAFFED_REQUIREMENTS or BLOCK_PARTLY_LOCKED_SUMMARY: the
   * refusal's summary code; or one of two blocks on the same times that no
   * longer fit together (BLOCK_SAME_TIMES_DIFFER, BLOCK_SAME_TIMES_TEACHERS,
   * BLOCK_MEMBERS_SHARE_TEACHER), which also carries `error`.
   */
  refusalCode: string;
  /**
   * The 400 the engine answers a block it cannot hold with, for a refusal
   * that is one: Generera throws it once its transaction has committed, so
   * the run fails with the sentence's code and values as the engine's own
   * block refusals do. A schemaförslag reads the code and the summary.
   */
  error?: HttpException;
}

/** One fetch, ready to be solved once or several times, and written from. */
export interface PreparedSchedule {
  ready: true;
  requestId: string;
  academicYearId: string;
  schoolId: string;
  payload: PreparedPayload;
  /** The school's saved lunch rules; a request's own rules win over them (Generera only). */
  storedRules: ScheduleRules | null;
  /** The maps an engine answer and a refusal are turned back through. No teacher map: see AnonMaps. */
  anonMaps: AnonMaps;
  /** Every free-day wish of the school's teachers, in real ids, for Generera's notes. Never sent. */
  freeDayWishes: FreeDayWish[];
  /**
   * The preserved, non-parked masters as this fetch read them, by teacher and
   * weekday: the half of a candidate's timetable every candidate keeps, which
   * a schemaförslag reads the wishes against (timetableWith). Generera reads
   * its own after its delete instead (RegenerationWritten).
   */
  keptTimetable: TeachersOnDay[];
  /** groupId → children who eat AS this group, for the stored sittings. */
  headcountByGroup: Map<string, number>;
  /**
   * The demand sent, in real ids, and each mirrored post's beside its leader
   * post's: what an answer must place exactly once mirrorLessons has written
   * the followers' lessons.
   */
  demand: RegenerationDemand[];
  /**
   * The posts of a block on another block's times, each with the post whose
   * times it takes (same-times.ts): an answer's lessons are mirrored through
   * these before they are judged, stored or written. Empty for a school with
   * no such block.
   */
  mirrors: Mirror[];
  /** The timplansposter as this fetch read them; an apply stamps its lessons from these. */
  requirementRows: RegenerationRequirementRow[];
  /** Delade lektioner: the posts sent with their lessons' teachers (SplitLessons). */
  splitLessons: SplitLessons;
  /** sha256 hex over the six parts (candidate-basis.ts). */
  basis: string;
  basisParts: BasisParts;
  /** The non-preserved masters' ids, sorted: exactly what a regeneration deletes. */
  draftIds: string[];
  /** The same masters by content. */
  draftLessons: DraftLesson[];
  /** Only when asked for ({ coverage: true }): it costs six more reads. */
  coverage: CoverageBase | null;
}

export type PrepareResult = PreparedSchedule | PreparedRefusal;

export interface SolveCandidateOptions {
  /** The candidate's own weights (the run's base with its variant's overrides); null for engine defaults. */
  weights?: ObjectiveWeights | null;
  search?: SearchOptions;
  /**
   * Hints in place of the fetch's own previousLessons — a refresh's old
   * candidate, through previousLessonsFrom. Absent: the draft's, as Generera.
   */
  previousLessons?: readonly AnonymousPreviousLesson[];
  /** This call's whole wait for the engine, overriding AI_ENGINE_TIMEOUT_MS. */
  timeoutMs: number;
}

export interface CandidateSolution {
  status: AiEngineScheduleResponse['status'];
  /** Real ids, HH:MM; empty unless OPTIMAL or FEASIBLE and accepted. */
  lessons: CandidateLesson[];
  /** Real group ids; null when the engine was not asked, which leaves the stored sittings standing. */
  lunches: AiEngineLunch[] | null;
  conflicts: AiEngineConflictAnalysis | null;
  /** The answer did not carry exactly the demand sent: the guard persist applies refused it. */
  rejected?: true;
}

export interface CandidateApplyInput {
  user: AuthenticatedUser;
  /**
   * The prepare step rebuilt IN THIS TRANSACTION, after the locks, whose basis
   * the caller has already found equal to the run's. Its draftIds are the
   * delete scope and its requirement rows what the lessons are stamped from.
   */
  prepared: PreparedSchedule;
  mode: PublishMode;
  lessons: readonly CandidateLesson[];
  lunches: AiEngineLunch[] | null;
  solverStatus: string;
  /** The safety version, taken first in the same transaction ("Före schemaförslag …"). */
  snapshot: { versions: Pick<ScheduleVersionsService, 'snapshotInTransaction'>; name: string };
  /**
   * Merged into the REGENERATE entry's after: source, runId, ordinal, variant,
   * metrics. The safety version's id is added here as safetyVersionId, so a
   * later RESTORE of it is known to undo this apply (OptimizationJobsService's
   * supersededBy).
   */
  after: Prisma.InputJsonObject;
}

export interface RegenerationCounts {
  lessonsCreated: number;
  unlockedReplaced: number;
  lockedPreserved: number;
  calendarLessonsRemoved: number;
}

/**
 * What a regeneration wrote, and the timetable it leaves by teacher and
 * weekday — the lessons it kept, as they stand after its delete, and the ones
 * it wrote — which Generera reads the free-day wishes against
 * (unkeptFreeDayWishes). Not logged: the counts are the REGENERATE entry.
 */
export interface RegenerationWritten extends RegenerationCounts {
  timetable: TeachersOnDay[];
}

export interface CandidateApplyResult extends RegenerationCounts {
  versionId: string;
}

/**
 * Which masters a regeneration replaces, said once for the master delete AND
 * the calendar sweep. Generera's is the rule itself — everything not
 * PRESERVED_FROM_REGENERATION — and an apply's is the exact ids its basis
 * saw, so a lesson that changed hands under it is never swept by a rule the
 * apply did not check.
 */
export type RegenerationScope = { kind: 'NOT_PRESERVED' } | { kind: 'IDS'; ids: readonly string[] };

/** callAiEngine's 503 when no connection was made: the engine never had the request. */
const ENGINE_UNREACHABLE = 'The AI engine could not be reached.';
/** callAiEngine's 503 for a failure before or outside the HTTP call itself. */
const ENGINE_UNAVAILABLE = 'AI engine unavailable.';

/**
 * Whether a failed engine call may have left the engine solving. It did when
 * the call reached the engine and ran out of time: this gateway's own timeout
 * ("did not respond in time"), or the engine's 503/504, whose wait does not
 * stop the solve thread. A call that never connected, or failed before it was
 * sent, left nothing running; neither did an engine that answered anything
 * else. A schemaförslag run keeps its call's deadline on the first kind only.
 */
export function engineMayStillBeSolving(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const status = error.getStatus();
  if (status !== HttpStatus.SERVICE_UNAVAILABLE && status !== HttpStatus.GATEWAY_TIMEOUT) return false;
  const body = error.getResponse();
  const shape = typeof body === 'object' && body !== null ? (body as { message?: unknown; code?: unknown }) : { message: body };
  if (shape.code === ENGINE_LACKS_CANDIDATES) return false;
  return shape.message !== ENGINE_UNREACHABLE && shape.message !== ENGINE_UNAVAILABLE;
}

/**
 * The year's machine-owned masters: everything a regeneration replaces, by
 * PRESERVED_FROM_REGENERATION. The one statement of that rule outside the
 * write, for the candidate service's counts, so a lesson cannot be a draft
 * lesson in one place and a kept one in another.
 */
export function draftMastersWhere(academicYearId: string): Prisma.MasterLessonWhereInput {
  return { academicYearId, NOT: { OR: PRESERVED_FROM_REGENERATION } };
}

/**
 * The dated lessons a regeneration of this scope removes in DIRECT mode: from
 * `today` on, still SCHEDULED, no attendance, of the masters the scope
 * replaces. The write's own where-clause, exported so a check can count
 * exactly the rows an apply would take off the calendar (design §3,
 * futureCalendarLessons). `today` has no default: it is regenerationSweepDay's,
 * for the write and the check alike, and a default here once handed every
 * caller the UTC day.
 */
export function calendarSweepWhere(
  scope: RegenerationScope,
  academicYearId: string,
  today: Date,
): Prisma.CalendarLessonWhereInput {
  return {
    ...(scope.kind === 'IDS'
      ? { masterLessonId: { in: [...scope.ids] } }
      : { masterLesson: { is: draftMastersWhere(academicYearId) } }),
    status: 'SCHEDULED',
    date: { gte: today },
    attendanceRecords: { none: {} },
  };
}

/**
 * The first day a DIRECT regeneration sweeps, its lessons and its meals alike:
 * the SCHOOL's today. It was midnight UTC, and for the hour or two after local
 * midnight that is yesterday in Stockholm: a regeneration then took yesterday's
 * lessons that had no attendance — lessons already held, the lektionslogg
 * written for them, the minutes the timplan's genomförd tid counts — and
 * yesterday's meals with them.
 *
 * A day and not an instant, so today goes whole, its lessons already held
 * among them. reconcilableLessons (propagate-template.ts) asks by instant and
 * keeps this morning, and can: its master survives the edit, so a publish's
 * idempotency key (masterLessonId, date) still finds the row it kept. A
 * regeneration replaces the masters, and nothing finds a kept row. The DIRECT
 * publish that refills the calendar starts on the school's today
 * (defaultPublishWindow) and writes the whole day, the hours already past
 * included, so a morning kept here would stand beside the new timetable's
 * morning: each class's morning twice, once as held and once as the new
 * timetable has it, and the genomförd tid counting both. The sweep clears the
 * days the publish fills, and no part of one. What that costs, this morning's
 * lessons without attendance and their logs, the manual says (6.11). A lov's
 * purge (SchoolBreaksService) asks by instant for the opposite reason: publish
 * skips a lov's days, so nothing writes back what it keeps.
 *
 * The timezone is read in the caller's transaction by schoolTimezone, as the
 * vikarie and lektionslogg paths read it, Stockholm for a school the caller
 * cannot read (it is their own).
 */
export async function regenerationSweepDay(
  tx: PrismaClient,
  schoolId: string,
  now: Date = new Date(),
): Promise<Date> {
  return todayInZone(await schoolTimezone(tx, schoolId), now);
}

/**
 * A stored candidate's lessons as the engine's previousLessons, for a refresh:
 * each lesson under its requirement's anonymous id in THIS fetch. A lesson whose
 * requirement this fetch does not send (deleted since, or now wholly covered by
 * locks) has nothing to be a hint for and is left out, as the fetch leaves out a
 * draft lesson without a requirement.
 */
export function previousLessonsFrom(
  prepared: PreparedSchedule,
  lessons: readonly Pick<CandidateLesson, 'requirementId' | 'dayOfWeek' | 'startTime'>[],
): AnonymousPreviousLesson[] {
  const sent = new Set(prepared.payload.requirements.map((requirement) => requirement.id));
  return lessons.flatMap((lesson) => {
    const anonId = prepared.anonMaps.requirementAnonMap.get(lesson.requirementId);
    if (anonId === undefined || !sent.has(anonId)) return [];
    return [{ requirementId: anonId, dayOfWeek: lesson.dayOfWeek, startTime: withSeconds(lesson.startTime) }];
  });
}

/**
 * Lessons in real ids as timplan coverage counts them: subject, group and
 * window from the requirement, as the write stamps them. A lesson whose
 * requirement the fetch did not read counts nothing.
 */
export function coverageLessonsOf(
  prepared: Pick<PreparedSchedule, 'requirementRows'>,
  lessons: readonly CandidateLesson[],
): ScheduledLessonInput[] {
  const rows = new Map(prepared.requirementRows.map((row) => [row.id, row]));
  return lessons.flatMap((lesson, index) => {
    const row = rows.get(lesson.requirementId);
    if (row === undefined) return [];
    return [
      {
        id: `candidate-${index}`,
        studentGroupId: row.studentGroupId,
        subjectId: row.subjectId,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        recurrence: row.recurrence,
        startDate: dayOf(row.startDate),
        endDate: dayOf(row.endDate),
        isParked: false,
        extraGroupIds: [],
        studentIds: [],
      },
    ];
  });
}

/** Lines left UNSCHEDULED or SHORT, and the minutes a week they are short by. */
export interface UnplacedTally {
  lines: number;
  minutes: number;
}

/**
 * What a timetable of the preserved lessons plus `lessons` leaves unplaced, by
 * the rule the PUB_UNPLACED gate reads (publications.service.ts): timplan
 * layer 2's group lines UNSCHEDULED or SHORT, and Σ planned − scheduled over
 * them. `unplacedOf(base, base.draftLessons)` is the current draft's figure.
 */
export function unplacedOf(base: CoverageBase, lessons: readonly ScheduledLessonInput[]): UnplacedTally {
  const coverage = computeScheduledCoverage({
    year: base.year,
    closures: base.closures,
    subjects: base.subjects,
    groups: base.groups,
    requirements: base.requirements,
    lessons: [...base.preservedLessons, ...lessons],
    pupils: [],
    includePupils: false,
  });
  let lines = 0;
  let minutes = 0;
  for (const group of coverage.groups) {
    for (const line of group.lines) {
      if (line.status !== 'UNSCHEDULED' && line.status !== 'SHORT') continue;
      lines++;
      minutes += Math.max(0, line.plannedMinutesPerWeek - line.scheduledMinutesPerWeek);
    }
  }
  return { lines, minutes };
}

/** The guard's tally: see writeRegeneration. */
interface DemandVerdict {
  requested: number;
  placed: number;
  unmatched: number;
  offTarget: number;
}

/**
 * Whether an answer carries exactly the demand it was sent: per requirement
 * the count, and for a split one the lengths. A lesson naming a requirement
 * the demand does not hold, or one the rows no longer hold (deleted while the
 * solver ran), is unmatched — and one unmatched lesson refuses the answer even
 * when every count is right, because it is then an answer to some other
 * request. Pure, so a candidate run judges its answers by the same rule the
 * write refuses them by.
 */
function checkAgainstDemand(
  lessons: readonly ResolvedLesson[],
  demand: readonly RegenerationDemand[],
  rowIds: ReadonlySet<string>,
): DemandVerdict {
  const wanted = new Map(demand.map((entry) => [entry.requirementId, entry.lessonsPerWeek]));
  const lengths = new Map(
    demand.flatMap((entry) => (entry.lessonLengths ? [[entry.requirementId, entry.lessonLengths] as const] : [])),
  );
  const teachers = new Map(
    demand.flatMap((entry) => (entry.lessonTeachers ? [[entry.requirementId, entry.lessonTeachers] as const] : [])),
  );
  const placedBy = new Map<string, number>();
  const minutesBy = new Map<string, number[]>();
  const teachersBy = new Map<string, (string | null)[]>();
  let unmatched = 0;
  let placed = 0;
  for (const lesson of lessons) {
    const id = lesson.requirementId;
    if (id === null || !rowIds.has(id) || !wanted.has(id)) {
      unmatched++;
      continue;
    }
    placed++;
    placedBy.set(id, (placedBy.get(id) ?? 0) + 1);
    if (lengths.has(id)) {
      const list = minutesBy.get(id) ?? [];
      list.push(minutesOf(lesson.endTime) - minutesOf(lesson.startTime));
      minutesBy.set(id, list);
    }
    if (teachers.has(id)) {
      const list = teachersBy.get(id) ?? [];
      list.push(lesson.teacherId ?? null);
      teachersBy.set(id, list);
    }
  }
  // Delade lektioner: the same teachers as sent, as many lessons each.
  const sameTeachers = (sent: readonly (string | null)[], got: readonly (string | null)[]): boolean => {
    const key = (list: readonly (string | null)[]) => list.map((id) => id ?? '').sort().join(',');
    return sent.length === got.length && key(sent) === key(got);
  };
  const sameLengths = (sent: readonly number[], got: readonly number[]): boolean => {
    const a = [...sent].sort((x, y) => y - x);
    const b = [...got].sort((x, y) => y - x);
    return a.length === b.length && a.every((minutes, i) => minutes === b[i]);
  };
  const offTarget = [...wanted].filter(
    ([id, count]) =>
      (placedBy.get(id) ?? 0) !== count ||
      (lengths.has(id) && !sameLengths(lengths.get(id)!, minutesBy.get(id) ?? [])) ||
      (teachers.has(id) && !sameTeachers(teachers.get(id)!, teachersBy.get(id) ?? [])),
  ).length;
  const requested = [...wanted.values()].reduce((sum, count) => sum + count, 0);
  return { requested, placed, unmatched, offTarget };
}

/**
 * The demand sent, in real ids, and each mirrored post's beside it: the
 * lessons its leader post was sent with, which an answer places once for the
 * leader and mirrorLessons once more for each follower. Every sent entry's
 * anonymous id came out of the map, so each has a real one; the fallback can
 * only be reached by a broken map, and then names nothing an answer could
 * match, which refuses the answer.
 */
function demandOf(
  sent: readonly AnonymousRequirement[],
  realRequirement: ReadonlyMap<string, string>,
  mirrors: readonly Mirror[],
  /** SplitLessons.realTeacher: anonymous → real, for the lists sent. */
  realTeacher: ReadonlyMap<string, string> = new Map(),
  rows: readonly RegenerationRequirementRow[] = [],
): RegenerationDemand[] {
  const sharesOf = new Map(rows.flatMap((row) => (row.shares && row.shares.length > 0 ? [[row.id, row.shares] as const] : [])));
  const demand: RegenerationDemand[] = sent.map((requirement) => {
    const requirementId = realRequirement.get(requirement.id) ?? `unsent:${requirement.id}`;
    const shares = sharesOf.get(requirementId);
    return {
      requirementId,
      lessonsPerWeek: requirement.lessonsPerWeek,
      ...(requirement.lessonLengths ? { lessonLengths: requirement.lessonLengths } : {}),
      ...(requirement.lessonTeacherIds
        ? {
            lessonTeachers: requirement.lessonTeacherIds.map((anon) =>
              anon === null ? null : (realTeacher.get(anon) ?? `unsent:${anon}`),
            ),
          }
        : {}),
      ...(shares ? { shareKey: shareKeyOf(shares) } : {}),
    };
  });
  const byId = new Map(demand.map((entry) => [entry.requirementId, entry]));
  for (const mirror of mirrors) {
    const leader = byId.get(mirror.leaderId);
    if (leader) demand.push({ ...leader, requirementId: mirror.followerId });
  }
  return demand;
}

/**
 * The mirrored posts as the basis reads them: which post's times each takes,
 * and what it is written with — its group and teachers — none of which the
 * payload carries for a post it does not send.
 */
function mirroredRowsOf(
  mirrors: readonly Mirror[],
  rows: readonly RegenerationRequirementRow[],
): MirroredRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return mirrors.flatMap((mirror) => {
    const row = byId.get(mirror.followerId);
    return row
      ? [
          {
            id: row.id,
            mirrorOf: mirror.leaderId,
            subjectId: row.subjectId,
            studentGroupId: row.studentGroupId,
            teacherId: row.teacherId,
            coTeacherId: row.coTeacherId,
          },
        ]
      : [];
  });
}

/**
 * The engine's lessons in real ids. An unknown requirement id becomes null —
 * kept, so the guard counts it — and an unknown room no room, as persist has
 * always read it.
 */
function resolveLessons(
  lessons: readonly AiEngineLesson[],
  requirementAnonMap: ReadonlyMap<string, string>,
  roomAnonMap: ReadonlyMap<string, string>,
  split: SplitLessons = NO_SPLIT,
): ResolvedLesson[] {
  const realRequirement = reversed(requirementAnonMap);
  const realRoom = reversed(roomAnonMap);
  const { requirementIds: splitIds, realTeacher, soleTeacher } = split;
  return lessons.map((lesson) => ({
    requirementId: realRequirement.get(lesson.requirementId) ?? null,
    roomId: lesson.roomId ? (realRoom.get(lesson.roomId) ?? null) : null,
    dayOfWeek: lesson.dayOfWeek,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    // Delade lektioner: a lesson of a post sent with its teachers carries its
    // own — null where the engine named none (that lesson's teacher was
    // deleted), and an id this request never sent as one it cannot match.
    ...(splitIds.has(lesson.requirementId)
      ? {
          teacherId:
            lesson.teacherId === undefined ? null : (realTeacher.get(lesson.teacherId) ?? `unsent:${lesson.teacherId}`),
        }
      : soleTeacher.has(lesson.requirementId)
        ? { teacherId: soleTeacher.get(lesson.requirementId)! }
        : {}),
  }));
}

/** realId → anonId, turned round. */
function reversed(map: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...map].map(([realId, anonId]) => [anonId, realId]));
}

/** The engine's HH:MM:SS as the HH:MM a candidate is stored in (the solver's grid has no seconds). */
function withoutSeconds(clock: string): string {
  return /^\d{2}:\d{2}/.test(clock) ? clock.slice(0, 5) : clock;
}

/** HH:MM as the HH:MM:SS the payload's clocks carry. */
function withSeconds(clock: string): string {
  return /^\d{2}:\d{2}$/.test(clock) ? `${clock}:00` : clock;
}

/** A foreign key the write met that no longer holds (a room deleted under it, say). */
function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2003') return true;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '23503';
}

/**
 * The engine's validation refusal of exactly `search` as an unknown field:
 * {details: {errors: [{type: 'extra_forbidden', loc: ['body', 'search']}]}}.
 */
function refusesSearch(body: { details?: { errors?: unknown } | null } | null): boolean {
  const errors = body?.details?.errors;
  return (
    Array.isArray(errors) &&
    errors.some((entry: unknown) => {
      const { type, loc } = (entry ?? {}) as { type?: unknown; loc?: unknown };
      return (
        type === 'extra_forbidden' &&
        Array.isArray(loc) &&
        loc.length === 2 &&
        loc[0] === 'body' &&
        loc[1] === 'search'
      );
    })
  );
}

/** Two sorted id lists, element by element. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The engine refuses a request carrying `search` — it is older than the field. */
export const ENGINE_LACKS_CANDIDATES = 'ENGINE_LACKS_CANDIDATES';

/**
 * The most groupConflicts pairs the engine takes in one request
 * (OptimizeScheduleRequest.group_conflicts, max_length in
 * optimization-engine/app/schemas/schedule.py). Ersättande grupper adds pairs
 * for each derived key, and a large school's week could pass the limit; the
 * engine would then answer a nameless 422. The gateway refuses it first, by
 * name (GROUP_CONFLICTS_OVER_ENGINE_LIMIT), with nothing sent or written.
 */
export const ENGINE_GROUP_CONFLICTS_LIMIT = 5000;
export const GROUP_CONFLICTS_OVER_ENGINE_LIMIT = 'GROUP_CONFLICTS_OVER_ENGINE_LIMIT';

/** The refusal for a week whose pairs pass the engine's limit; English as in messages.py. */
export function groupConflictsRefusal(pairs: number): AiEngineConflictAnalysis {
  return {
    summary:
      `The groups that share pupils make ${pairs} pairs, more than the ${ENGINE_GROUP_CONFLICTS_LIMIT} the ` +
      'timetable engine takes in one run, so the week was not sent. Fewer groups that share pupils, or fewer ' +
      'replacing groups, bring the number down.',
    summaryCode: GROUP_CONFLICTS_OVER_ENGINE_LIMIT,
    summaryParams: { pairs, limit: ENGINE_GROUP_CONFLICTS_LIMIT },
    conflicts: [],
  };
}

@Injectable()
export class OptimizationProxyService {
  private readonly logger = new Logger(OptimizationProxyService.name);
  private readonly aiConfig: AiEngineConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.getOrThrow<AiEngineConfig>('aiEngine');
  }

  async triggerScheduling(
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights | null,
    rules?: ScheduleRules | null,
  ): Promise<AiEngineScheduleResponse> {
    const requestId = randomUUID();

    this.logger.log(
      `Optimization requested [requestId=${requestId}, academicYearId=${academicYearId}]`,
    );

    // Step 1: Fetch raw data under the authenticated user's RLS session —
    // prepareSchedule, the step a schemaförslag run shares. The staffing
    // pre-flight and the block judgement run in it, in the same transaction:
    // a school whose policy refuses to generate around a teacherless row, or
    // a block whose lessons are partly locked, is answered before the engine
    // is woken, and nothing is written — see unstaffedRefusal and judgeBlocks.
    const prepared = await this.prisma.withRls(user, (tx) =>
      this.prepareSchedule(tx, academicYearId, user, { requestId }),
    );
    if (!prepared.ready) {
      if (prepared.error) {
        this.logger.warn(
          `Optimization refused before the engine: two blocks on the same times no longer fit together (${prepared.refusalCode}) [requestId=${requestId}, academicYearId=${academicYearId}]`,
        );
        throw prepared.error;
      }
      if (prepared.refusalCode === STAFF_UNSTAFFED_REQUIREMENTS) {
        this.logger.warn(
          `Optimization refused before the engine: ${prepared.refusal.conflicts?.summaryParams?.count ?? 0} requirement(s) without a teacher [requestId=${requestId}, academicYearId=${academicYearId}]`,
        );
      } else {
        this.logger.warn(
          `Optimization refused before the engine: ${prepared.refusal.conflicts?.conflicts.length ?? 0} block(s) partly locked [requestId=${requestId}, academicYearId=${academicYearId}]`,
        );
      }
      return prepared.refusal;
    }
    const { anonMaps } = prepared;

    // The school's saved lunch rules, unless this caller brought their own.
    // Body-wins rather than merge-per-field: two half-specified rule sets
    // silently combining into a third nobody wrote is worse than either.
    const effectiveRules = rules ?? prepared.storedRules;

    const payload: AiEngineScheduleRequest = {
      ...prepared.payload,
      ...(weights ? { weights } : {}),
      ...(effectiveRules ? { rules: effectiveRules } : {}),
    };

    // Step 2: Call the AI engine with the stripped payload. When every
    // requirement is already covered by locked lessons there is nothing left
    // to solve — skip the engine and just clean up unlocked leftovers.
    const response: AiEngineScheduleResponse =
      payload.requirements.length > 0
        ? await this.callAiEngine<AiEngineScheduleResponse>('/v1/schedule', payload, anonMaps)
        : { requestId, status: 'FEASIBLE', lessons: [], conflicts: null };

    // The sittings, with real group ids, computed once: they are both written
    // below and returned to the caller. Null when the engine was not asked.
    const realisedLunches = this.realiseLunches(response, anonMaps.groupAnonMap);
    if (realisedLunches === null) {
      this.logger.warn(
        `Engine skipped (every requirement is hand-placed); the previous run's sittings stand [academicYearId=${academicYearId}].`,
      );
    }

    // Step 3: Persist the master-lesson output, translating anon ids back.
    // The demand rides along as what the response is checked against before
    // anything is deleted, the mirrors as the posts written at their leader
    // posts' times, and the draft's ids as what the fetch saw — see
    // persistMasterLessons.
    const written = await this.prisma.withRls(user, (tx) =>
      this.persistMasterLessons(
        tx,
        academicYearId,
        user,
        response,
        prepared.demand,
        prepared.mirrors,
        anonMaps.requirementAnonMap,
        anonMaps.roomAnonMap,
        realisedLunches,
        prepared.headcountByGroup,
        prepared.draftIds,
        prepared.splitLessons,
      ),
    );

    this.logger.log(
      `Optimization complete [requestId=${requestId}, status=${response.status}, ` +
        `lessons=${response.lessons.length}, lunches=${response.lunches?.length ?? 0}]`,
    );

    // The sittings and the refusal leave this method carrying REAL ids and
    // the school's own names. Everything the engine sees is anonymised, so a
    // caller handed the raw reply would get uuids that exist in no table.
    //
    // And the free-day wishes the timetable just written does not keep, read
    // off the timetable persist left: what it wrote and what it kept, as they
    // stood when it wrote — see unkeptFreeDayWishes. None when nothing was
    // written: a refused week keeps last week's timetable, and the wishes it
    // broke were said when it was made.
    return {
      ...response,
      lunches: realisedLunches ?? [],
      conflicts: this.realiseConflicts(response.conflicts, anonMaps),
      notes: written === null ? [] : unkeptFreeDayWishes(prepared.freeDayWishes, written),
    };
  }

  /**
   * THE FETCH OF A REGENERATION, shared by Generera and a schemaförslag run
   * (and rebuilt by the apply, and by its staleness check): the year's
   * rosters, the staffing pre-flight, the anonymised payload, the block
   * judgement, the draft's own lessons and the basis over all of it, in the
   * caller's transaction.
   *
   * A refusal comes back as one ({ ready: false }), realised exactly as
   * triggerScheduling has always answered it, so a candidate run and an apply
   * read the same code the job row stores.
   *
   * `coverage: true` adds the timplan rows the "unplaced" figure needs; only a
   * candidate run asks, since it is six more reads.
   */
  async prepareSchedule(
    tx: PrismaClient,
    academicYearId: string,
    user: AuthenticatedUser,
    options: { requestId?: string; coverage?: boolean } = {},
  ): Promise<PrepareResult> {
    const requestId = options.requestId ?? randomUUID();
    // Whose classes these are: for a rolled year not yet activated, the
    // pupils its activation would place (projected-rosters.ts), so next
    // year's timetable can be generated in spring. A year two steps ahead
    // is still refused there (ROLLOVER_NOT_ACTIVATED, R6): walking straight
    // through an unactivated year is not what activating it does.
    const rosterBasis = await rostersOfYear(tx, user, academicYearId);
    const schoolId = requireSchoolId(user);
    const unstaffed = await this.unstaffedRefusal(tx, academicYearId, schoolId, requestId);
    if (unstaffed) {
      return {
        ready: false,
        requestId,
        academicYearId,
        refusal: unstaffed,
        refusalCode: unstaffed.conflicts?.summaryCode ?? STAFF_UNSTAFFED_REQUIREMENTS,
      };
    }
    const data = await this.fetchAndAnonymize(tx, academicYearId, schoolId, rosterBasis, user.channel);
    const anonMaps: AnonMaps = {
      // The numberings a refusal's årskurser are named back in (yearGrades).
      gradeNumbering: data.gradeNumbering,
      numberingOnDay: data.numberingOnDay,
      requirementAnonMap: data.requirementAnonMap,
      roomAnonMap: data.roomAnonMap,
      groupAnonMap: data.groupAnonMap,
      roomTypeAnonMap: data.roomTypeAnonMap,
      constraintAnonMap: data.constraintAnonMap,
      workRuleAnonMap: data.workRuleAnonMap,
      blockAnonMap: data.blockAnonMap,
      dayLimitAnonMap: data.dayLimitAnonMap,
      dayLimitTeacherIds: data.dayLimitTeacherIds,
      // Only when the walk was sent: no other sentence names a teacher.
      travelTeacherIds:
        data.siteTravelTimes.length > 0 ? reversed(data.teacherAnonMap) : new Map<string, string>(),
      nameById: data.nameById,
    };

    // A block whose lessons are partly locked is refused here, by name, for
    // the reason unstaffedRefusal gives for its own: the engine is not woken,
    // nothing is written, and the grundschema stands. See judgeBlocks.
    if (data.blockRefusal) {
      return {
        ready: false,
        requestId,
        academicYearId,
        refusal: {
          requestId,
          status: 'INFEASIBLE',
          lessons: [],
          lunches: [],
          conflicts: this.realiseConflicts(data.blockRefusal, anonMaps),
        },
        refusalCode: data.blockRefusal.summaryCode,
      };
    }
    // More pairs than the engine takes: refused here by name, as above, so a
    // large school meets a sentence and not the engine's nameless 422.
    if (data.pairsRefusal) {
      return {
        ready: false,
        requestId,
        academicYearId,
        refusal: {
          requestId,
          status: 'INFEASIBLE',
          lessons: [],
          lunches: [],
          conflicts: this.realiseConflicts(data.pairsRefusal, anonMaps),
        },
        refusalCode: data.pairsRefusal.summaryCode,
      };
    }
    // Two blocks on the same times that no longer fit together: refused as
    // the engine refuses a block it cannot hold, nothing solved or written.
    // Returned, as the refusals above are, so the transaction commits what it
    // read (the Läslogg's row) and a schemaförslag's check and apply answer
    // with the code; Generera throws the 400.
    if (data.sameTimesRefusal) {
      const body = data.sameTimesRefusal.getResponse() as {
        message: string;
        code: string;
        params: Record<string, string | number>;
      };
      return {
        ready: false,
        requestId,
        academicYearId,
        refusal: {
          requestId,
          status: 'INFEASIBLE',
          lessons: [],
          lunches: [],
          conflicts: { summary: body.message, summaryCode: body.code, summaryParams: body.params, conflicts: [] },
        },
        refusalCode: body.code,
        error: data.sameTimesRefusal,
      };
    }

    // The draft's own lessons: the machine-owned masters a regeneration
    // replaces (the complement of PRESERVED_FROM_REGENERATION, parked ones
    // included, since the delete takes them too). Their ids are what Generera
    // checks again under the year lock before it deletes (GENERATE_STALE) and
    // what an apply deletes by; their content is what "moved" is counted
    // against and part of the basis.
    const draftRows = await tx.masterLesson.findMany({
      where: { academicYearId, NOT: { OR: PRESERVED_FROM_REGENERATION } },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        recurrence: true,
        startDate: true,
        endDate: true,
        isParked: true,
      },
    });
    const draftLessons: DraftLesson[] = draftRows.map((row) => ({
      id: row.id,
      subjectId: row.subjectId,
      studentGroupId: row.studentGroupId,
      teacherId: row.teacherId ?? null,
      coTeacherId: row.coTeacherId ?? null,
      roomId: row.roomId ?? null,
      dayOfWeek: row.dayOfWeek,
      startTime: clockOf(row.startTime) ?? '',
      endTime: clockOf(row.endTime) ?? '',
      recurrence: row.recurrence ?? null,
      startDate: dayOf(row.startDate),
      endDate: dayOf(row.endDate),
      isParked: row.isParked ?? false,
    }));

    const payload: PreparedPayload = {
      requestId,
      academicYearId,
      requirements: data.requirements,
      rooms: data.rooms,
      constraints: data.constraints,
      frameTimes: data.frameTimes,
      lunchServings: data.lunchServings,
      lunchPlacements: data.lunchPlacements,
      rasts: data.rasts,
      roomPreferences: data.roomPreferences,
      teacherWorkRules: data.teacherWorkRules,
      // Only when somebody's post limits their days: see AiEngineScheduleRequest.
      ...(data.teacherDayLimits.length > 0 ? { teacherDayLimits: data.teacherDayLimits } : {}),
      fixedLessons: data.fixedLessons,
      groups: data.groups,
      previousLessons: data.previousLessons,
      groupConflicts: data.groupConflicts,
      // Restid i generatorn: only when the school turned the walk on and has a
      // figure, the rooms then carrying their sites. See AiEngineScheduleRequest.
      ...(data.siteTravelTimes.length > 0 ? { siteTravelTimes: data.siteTravelTimes } : {}),
    };

    // Over the payload turned back to real ids — the teacher's and the
    // subject's maps too, which leave this method no further — so two reads of
    // an unchanged school agree although every anonymous id differs.
    const basisParts = basisPartsOf(
      basisInputsOf({
        payload,
        maps: [
          data.requirementAnonMap,
          data.subjectAnonMap,
          data.groupAnonMap,
          data.teacherAnonMap,
          data.roomAnonMap,
          data.roomTypeAnonMap,
          data.constraintAnonMap,
          data.workRuleAnonMap,
          data.blockAnonMap,
          data.dayLimitAnonMap,
          data.siteAnonMap,
        ],
        storedRules: data.storedRules,
        draftLessons,
        mirrors: mirroredRowsOf(data.mirrors, data.requirementRows),
      }),
    );

    const realRequirement = reversed(data.requirementAnonMap);
    const splitLessons = splitLessonsOf(data.requirements, data.teacherAnonMap, data.soleTeachers);
    return {
      ready: true,
      requestId,
      academicYearId,
      schoolId,
      payload,
      storedRules: data.storedRules,
      anonMaps,
      freeDayWishes: data.freeDayWishes,
      keptTimetable: data.preservedRows.map((row) => ({
        teacherId: row.teacherId,
        coTeacherId: row.coTeacherId,
        dayOfWeek: row.dayOfWeek,
      })),
      headcountByGroup: data.headcountByGroup,
      demand: demandOf(data.requirements, realRequirement, data.mirrors, splitLessons.realTeacher, data.requirementRows),
      mirrors: data.mirrors,
      requirementRows: data.requirementRows,
      splitLessons,
      basis: basisOf(basisParts),
      basisParts,
      draftIds: sortedIds(draftLessons.map((lesson) => lesson.id)),
      draftLessons,
      coverage: options.coverage
        ? await this.readCoverageBase(tx, academicYearId, data.preservedRows, draftLessons)
        : null,
    };
  }

  /**
   * The timplan rows layer 2 judges against (readPlannedRows, the reader the
   * coverage page and the publish gate share), with the year's own lessons
   * split into what every candidate keeps and what the draft has now. No
   * roster is read: group lines need none, and no pupil id is carried.
   */
  private async readCoverageBase(
    tx: PrismaClient,
    academicYearId: string,
    preservedRows: PreservedLessonRow[],
    draftLessons: readonly DraftLesson[],
  ): Promise<CoverageBase | null> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { startDate: true, endDate: true },
    });
    if (!year) return null;
    const rows = await readPlannedRows(tx, academicYearId);
    return {
      year: { startDate: dayOf(year.startDate) ?? '', endDate: dayOf(year.endDate) ?? '' },
      closures: rows.closures,
      subjects: rows.subjects,
      groups: rows.groups,
      requirements: rows.requirements,
      preservedLessons: preservedRows.map((row) => ({
        id: row.id,
        studentGroupId: row.studentGroupId,
        subjectId: row.subjectId,
        startTime: clockOf(row.startTime) ?? '',
        endTime: clockOf(row.endTime) ?? '',
        recurrence: row.recurrence ?? null,
        startDate: dayOf(row.startDate),
        endDate: dayOf(row.endDate),
        isParked: false,
        extraGroupIds: (row.extraGroups ?? []).map((entry) => entry.studentGroupId),
        studentIds: [],
      })),
      // No extra groups and no named pupils: a lesson with either is preserved.
      draftLessons: draftLessons.map((lesson) => ({
        id: lesson.id,
        studentGroupId: lesson.studentGroupId,
        subjectId: lesson.subjectId,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        recurrence: lesson.recurrence,
        startDate: lesson.startDate,
        endDate: lesson.endDate,
        isParked: lesson.isParked,
        extraGroupIds: [],
        studentIds: [],
      })),
    };
  }

  /**
   * ONE CANDIDATE: the prepared fetch sent with this candidate's weights,
   * search and hints, and the answer brought back in real ids.
   *
   * No transaction and no write: a candidate is stored by its run, and only an
   * apply writes. The answer is judged by the guard persist applies
   * (checkAgainstDemand) — one that does not carry exactly the demand sent
   * comes back `rejected` with no lessons, and the run stores it as REJECTED
   * instead of a timetable that answers some other request.
   *
   * Every failure of the call itself is callAiEngine's: a timeout or an
   * unreachable engine is a 503, an engine older than `search` a 503
   * ENGINE_LACKS_CANDIDATES, a refusal its own status and code.
   */
  async solveCandidate(
    prepared: PreparedSchedule,
    options: SolveCandidateOptions,
  ): Promise<CandidateSolution> {
    const { storedRules, anonMaps } = prepared;
    const payload: AiEngineScheduleRequest = {
      ...prepared.payload,
      // Its own correlation id per call: several requests of one fetch.
      requestId: randomUUID(),
      previousLessons: options.previousLessons
        ? [...options.previousLessons]
        : prepared.payload.previousLessons,
      ...(options.weights ? { weights: options.weights } : {}),
      ...(storedRules ? { rules: storedRules } : {}),
      ...(options.search ? { search: options.search } : {}),
    };
    // Nothing left to place: the same shortcut Generera takes, and the same
    // answer — no lessons, and no sittings to replace the stored ones with.
    if (payload.requirements.length === 0) {
      return { status: 'FEASIBLE', lessons: [], lunches: null, conflicts: null };
    }

    const response = await this.callAiEngine<AiEngineScheduleResponse>(
      '/v1/schedule',
      payload,
      anonMaps,
      { timeoutMs: options.timeoutMs },
    );
    const conflicts = this.realiseConflicts(response.conflicts, anonMaps);
    if (response.status === 'INFEASIBLE' || response.status === 'TIMEOUT') {
      return { status: response.status, lessons: [], lunches: null, conflicts };
    }

    const resolved = mirrorLessons(
      resolveLessons(response.lessons, anonMaps.requirementAnonMap, anonMaps.roomAnonMap, prepared.splitLessons),
      prepared.mirrors,
    );
    const verdict = checkAgainstDemand(
      resolved,
      prepared.demand,
      new Set(prepared.requirementRows.map((row) => row.id)),
    );
    if (verdict.unmatched > 0 || verdict.offTarget > 0) {
      this.logger.warn(
        `Rejected AI engine candidate [academicYearId=${prepared.academicYearId}, status=${response.status}, requestedLessons=${verdict.requested}, placedLessons=${verdict.placed}, unmatchedLessons=${verdict.unmatched}, requirementsOffTarget=${verdict.offTarget}].`,
      );
      return { status: response.status, lessons: [], lunches: null, conflicts, rejected: true };
    }
    return {
      status: response.status,
      lessons: resolved.map((lesson) => ({
        requirementId: lesson.requirementId as string,
        roomId: lesson.roomId,
        dayOfWeek: lesson.dayOfWeek,
        startTime: withoutSeconds(lesson.startTime),
        endTime: withoutSeconds(lesson.endTime),
        // Only on a lesson of a shared post, so a candidate of a school that
        // shares nothing is stored byte for byte as it always was.
        ...(lesson.teacherId !== undefined ? { teacherId: lesson.teacherId } : {}),
      })),
      lunches: this.realiseLunches(response, anonMaps.groupAnonMap),
      conflicts,
    };
  }

  /**
   * THE APPLY'S WRITE (design §4 steps 7–10), in the caller's transaction,
   * after the caller has taken the locks (enterGrundschemaWrite, then
   * lockYearForCandidateApply, then lockYearMasters), re-loaded its run and
   * found the rebuilt basis equal to the stored one.
   *
   *  7. The safety version, before the first write and in this transaction,
   *     so a refused apply leaves no version promising a change that never
   *     happened.
   *  8. The shared write, scoped to exactly the ids the rebuilt fetch saw; a
   *     different number deleted means the draft moved under the apply.
   *  9. Before the change log: no machine-owned lesson of the year is left
   *     but the ones just created, and the preserved lessons are still, by
   *     content, the ones the candidate was solved around. Either failing is
   *     409 SCHEDULE_CANDIDATE_STALE, and the transaction rolls back whole.
   *     What is left open is a hand INSERT committing after these reads and
   *     before the commit — the window Generera has always had.
   * 10. The REGENERATE entry, with the caller's `after` (source, run,
   *     candidate, metrics) under the counts.
   *
   * A deadlock or a foreign key the write meets (40P01, P2003/23503) and a
   * lock wait past the 5 s are 409 SCHEDULE_CANDIDATE_BUSY.
   */
  async applyCandidateWrite(tx: PrismaClient, input: CandidateApplyInput): Promise<CandidateApplyResult> {
    const { prepared, user } = input;
    const schoolId = requireSchoolId(user);
    const { academicYearId } = prepared;
    try {
      const version = await input.snapshot.versions.snapshotInTransaction(
        tx,
        academicYearId,
        input.snapshot.name,
        user,
      );
      const { timetable: _timetable, ...counts } = await this.writeRegeneration(tx, {
        schoolId,
        academicYearId,
        actorId: user.userId ?? null,
        mode: input.mode,
        solverStatus: input.solverStatus,
        lessons: input.lessons,
        demand: prepared.demand,
        requirementRows: prepared.requirementRows,
        lunches: input.lunches,
        headcountByGroup: prepared.headcountByGroup,
        scope: { kind: 'IDS', ids: prepared.draftIds },
        after: { ...input.after, safetyVersionId: version.id },
        // A basis that matched cannot meet either; if one is met anyway, the
        // draft is not what the basis says it is.
        refusals: {
          mismatch: () => scheduleCandidateStale(['requirements']),
          scopeChanged: () => scheduleCandidateStale(['draft']),
        },
        verify: async (created) => {
          const machineOwned = await tx.masterLesson.count({
            where: { academicYearId, NOT: { OR: PRESERVED_FROM_REGENERATION } },
          });
          if (machineOwned !== created) throw scheduleCandidateStale(['draft']);
          const preserved = await tx.masterLesson.findMany({
            where: { academicYearId, isParked: false, OR: PRESERVED_FROM_REGENERATION },
            select: {
              studentGroupId: true,
              teacherId: true,
              coTeacherId: true,
              roomId: true,
              dayOfWeek: true,
              startTime: true,
              endTime: true,
              extraGroups: { select: { studentGroupId: true } },
            },
          });
          if (preservedPartOf(preserved) !== prepared.basisParts.preserved) {
            throw scheduleCandidateStale(['preserved']);
          }
        },
      });
      return { versionId: version.id, ...counts };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isLockTimeout(error) || isWriteConflict(error) || isForeignKeyViolation(error)) {
        throw scheduleBusy(SCHEDULE_CANDIDATE_BUSY);
      }
      throw error;
    }
  }

  /**
   * The engine's refusal with its ids turned back and its classes named.
   *
   * Ids inside the text go back to real ones through deanonymise, and a
   * group's real id goes one step further, to the name the school gave it:
   * "student group 4A", not a uuid in either id space. The ids in
   * resourceIds are mapped back the same way and, for groups, ALSO returned
   * as resourceNames. The lunch stage's lines say "the classes named here"
   * and carry the classes only in that field — which, until this, no layer
   * mapped back and no screen showed, so a school read "0 class(es)" one
   * week and "the classes named here" with nobody named the next.
   */
  private realiseConflicts(
    conflicts: AiEngineConflictAnalysis | null | undefined,
    maps: AnonMaps,
  ): AiEngineConflictAnalysis | null {
    if (!conflicts) return null;
    // EVERY id space, not only the groups'. `resourceIds` is mixed: the lunch
    // lines put classes in it, and the reservation line puts whatever the
    // reservation is about — a teacher, a room or a class. Reversing the
    // group map alone left a teacher's anonymous uuid in the response and
    // silently gave that detail fewer names than ids.
    const realByAnon = new Map<string, string>();
    for (const map of [
      maps.groupAnonMap,
      maps.roomAnonMap,
      maps.requirementAnonMap,
      maps.roomTypeAnonMap,
      maps.constraintAnonMap,
      // The arbetstid a "teacher's lunch has nowhere to go" refusal names. It
      // belongs in this list and not only in deanonymise's: the rule's id also
      // travels in `resourceIds`, where an untranslated one is a uuid the school
      // can look up in no table — and no NAME will ever fill that slot for it,
      // since the teacher map is discarded by design.
      maps.workRuleAnonMap,
      // The block a block's sentence names, which `resourceIds` carries too.
      maps.blockAnonMap ?? new Map<string, string>(),
      // The post a deltid sentence names. In `resourceIds` it goes one step
      // further, to the post's teacher, below.
      maps.dayLimitAnonMap ?? new Map<string, string>(),
    ]) {
      for (const [realId, anonId] of map) realByAnon.set(anonId, realId);
    }
    const teacherOfPost = maps.dayLimitTeacherIds ?? new Map<string, string>();
    const summaryParams = this.namedParams(conflicts.summaryParams ?? {}, maps);
    const summaryBearsDays = isDaysBearing(conflicts.summaryCode);
    return {
      // A days-bearing sentence leaves without its figure: see work-days.ts.
      // The summary never is one today — the engine's summaries count causes
      // and name none — and is held to the same rule all the same, since it
      // is stored and shown like every line under it.
      summary: summaryBearsDays ? WORK_DAYS_HIDDEN_MESSAGE : this.named(conflicts.summary, maps),
      summaryCode: conflicts.summaryCode,
      summaryParams: summaryBearsDays ? withoutDays(summaryParams) : summaryParams,
      ...(summaryBearsDays ? { summarySubjectIds: this.limitSubjects(summaryParams, maps) } : {}),
      conflicts: conflicts.conflicts.map((detail) => {
        // A post's id goes on to its teacher's: the resource a deltid
        // sentence is about is the person, and so is the travel line's (just
        // below); nothing else in this list is ever a Users id. Never named
        // here — see nameById — and never stored: the stored refusal keeps no
        // resourceIds, and the reader is told whose post it is only when they
        // read HR, whose walk it is when anyone reads it
        // (OptimizationJobsService).
        const travelTeachers = maps.travelTeacherIds ?? new Map<string, string>();
        if (detail.code === TRAVEL_TEACHERS_CODE) {
          // The teachers who cannot make the walk, as Users ids kept beside
          // the sentence and named when it is read; never a name stored here.
          const teachers = detail.resourceIds
            .map((anonId) => travelTeachers.get(anonId))
            .filter((id): id is string => id !== undefined);
          return {
            ...detail,
            message: this.named(detail.message, maps),
            params: this.namedParams(detail.params ?? {}, maps),
            resourceIds: teachers,
            resourceNames: [],
            subjectIds: teachers,
          };
        }
        const resourceIds = detail.resourceIds.map((anonId) => {
          const realId = realByAnon.get(anonId) ?? anonId;
          return teacherOfPost.get(realId) ?? realId;
        });
        const params = this.namedParams(detail.params ?? {}, maps);
        const realised = {
          ...detail,
          message: this.named(detail.message, maps),
          params: yearGrades(detail.code, params, maps),
          resourceIds,
          // Only the ones there IS a name for. A teacher is deliberately
          // absent — see nameById — so a reservation about one names the
          // reservation in its sentence and nobody in this list.
          resourceNames: resourceIds
            .map((realId) => maps.nameById.get(realId))
            .filter((name): name is string => name !== undefined),
        };
        if (!isDaysBearing(detail.code)) return realised;
        return {
          ...realised,
          params: withoutDays(params),
          message: WORK_DAYS_HIDDEN_MESSAGE,
          subjectIds: this.limitSubjects(params, maps),
        };
      }),
    };
  }

  /**
   * The teacher whose post a days sentence names, by its `limit` param once
   * that is the post's real id again: the Users id the Läslogg records and
   * the job store keeps beside the sentence. Empty when the sentence names no
   * post this run sent, which then stays hidden from every reader.
   */
  private limitSubjects(params: Record<string, string | number>, maps: AnonMaps): string[] {
    const teacher = maps.dayLimitTeacherIds?.get(String(params['limit']));
    return teacher === undefined ? [] : [teacher];
  }

  /**
   * The generate pre-flight: STAFF_UNSTAFFED_REQUIREMENTS, or null to go on.
   *
   * A week solved for a timplanspost with no teacher is a week nobody can
   * teach: the engine places the row with no teacher constraint at all, and the
   * school finds out on the first Monday. Whether to start anyway is the
   * school's call — StaffingPolicy.unstaffedGeneration, ALLOW by default, which
   * is today's behaviour — and REFUSE answers here, before the payload is built
   * or the engine is woken.
   *
   * THROUGH realiseConflicts, AS AN ENGINE REFUSAL WOULD COME BACK. The rows
   * get anonymous ids and the refusal names them by those, exactly as the
   * engine's own refusals do, and the same path that turns an engine refusal
   * into the school's words turns these into "Matematik för 7B" in
   * resourceNames — the name the Timplan page gives the cell. So the job row,
   * the generate page and the history read this refusal the way they read
   * every other, with no second route for one code. Never a person: the
   * sentence counts rows, and the names are a subject and a group.
   *
   * Status INFEASIBLE because that is what the reply means to everything
   * downstream — no lessons came back, persistMasterLessons writes nothing and
   * the school's grundschema stands — and the summaryCode says why it was not
   * the solver that decided.
   */
  private async unstaffedRefusal(
    tx: PrismaClient,
    academicYearId: string,
    schoolId: string,
    requestId: string,
  ): Promise<AiEngineScheduleResponse | null> {
    const policy = await tx.staffingPolicy.findUnique({
      where: { schoolId },
      select: { unstaffedGeneration: true },
    });
    if (policy?.unstaffedGeneration !== 'REFUSE') return null;
    const unstaffed = await readUnstaffedRequirements(tx, academicYearId);
    if (unstaffed.length === 0) return null;

    const requirementAnonMap = new Map<string, string>();
    const nameById = new Map<string, string>();
    const named = unstaffed
      .map((row) => ({ id: row.id, name: requirementName(row.subject.name, row.studentGroup.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.id.localeCompare(b.id));
    for (const row of named) {
      requirementAnonMap.set(row.id, randomUUID());
      nameById.set(row.id, row.name);
    }
    const anonIds = [...requirementAnonMap.values()];
    const params = { count: named.length };
    // The catalogue's English (optimization-engine/app/messages.py), rendered
    // here because the engine never sees this refusal; the web renders the
    // Swedish from the code and params.
    const message =
      `${named.length === 1 ? '1 requirement has' : `${named.length} requirements have`} no teacher, ` +
      `and the school's staffing policy refuses to generate a timetable until every requirement has one. ` +
      `Staff the requirements named here, or allow generation without a teacher in the staffing settings.`;
    const conflicts: AiEngineConflictAnalysis = {
      summary: message,
      summaryCode: STAFF_UNSTAFFED_REQUIREMENTS,
      summaryParams: params,
      conflicts: [
        {
          category: 'INSUFFICIENT_RESOURCES',
          code: STAFF_UNSTAFFED_REQUIREMENTS,
          params,
          message,
          requirementIds: anonIds,
          roomIds: [],
          constraintIds: [],
          resourceIds: anonIds,
        },
      ],
    };
    return {
      requestId,
      status: 'INFEASIBLE',
      lessons: [],
      lunches: [],
      conflicts: this.realiseConflicts(conflicts, {
        requirementAnonMap,
        roomAnonMap: new Map(),
        groupAnonMap: new Map(),
        roomTypeAnonMap: new Map(),
        constraintAnonMap: new Map(),
        workRuleAnonMap: new Map(),
        nameById,
      }),
    };
  }

  /** An engine sentence with its ids turned back and its groups named. */
  private named(text: string, maps: AnonMaps): string {
    let out = this.deanonymise(text, maps);
    for (const [realId, name] of maps.nameById) out = out.split(realId).join(name);
    return out;
  }

  /**
   * The same substitution over the values a sentence carries.
   *
   * A param holding a group's id is an anonymous uuid, and the Swedish
   * sentence rendering it would otherwise name a row that exists in no table.
   * Numbers pass through untouched.
   */
  private namedParams(
    params: Record<string, string | number>,
    maps: AnonMaps,
  ): Record<string, string | number> {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        typeof value === 'string' ? this.named(value, maps) : value,
      ]),
    );
  }

  /**
   * The engine's sittings with their anonymous group ids turned back.
   *
   * A sitting whose group cannot be resolved is DROPPED, not passed through
   * with the anonymous id: the map is built from the same groups the payload
   * was assembled from, so an unresolvable id means the engine invented one,
   * and a lunch pointing at a group that does not exist is worse than no lunch
   * at all — it would be stored, drawn, and unexplainable.
   */
  private realiseLunches(
    response: AiEngineScheduleResponse,
    groupAnonMap: Map<string, string>,
  ): AiEngineLunch[] | null {
    // No `lunches` at all is not the same as none: the engine answers with
    // a list — empty when the school has no lunch rule — and only a reply
    // built here without calling it carries none. That reply must not wipe
    // the sittings: a week that is wholly hand-placed skips the engine, and
    // its classes still eat where the last run put them. (A panel found the
    // rows being deleted and nothing written.) Placing lunches around locked
    // lessons alone would need the engine to accept an empty timplan; until
    // it does, the last run's sittings stand and the log says so.
    if (response.lunches === undefined) return null;
    if (response.lunches.length === 0) return [];

    const realIdOf = new Map(
      [...groupAnonMap].map(([realId, anonId]) => [anonId, realId]),
    );
    const realised: AiEngineLunch[] = [];
    for (const lunch of response.lunches) {
      const studentGroupId = realIdOf.get(lunch.studentGroupId);
      if (!studentGroupId) {
        this.logger.warn(
          `Dropping a sitting for unknown group ${lunch.studentGroupId}.`,
        );
        continue;
      }
      realised.push({ ...lunch, studentGroupId });
    }
    return realised;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchAndAnonymize(
    tx: PrismaClient,
    academicYearId: string,
    schoolId: string,
    basis: RosterBasis,
    /** The reader's client, for the Läslogg row the days limits write. */
    channel?: AccessChannel | null,
  ): Promise<{
    requirements: AnonymousRequirement[];
    rooms: AnonymousRoom[];
    constraints: AnonymousConstraint[];
    frameTimes: AnonymousFrameTime[];
    lunchServings: AnonymousLunchServing[];
    lunchPlacements: AnonymousLunchPlacement[];
    rasts: AnonymousRast[];
    roomPreferences: AnonymousRoomPreference[];
    teacherWorkRules: AnonymousTeacherWorkRule[];
    /** Deltid in days; empty when no post the payload reaches sets it. */
    teacherDayLimits: AnonymousTeacherDayLimit[];
    fixedLessons: AnonymousFixedLesson[];
    groups: AnonymousGroup[];
    previousLessons: AnonymousPreviousLesson[];
    groupConflicts: [string, string][];
    /** Restid i generatorn: the walks, empty unless the school turned them on. */
    siteTravelTimes: AnonymousSiteTravelTime[];
    /** The sites the walks and the rooms name. Nothing in an answer names one. */
    siteAnonMap: Map<string, string>;
    roomAnonMap: Map<string, string>;
    requirementAnonMap: Map<string, string>;
    /**
     * Needed to read the sittings back. The comment above says only the room
     * and requirement maps are used to reverse the response — that was true
     * until the engine began returning lunches, which name a student group.
     */
    groupAnonMap: Map<string, string>;
    /** groupId → children who eat AS this group, for the stored sittings. */
    headcountByGroup: Map<string, number>;
    /** Needed to translate "required type X" in an engine refusal. */
    roomTypeAnonMap: Map<string, string>;
    /** And the reservation one names. */
    constraintAnonMap: Map<string, string>;
    /** And the arbetstid one names, which is the ONLY way back to that row. */
    workRuleAnonMap: Map<string, string>;
    /** And the post a days sentence names, back to the row. */
    dayLimitAnonMap: Map<string, string>;
    /** The post → its teacher, for whom a days sentence is about. Never sent. */
    dayLimitTeacherIds: Map<string, string>;
    /** Real group id → the school's name for it, for realiseConflicts. */
    nameById: Map<string, string>;
    /** Parallella block: the block a refusal names, back to the real one. */
    blockAnonMap: Map<string, string>;
    /** BLOCK_PARTLY_LOCKED, in anonymous ids, or null to go on. */
    blockRefusal: AiEngineConflictAnalysis | null;
    /** GROUP_CONFLICTS_OVER_ENGINE_LIMIT, or null to go on. */
    pairsRefusal: AiEngineConflictAnalysis | null;
    /** The follower posts written at their leader posts' times, in real ids (same-times.ts). */
    mirrors: Mirror[];
    /** Two blocks on the same times that no longer fit together, named; null to go on. */
    sameTimesRefusal: HttpException | null;
    storedRules: ScheduleRules | null;
    /** Every free-day wish of the school's teachers, in real ids. Never sent. */
    freeDayWishes: FreeDayWish[];
    /**
     * The teacher's and the subject's maps, which nothing turns an engine
     * answer back through. Returned for the basis alone (prepareSchedule),
     * which has to read the payload in real ids, and dropped there: a refusal
     * may name no person, so the teacher map never reaches AnonMaps. Its
     * reverse does, as travelTeacherIds, only when walks were sent: the walk's
     * line is turned into Users ids, which the job and candidate views name
     * at read time, never a name stored.
     */
    teacherAnonMap: Map<string, string>;
    subjectAnonMap: Map<string, string>;
    /** The timplansposter as read, for the lessons a write stamps from them. */
    requirementRows: RegenerationRequirementRow[];
    /**
     * Delade lektioner: a shared post sent WITHOUT lessonTeacherIds, because
     * the lessons left to place have one teacher — anonymous post → that
     * teacher, real id or null. Its lessons are that teacher's, not the lead's.
     */
    soleTeachers: Map<string, string | null>;
    /** The preserved, non-parked masters as read, without their named pupils. */
    preservedRows: PreservedLessonRow[];
    /** The läsår's numbering, for the refusals that echo a class span (yearGrades). */
    gradeNumbering: GradeNumbering;
    /** A day's läsår's numbering, for a dated årskursregel's echo (yearGrades). */
    numberingOnDay: (day: string) => GradeNumbering;
  }> {
    // Anonymous-id lookup tables: realId → anonId.
    const teacherAnonMap = new Map<string, string>();
    const roomAnonMap = new Map<string, string>();
    const groupAnonMap = new Map<string, string>();
    const subjectAnonMap = new Map<string, string>();
    const requirementAnonMap = new Map<string, string>();
    // Room types are school-authored names ("Trä- och metallslöjd"), so they
    // are anonymised like every other identifier: the solver only ever needs
    // to know that a room's type and a requirement's required type are the
    // SAME token, never what the school calls it.
    const roomTypeAnonMap = new Map<string, string>();
    const constraintAnonMap = new Map<string, string>();
    // The teacher's arbetstid. A map rather than a fresh uuid per row, and for
    // the reason spelled out where the constraint map is used: the engine puts
    // this id in the refusal it writes, and an id minted on the way out exists
    // in no table in either id space — not lookupable by the school, by this
    // gateway, or by a developer holding the database. It is the more important
    // here than anywhere else, because the refusal is about a PERSON and the
    // person's own map is deliberately thrown away.
    const workRuleAnonMap = new Map<string, string>();
    // Parallella block. A map for the reason the work rules have one: the
    // engine names the block in every sentence about it, and the id has to
    // come back to the row the school wrote.
    const blockAnonMap = new Map<string, string>();
    // Deltid in days, by the post that sets it. A map for the work rules'
    // reason, and a second one beside it for whose post it is: see the read.
    const dayLimitAnonMap = new Map<string, string>();
    const dayLimitTeacherIds = new Map<string, string>();
    const soleTeachers = new Map<string, string | null>();

    const anonId = (map: Map<string, string>, realId: string): string => {
      const existing = map.get(realId);
      if (existing) return existing;
      const id = randomUUID();
      map.set(realId, id);
      return id;
    };

    // Fetch teaching requirements (no PII fields selected). The subject's
    // required room type is an enum (not PII) and rides along for room
    // eligibility in the engine.
    const rawRequirements = await tx.teachingRequirement.findMany({
      where: { academicYearId },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        lessonsPerWeek: true,
        minutesPerLesson: true,
        // Lektionslängder: one length per lesson when they differ. Sent only
        // when the lessons still to be placed have two or more lengths.
        lessonLengths: true,
        // The pupil buffers. Numbers, not names, so they cross to the engine
        // like the lesson length beside them — and they are the class's own
        // occupancy, never the teacher's or the room's.
        minutesBefore: true,
        minutesAfter: true,
        // Ämnesfördelning: the row's own rule, when it carries one. The
        // subject's default rides on the subject join below.
        ownDistribution: true,
        maxLessonsPerDay: true,
        minDaysBetween: true,
        // Parallella block: the block the row runs in. Forwarded as an
        // anonymous id, and only for a block the engine can hold together —
        // see judgeBlocks.
        blockId: true,
        // Delade lektioner: the lessons other teachers take. Each lesson is
        // sent with its own teacher when the ones left to place have two or
        // more (lessonTeacherIds); a row nobody shares sends what it did.
        shares: {
          select: { teacherId: true, lessons: true, minutes: true },
          orderBy: [{ minutes: 'desc' }, { teacherId: 'asc' }],
        },
        // Never forwarded — the engine has no notion of weeks. Read here
        // because the subtraction below compares a preserved lesson's weeks
        // against these, and stamped on the lessons the run produces so a
        // spring-only requirement yields spring-only lessons.
        recurrence: true,
        startDate: true,
        endDate: true,
        // The names ride along on joins that were already being made. They
        // are never forwarded to the engine, which sees anonymous tokens
        // throughout; they are what a refusal is turned back into on its way
        // to the school — see realiseConflicts.
        subject: {
          select: {
            requiredRoomTypeId: true,
            name: true,
            requiredRoomType: { select: { name: true } },
            maxLessonsPerDay: true,
            minDaysBetween: true,
          },
        },
      },
    });

    // See PRESERVED_FROM_REGENERATION: these are the lessons regeneration must
    // not touch and must plan around. Those that cover a requirement's whole
    // period are subtracted from its weekly demand, so the solver re-places
    // only the machine-owned remainder.
    const preservedLessons = await tx.masterLesson.findMany({
      // A parked lesson is preserved like any hand-made one — regeneration
      // does not own it — but it is NOT sent as a fixed placement: it occupies
      // nothing, and blocking the engine out of a slot nobody is in would be
      // reading its memory of where it was as where it is.
      where: { academicYearId, isParked: false, OR: PRESERVED_FROM_REGENERATION },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        // Not forwarded as they are — the engine has no notion of weeks.
        // Selected because the subtraction below has to know which weeks a
        // preserved lesson is really there before it cancels any of a
        // requirement's demand, and because a post's day limit is sent with
        // the weekdays these lessons hold week by week (lockedWeekdays).
        recurrence: true,
        startDate: true,
        endDate: true,
        extraGroups: { select: { studentGroupId: true } },
        // The pupils a hand-placed lesson names one by one. Not forwarded —
        // the engine plans around the lesson's groups — but a pupil who is
        // in the building for it puts their home class at lunch (see
        // atSchool), and a panel found that class going without.
        participants: { select: { studentId: true } },
      },
    });
    const participantIds = new Set(
      preservedLessons.flatMap((lesson) =>
        (lesson.participants ?? []).map((entry) => entry.studentId),
      ),
    );

    // Student -> groups, from BOTH membership kinds: the home class
    // (Users.studentGroupId) and teaching groups (StudentGroupMembers). Only
    // aggregates and id-relations derived from this ever leave this method —
    // student ids themselves are never sent to the engine.
    /*
     * Every group the week concerns — not only the ones with a requirement.
     *
     * A class whose lessons are every one of them placed by hand has no
     * requirement left after the subtraction below, and used to fall out of the
     * payload entirely. Its children are still in the building, and a class that
     * books no seats while its children eat is the one error direction the seat
     * rule cannot afford.
     */
    /*
     * AND EVERY HOME CLASS, whether or not the timplan names it.
     *
     * The paragraph above covers a class whose lessons are hand-placed. It did
     * not cover the school in the screenshot: every lesson on a teaching group
     * (4ma1, 4sv1, 4no1 …) and not one on the class itself. Such a class has no
     * requirement, no preserved lesson, and so no entry here — and a group not
     * in `groups` is a group the engine owes no lunch. Its children were in the
     * building all along; their meal was never placed, and the sittings the
     * engine DID place — for the teaching groups, headcount 0 — were dropped at
     * persist because a pupil eats with their class. Zero rows, and a notice
     * saying no lunch had been placed for the year.
     *
     * A class is a class by `kind`, read here once and reused for the spans
     * below. Fetched before the membership queries because those are scoped to
     * this list, and a class's pupils have to be counted for its headcount.
     */
    const allGroups = await tx.studentGroup.findMany({
      where: { academicYearId },
      select: { id: true, gradeLevel: true, kind: true, name: true, halfOfId: true, replacesSubjectId: true },
    });
    // What the school calls each thing, for the refusal on its way back.
    //
    // ONE MAP OVER EVERY KIND OF ID, because a refusal names whatever it is
    // about and the ids are unique across the tables. A class is its own
    // name; a timplan row has none of its own and is named the way the
    // Timplan page names it, by subject and group. Nothing here is ever sent
    // to the engine, which sees anonymous tokens throughout.
    //
    // NO PERSON'S NAME GOES IN. firstName/lastName are marked PII in the
    // schema, and this map ends up denormalised into OptimizationJobs.conflicts
    // — a copy that no rename or deletion would ever reach. A reservation is
    // named by what it reserves and when, below.
    const nameById = new Map<string, string>();
    for (const group of allGroups) {
      if (typeof group.name === 'string' && group.name.length > 0) {
        nameById.set(group.id, group.name);
      }
    }
    // A timplan row carries no name of its own, and is named the way the app
    // already speaks it: `requirements.cellLabel` is "{subject} för {group}",
    // the aria-label on exactly this cell. Unique by construction — the
    // schema's @@unique(schoolId, academicYearId, studentGroupId, subjectId)
    // means group + subject names one row inside a läsår. The groups go in
    // first, above, because this reads them.
    for (const requirement of rawRequirements) {
      const subject = requirement.subject?.name;
      if (!subject) continue;
      nameById.set(requirement.id, requirementName(subject, nameById.get(requirement.studentGroupId)));
      const roomTypeId = requirement.subject.requiredRoomTypeId;
      const roomType = requirement.subject.requiredRoomType?.name;
      if (roomTypeId && roomType) nameById.set(roomTypeId, roomType);
    }
    // A block is named by the name the school gave it ("Språkval åk 7"), like a
    // class. Read only when a row of the year is in one, so a school that has
    // written no block asks the database nothing more than it did.
    //
    // And the block each takes the times of (same-times.ts), read with it: a
    // spring block on its autumn block's times is a link only while both hold
    // a row of the year.
    const blockIds = [
      ...new Set(rawRequirements.flatMap((r) => (r.blockId ? [r.blockId] : []))),
    ];
    let links: SameTimesLink[] = [];
    if (blockIds.length > 0) {
      const blocks = await tx.teachingBlock.findMany({
        where: { id: { in: blockIds } },
        select: { id: true, name: true, sameTimesAsBlockId: true },
      });
      for (const block of blocks) nameById.set(block.id, block.name);
      links = sameTimesLinks(blocks.map((block) => ({ id: block.id, sameTimesAsBlockId: block.sameTimesAsBlockId ?? null })));
    }
    const homeClassIds = allGroups
      .filter((group) => group.kind === 'CLASS')
      .map((group) => group.id);

    const scheduledGroupIds = [
      ...new Set([
        ...rawRequirements.map((r) => r.studentGroupId),
        ...preservedLessons.map((lesson) => lesson.studentGroupId),
        ...preservedLessons.flatMap((lesson) =>
          lesson.extraGroups.map((entry) => entry.studentGroupId),
        ),
        ...homeClassIds,
      ]),
    ];
    // Who sits where, and so how big each group is and which years it holds.
    // Read through room-eligibility.ts because the room optimisation reads it
    // the same way: a lesson it moves may only land where this run could have
    // put it, and that holds only while both count 7A with one piece of code.
    const rosters = await loadRosters(tx, basis, scheduledGroupIds, allGroups, participantIds);
    const { groupsByStudent, membersByGroup, homeMembers, homeClassOf } = rosters;

    /*
     * Dining-hall headcount, which is deliberately NOT the same number.
     *
     * A child eats once. Ma71's students are already counted in 7A, where their
     * home class is, so Ma71 itself brings nobody to the hall — send its size
     * here and the hall fills up twice over with the same children, and the
     * school is told to build a bigger one.
     *
     * Home-class membership only, therefore: Users.studentGroupId, never
     * StudentGroupMembers. That alone is the whole rule — a teaching group is
     * nobody's home class, so it counts nought without being asked about its
     * kind. Checking the kind as well was strictly worse: it would count a
     * student whose home class had been set to a teaching group nowhere at all,
     * and an undercounted hall sends children to a room with no chairs in it.
     */
    const homeCountByGroup = new Map<string, number>();
    for (const row of homeMembers) {
      if (!row.studentGroupId) continue;
      homeCountByGroup.set(
        row.studentGroupId,
        (homeCountByGroup.get(row.studentGroupId) ?? 0) + 1,
      );
    }

    // Year span per scheduled group, for rooms limited to a stage and for the
    // frames, rasts and sittings that reach a stage. See gradeSpanOf for why it
    // is read off the pupils' home classes rather than off the group.
    //
    // In the nine-year numbering (grade-numbering.ts): frames, rasts, sittings,
    // rooms and årskursregler are school-wide and stated that way for good,
    // so a tioårig läsår's 10A is sent as the 9 a "7–9" frame binds, and the
    // engine compares like with like. The engine contract does not change.
    const numbering = await yearNumberingOf(tx, academicYearId);
    const gradeSpanByGroup = new Map<string, { min: number; max: number }>();
    for (const groupId of scheduledGroupIds) {
      const span = toNioarigSpan(gradeSpanOf(rosters, [groupId]), numbering);
      if (span) gradeSpanByGroup.set(groupId, span);
    }
    // A group the timplan names but whose year cannot be derived is bound by
    // NO frame and NO rast — the engine reads "unknown" as "unrestricted", on
    // purpose. That is how a slöjd group with no members and no gradeLevel of
    // its own gets a lesson laid straight across förmiddagsrasten. Said in the
    // log here and on the generate page, because the grid only ever shows the
    // band and the lesson on top of it, never why.
    const spanless = rawRequirements
      .map((r) => r.studentGroupId)
      .filter((groupId, index, all) => all.indexOf(groupId) === index)
      .filter((groupId) => !gradeSpanByGroup.has(groupId));
    if (spanless.length > 0) {
      this.logger.warn(
        `${spanless.length} group(s) with requirements have no derivable year; frame times and rasts will not bind their lessons [academicYearId=${academicYearId}].`,
      );
    }

    // Groups sharing at least one student can never hold overlapping lessons —
    // that is the whole point of teaching groups being real sets of students
    // rather than labels. One pass over students; each contributes the pairs
    // among its own groups, deduplicated by ordered key.
    const conflictPairKeys = new Set<string>();
    const realGroupConflicts: [string, string][] = [];
    for (const groups of groupsByStudent.values()) {
      if (groups.size < 2) continue;
      const list = [...groups].sort();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = `${list[i]}:${list[j]}`;
          if (!conflictPairKeys.has(key)) {
            conflictPairKeys.add(key);
            realGroupConflicts.push([list[i], list[j]]);
          }
        }
      }
    }
    // A class's halves answer for the pupils they MAY hold (class-halves.ts):
    // each half pairs with its class, and with every group of the class's
    // pupils still placed in no half, and never with its sibling. That is the
    // whole of Halvklasser as the engine sees it — the same pairwise
    // no-overlap it keeps for any two groups, so 7A:1's slöjd and 7A:2's NO
    // may share an hour while nothing else of 7A's may. No new field.
    for (const [first, second] of rosters.halfPairs) {
      const key = `${first}:${second}`;
      if (!conflictPairKeys.has(key)) {
        conflictPairKeys.add(key);
        realGroupConflicts.push([first, second]);
      }
    }

    /*
     * Ersättande grupper (common/replacing-groups.ts): a group's lessons in a
     * subject a replacing group replaces are sat by the group's pupils LESS
     * the replacing group's members — SvA7's pupils are at SvA, not at 7A's
     * svenska. Such a requirement (and such a locked lesson, group by group)
     * answers for a derived key, "7A without SvA7", sent as its pupilGroupId
     * (pupilGroupIds); the key pairs with 7A and everything 7A pairs with but
     * SvA7, so the engine may put SvA7's lessons beside 7A's svenska and
     * nowhere else in 7A's week. Every rule about the class itself — its
     * daily maximum, its unavailable hours, its lunch — still reads the
     * requirement's studentGroupId.
     *
     * A school with no replacing group sends no pupilGroupId and no new
     * pair: the payload is byte for byte what it was.
     */
    const replacedSubjects = replacedSubjectOf(allGroups);
    const replacingOf = replacingBySubject(replacedSubjects);
    const pupilKeyByRequirement = new Map<string, string>();
    const pupilKeysByLesson = new Map<string, string[]>();
    if (replacingOf.size > 0) {
      const partners = new Map<string, Set<string>>();
      for (const [first, second] of realGroupConflicts) {
        for (const [a, b] of [[first, second], [second, first]] as const) {
          const set = partners.get(a);
          if (set) set.add(b);
          else partners.set(a, new Set([b]));
        }
      }
      const shares = (a: string, b: string) => partners.get(a)?.has(b) ?? false;
      // A teaching group (not a half) keeps its members on its own lessons
      // (keptByOf): Svenska fördjupning answers for itself, SvA pupils and all.
      const groupById = new Map(allGroups.map((group) => [group.id, group]));
      const scopeOf = (subjectId: string, groupIds: string[]) => {
        const keptBy = keptByOf(groupById.get(groupIds[0]!));
        return { subjectId, groupIds, ...(keptBy === undefined ? {} : { keptBy }) };
      };
      for (const r of rawRequirements) {
        const key = pupilKeyOf(r.studentGroupId, scopeOf(r.subjectId, [r.studentGroupId]), replacingOf, shares);
        if (key !== r.studentGroupId) pupilKeyByRequirement.set(r.id, key);
      }
      for (const lesson of preservedLessons) {
        const groupIds = [lesson.studentGroupId, ...lesson.extraGroups.map((entry) => entry.studentGroupId)];
        // A pupil named on the lesson stays on it, so their replacing group
        // is not left out of it (the engine is told nothing else of them).
        const namedIn = replacingGroupsOfNamed(
          (lesson.participants ?? []).map((entry) => entry.studentId),
          (pupil) => groupsByStudent.get(pupil) ?? [],
          replacedSubjects,
        );
        const keys = pupilKeysOf(scopeOf(lesson.subjectId, groupIds), replacingOf, shares, namedIn);
        if (keys.some((key, index) => key !== groupIds[index])) pupilKeysByLesson.set(lesson.id, keys);
      }
      const derived = [...pupilKeyByRequirement.values(), ...[...pupilKeysByLesson.values()].flat()];
      for (const [first, second] of replacementPairs(derived, (groupId) => partners.get(groupId) ?? [])) {
        const key = `${first}:${second}`;
        if (!conflictPairKeys.has(key)) {
          conflictPairKeys.add(key);
          realGroupConflicts.push([first, second]);
        }
      }
      // Named for a refusal that reaches the school through one: "7A utan SvA7".
      for (const key of derived) {
        const parsed = parseDerivedKey(key);
        if (!parsed || nameById.has(key)) continue;
        const base = nameById.get(parsed.groupId);
        const without = parsed.replacing.map((id) => nameById.get(id)).filter((name): name is string => !!name);
        if (base) nameById.set(key, without.length > 0 ? `${base} utan ${without.join(' och ')}` : base);
      }
    }

    /*
     * How much of the weekly demand is already placed by hand.
     *
     * Only a lesson that is there for every week the requirement is can cancel
     * one of its lessons a week. The engine has no concept of weeks at all, so
     * whatever is subtracted here is subtracted from all of them alike — there
     * is no way to say "one lesson, but only on odd ones". That leaves only the
     * choice of which way to be wrong, and the two directions are not
     * symmetric.
     *
     * Counting a lesson that is absent for part of the requirement
     * under-delivers, invisibly: lessonsPerWeek 2 with one locked odd-week
     * lesson sends 1 to the solver, and the class quietly gets one lesson on
     * even weeks for the rest of the year while the timplan says two. Nothing
     * on any screen says so. Not counting it over-delivers: an extra lesson on
     * odd weeks, sitting on the timetable in front of the administrator, who
     * can unlock or remove it. That costs packing room and not correctness —
     * the preserved lesson is forwarded as a fixed placement either way, so its
     * slot stays blocked in every week, and what the engine adds carries the
     * requirement's own window.
     *
     * So the test below is a covering test, and everything it cannot be sure of
     * falls on the visible side: equal recurrence, and a date window enclosing
     * the requirement's. Equal rather than covering recurrences on purpose —
     * an ALL_WEEKS lesson does cover an ODD_WEEKS requirement, and counting it
     * would buy one lesson of packing room in exchange for a second comparison
     * that has to stay right forever. Equality also keeps a recurrence added to
     * the enum later on the safe side without this line being touched: two
     * lessons with the same recurrence run the same weeks whatever it is, and
     * anything unequal is simply not counted. calendar/lesson-recurrence.ts
     * reads a missing recurrence as ALL_WEEKS because there the wrong guess
     * would drop half a school's lessons; here the wrong guess would hide them,
     * so an absent column on either side counts for nothing.
     */
    const coversDemand = (
      lesson: RecurrenceWindow,
      requirement: RecurrenceWindow,
    ): boolean => {
      if (!lesson.recurrence || !requirement.recurrence) return false;
      if (lesson.recurrence !== requirement.recurrence) return false;

      // Both columns are `@db.Date`, so both sides arrive at midnight UTC and
      // compare as plain instants. A null bound is the open one — "from the
      // start of the year", "until it ends" — so it encloses whatever the
      // requirement asks for, while a bound on the lesson and none on the
      // requirement encloses nothing: the requirement outlives the lesson.
      if (
        lesson.startDate &&
        (!requirement.startDate || lesson.startDate > requirement.startDate)
      ) {
        return false;
      }
      if (
        lesson.endDate &&
        (!requirement.endDate || lesson.endDate < requirement.endDate)
      ) {
        return false;
      }
      return true;
    };

    // Keyed on the demand a lesson answers, which one requirement per (year,
    // group, subject) — TeachingRequirement's own unique key — makes
    // unambiguous. The lessons themselves rather than a count, because whether
    // any of them cancels anything is a question about the requirement's
    // period and cannot be answered until the requirement is in hand.
    const preservedByDemand = new Map<
      string,
      (RecurrenceWindow & { dayOfWeek: number; startTime: Date; endTime: Date; teacherId: string | null })[]
    >();
    for (const lesson of preservedLessons) {
      const key = `${lesson.studentGroupId}:${lesson.subjectId}`;
      const forDemand = preservedByDemand.get(key);
      if (forDemand) forDemand.push(lesson);
      else preservedByDemand.set(key, [lesson]);
    }

    // The lessons still to place, one length each (locked-coverage.ts): a
    // uniform requirement loses one lesson per covering lock, as it always
    // did; a split one loses the length each lock answers. Worked out for
    // every row before any is sent, because a block is judged over all its
    // members.
    const remainingOf = new Map<string, number[]>();
    // Delade lektioner: on a shared row, the teacher of each lesson left, in
    // remainingOf's order (coverLockedSharedLessons); absent on every other.
    const teachersLeftOf = new Map<string, (string | null)[]>();
    for (const r of rawRequirements) {
      const covering = (
        preservedByDemand.get(`${r.studentGroupId}:${r.subjectId}`) ?? []
      ).filter((lesson) => coversDemand(lesson, r));
      const shares = r.shares ?? [];
      if (hasShares({ ...r, shares })) {
        const left = coverLockedSharedLessons(
          lessonTeachersOf({ ...r, shares }),
          covering.map((lesson) => ({
            minutes: lessonMinutes(lesson.startTime, lesson.endTime),
            teacherId: lesson.teacherId ?? null,
          })),
        );
        remainingOf.set(r.id, left.map((lesson) => lesson.minutes));
        teachersLeftOf.set(r.id, left.map((lesson) => lesson.teacherId));
        continue;
      }
      remainingOf.set(
        r.id,
        coverLockedLessons(
          lessonMinutesOf(r),
          covering.map((lesson) => lessonMinutes(lesson.startTime, lesson.endTime)),
        ),
      );
    }
    const demandOf = new Map(rawRequirements.map((r) => [r.id, `${r.studentGroupId}:${r.subjectId}`]));
    const blocks = judgeBlocks(
      rawRequirements,
      (id) => remainingOf.get(id)?.length ?? 0,
      (id) => preservedByDemand.get(demandOf.get(id) ?? '')?.length ?? 0,
      links,
    );

    /*
     * Two blocks on the same times, both with every lesson to place
     * (blocks.mirrored): the leader's posts are sent and the follower's are
     * not; each follower post is written at the times of its leader post in
     * the same subject once the answer is back (mirrorLessons). Whether they
     * still fit together is judged here, and a pair that does not refuses the
     * run by name (sameTimesRefusal, which prepareSchedule answers after
     * the partly locked blocks, which answer first).
     */
    const mirrors: Mirror[] = [];
    const mirroredIds = new Set<string>();
    const leaderPlans = new Map<string, MirrorPlan>();
    let sameTimesRefusal: HttpException | null = null;
    const followerIds = new Set(links.map((link) => link.followerBlockId));
    const rowById = new Map(rawRequirements.map((r) => [r.id, r]));
    // Halvklasser: a half's class, so one subject read by the halves in turn
    // can be held for the whole class (same-times.ts, holdsClass).
    const halfOfById = new Map(allGroups.map((group) => [group.id, group.halfOfId ?? null]));
    const sameTimesRow = (r: (typeof rawRequirements)[number]) => sameTimesRowOf(r, halfOfById);
    for (const link of blocks.mirrored.values()) {
      const membersOf = (blockId: string) => rawRequirements.filter((r) => r.blockId === blockId);
      const followers = membersOf(link.followerBlockId);
      const judgement = planMirror(
        membersOf(link.leaderBlockId).map(sameTimesRow),
        followers.map(sameTimesRow),
        followerIds.has(link.leaderBlockId),
      );
      if (!judgement.ok) {
        sameTimesRefusal ??= sameTimesRefusalOf(judgement, link, nameById);
        continue;
      }
      mirrors.push(...judgement.plan.mirrors);
      for (const follower of followers) mirroredIds.add(follower.id);
      for (const leaderId of judgement.plan.adults.keys()) leaderPlans.set(leaderId, judgement.plan);
    }

    /*
     * Delade lektioner in a parallel block: the engine starts the k-th lesson
     * of each member with the k-th of the others, which loses nothing while a
     * member's lessons are interchangeable — one teacher's, or one member
     * split and the rest each one teacher's, whose lessons can be laid
     * against the split one's in any order. Two members split between
     * teachers are not: Anna's lesson tied to Carl's where only Anna's beside
     * Dana's fits refuses a week that has a timetable. So such a block is
     * refused by name before anything is sent, as the engine refuses a block
     * it cannot hold.
     */
    let splitBlockRefusal: HttpException | null = null;
    for (const blockId of blocks.sent) {
      const split = rawRequirements.filter(
        (r) => r.blockId === blockId && new Set(teachersLeftOf.get(r.id) ?? []).size > 1,
      );
      if (split.length < 2) continue;
      const [first, second] = [...split].sort((a, b) => (a.id < b.id ? -1 : 1));
      const params = {
        block: nameById.get(blockId) ?? blockId,
        requirement: nameById.get(first!.id) ?? first!.id,
        other: nameById.get(second!.id) ?? second!.id,
      };
      splitBlockRefusal ??= new HttpException(
        {
          message:
            `${params.block}: ${params.requirement} and ${params.other} both have their lessons split between ` +
            'teachers, and the lessons of a block are placed together one by one. Give one of them one teacher ' +
            'again, or take it out of the block.',
          code: BLOCK_MEMBERS_SPLIT,
          params,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const requirements: AnonymousRequirement[] = rawRequirements.flatMap((r) => {
      // A mirrored post is written at its leader post's times, never sent.
      if (mirroredIds.has(r.id)) return [];
      const remainingLengths = remainingOf.get(r.id) ?? [];
      const remaining = remainingLengths.length;
      if (remaining <= 0) return [];
      // A uniform remainder is today's entry exactly — no list, and the one
      // length as minutesPerLesson. Only a remainder of two or more lengths
      // carries the list, with its count and its longest as the scalars.
      const split = canonicalShape(remainingLengths);
      // A leader post holds its follower's lessons too (same-times.ts): the
      // room the larger of its half and the follower's in its subject needs,
      // the longer buffers of its own group's two posts, the stricter rule,
      // and the follower's teachers the leader block lacks in an empty place.
      const plan = leaderPlans.get(r.id);
      const bySubject = plan ? rowById.get(plan.sameSubject.get(r.id) ?? '') : undefined;
      const byGroup = plan ? rowById.get(plan.sameGroup.get(r.id) ?? '') : undefined;
      // One subject read by the halves in turn: the first half's post is sat
      // by the whole class as far as the engine knows, so the second half is
      // free at its times for its own lessons there (same-times.ts). This
      // overrides a replacing group's derived key: the class pairs with the
      // replacing group too, so its lessons are kept off these times as
      // well. That costs the week room, never puts a pupil in two places.
      const heldClass = plan?.holdsClass.get(r.id);
      const pupilKey = heldClass ?? pupilKeyByRequirement.get(r.id);
      const adults = plan?.adults.get(r.id) ?? { teacherId: r.teacherId, coTeacherId: r.coTeacherId };
      // Delade lektioner: each lesson left with its own teacher. Two or more
      // teachers send the list, and the scalar is its first; one sends that
      // teacher alone — a share's, when the lead's lessons are all locked —
      // and no list, the entry a post with one teacher always had. A shared
      // post is never in a mirrored pair (BLOCK_SAME_TIMES_SPLIT_LESSONS), so
      // `adults` is its own here.
      const teachersLeft = teachersLeftOf.get(r.id);
      const lessonTeacherIds =
        teachersLeft && new Set(teachersLeft).size > 1
          ? teachersLeft.map((id) => (id === null ? null : anonId(teacherAnonMap, id)))
          : null;
      const leadTeacher = teachersLeft ? teachersLeft[0]! : adults.teacherId;
      if (teachersLeft && !lessonTeacherIds) soleTeachers.set(anonId(requirementAnonMap, r.id), leadTeacher);
      const needs = widerNeeds(
        roomNeedsOf(rosters, { groupIds: [r.studentGroupId] }, r.subject, numbering),
        bySubject ? roomNeedsOf(rosters, { groupIds: [bySubject.studentGroupId] }, bySubject.subject, numbering) : null,
      );
      // Ämnesfördelning: the row's own rule or its subject's, each half sent
      // only when set — see AnonymousRequirement.maxLessonsPerDay. The locked
      // weekdays go with a rule and never without one, and they are EVERY
      // preserved lesson of the row, not only the ones that cancel demand
      // above: a lesson locked on odd weeks is still on Monday in the weeks it
      // runs, and the engine, which has no weeks, has to count it there.
      const rule = stricterRule(
        effectiveDistribution(r, r.subject),
        bySubject ? effectiveDistribution(bySubject, bySubject.subject) : null,
      );
      const lockedDays = hasDistributionRule(rule)
        ? (preservedByDemand.get(`${r.studentGroupId}:${r.subjectId}`) ?? [])
            .map((lesson) => lesson.dayOfWeek as DayOfWeek)
            .sort((a, b) => a - b)
        : [];
      return [
        {
          id: anonId(requirementAnonMap, r.id),
          subjectId: anonId(subjectAnonMap, r.subjectId),
          studentGroupId: anonId(groupAnonMap, r.studentGroupId),
          // Ersättande grupper: who sits it, when not all of the group (above);
          // the whole class, for a half's post that holds its sibling (above).
          ...(pupilKey !== undefined ? { pupilGroupId: anonId(groupAnonMap, pupilKey) } : {}),
          teacherId: leadTeacher ? anonId(teacherAnonMap, leadTeacher) : null,
          lessonsPerWeek: remaining,
          // The longest REMAINING length: r.minutesPerLesson for a uniform
          // requirement, as before, and 40 for 1 × 80 + 1 × 40 with the 80
          // locked — the lesson the engine is actually asked to place.
          minutesPerLesson: split.minutesPerLesson,
          ...(split.lessonLengths.length > 0 ? { lessonLengths: split.lessonLengths } : {}),
          // Forwarded as they stand, beside the length and not folded into it:
          // the engine has to place 60 minutes of teaching and keep the class
          // clear for 90, and a sum would lose which of the two it was told.
          minutesBefore: byGroup ? Math.max(r.minutesBefore, byGroup.minutesBefore) : r.minutesBefore,
          minutesAfter: byGroup ? Math.max(r.minutesAfter, byGroup.minutesAfter) : r.minutesAfter,
          ...(rule.maxLessonsPerDay !== null ? { maxLessonsPerDay: rule.maxLessonsPerDay } : {}),
          ...(rule.minDaysBetween !== null ? { minDaysBetween: rule.minDaysBetween } : {}),
          ...(lockedDays.length > 0 ? { lockedDays } : {}),
          // Sent only for a block of two or more with every lesson to place —
          // see judgeBlocks — so a school without blocks sends the payload it
          // always sent, and an engine that predates the key never meets it.
          ...(r.blockId && blocks.sent.has(r.blockId)
            ? { blockId: anonId(blockAnonMap, r.blockId) }
            : {}),
          studentGroupSize: needs.studentGroupSize,
          minGradeLevel: needs.minGradeLevel,
          maxGradeLevel: needs.maxGradeLevel,
          requiredRoomType: needs.requiredRoomTypeId
            ? anonId(roomTypeAnonMap, needs.requiredRoomTypeId)
            : null,
          coTeacherId: adults.coTeacherId ? anonId(teacherAnonMap, adults.coTeacherId) : null,
          ...(lessonTeacherIds ? { lessonTeacherIds } : {}),
        },
      ];
    });

    // Previous (unlocked) placements → minimal-disruption re-optimization.
    // Mapped to their requirement via (group, subject); lessons whose
    // requirement no longer exists (or is fully locked) are skipped.
    const anonReqByDemand = new Map<string, string>();
    for (const r of rawRequirements) {
      const anon = requirementAnonMap.get(r.id);
      if (anon) anonReqByDemand.set(`${r.studentGroupId}:${r.subjectId}`, anon);
    }
    const unlockedLessons = await tx.masterLesson.findMany({
      where: { academicYearId, isLocked: false },
      select: {
        subjectId: true,
        studentGroupId: true,
        dayOfWeek: true,
        startTime: true,
      },
    });
    const previousLessons: AnonymousPreviousLesson[] = unlockedLessons.flatMap(
      (lesson) => {
        const anonReq = anonReqByDemand.get(
          `${lesson.studentGroupId}:${lesson.subjectId}`,
        );
        if (!anonReq) return [];
        return [
          {
            requirementId: anonReq,
            dayOfWeek: lesson.dayOfWeek as DayOfWeek,
            startTime: this.timeToString(lesson.startTime),
          },
        ];
      },
    );

    const fixedLessons: AnonymousFixedLesson[] = preservedLessons.map((lesson) => ({
      id: randomUUID(),
      teacherId: lesson.teacherId ? anonId(teacherAnonMap, lesson.teacherId) : null,
      coTeacherId: lesson.coTeacherId
        ? anonId(teacherAnonMap, lesson.coTeacherId)
        : null,
      studentGroupId: anonId(groupAnonMap, lesson.studentGroupId),
      roomId: lesson.roomId ? anonId(roomAnonMap, lesson.roomId) : null,
      dayOfWeek: lesson.dayOfWeek as DayOfWeek,
      startTime: this.timeToString(lesson.startTime),
      endTime: this.timeToString(lesson.endTime),
      extraGroupIds: lesson.extraGroups.map((entry) =>
        anonId(groupAnonMap, entry.studentGroupId),
      ),
      // Ersättande grupper: who sits it, group by group, when a replacing
      // group takes some of them elsewhere (above).
      ...(pupilKeysByLesson.has(lesson.id)
        ? { pupilGroupIds: pupilKeysByLesson.get(lesson.id)!.map((key) => anonId(groupAnonMap, key)) }
        : {}),
    }));

    /*
     * Who the dining hall has to seat.
     *
     * One entry per group the week concerns, carrying only how many children it
     * brings to lunch. Its own list rather than a field on each requirement,
     * because the fact belongs to the group: hanging it off requirements meant a
     * class whose lessons were all placed by hand disappeared from the count
     * along with its requirements, while its children kept eating.
     */
    // HOME CLASSES ONLY. `groups` is who eats, and a pupil eats once, with their
    // class. A teaching group here would be a second mandatory meal for the
    // same children — thirty minutes reserved on Ma71's day for a lunch nobody
    // takes there, and an INFEASIBLE with a lunch cause on the day it does not
    // fit. Its lessons still keep the class's meal clear, through the shared-
    // pupil pairs below.
    //
    // AND ONLY THE CLASSES THAT ARE AT SCHOOL THIS WEEK: a class eats when the
    // week holds a lesson its pupils sit in — a requirement or a locked lesson
    // on the class itself, or on a teaching group one of its pupils belongs
    // to. For one release every class of the year was sent, on the argument
    // that a class in the register is a class in the building. A school that
    // was scheduling two classes as a trial, with the other twenty-two entered
    // and full of pupils but without a single lesson, had all twenty-four sent
    // to the hall: 530 children in 115 seats, and it was told, in a second, by
    // arithmetic, that its dining hall could not feed two classes of twenty.
    // The register says who exists; the timplan says who is here.
    const lessonGroupIds = new Set<string>([
      ...rawRequirements.map((r) => r.studentGroupId),
      ...preservedLessons.map((lesson) => lesson.studentGroupId),
      ...preservedLessons.flatMap((lesson) =>
        lesson.extraGroups.map((entry) => entry.studentGroupId),
      ),
    ]);
    // A half's lessons are its class's pupils' lessons, placed in it or not:
    // a class whose week is only its halves' slöjd still eats.
    for (const group of allGroups) {
      if (group.halfOfId && lessonGroupIds.has(group.id)) lessonGroupIds.add(group.halfOfId);
    }
    const classesWithAParticipant = new Set<string>();
    for (const studentId of participantIds) {
      const homeClass = homeClassOf.get(studentId);
      if (homeClass) classesWithAParticipant.add(homeClass);
    }
    const atSchool = (classId: string): boolean => {
      if (lessonGroupIds.has(classId)) return true;
      if (classesWithAParticipant.has(classId)) return true;
      for (const studentId of membersByGroup.get(classId) ?? []) {
        for (const groupId of groupsByStudent.get(studentId) ?? []) {
          if (lessonGroupIds.has(groupId)) return true;
        }
      }
      return false;
    };
    const homeClassSet = new Set(homeClassIds);
    const groups: AnonymousGroup[] = scheduledGroupIds
      .filter((groupId) => homeClassSet.has(groupId) && atSchool(groupId))
      .map((groupId) => ({
      id: anonId(groupAnonMap, groupId),
      lunchHeadcount: homeCountByGroup.get(groupId) ?? 0,
      // The same span the requirements carry, sent on the group as well: a
      // sitting and a frame both reach a stage, and a MEAL has no requirement
      // to read one off. Null for a group whose years cannot be derived — the
      // engine reads that as "unknown" and leaves it the school-wide window.
      minGradeLevel: gradeSpanByGroup.get(groupId)?.min ?? null,
      maxGradeLevel: gradeSpanByGroup.get(groupId)?.max ?? null,
    }));

    // Fetch rooms. The name and the type's name are read for the way BACK —
    // a refusal that names a room should name it the way the Salar page does
    // — and never forwarded: what the engine gets is capacity, an anonymous
    // type token and the year span.
    const rawRooms = await tx.room.findMany({
      where: {
        school: {
          academicYears: { some: { id: academicYearId } },
        },
      },
      select: {
        id: true,
        capacity: true,
        roomTypeId: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        // Restid i generatorn: sent only when the walk is on, below.
        siteId: true,
        // Same reason as the subject's name above: for the way back, never
        // for the engine.
        name: true,
        roomType: { select: { name: true } },
      },
    });
    for (const room of rawRooms) {
      if (room.name) nameById.set(room.id, room.name);
      if (room.roomTypeId && room.roomType?.name) {
        nameById.set(room.roomTypeId, room.roomType.name);
      }
    }

    /*
     * The school's lunch rules, read inside this same RLS transaction.
     *
     * They used to live in one administrator's browser, so a colleague
     * generating the schedule ran under different rules without knowing it. A
     * disabled row is read as no rule at all rather than as a lunch of zero
     * minutes — "we have not decided" and "we decided against" both mean the
     * engine should not reserve anything.
     */
    const lunchSettings = await tx.lunchSetting.findUnique({
      where: { schoolId },
      select: {
        lunchEnabled: true,
        lunchStartTime: true,
        lunchEndTime: true,
        lunchMinutes: true,
        diningSeats: true,
        maxLessonsPerDayPerGroup: true,
        generatorKeepsTravelTime: true,
      },
    });
    const storedRules: ScheduleRules | null = !lunchSettings
      ? null
      : {
          ...(lunchSettings.lunchEnabled
            ? {
                lunchStartTime: this.timeToString(lunchSettings.lunchStartTime),
                lunchEndTime: this.timeToString(lunchSettings.lunchEndTime),
                lunchMinutes: lunchSettings.lunchMinutes,
                ...(lunchSettings.diningSeats !== null
                  ? { diningSeats: lunchSettings.diningSeats }
                  : {}),
              }
            : {}),
          ...(lunchSettings.maxLessonsPerDayPerGroup !== null
            ? {
                maxLessonsPerDayPerGroup:
                  lunchSettings.maxLessonsPerDayPerGroup,
              }
            : {}),
        };

    // Soft room wishes. Anonymised like everything else: the engine sees ids
    // it cannot resolve, and the weights that order them.
    const rawPreferences = await tx.roomPreference.findMany({
      select: {
        id: true,
        subjectId: true,
        kind: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        roomTypeId: true,
        weight: true,
        rooms: { select: { roomId: true } },
      },
    });

    /*
     * Restid i generatorn: the walk between the school's skolområden, kept by
     * the generator only when the school's Skolregler say so. Read only then —
     * a school that has not turned it on asks nothing more than it did — and
     * sent only when there is a figure: the walks, and each room's site
     * beside them, every site anonymised like a room type. Off, or on without
     * a figure, the payload is the one it was (no `siteTravelTimes`, no
     * `siteId`), and so is the engine's model.
     *
     * Every row as stored, a 0 included: the engine counts a walk the way
     * common/site-travel.ts does (a figure above zero between two different
     * sites), and one reading of the rule is enough.
     */
    const siteAnonMap = new Map<string, string>();
    const travelRows = lunchSettings?.generatorKeepsTravelTime
      ? await tx.siteTravelTime.findMany({
          where: { schoolId },
          select: { siteAId: true, siteBId: true, minutes: true },
          orderBy: [{ siteAId: 'asc' }, { siteBId: 'asc' }],
        })
      : [];
    const siteTravelTimes: AnonymousSiteTravelTime[] = travelRows.map((row) => ({
      siteAId: anonId(siteAnonMap, row.siteAId),
      siteBId: anonId(siteAnonMap, row.siteBId),
      minutes: row.minutes,
    }));

    const rooms: AnonymousRoom[] = rawRooms.map((r) => ({
      id: anonId(roomAnonMap, r.id),
      capacity: r.capacity,
      type: r.roomTypeId ? anonId(roomTypeAnonMap, r.roomTypeId) : null,
      minGradeLevel: r.minGradeLevel,
      maxGradeLevel: r.maxGradeLevel,
      ...(siteTravelTimes.length > 0 && r.siteId !== null
        ? { siteId: anonId(siteAnonMap, r.siteId) }
        : {}),
    }));

    const roomPreferences: AnonymousRoomPreference[] = rawPreferences.map((p) => {
      // Only rooms the payload actually carries: one no longer scheduled points
      // at nothing the engine can see.
      //
      // Dropping them is right for a WISH and a silent weakening for a LOCK: a
      // lock whose rooms all vanish here becomes a rule naming nothing, and the
      // engine reads that as "no restriction" rather than as "impossible". Kept
      // and reported instead — the unresolved count rides along so the caller
      // can say which rule stopped meaning what it says.
      const roomIds = p.rooms
        .map((entry) => roomAnonMap.get(entry.roomId))
        .filter((id): id is string => Boolean(id));
      if (p.kind === 'LOCK' && roomIds.length < p.rooms.length) {
        this.logger.warn(
          `Room lock ${p.id} names ${p.rooms.length - roomIds.length} room(s) ` +
            `no longer in the payload; the lock is narrower than it reads.`,
        );
      }
      return {
        id: anonId(requirementAnonMap, p.id),
        subjectId: anonId(subjectAnonMap, p.subjectId),
        kind: p.kind,
        minGradeLevel: p.minGradeLevel,
        maxGradeLevel: p.maxGradeLevel,
        roomType: p.roomTypeId ? anonId(roomTypeAnonMap, p.roomTypeId) : null,
        roomIds,
        weight: p.weight,
      };
    });

    // Fetch availability constraints (drop reason text field). An uppdrag's
    // slot only in its own läsår — see constraintsOfYear.
    const rawConstraints = await tx.availabilityConstraint.findMany({
      where: {
        school: {
          academicYears: { some: { id: academicYearId } },
        },
        AND: [constraintsOfYear(academicYearId)],
      },
      select: {
        id: true,
        resourceType: true,
        userId: true,
        roomId: true,
        studentGroupId: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        date: true,
        startTime: true,
        endTime: true,
        type: true,
      },
    });

    // A dated årskursregel is stated in the numbering of the läsår its own day
    // falls in. The read above has no date window, so last year's prao is
    // here beside this year's, each read by its own läsår.
    const numberingOnDay = rawConstraints.some((c) => c.resourceType === 'GRADE_LEVEL' && c.date)
      ? await dayNumberingOf(tx, academicYearId)
      : () => 'NIOARIG' as const;

    const constraints: AnonymousConstraint[] = rawConstraints.flatMap(
      (c): AnonymousConstraint[] => {
        const common = {
          // Through the map, not a fresh uuid. A bare randomUUID() here was an
          // id that existed in no table in either id space: the engine put it
          // in `constraintIds` and in the sentence it wrote, and what came out
          // the other end could not be looked up by the school, by this
          // gateway, or by a developer holding the database.
          id: anonId(constraintAnonMap, c.id),
          resourceKind: c.resourceType as ResourceKind,
          dayOfWeek: c.dayOfWeek as DayOfWeek | null,
          date: c.date ? c.date.toISOString().slice(0, 10) : null,
          startTime: this.timeToString(c.startTime),
          endTime: this.timeToString(c.endTime),
          kind: c.type as ConstraintKind,
        };

        // A year range names no resource, so it carries its bounds instead and
        // the engine matches them against each group's own span. Fanning it out
        // to one rule per class here was the alternative: twelve classes across
        // five weekdays is sixty rows for what an admin wrote as one line, and
        // the payload is capped at five thousand.
        //
        // The group spans are sent in NIOARIG (gradeSpanByGroup). A weekly
        // årskursregel is school-wide and NIOARIG already; a dated one (a
        // prao day) is stated in the numbering of the läsår its day falls in
        // (numberingOnDay) and is read into NIOARIG here.
        if (c.resourceType === 'GRADE_LEVEL') {
          const stated = common.date === null ? 'NIOARIG' : numberingOnDay(common.date);
          return [
            {
              ...common,
              minGradeLevel: toNioarig(c.minGradeLevel, stated),
              maxGradeLevel: toNioarig(c.maxGradeLevel, stated),
            },
          ];
        }

        const resourceId = c.userId
          ? anonId(teacherAnonMap, c.userId)
          : c.roomId
            ? anonId(roomAnonMap, c.roomId)
            : c.studentGroupId
              ? anonId(groupAnonMap, c.studentGroupId)
              : null;

        // A row whose declared type has no matching id used to be forwarded
        // with a freshly minted uuid the engine could never match against
        // anything: the rule saved, listed and constrained nothing, silently.
        // The API refuses to write one now; a survivor from before that check
        // is dropped here rather than sent as a lie.
        if (resourceId === null) {
          this.logger.warn(
            `Skipping constraint ${c.id}: ${c.resourceType} names no resource.`,
          );
          return [];
        }

        return [{ ...common, resourceId }];
      },
    );

    // Ramtider. School-scoped like the constraints above, and read through the
    // same year -> school hop rather than a schoolId the caller supplied, so a
    // request for another school's year cannot pull this school's rows.
    //
    // Nothing to anonymise: a frame names a span of years, which is a property
    // of the timetable and not of a person or a room.
    const rawFrames = await tx.frameTime.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        changeoverMinutes: true,
      },
    });

    const frameTimes: AnonymousFrameTime[] = rawFrames.map((frame) => ({
      minGradeLevel: frame.minGradeLevel,
      maxGradeLevel: frame.maxGradeLevel,
      dayOfWeek: frame.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(frame.startTime),
      endTime: this.timeToString(frame.endTime),
      changeoverMinutes: frame.changeoverMinutes,
    }));

    // Lunchsittningar. School-scoped like the frames above and read through the
    // same year -> school hop, so a request for another school's year cannot
    // pull this school's rows. Nothing to anonymise: a sitting names a span of
    // years, not a person or a room.
    const rawServings = await tx.lunchServing.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        seats: true,
      },
    });

    const lunchServings: AnonymousLunchServing[] = rawServings.map((serving) => ({
      minGradeLevel: serving.minGradeLevel,
      maxGradeLevel: serving.maxGradeLevel,
      dayOfWeek: serving.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(serving.startTime),
      endTime: this.timeToString(serving.endTime),
      seats: serving.seats,
    }));

    // Meals the school placed by hand. YEAR-scoped, like every sitting: this
    // is what the school decided against one läsår's lessons. Anonymised
    // through the group map, and a row whose class the map does not know is
    // left out — the engine would have no lunch variable to pin for it.
    const handSittings = await tx.lunchSitting.findMany({
      where: { academicYearId, isGenerated: false },
      select: { studentGroupId: true, dayOfWeek: true, startTime: true },
    });
    const lunchPlacements: AnonymousLunchPlacement[] = handSittings.flatMap((sitting) => {
      const anonymous = groupAnonMap.get(sitting.studentGroupId);
      return anonymous === undefined
        ? []
        : [
            {
              studentGroupId: anonymous,
              dayOfWeek: sitting.dayOfWeek as DayOfWeek,
              startTime: this.timeToString(sitting.startTime),
            },
          ];
    });

    // Raster. School-scoped and read through the same year -> school hop as the
    // frames and the sittings above, so a request for another school's year
    // cannot pull this school's rows. The NAME is deliberately not sent: the
    // engine subtracts minutes and has nothing to say about what they are
    // called, and every field that reaches it is one more thing that could
    // identify a school in a payload built to be anonymous.
    const rawRasts = await tx.rast.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        requiresLessonBefore: true,
      },
    });

    const rasts: AnonymousRast[] = rawRasts.map((rast) => ({
      minGradeLevel: rast.minGradeLevel,
      maxGradeLevel: rast.maxGradeLevel,
      dayOfWeek: rast.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(rast.startTime),
      endTime: this.timeToString(rast.endTime),
      requiresLessonBefore: rast.requiresLessonBefore,
    }));

    /*
     * Lärarnas arbetstid. School-scoped and read through the same year -> school
     * hop as the frames, the sittings and the rasts above, so a request for
     * another school's year cannot pull this school's rows.
     *
     * BOTH IDS ARE ANONYMISED, and they are anonymised differently on purpose.
     * The teacher goes through `teacherAnonMap`, the same map the requirements
     * and the fixed lessons use, so the engine can tell that this rule and that
     * lesson concern one person — and that map is DISCARDED when the request
     * ends, because a refusal about a teacher must never be able to name them.
     * The rule's own id goes through `workRuleAnonMap`, which is kept and
     * reversed on the way back, because the refusal has to name SOMETHING the
     * school can open, and with the person unnameable the row is all there is.
     *
     * A rule whose teacher is not already in the map is LEFT OUT. That teacher
     * appears in no requirement, no fixed lesson and no reservation this year, so
     * the engine has no lesson of theirs to hang an assumption on — and minting a
     * teacher token here would send a rule about somebody the payload never
     * mentions, which is a fresh uuid the engine can match against nothing. Said
     * in the log, because "my lunch rule did nothing" is otherwise invisible.
     *
     * No name, and nothing but numbers and clocks. The engine has nothing to say
     * about what a teacher is called, and every field that reaches it is one more
     * thing that could identify a school in a payload built to be anonymous.
     */
    const rawWorkRules = await tx.teacherWorkRule.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        id: true,
        userId: true,
        lunchMinutes: true,
        lunchStartTime: true,
        lunchEndTime: true,
        minDailyRestMinutes: true,
        // Lärarens dag: the cap and the wish, set by an administrator who
        // plans (20261123090000). Numbers, like the rest above.
        maxTeachingMinutesPerDay: true,
        preferredFreeDayOfWeek: true,
      },
    });

    const teacherWorkRules: AnonymousTeacherWorkRule[] = rawWorkRules.flatMap(
      (rule): AnonymousTeacherWorkRule[] => {
        const teacherId = teacherAnonMap.get(rule.userId);
        if (teacherId === undefined) {
          this.logger.warn(
            `Skipping work rule ${rule.id}: its teacher has no lesson, reservation ` +
              `or requirement in this year, so there is nothing to hold it against.`,
          );
          return [];
        }
        return [
          {
            id: anonId(workRuleAnonMap, rule.id),
            teacherId,
            lunchMinutes: rule.lunchMinutes,
            lunchStartTime: rule.lunchStartTime
              ? this.timeToString(rule.lunchStartTime)
              : null,
            lunchEndTime: rule.lunchEndTime
              ? this.timeToString(rule.lunchEndTime)
              : null,
            minDailyRestMinutes: rule.minDailyRestMinutes,
            // Each only when set, never as null: the four above have been
            // on the wire since the list existed, these have not, and a school
            // that sets neither sends what it always sent. A rule holding only
            // one of them (no lunch, no rest) is a rule all the same, and is
            // sent with the four as nulls.
            ...(rule.maxTeachingMinutesPerDay !== null
              ? { maxTeachingMinutesPerDay: rule.maxTeachingMinutesPerDay }
              : {}),
            ...(rule.preferredFreeDayOfWeek !== null
              ? { preferredFreeDay: rule.preferredFreeDayOfWeek as DayOfWeek }
              : {}),
          },
        ];
      },
    );

    /*
     * Deltid in days (TeacherEmployments.maxTeachingDaysPerWeek): the year's
     * posts that set it, and only those. Read the way every other row here is,
     * under the starter's own session, and NOT filtered by whether the starter
     * reads HR: every administrator's arm reads the posts, and a week generated
     * by a schemaläggare without HR-läs must hold the same limits as one
     * generated by rektor, or the timetable would depend on who pressed the
     * button. What a reader is SHOWN of a refusal about it is decided when the
     * run is read (work-days.ts); the rule itself is the same for everybody.
     *
     * The teacher through `teacherAnonMap` and the post through its own kept
     * map, exactly as the work rules above go — and a limit whose teacher
     * this year never mentions is left out and said in the log, for their
     * reason. Whose post it is is kept beside the map (`dayLimitTeacherIds`)
     * and never sent: it is how a refusal about the post can be put in front
     * of a reader with HR-läs with the teacher named, and written to the
     * Läslogg by a Users id.
     */
    /*
     * AND THE WEEKDAYS THE TEACHER'S FIXED LESSONS HOLD, WEEK BY WEEK
     * (lockedWeekdaySets): the lessons sent as fixed placements that the
     * teacher leads or co-teaches, read by their recurrence and dates, which
     * the fixed placement itself does not carry. The engine counts a lesson
     * it places as taught every week, and a weekday as already taught only
     * in the weeks one of these runs on it — not, as it did, every weekday
     * any of them holds as taught in every week, which read a part-timer's
     * Monday and Tuesday in odd weeks and Wednesday and Thursday in even ones
     * as four days spent, and placed a weekly Monday and Wednesday on top.
     * The lessons were read above. The läsår's first and last day bound the
     * weeks read — a null date is the year's own bound, and a week outside it
     * is no week the school has — and are read only when a post has a limit:
     * one statement then, none for a school that sets no days.
     */
    const lockedWeekdaysOf = (userId: string, maxDays: number, year: YearSpan | undefined): DayOfWeek[][] =>
      lockedWeekdaySets(
        preservedLessons
          .filter((lesson) => lesson.teacherId === userId || lesson.coTeacherId === userId)
          .map((lesson) => ({
            id: lesson.id,
            dayOfWeek: lesson.dayOfWeek,
            startMinutes: clockMinutes(lesson.startTime),
            endMinutes: clockMinutes(lesson.endTime),
            recurrence: lesson.recurrence,
            startDate: lesson.startDate ? lesson.startDate.toISOString().slice(0, 10) : null,
            endDate: lesson.endDate ? lesson.endDate.toISOString().slice(0, 10) : null,
          })),
        maxDays,
        year,
      ) as DayOfWeek[][];
    const rawDayLimits = await tx.teacherEmployment.findMany({
      where: { academicYearId, maxTeachingDaysPerWeek: { not: null } },
      select: { id: true, userId: true, maxTeachingDaysPerWeek: true },
    });
    const yearRow =
      rawDayLimits.length > 0
        ? await tx.academicYear.findUnique({
            where: { id: academicYearId },
            select: { startDate: true, endDate: true },
          })
        : null;
    const yearSpan: YearSpan | undefined = yearRow
      ? { startDate: yearRow.startDate.toISOString().slice(0, 10), endDate: yearRow.endDate.toISOString().slice(0, 10) }
      : undefined;
    const teacherDayLimits: AnonymousTeacherDayLimit[] = rawDayLimits.flatMap(
      (post): AnonymousTeacherDayLimit[] => {
        const teacherId = teacherAnonMap.get(post.userId);
        if (teacherId === undefined) {
          this.logger.warn(
            `Skipping the day limit on post ${post.id}: its teacher has no lesson, reservation ` +
              `or requirement in this year, so there is nothing to hold it against.`,
          );
          return [];
        }
        dayLimitTeacherIds.set(post.id, post.userId);
        // The where admits no null.
        const maxTeachingDaysPerWeek = post.maxTeachingDaysPerWeek as number;
        return [
          {
            id: anonId(dayLimitAnonMap, post.id),
            teacherId,
            maxTeachingDaysPerWeek,
            lockedWeekdays: lockedWeekdaysOf(post.userId, maxTeachingDaysPerWeek, yearSpan),
          },
        ];
      },
    );
    // A post's days are HR data, and this transaction read them for every
    // teacher whose limit it sends: written to the Läslogg in the read's own
    // transaction, as every read of a post is. Nobody shown them — the engine
    // gets an anonymous number — but the starter's session read them, and the
    // log is of reads. No limit sent, nothing written.
    await recordRead(tx, 'EMPLOYMENT', dayLimitTeacherIds.values(), channel);

    // Anonymize the conflict pairs with the same group map the requirements
    // used, so the engine sees a consistent id space. Pairs whose groups never
    // reached the payload (no requirement and no fixed lesson references them)
    // are dropped — the engine would have nothing to constrain.
    const groupConflicts: [string, string][] = realGroupConflicts.flatMap(
      ([a, b]) => {
        const anonA = groupAnonMap.get(a);
        const anonB = groupAnonMap.get(b);
        return anonA && anonB ? [[anonA, anonB] as [string, string]] : [];
      },
    );

    // A block whose lessons are partly locked, in the ids the payload uses, so
    // it reaches the school through realiseConflicts as the engine's own
    // refusals do. Every member is named, sent or not.
    // And two blocks on the same times one of which the school placed, the
    // two named, under the same summary.
    const blockRefusal =
      blocks.partlyLocked.length === 0 && blocks.lockedApart.length === 0
        ? null
        : partlyLockedRefusal([
            ...blocks.partlyLocked.map((block) => ({
              block: anonId(blockAnonMap, block.blockId),
              members: block.memberIds.map((id) => anonId(requirementAnonMap, id)),
              locked: block.locked,
            })),
            ...blocks.lockedApart.map((pair) => ({
              block: anonId(blockAnonMap, pair.blockId),
              other: anonId(blockAnonMap, pair.otherBlockId),
              members: pair.memberIds.map((id) => anonId(requirementAnonMap, id)),
              locked: pair.locked,
            })),
          ]);

    return {
      requirements,
      rooms,
      constraints,
      frameTimes,
      lunchServings,
      lunchPlacements,
      rasts,
      roomPreferences,
      teacherWorkRules,
      teacherDayLimits,
      fixedLessons,
      groups,
      previousLessons,
      groupConflicts,
      siteTravelTimes,
      siteAnonMap,
      roomAnonMap,
      requirementAnonMap,
      groupAnonMap,
      headcountByGroup: homeCountByGroup,
      roomTypeAnonMap,
      constraintAnonMap,
      workRuleAnonMap,
      dayLimitAnonMap,
      dayLimitTeacherIds,
      nameById,
      blockAnonMap,
      blockRefusal,
      pairsRefusal: groupConflicts.length > ENGINE_GROUP_CONFLICTS_LIMIT ? groupConflictsRefusal(groupConflicts.length) : null,
      mirrors,
      // The two ways a block cannot be held, answered the same way.
      sameTimesRefusal: sameTimesRefusal ?? splitBlockRefusal,
      // The free-day wishes, for what the finished timetable is read against
      // (unkeptFreeDayWishes): every rule that states one, sent to the engine
      // or not — a teacher who teaches nothing keeps theirs trivially. The
      // lessons Generera's regeneration keeps are NOT taken from here: they
      // are read by persistMasterLessons, after its delete, as the timetable
      // it leaves. A schemaförslag, which writes nothing, reads them from
      // preservedRows (keptTimetable), which the basis holds still to apply.
      freeDayWishes: rawWorkRules.flatMap((rule): FreeDayWish[] =>
        rule.preferredFreeDayOfWeek === null
          ? []
          : [{ ruleId: rule.id, userId: rule.userId, day: rule.preferredFreeDayOfWeek }],
      ),
      gradeNumbering: numbering,
      numberingOnDay,
      // An empty object would send `rules: {}` and read as "rules were
      // considered and came to nothing", which the engine treats the same but
      // a reader of the payload would not.
      storedRules:
        storedRules !== null && Object.keys(storedRules).length > 0
          ? storedRules
          : null,
      teacherAnonMap,
      subjectAnonMap,
      soleTeachers,
      requirementRows: rawRequirements.map((r) => ({
        id: r.id,
        subjectId: r.subjectId,
        studentGroupId: r.studentGroupId,
        teacherId: r.teacherId ?? null,
        coTeacherId: r.coTeacherId ?? null,
        recurrence: r.recurrence,
        startDate: r.startDate ?? null,
        endDate: r.endDate ?? null,
        // Only when there are any: a row nobody shares is the object it always was.
        ...((r.shares ?? []).length > 0 ? { shares: r.shares } : {}),
      })),
      // Named field by field: the participants' pupil ids stay in here.
      preservedRows: preservedLessons.map((lesson) => ({
        id: lesson.id,
        subjectId: lesson.subjectId,
        studentGroupId: lesson.studentGroupId,
        teacherId: lesson.teacherId ?? null,
        coTeacherId: lesson.coTeacherId ?? null,
        dayOfWeek: lesson.dayOfWeek,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        recurrence: lesson.recurrence,
        startDate: lesson.startDate,
        endDate: lesson.endDate,
        extraGroups: lesson.extraGroups ?? [],
      })),
    };
  }

  /**
   * Turn the anonymous ids in an engine refusal back into real ones.
   *
   * Every named refusal the engine can produce — "A room lock leaves
   * requirement 8f2c… nowhere to go", "No room satisfies capacity/type/years
   * for requirement …" — names an id the engine minted. Forwarded verbatim it
   * is a uuid that exists in no table, which is the state the engine's conflict
   * MESSAGES are still in.
   *
   * A substitution rather than a second implementation of the rule: rebuilding
   * the lock resolution here in TypeScript to phrase a nicer sentence would be
   * two implementations of one meaning, and the one that drifts is the one
   * nobody runs. The engine keeps saying what is wrong; this only restores who
   * it is about.
   */
  private deanonymise(message: string, maps: AnonMaps): string {
    const real = new Map<string, string>();
    for (const map of [
      maps.requirementAnonMap,
      maps.roomAnonMap,
      maps.groupAnonMap,
      maps.roomTypeAnonMap,
      maps.constraintAnonMap,
      maps.workRuleAnonMap,
      maps.lessonAnonMap ?? new Map<string, string>(),
      maps.blockAnonMap ?? new Map<string, string>(),
      maps.dayLimitAnonMap ?? new Map<string, string>(),
    ]) {
      for (const [realId, anonId] of map) real.set(anonId, realId);
    }
    // Only whole uuids are replaced, so a message that happens to contain a
    // uuid-shaped substring of something else is left alone.
    return message.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      (found) => real.get(found) ?? found,
    );
  }

  /**
   * POST an anonymised payload to one of the engine's routes.
   *
   * Public, and taking the path, because the room optimisation calls a second
   * route with exactly the same needs: the service key, the timeout, and the
   * three failures told apart below. A copy of this method would be a second
   * place that forgets one of them — which is how "unreachable" and "answered
   * with an error" were once the same sentence.
   *
   * `maps` turns ids in a refusal back into ones the school can look up; pass
   * the maps the payload was built with.
   *
   * `timeoutMs` is this call's whole wait, in place of AI_ENGINE_TIMEOUT_MS —
   * for the rxjs timeout AND the module's axios timeout, which would otherwise
   * cut a longer call off at the default first. A schemaförslag sets it from
   * the budget it gives the solver; every other caller passes nothing and
   * waits exactly as before.
   */
  async callAiEngine<TResponse>(
    path: string,
    payload: object,
    maps: AnonMaps,
    options: { timeoutMs?: number } = {},
  ): Promise<TResponse> {
    const url = `${this.aiConfig.baseUrl}${path}`;
    const carriesSearch = (payload as { search?: unknown }).search !== undefined;

    try {
      const response = await firstValueFrom(
        this.http
          .post<TResponse>(url, payload, {
            headers: {
              'X-API-Key': this.aiConfig.apiKey,
              'Content-Type': 'application/json',
            },
            ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          })
          .pipe(
            timeout(options.timeoutMs ?? this.aiConfig.timeoutMs),
            /*
             * Three different failures, told apart, because they need three
             * different things done about them.
             *
             * "Returned an error" used to cover two of them. An AxiosError with
             * no `response` is a request that never arrived — the engine
             * refused the connection, or the host does not resolve — and
             * reporting that as the engine having answered sent whoever read
             * the log looking at the engine's own logs, which are empty because
             * it was never running. That is the ordinary case locally: the
             * engine is a separate service and it is easy to forget to start.
             *
             * The status is kept from the response where there is one, because
             * a 400 from the engine means this request was wrong and a 500
             * means the engine broke, and flattening both into 502 loses the
             * only thing that separates them.
             */
            catchError((error: unknown) => {
              if (error instanceof TimeoutError) {
                throw new ServiceUnavailableException(
                  'The AI engine did not respond in time.',
                );
              }
              if (error instanceof AxiosError) {
                if (error.response === undefined) {
                  this.logger.error(
                    `AI engine unreachable at ${this.aiConfig.baseUrl} [${error.code ?? 'no code'}]`,
                  );
                  throw new ServiceUnavailableException(ENGINE_UNREACHABLE);
                }
                /*
                 * The engine's own sentence, not a generic one.
                 *
                 * Every named refusal the engine can produce — a lesson length
                 * off the grid, a lunch an availability rule leaves no room
                 * for, a frame too tight for its own stage — arrived here and
                 * was replaced by "The AI engine returned an error.", which
                 * tells a school nothing it can act on. The messages exist and
                 * name the requirement, the group and the day; they were simply
                 * thrown away one layer below the screen that shows them.
                 *
                 * Only the message is forwarded, and only when it is a string:
                 * the engine's error body is {code, message}, and passing the
                 * object through would put a JSON blob in a toast. A 5xx from
                 * the engine keeps the generic text — an internal failure's
                 * detail is ours to read in the logs, not the school's.
                 */
                const body = error.response.data as {
                  message?: unknown;
                  details?: { code?: unknown; params?: unknown; errors?: unknown } | null;
                } | null;
                /*
                 * An engine older than `search`. Its models forbid fields they
                 * do not know, so the request is refused whole with a 422 that
                 * names the field — the deploy order the contract allows (the
                 * engine ships with the API, from the same merge) leaves a few
                 * minutes in which a schemaförslag run meets one. Said as what
                 * it is, so the run fails with a sentence a school can wait
                 * out rather than "validation failed". Only a request that
                 * carried `search`, and only that exact refusal: any other
                 * 422 is this gateway's mistake and keeps its own sentence.
                 */
                if (error.response.status === 422 && carriesSearch && refusesSearch(body)) {
                  throw new HttpException(
                    {
                      message:
                        'Schemamotorn är äldre än API:t och kan inte ta fram schemaförslag ännu. Försök igen om några minuter.',
                      code: ENGINE_LACKS_CANDIDATES,
                    },
                    HttpStatus.SERVICE_UNAVAILABLE,
                  );
                }
                const readable =
                  error.response.status < 500 && typeof body?.message === 'string';
                const detail = readable
                  ? this.deanonymise(body.message as string, maps)
                  : 'The AI engine returned an error.';
                // The refusal's own name and values travel with it, so the
                // screen can say in Swedish what the engine said in English.
                // An object body rather than a string: Nest returns it as the
                // response body, where `message` is still where every reader
                // of this API already looks.
                const named: { code?: string; params?: Record<string, string | number> } =
                  readable && body?.details && typeof body.details.code === 'string'
                    ? {
                        code: body.details.code,
                        params: yearGrades(
                          body.details.code,
                          this.namedParams((body.details.params ?? {}) as Record<string, string | number>, maps),
                          maps,
                        ),
                      }
                    : {};
                // A pre-flight about a post's days (TEACHER_WORK_DAYS_TOO_FEW_
                // FOR_WEEK) leaves as a realised 200 does, without its figure,
                // and with its teacher where no answer reaches: see
                // WorkDaysRefusal.
                if (isDaysBearing(named.code)) {
                  const params = named.params ?? {};
                  throw new WorkDaysRefusal(
                    { message: WORK_DAYS_HIDDEN_MESSAGE, code: named.code as string, params: withoutDays(params) },
                    error.response.status,
                    this.limitSubjects(params, maps),
                  );
                }
                throw new HttpException(
                  { message: detail, ...named },
                  error.response.status,
                );
              }
              throw new ServiceUnavailableException(ENGINE_UNAVAILABLE);
            }),
          ),
      );

      return response.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(ENGINE_UNAVAILABLE);
    }
  }

  /**
   * Writes the engine's week in place of the machine's last one, and answers
   * with the timetable that leaves, by its lessons' teachers and weekday: the
   * lessons it kept, as they stand after its delete, and the ones it wrote —
   * what the free-day wishes are read against (unkeptFreeDayWishes) — or with
   * null when it wrote nothing and left the timetable as it was.
   */
  private async persistMasterLessons(
    tx: PrismaClient,
    academicYearId: string,
    user: AuthenticatedUser,
    response: AiEngineScheduleResponse,
    /** What the answer must place, in real ids, the mirrored posts' included (prepareSchedule). */
    demand: readonly RegenerationDemand[],
    /** The posts written at their leader posts' times (same-times.ts). */
    mirrors: readonly Mirror[],
    requirementAnonMap: Map<string, string>,
    roomAnonMap: Map<string, string>,
    /**
     * Sittings carrying REAL group ids — realiseLunches has already run. Null
     * when the engine was never asked, and then the stored sittings are left
     * exactly as they were.
     */
    lunches: AiEngineLunch[] | null,
    /** groupId → children seated, so the kitchen's list needs no re-derivation. */
    headcountByGroup: Map<string, number>,
    /** The draft's own masters as the fetch saw them, sorted (prepareSchedule). */
    draftIds: readonly string[],
    /** Delade lektioner: the posts sent with their lessons' teachers. */
    splitLessons: SplitLessons = NO_SPLIT,
  ): Promise<TeachersOnDay[] | null> {
    // First, before anything is read: the publication lock and the mode
    // (publish-mode.ts). In DRAFT the regenerated grundschema is a draft.
    // A principal with no tenant is refused below, before anything is
    // deleted, with the message it has always had; it takes no lock.
    const mode = user.schoolId ? await enterGrundschemaWrite(tx, user.schoolId) : 'DIRECT';

    // Neither verdict yields lessons, so both must bail out *before* the
    // delete-and-recreate below — otherwise a run that produced nothing would
    // wipe the school's existing unlocked timetable.
    if (response.status === 'INFEASIBLE' || response.status === 'TIMEOUT') {
      this.logger.warn(
        `AI engine returned ${response.status} for academicYearId=${academicYearId}. No master lessons written.`,
      );
      return null;
    }

    try {
      // One wholesale rewrite of a year at a time (regeneration-lock.ts): an
      // apply or a restore in progress is waited for 5 s, then 409
      // SCHEDULE_BUSY. After the early return, so a run with nothing to write
      // waits for nobody.
      await lockYearForRegeneration(tx, academicYearId, SCHEDULE_BUSY);

      // The lost update the lock alone does not stop. The fetch was a minute
      // ago; if a lesson was locked, unlocked or deleted since, a candidate
      // applied or another run written, this answer was solved for a draft
      // that no longer exists, and writing it would silently throw away
      // whatever replaced it. The set of the draft's own lessons is what this
      // write deletes, so that set is what is compared.
      const now = await tx.masterLesson.findMany({
        where: { academicYearId, NOT: { OR: PRESERVED_FROM_REGENERATION } },
        select: { id: true },
      });
      if (!sameIds(sortedIds(now.map((row) => row.id)), sortedIds(draftIds))) {
        this.logger.warn(
          `Generated timetable not written: the draft changed while the solver ran [academicYearId=${academicYearId}].`,
        );
        throw generateStale();
      }

      if (!user.schoolId) {
        throw new Error('Cannot persist master lessons: schoolId missing from JWT.');
      }

      // Fetch requirement details needed for the MasterLesson record. Read again
      // rather than carried from the fetch phase: the solver has been running in
      // between, and every other field written below comes from this same row.
      const requirementRows = (
        await tx.teachingRequirement.findMany({
          where: { academicYearId },
          select: {
            id: true,
            subjectId: true,
            studentGroupId: true,
            teacherId: true,
            coTeacherId: true,
            recurrence: true,
            startDate: true,
            endDate: true,
            // Delade lektioner: compared with the ones the answer was asked
            // for, so shares changed while the solver ran refuse the write.
            shares: {
              select: { teacherId: true, lessons: true, minutes: true },
              orderBy: [{ minutes: 'desc' }, { teacherId: 'asc' }],
            },
          },
        })
      ).map(({ shares, ...row }) => ({ ...row, ...((shares ?? []).length > 0 ? { shares } : {}) }));

      // The answer in real ids, each mirrored post's lessons written beside
      // its leader post's, judged against the demand by the shared write.
      const written = await this.writeRegeneration(tx, {
        schoolId: user.schoolId,
        academicYearId,
        actorId: user.userId ?? null,
        mode,
        solverStatus: response.status,
        lessons: mirrorLessons(resolveLessons(response.lessons, requirementAnonMap, roomAnonMap, splitLessons), mirrors),
        demand,
        requirementRows,
        lunches,
        headcountByGroup,
        scope: { kind: 'NOT_PRESERVED' },
      });
      return written.timetable;
    } catch (error) {
      // lock_timeout stays 5 s for the rest of the transaction, so a row a
      // hand edit holds is waited for as long as the lock was, and answered
      // the same way.
      if (isLockTimeout(error)) throw scheduleBusy(SCHEDULE_BUSY);
      throw error;
    }
  }

  /**
   * THE REGENERATION WRITE, one body for Generera and for an apply: the
   * guard, the dated lessons of the masters going, the masters, the new
   * lessons, the sittings and the REGENERATE entry, in the caller's
   * transaction and in that order.
   *
   * The scope is the one difference that matters, and it is used IDENTICALLY
   * by the calendar sweep and the master delete: a lesson whose master stays
   * must keep its dated lessons, and one whose master goes must lose them.
   * Generera's is today's rule (NOT preserved); an apply's is the ids its
   * basis saw (`id IN`, `masterLessonId IN`), with the number deleted checked.
   *
   * The requirement rows are passed in: Generera passes the ones it re-read
   * after the solve, an apply the ones its basis was hashed from, so no second
   * read can hand the lessons a teacher the basis never saw.
   */
  private async writeRegeneration(
    tx: PrismaClient,
    input: {
      schoolId: string;
      academicYearId: string;
      actorId: string | null;
      mode: PublishMode;
      solverStatus: string;
      lessons: readonly ResolvedLesson[];
      demand: readonly RegenerationDemand[];
      requirementRows: readonly RegenerationRequirementRow[];
      lunches: AiEngineLunch[] | null;
      headcountByGroup: Map<string, number>;
      scope: RegenerationScope;
      /** Merged into the entry's `after`, under the counts (which it cannot override). */
      after?: Prisma.InputJsonObject;
      /** What a guard failure throws, when not Generera's 502 / a plain error. */
      refusals?: { mismatch?: () => Error; scopeChanged?: () => Error };
      /** Run after the writes and before the change log; throw to roll back. */
      verify?: (lessonsCreated: number) => Promise<void>;
    },
  ): Promise<RegenerationWritten> {
    const { schoolId, academicYearId, mode, scope } = input;
    const rowById = new Map(input.requirementRows.map((row) => [row.id, row]));

    /*
     * The whole replacement is built and checked here, BEFORE a single row is
     * deleted — the ordering is the guard, not an optimization.
     *
     * The engine places every lesson it is asked for or none at all: one
     * decision variable per lesson-per-week, all of them extracted into the
     * response. So a solution that does not carry exactly the demand it was
     * sent is not an answer to this request, whatever its status says, and the
     * timetable must not be replaced by it. A well-formed but empty
     * `{status:"FEASIBLE", lessons:[]}` used to reach the delete below and
     * leave the school's year with nothing in it — and no snapshot is taken
     * before a regeneration, so there was nothing to put back.
     *
     * Lektionslängder: an entry sent WITH a list must come back as exactly
     * those lengths — an engine placing 1 × 80 + 1 × 40 as two 80s answered
     * another request. Only those entries: a uniform one is checked by count
     * as it always was, so no school that never splits meets a new 502.
     */
    const verdict = checkAgainstDemand(input.lessons, input.demand, new Set(rowById.keys()));
    // Delade lektioner: the rows' shares must be the ones the answer was
    // asked for. Equal ('' and '') for every row nobody shares, so a school
    // that shares nothing meets no new refusal here; a row shared, unshared or
    // shared differently while the solver ran is an answer to another request.
    const sharesMoved = input.demand.some((entry) => {
      const row = rowById.get(entry.requirementId);
      return row !== undefined && (entry.shareKey ?? '') !== shareKeyOf(row.shares);
    });
    if (sharesMoved) {
      // Not the engine's fault, so no 502: the school changed a post's shares
      // while the solver ran, and the answer is to a request that no longer
      // stands — said as a draft that moved (GENERATE_STALE, run again), or
      // as the caller's own stale basis (a schemaförslag's apply).
      this.logger.warn(
        `Generated timetable not written: a timplanspost's shares changed while the solver ran [academicYearId=${academicYearId}].`,
      );
      throw input.refusals?.mismatch?.() ?? generateStale();
    }
    if (verdict.unmatched > 0 || verdict.offTarget > 0) {
      this.logger.error(
        `Rejected AI engine solution [academicYearId=${academicYearId}, status=${input.solverStatus}, requestedLessons=${verdict.requested}, placedLessons=${verdict.placed}, unmatchedLessons=${verdict.unmatched}, requirementsOffTarget=${verdict.offTarget}]. Timetable left untouched.`,
      );
      throw (
        input.refusals?.mismatch?.() ??
        new HttpException(
          'The AI engine returned a solution that does not match the requested timetable. The existing timetable was left unchanged.',
          HttpStatus.BAD_GATEWAY,
        )
      );
    }

    // Every lesson matched a row above, so every lookup below finds one.
    const creates = input.lessons.map((lesson) => {
      const req = rowById.get(lesson.requirementId as string)!;
      return {
        schoolId,
        academicYearId,
        subjectId: req.subjectId,
        studentGroupId: req.studentGroupId,
        // Delade lektioner: a lesson of a shared post is its own teacher's;
        // every other lesson is its post's lead's, as it always was.
        teacherId: lesson.teacherId !== undefined ? lesson.teacherId : (req.teacherId ?? null),
        coTeacherId: req.coTeacherId ?? null,
        roomId: lesson.roomId ?? null,
        dayOfWeek: lesson.dayOfWeek,
        startTime: this.parseTime(lesson.startTime),
        endTime: this.parseTime(lesson.endTime),
        // The window comes from the requirement, never from the engine — the
        // engine was never told about weeks and packs a spring-only course as
        // if it ran all year. Stamping the period on afterwards over-provisions
        // (two half-year subjects get separate slots where one would have
        // done) and that is the visible kind of wrong; a lesson that came back
        // as an ordinary weekly one would silently turn "kemi bara på
        // vårterminen" into a year-long course.
        recurrence: req.recurrence,
        startDate: req.startDate,
        endDate: req.endDate,
        // What makes the next run allowed to delete this row again: the one
        // place in the codebase that sets it true, and the column
        // PRESERVED_FROM_REGENERATION asks to tell whose lesson this is.
        isGenerated: true,
      };
    });

    // Non-destructive regeneration: handmade lessons, locked lessons AND
    // participant lessons (manual multi-class / individual-student constructs)
    // are preserved verbatim; only lessons this optimizer wrote are replaced by
    // the new solution. The same four shapes the fetch above shares — and the
    // rows about to be deleted are exactly the ones a previous run stamped
    // `isGenerated`; see the constant for why that is a column and not a guess.
    const preservedWhere = { OR: PRESERVED_FROM_REGENERATION };
    const ids = scope.kind === 'IDS' ? [...scope.ids] : [];

    /*
     * The dated lessons of the templates about to go, removed before the
     * templates themselves.
     *
     * CalendarLessons.masterLessonId is ON DELETE SET NULL, so they would
     * otherwise outlive their template as orphans — and publish keys its
     * idempotency set on (masterLessonId, date), which an orphan matches
     * nothing in. Publishing again after a regeneration then materialized the
     * same week a second time: one lesson a week over four weeks came back as
     * eight, half of them at a slot no timetable mentions any more.
     *
     * Still-SCHEDULED, no attendance recorded, from the school's today: the
     * single-lesson delete's rule (master-lessons.service.ts) but by the day
     * where that one asks by instant, because the publish that follows a
     * regeneration refills whole days (regenerationSweepDay). What has already
     * happened stays exactly as it happened, orphaned but intact.
     */
    // Not in DRAFT: the regeneration is a draft, its published rows stay, and
    // the delete below records them (PublicationPendingRemovals) for the next
    // publish to adopt or remove. Nor its meals (replaceSittings), so there is
    // no day to read.
    const sweepFrom = mode === 'DRAFT' ? null : await regenerationSweepDay(tx, schoolId);
    const { count: removedCalendarLessons } =
      sweepFrom === null
        ? { count: 0 }
        : await tx.calendarLesson.deleteMany({ where: calendarSweepWhere(scope, academicYearId, sweepFrom) });

    const { count: removedUnlocked } = await tx.masterLesson.deleteMany({
      where:
        scope.kind === 'IDS'
          ? { academicYearId, id: { in: ids } }
          : { academicYearId, NOT: preservedWhere },
    });
    // An id the basis saw that is gone, or no longer the year's: the draft
    // moved under the write, and the scope no longer says what it said.
    if (scope.kind === 'IDS' && removedUnlocked !== ids.length) {
      throw (
        input.refusals?.scopeChanged?.() ??
        new Error(`Regeneration scope changed: ${ids.length} expected, ${removedUnlocked} deleted.`)
      );
    }
    /*
     * What the delete left: the audit's count, and the kept half of the
     * timetable the free-day wishes are read against — the timetable this
     * write leaves, so it is read after the delete rather than carried from
     * the fetch. For Generera the solver ran in between: a handmade lesson
     * placed meanwhile is kept and read here, while a lesson that became the
     * machine's or stopped being it never reaches this point (GENERATE_STALE,
     * under the year lock). An apply rebuilt its fetch in this transaction.
     * (A hand edit through MasterLessonsService takes its share of the year's
     * regeneration lock before it writes, and this write holds that lock, so
     * none lands between this read and the commit.) One read for both, where a
     * count stood: the transaction, which holds that lock, sends no more
     * statements than it did. A parked lesson is kept and counted, and
     * occupies no day.
     */
    const preserved = await tx.masterLesson.findMany({
      where: { academicYearId, ...preservedWhere },
      select: { teacherId: true, coTeacherId: true, dayOfWeek: true, isParked: true },
    });
    const lockedPreserved = preserved.length;

    // One INSERT for the lot: no create carries a nested write.
    if (creates.length > 0) {
      await tx.masterLesson.createMany({ data: creates });
    }

    /*
     * The sittings, in the same transaction and with the same all-or-nothing
     * shape as the lessons above.
     *
     * The solver's rows are replaced; the school's are kept. A hand-placed
     * sitting went to the engine as a pin on the lunch variable it builds, not
     * as a fixed lesson beside it, so there is one reservation per meal and the
     * row survives the run that honoured it. See replaceSittings.
     *
     * Reached only after the guards above, so a run the gateway refused leaves
     * last week's flow exactly where it was — and so does a run that never
     * asked the engine, which has no sittings to replace them with.
     */
    if (input.lunches !== null) {
      await this.replaceSittings(tx, schoolId, academicYearId, input.lunches, input.headcountByGroup, sweepFrom);
    }

    await input.verify?.(creates.length);

    // Append a REGENERATE entry to the schedule audit trail.
    const counts: RegenerationCounts = {
      lessonsCreated: creates.length,
      unlockedReplaced: removedUnlocked,
      lockedPreserved,
      calendarLessonsRemoved: removedCalendarLessons,
    };
    await tx.scheduleChangeLog.create({
      data: {
        schoolId,
        academicYearId,
        masterLessonId: null,
        actorId: input.actorId,
        action: 'REGENERATE',
        after: {
          ...(input.after ?? {}),
          solverStatus: input.solverStatus,
          ...counts,
        },
      },
    });
    return {
      ...counts,
      timetable: [...preserved.filter((lesson) => !lesson.isParked), ...creates].map((lesson) => ({
        teacherId: lesson.teacherId,
        coTeacherId: lesson.coTeacherId,
        dayOfWeek: lesson.dayOfWeek,
      })),
    };
  }

  /**
   * Replace the stored sittings with the engine's, classes only, and clear
   * the calendar's future meals so publish re-derives them. The body that
   * used to sit inline in persistMasterLessons; lifted out so a run that
   * never asked the engine can skip it whole.
   */
  private async replaceSittings(
    tx: PrismaClient,
    schoolId: string,
    academicYearId: string,
    lunches: AiEngineLunch[],
    headcountByGroup: Map<string, number>,
    /** The lessons' first swept day (regenerationSweepDay); null in DRAFT. */
    sweepFrom: Date | null,
  ): Promise<void> {
    /*
     * The solver's rows only. A meal the school placed by hand is an
     * instruction, not an output: it went to the engine as a pin, and a run
     * that deleted it would honour it once and forget it for the next.
     */
    await tx.lunchSitting.deleteMany({ where: { academicYearId, isGenerated: true } });
    const handPlaced = await tx.lunchSitting.findMany({
      where: { academicYearId, isGenerated: false },
      select: { id: true, studentGroupId: true, dayOfWeek: true, startTime: true },
    });
    const handByKey = new Map(
      handPlaced.map((row) => [`${row.studentGroupId}:${row.dayOfWeek}`, row]),
    );

    /*
     * Classes eat. Teaching groups do not.
     *
     * The engine gives a lunch interval to every group that carries a
     * requirement — its own comment says so, EVERY HOME CLASS EATS EVERY SCHOOL
     * DAY — and the set it iterates unions the groups with lessons, so Ma71
     * arrives with headcount 0 and gets a sitting every school day. Those rows
     * are not wrong in the engine, where the interval is what keeps a teaching
     * group's lessons out of its members' meal; they are wrong in this table,
     * which is the kitchen's list and the pupil's band. A pupil eats once, with
     * their class.
     */
    const classIds = new Set(
      (
        await tx.studentGroup.findMany({
          where: { academicYearId, kind: 'CLASS' },
          select: { id: true },
        })
      ).map((group) => group.id),
    );
    const classSittings = lunches.filter((lunch) => classIds.has(lunch.studentGroupId));

    /*
     * The engine reports a pinned meal back like any other, so the answer for a
     * hand-placed day lands on a row that already exists — and creating over it
     * would break LunchSittings_group_day_key inside this transaction, after a
     * solve the school watched succeed. So a hand row keeps its start, the one
     * thing the school said, and takes the rest from the answer: the length,
     * because lunchMinutes may have changed since it was placed, and the
     * headcount, because the class may have. If the answer's start is not the
     * school's, the pin did not bind — two halves of one seam have drifted, and
     * that is said loudly rather than papered over.
     */
    const fresh = classSittings.filter(
      (lunch) => !handByKey.has(`${lunch.studentGroupId}:${lunch.dayOfWeek}`),
    );
    for (const lunch of classSittings) {
      const hand = handByKey.get(`${lunch.studentGroupId}:${lunch.dayOfWeek}`);
      if (hand === undefined) continue;
      if (this.timeToString(hand.startTime) !== lunch.startTime) {
        this.logger.error(
          `A hand-placed lunch did not bind: group ${lunch.studentGroupId} day ${lunch.dayOfWeek} ` +
            `was placed at ${this.timeToString(hand.startTime)} and the engine answered ${lunch.startTime}.`,
        );
      }
      await tx.lunchSitting.update({
        where: { id: hand.id },
        data: {
          endTime: this.parseTime(lunch.endTime),
          headcount: headcountByGroup.get(lunch.studentGroupId) ?? 0,
        },
      });
    }
    /*
     * A hand-placed row the engine did not answer for was not honoured: the
     * school switched lunch off, or the class is not at school this week. It
     * goes, for the rule the spec states for the solver's rows — a school that
     * switched lunch off must not keep last term's flow on the grid — and here
     * with a sharper reason: with no meal in the model the lessons were placed
     * straight across it, and kept it would reach the pupil's calendar on top
     * of one.
     */
    const answered = new Set(
      classSittings.map((lunch) => `${lunch.studentGroupId}:${lunch.dayOfWeek}`),
    );
    const unanswered = handPlaced.filter(
      (row) => !answered.has(`${row.studentGroupId}:${row.dayOfWeek}`),
    );
    if (unanswered.length > 0) {
      await tx.lunchSitting.deleteMany({
        where: { id: { in: unanswered.map((row) => row.id) } },
      });
    }

    if (fresh.length > 0) {
      await tx.lunchSitting.createMany({
        data: fresh.map((lunch) => ({
          schoolId,
          academicYearId,
          studentGroupId: lunch.studentGroupId,
          dayOfWeek: lunch.dayOfWeek,
          startTime: this.parseTime(lunch.startTime),
          endTime: this.parseTime(lunch.endTime),
          headcount: headcountByGroup.get(lunch.studentGroupId) ?? 0,
          isGenerated: true,
        })),
      });
    }

    /*
     * And the meals already on the calendar go with them.
     *
     * This file's own header states the rule: whoever replaces a generated
     * timetable deletes its future materializations in the same transaction.
     * The half for the lessons was written; the half for the meal was not, and
     * publish then skipped every (group, date) that already existed — so a
     * republished week kept last month's lunch times for ever, and no screen
     * anywhere said the two disagreed.
     *
     * No academicYearId column is needed to find them: a CalendarLunch belongs
     * to a StudentGroup and a StudentGroup belongs to a year, so the relation
     * filter reaches them. Adding the column and backfilling it from
     * LunchSittings — the obvious alternative — joins on
     * (schoolId, studentGroupId, dayOfWeek) while that table's unique key
     * includes the year, so a school in its second läsår has two matching rows
     * and the backfill is ambiguous.
     *
     * The same three-part guard the lessons use does NOT apply. A CalendarLesson
     * may carry attendance, and rewriting one would be rewriting what happened;
     * a CalendarLunch carries no attendance, no status and no participants, so
     * there is nothing to preserve and no reason to keep the past. Only the
     * lessons' days are deleted all the same, from the school's today, because
     * a meal that was eaten is a fact about a day that has been.
     */
    // Not in DRAFT. The regeneration is a draft, and the meals on the
    // calendar are the published ones that pupils, guardians and the viewer
    // read; the sittings written above are the draft's, hidden from them by
    // RLS until a publish, which replaces the meals of its own window from
    // them (PublicationsService.attempt).
    if (sweepFrom === null) return;
    await tx.calendarLunch.deleteMany({
      where: {
        studentGroup: { is: { academicYearId } },
        date: { gte: sweepFrom },
      },
    });
  }

  /** Converts a Prisma `Time` value (a JS Date with time component) to HH:MM:SS. */
  private timeToString(date: Date): string {
    const h = date.getUTCHours().toString().padStart(2, '0');
    const m = date.getUTCMinutes().toString().padStart(2, '0');
    const s = date.getUTCSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  /** Parses HH:MM:SS from the AI engine response into a Date for Prisma Time fields. */
  private parseTime(timeStr: string): Date {
    const [h, m, s] = timeStr.split(':').map(Number);
    const d = new Date(0);
    d.setUTCHours(h ?? 0, m ?? 0, s ?? 0, 0);
    return d;
  }
}

/** A timplanspost as same-times.ts plans it, with its group's class when the group is a half. */
function sameTimesRowOf(
  row: {
    id: string;
    subjectId: string;
    studentGroupId: string;
    teacherId: string | null;
    coTeacherId: string | null;
    lessonsPerWeek: number;
    minutesPerLesson: number;
    lessonLengths: number[];
    recurrence: LessonRecurrence;
    startDate: Date | null;
    endDate: Date | null;
    shares?: readonly LessonShare[];
  },
  halfOfById: ReadonlyMap<string, string | null> = new Map(),
): SameTimesRow {
  const halfOfId = halfOfById.get(row.studentGroupId) ?? null;
  return {
    id: row.id,
    subjectId: row.subjectId,
    studentGroupId: row.studentGroupId,
    teacherId: row.teacherId ?? null,
    coTeacherId: row.coTeacherId ?? null,
    lessonsPerWeek: row.lessonsPerWeek,
    minutesPerLesson: row.minutesPerLesson,
    lessonLengths: row.lessonLengths ?? [],
    recurrence: row.recurrence,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    ...((row.shares ?? []).length > 0 ? { shared: true } : {}),
    ...(halfOfId !== null ? { halfOfId } : {}),
  };
}

/**
 * A pair of blocks on the same times that planMirror refused, as the engine
 * refuses a block it cannot hold (a 400 with the sentence's code and values,
 * which a run stores and the page says in Swedish), named by the names the
 * school gave them: the follower is `block`, the block whose times it takes
 * `other`. The English is the catalogue's (optimization-engine/app/
 * messages.py), rendered here because the engine never sees the pair.
 */
function sameTimesRefusalOf(
  judgement: Exclude<ReturnType<typeof planMirror>, { ok: true }>,
  link: SameTimesLink,
  nameById: ReadonlyMap<string, string>,
): HttpException {
  const name = (id: string): string => nameById.get(id) ?? id;
  const block = name(link.followerBlockId);
  const other = name(link.leaderBlockId);
  if (judgement.code === BLOCK_SAME_TIMES_SPLIT_LESSONS) {
    const params = { block, other, requirement: name(judgement.requirementId) };
    return new HttpException(
      {
        message:
          `${block} takes the times of ${other}, and ${params.requirement} has its lessons split between ` +
          'teachers. A block on another block\'s times holds one teacher per entry for all its lessons, so give ' +
          'the entry one teacher again, or delete ' +
          `${block} to place its lessons at times of their own.`,
        code: judgement.code,
        params,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (judgement.code === BLOCK_MEMBERS_SHARE_TEACHER) {
    const params = { block, requirement: name(judgement.requirementId), other: name(judgement.otherId) };
    return new HttpException(
      {
        message:
          `${block}: ${params.requirement} and ${params.other} have the same teacher, who cannot teach both at the ` +
          'same time. Give one of them another teacher, or take it out of the block.',
        code: judgement.code,
        params,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  const message =
    judgement.code === BLOCK_SAME_TIMES_DIFFER
      ? `${block} takes the times of ${other}, and the two no longer fit together: they need the same subjects ` +
        "for the same groups (or, for a subject a class's halves take in turn, one entry on each half), with the " +
        'same lessons, in weeks that never meet. Make them match again, where Change lessons on either block ' +
        `changes both, or delete ${block} to place its lessons at times of their own.`
      : `${block} takes the times of ${other}, and has more teachers that ${other} does not than the entries of ` +
        `${other} have room for beside their own. Give the entries of ${block} the teachers of ${other}, or take a ` +
        `co-teacher off ${other}.`;
  return new HttpException({ message, code: judgement.code, params: { block, other } }, HttpStatus.BAD_REQUEST);
}

/**
 * The room a lesson of both posts needs: the larger group, and both spans.
 * Null (no follower) is the post's own needs.
 */
function widerNeeds(own: RoomNeeds, other: RoomNeeds | null): RoomNeeds {
  if (other === null) return own;
  const bound = (a: number | null, b: number | null, pick: (x: number, y: number) => number) =>
    a === null ? b : b === null ? a : pick(a, b);
  return {
    studentGroupSize: Math.max(own.studentGroupSize, other.studentGroupSize),
    minGradeLevel: bound(own.minGradeLevel, other.minGradeLevel, Math.min),
    maxGradeLevel: bound(own.maxGradeLevel, other.maxGradeLevel, Math.max),
    requiredRoomTypeId: own.requiredRoomTypeId,
  };
}

/** The stricter of two ämnesfördelningar, each half on its own; null is no second rule. */
function stricterRule(own: DistributionRule, other: DistributionRule | null): DistributionRule {
  if (other === null) return own;
  const bound = (a: number | null, b: number | null, pick: (x: number, y: number) => number) =>
    a === null ? b : b === null ? a : pick(a, b);
  return {
    maxLessonsPerDay: bound(own.maxLessonsPerDay, other.maxLessonsPerDay, Math.min),
    minDaysBetween: bound(own.minDaysBetween, other.minDaysBetween, Math.max),
  };
}

/**
 * The refusals whose `grades` is the span of a timplanspost's or a group's
 * classes — sent in NIOARIG (fetchAndAnonymize), so named back in the year's
 * own numbering. Not a lunch serving's or a weekly reservation's span, which
 * the school stated in NIOARIG and reads so (LUNCH_SERVING_CANNOT_FEED_STAGE);
 * a dated årskursregel's is its own day's läsår's (yearGrades).
 */
const CLASS_SPAN_CODES = new Set([
  'FRAME_NO_WINDOW_FOR_REQUIREMENT',
  'MARGIN_NO_WINDOW_FOR_REQUIREMENT',
  'RAST_NO_STRETCH_FOR_REQUIREMENT',
  'RAST_MARGIN_NO_STRETCH_FOR_REQUIREMENT',
  'LESSON_NO_START_FOR_REQUIREMENT',
  'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT',
  'ROOM_LOCK_LEAVES_NO_ROOM',
  'RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT',
  'RAST_DEMANDS_MORE_LESSONS_THAN_FIT_BEFORE_IT',
]);

/**
 * A refusal's params with the span in `grades` ("7", "7–9") in the numbering
 * the school reads it in: a class span (CLASS_SPAN_CODES) in the scheduled
 * läsår's, a dated årskursregel's (a reservation's params: kind GRADE_LEVEL
 * and a date, INPUT_CONSTRAINT_TIME_OFF_GRID) in its own day's läsår's.
 * Everything else is stated in NIOARIG and left as sent.
 */
export function yearGrades(
  code: string | undefined,
  params: Record<string, string | number>,
  maps: Pick<AnonMaps, 'gradeNumbering' | 'numberingOnDay'>,
): Record<string, string | number> {
  const grades = params['grades'];
  const date = params['date'];
  if (!code || typeof grades !== 'string') return params;
  const numbering = CLASS_SPAN_CODES.has(code)
    ? maps.gradeNumbering
    : params['kind'] === 'GRADE_LEVEL' && typeof date === 'string' && date !== ''
      ? maps.numberingOnDay?.(date)
      : undefined;
  if (numbering !== 'TIOARIG') return params;
  return { ...params, grades: grades.replace(/\d+/g, (grade) => String(fromNioarig(Number(grade), numbering))) };
}
