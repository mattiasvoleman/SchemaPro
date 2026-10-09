import { isoWeekNumber, runsOn } from '../calendar/lesson-recurrence';
import {
  breakCoversGroup,
  breakDaysOf,
  closuresByDateOf,
  isoWeekday,
  parseUtcDate,
  publishSkips,
  toDateString,
  type PublishBreak,
  type PublishClosure,
  type PublishDaysContext,
} from '../calendar/publish-days';
import { teachingWeeks, type ClosedRange } from '../staffing/teaching-weeks';
import { shortestLessonOf, weeklyMinutesOf } from './lesson-lengths';
import type { PlannedCoverageInput, PlannedGroup, PlannedRequirement } from './timplan-planned';
import { lessonMinutes } from './timplan-scheduled';
import { zonedTimeToUtc } from './utils/time';

/*
 * Genomfört mot schemalagt — layer 3 of the timplan coverage: the minutes the
 * calendar records as held, per group, subject and pupil, against what was
 * published, with the lost minutes split by cause and a projection to the end
 * of the läsår against the planned year.
 *
 * WHAT COUNTS AS DELIVERED is defined once, in SQL, in
 * src/timplan/timplan-delivered.sql.ts: a past, SCHEDULED or COMPLETED lesson
 * with a teacher row, of a subject that counts, for each pupil on its roster;
 * plus the school's credits in scope dated before today. This module never
 * re-classifies a lesson: it receives the minutes per (owner, subject, bucket,
 * audience) and puts pupils on the audiences. Attendance is not subtracted.
 *
 * Gateway-only and pure (no Prisma, no clock: the caller hands in asOf). The
 * web holds types and view helpers only; nothing recomputes layer 3 live.
 *
 * ## A line
 *
 * Per (group, subject) — and a line "none" for credits without a subject. A
 * group line counts the lessons the group OWNS and those it attends as an
 * EXTRA group; a pupil line every lesson whose audience holds the pupil (home
 * class, teaching groups, extra groups, named), each audience ONCE however many
 * of the pupil's groups it reaches through.
 *
 *   published        = every past bucket but CANCELLED_ON_BREAK
 *   delivered        = DELIVERED
 *   lost             = TEACHERLESS + CANCELLED_* (not ON_BREAK) + OTHER
 *   credited         = credits in scope dated before asOfDate
 *   calendarAhead    = AHEAD (teacherless excluded, R2)
 *   masterAhead      = Σ over the staffed non-parked master lessons reaching
 *                      the line of their minutes on each day from the day
 *                      after the lesson's own last calendar row (or today) to
 *                      the year's end that publish would write a lesson on
 *                      (runsOn ∧ publishSkips = null; today only if the
 *                      lesson has not yet ended) — the per-lesson horizon (R1)
 *   creditsAhead     = credits in scope dated today or later (R9)
 *   projected        = delivered + credited + calendarAhead + masterAhead + creditsAhead
 *   plannedYear      = Σ weeklyMinutesOf(post) × teachingWeeks(post, year, lov, grade)
 *                      at the group's own årskurs — a teaching group's too
 *                      when it carries one, since publish and the walk skip
 *                      its lessons by that årskurs (gradeOfGroup)
 *   unrecorded       = the planned minutes of the teaching days nothing records:
 *                      before the first published day, after the last one up
 *                      to yesterday (R3), and the past weekdays between them
 *                      on which the school's calendar holds no row at all —
 *                      a gap two publishes left — neither delivered nor lost
 *   delta            = projected − (plannedYear − unrecorded)
 *   scheduleGap      = (projected + lost + aheadCancelled + aheadTeacherless)
 *                      − (plannedYear − unrecorded)   (R4: the schedule's own
 *                      shortfall, apart from cancellations)
 *   status           = NO_PLAN without a planned year; SHORT when −delta is at
 *                      least the line's shortest lesson; ON_TRACK otherwise.
 *
 * plannedYear charges a lov day a fifth of a week while the walk drops that
 * weekday's real lessons, so a sub-lesson difference either way is no
 * finding — a larger one shows up in scheduleGap, apart from lost.
 *
 * ## Credits
 *
 * A credit reaches: the whole school — every home pupil of a class of the
 * year and every class line; a grade span — pupils whose HOME class's årskurs
 * is inside it and the class lines inside it; a group — its pupils and its
 * line. Teaching-group lines are reached only in the credit's subject where
 * the group studies it (a post or a lesson in it): from a whole-school credit,
 * from a span wholly holding its members' span (their home classes' grades,
 * or the group's own årskurs without members, R8), and from a class credit
 * when every member's home class is that class — the 7AB-tjej rule for one
 * class. A Spanska group gets no "Idrott tillgodoräknat" line from a
 * friluftsdag; its pupils have the minutes through their class. A credit
 * without a subject reaches class lines only. A non-counting subject, an empty scope or a group
 * of another year reaches nobody (TIMPLAN_CREDIT_REACHES_NOBODY); a date
 * outside the year counts nowhere (TIMPLAN_CREDIT_OUTSIDE_YEAR). A credit on a
 * day that still has delivered lessons owned in its scope is never subtracted
 * — a temaeftermiddag after a morning of lessons is legitimate — but named
 * (TIMPLAN_CREDIT_OVERLAPS_DELIVERED, R6).
 *
 * ## The pupil
 *
 * Listed only for a shortfall of their own (R16): their projected deficit in
 * a line exceeds the sum of the deficits of every group line reaching them in
 * it by at least the line's shortest lesson — or nothing delivered while their
 * class's median for the line is above nothing. Everyone else is counted.
 * Statistics on a group line are over the pupils' projected delta (R17), with
 * raw delivered minutes beside them. Rosters are TODAY's (no history until
 * P4); a past year's classes read empty and say so.
 */

export type DeliveredBucket =
  | 'DELIVERED'
  | 'TEACHERLESS'
  | 'CANCELLED_TEACHER_UNAVAILABLE'
  | 'CANCELLED_ROOM_UNAVAILABLE'
  | 'CANCELLED_MANUAL'
  | 'CANCELLED_UNKNOWN'
  | 'CANCELLED_ON_BREAK'
  | 'OTHER'
  | 'AHEAD'
  | 'AHEAD_TEACHERLESS'
  | 'AHEAD_CANCELLED'
  | 'AHEAD_CANCELLED_ON_BREAK'
  | 'AHEAD_OTHER';

export type LostCause =
  | 'cancelledTeacherUnavailable'
  | 'cancelledRoomUnavailable'
  | 'cancelledManual'
  | 'cancelledUnknown'
  | 'teacherless'
  | 'otherStatus';

const LOST: Partial<Record<DeliveredBucket, LostCause>> = {
  CANCELLED_TEACHER_UNAVAILABLE: 'cancelledTeacherUnavailable',
  CANCELLED_ROOM_UNAVAILABLE: 'cancelledRoomUnavailable',
  CANCELLED_MANUAL: 'cancelledManual',
  CANCELLED_UNKNOWN: 'cancelledUnknown',
  TEACHERLESS: 'teacherless',
  OTHER: 'otherStatus',
};
const CAUSE_ORDER: LostCause[] = [
  'cancelledTeacherUnavailable',
  'cancelledRoomUnavailable',
  'cancelledManual',
  'cancelledUnknown',
  'teacherless',
  'otherStatus',
];

/** Statements A and B: minutes per (owner, subject, bucket, audience). */
export interface DeliveredAudienceRow {
  studentGroupId: string;
  subjectId: string;
  bucket: DeliveredBucket;
  /** Sorted; empty on an unshared lesson. */
  extraGroupIds: string[];
  studentIds: string[];
  minutes: number;
  lessons: number;
}

/** Statement C: a master lesson's calendar rows. */
export interface DeliveredHorizonRow {
  masterLessonId: string;
  aheadRows: number;
  firstDate: string;
  lastDate: string;
}

/** Statement D: DELIVERED minutes per (owner group, date). */
export interface DeliveredDateRow {
  studentGroupId: string;
  date: string;
  minutes: number;
}

export interface DeliveredMasterLesson {
  id: string;
  studentGroupId: string;
  subjectId: string;
  extraGroupIds: string[];
  studentIds: string[];
  teacherId: string | null;
  coTeacherId: string | null;
  dayOfWeek: number;
  /** 'HH:MM' or 'HH:MM:SS'. */
  startTime: string;
  endTime: string;
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  startDate: string | null;
  endDate: string | null;
  isParked: boolean;
}

export interface TimplanCreditRow {
  id: string;
  date: string;
  minutes: number;
  subjectId: string | null;
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  name: string;
}

export interface DeliveredCoverageInput {
  /** P2's read (readPlannedInput): year, lov, subjects, groups, posts, pupils, plans. */
  planned: PlannedCoverageInput;
  audiences: DeliveredAudienceRow[];
  horizon: DeliveredHorizonRow[];
  dates: DeliveredDateRow[];
  masterLessons: DeliveredMasterLesson[];
  /** What publish skips by: the year's breaks and dated class/grade closures. */
  publish: { breaks: PublishBreak[]; closures: PublishClosure[]; timezone: string };
  credits: TimplanCreditRow[];
  /** The instant "past" is measured at (ISO), and the school's day it falls on. */
  asOf: string;
  asOfDate: string;
  /** The year's first and last dated row; null when nothing is published. */
  published: { from: string; through: string } | null;
  /**
   * Every date the year's calendar holds a row on (statement C). A past
   * weekday between `published.from` and `through` missing from it is a gap
   * two publishes left. Absent: no gap is looked for.
   */
  publishedDays?: string[];
  /** The drill-down: detail lines for this group, and (admin) every pupil of it. */
  drillGroupId: string | null;
}

export interface DeltaStats {
  min: number;
  median: number;
  max: number;
  below: number;
}

export interface DeliveredLineSummary {
  /** 'subject:<id>' or 'none' (credits without a subject). */
  key: string;
  subjectId: string | null;
  publishedMinutes: number;
  deliveredMinutes: number;
  lostMinutes: number;
  creditedMinutes: number;
  projectedMinutes: number;
  plannedYearMinutes: number;
  unrecordedMinutes: number;
  deliveredPercent: number | null;
  status: 'ON_TRACK' | 'SHORT' | 'NO_PLAN';
  pupils?: {
    /** Raw delivered minutes so far; below = pupils given less than the line itself. */
    delivered: DeltaStats;
    /** projected − (plannedYear − unrecorded), per pupil, subject-wide. */
    projectedDelta: DeltaStats;
    belowPlanned: number;
    nothingDelivered: number;
  };
}

export interface DeliveredProjection {
  deliveredSoFar: number;
  calendarAhead: number;
  aheadTeacherless: number;
  aheadCancelled: number;
  masterAhead: number;
  creditsAhead: number;
  projectedMinutes: number;
  plannedYearMinutes: number;
  unrecordedMinutes: number;
  targetYearMinutes: number | null;
  deltaMinutes: number;
  scheduleGapMinutes: number;
  /** Lost so far plus cancelled ahead: what cancellations cost the year. */
  lostMinutes: number;
}

export interface DeliveredLineDetail extends DeliveredLineSummary {
  lost: Partial<Record<LostCause, number>>;
  cancelledOnBreak: number;
  projection: DeliveredProjection;
  credits: { id: string; date: string; name: string; minutes: number }[];
  masterLessonIds: string[];
}

export interface DeliveredGroupSummary {
  studentGroupId: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  pupilCount: number;
  /** unrecorded: the planned minutes of days nothing records, inside plannedYear (projected is judged against plannedYear − unrecorded). */
  totals: { published: number; delivered: number; lost: number; credited: number; projected: number; plannedYear: number; unrecorded: number };
  lostByCause: Partial<Record<LostCause, number>>;
  lines: (DeliveredLineSummary | DeliveredLineDetail)[];
}

export interface DeliveredPupilSource {
  /** The group the delivered lessons reached the pupil through; null when only named. */
  studentGroupId: string | null;
  deliveredMinutes: number;
  /** The pupil's other groups the same lessons reached them through, counted once. */
  sharedWith: string[];
}

export interface DeliveredPupil {
  pupilId: string;
  homeGroupId: string;
  gradeLevel: number | null;
  lines: (DeliveredLineSummary & { groupDeficitMinutes: number; sources: DeliveredPupilSource[] })[];
}

export type DeliveredVerdictCode =
  | 'TIMPLAN_NOT_PUBLISHED'
  | 'TIMPLAN_PUBLISHED_LATE'
  | 'TIMPLAN_PUBLISHED_BEHIND'
  | 'TIMPLAN_PUBLISHED_GAP'
  | 'TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS'
  | 'TIMPLAN_CALENDAR_DRIFT'
  | 'TIMPLAN_DELIVERED_TEACHERLESS'
  | 'TIMPLAN_PROJECTION_SHORT'
  | 'TIMPLAN_PUPIL_PROJECTION_SHORT'
  | 'TIMPLAN_PUPIL_NOTHING_DELIVERED'
  | 'TIMPLAN_CREDIT_OUTSIDE_YEAR'
  | 'TIMPLAN_CREDIT_REACHES_NOBODY'
  | 'TIMPLAN_CREDIT_OVERLAPS_DELIVERED'
  | 'TIMPLAN_CALENDAR_ON_BREAK';

export interface DeliveredVerdict {
  code: DeliveredVerdictCode;
  severity: 'notice' | 'warning';
  studentGroupId?: string;
  subjectIds?: string[];
  pupilId?: string;
  creditId?: string;
  params: Record<string, string | number>;
}

export interface DeliveredCoverage {
  layer: 'delivered';
  asOf: string;
  asOfDate: string;
  published: { from: string; through: string } | null;
  pupilLevel: boolean;
  groups: DeliveredGroupSummary[];
  pupils: DeliveredPupil[] | null;
  pupilCount: number;
  pupilsBelowPlanned: number | null;
  credits: { count: number; minutes: number };
  /**
   * The calendar ahead of today against the grundschema. extraMinutes: rows
   * the grundschema would not write (a parked lesson's, a narrowed window's);
   * missingMinutes: occurrences it would write that have no row. minutes is
   * missing − extra, kept signed for the reader that wants one figure — the
   * two parts are what to act on, since they cancel each other in it.
   */
  drift: { minutes: number; extraMinutes: number; missingMinutes: number; lessons: number } | null;
  verdicts: DeliveredVerdict[];
}

const VERDICT_ORDER: Record<DeliveredVerdictCode, number> = {
  TIMPLAN_NOT_PUBLISHED: 0,
  TIMPLAN_PUBLISHED_LATE: 1,
  TIMPLAN_PUBLISHED_BEHIND: 2,
  TIMPLAN_PUBLISHED_GAP: 3,
  TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS: 4,
  TIMPLAN_CALENDAR_DRIFT: 5,
  TIMPLAN_DELIVERED_TEACHERLESS: 6,
  TIMPLAN_PROJECTION_SHORT: 7,
  TIMPLAN_PUPIL_PROJECTION_SHORT: 8,
  TIMPLAN_PUPIL_NOTHING_DELIVERED: 9,
  TIMPLAN_CREDIT_OUTSIDE_YEAR: 10,
  TIMPLAN_CREDIT_REACHES_NOBODY: 11,
  TIMPLAN_CREDIT_OVERLAPS_DELIVERED: 12,
  TIMPLAN_CALENDAR_ON_BREAK: 13,
};

const NONE = 'none';
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv');
const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: string, days: number): string =>
  toDateString(new Date(parseUtcDate(date).getTime() + days * DAY_MS));
const clockDate = (hhmm: string): Date => new Date(`1970-01-01T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}.000Z`);

/** min / median / max over whole minutes, `below` counted by the caller's rule. */
function statsOf(values: number[], below: number): DeltaStats {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    min: sorted[0]!,
    median:
      sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2),
    max: sorted[sorted.length - 1]!,
    below,
  };
}

/** Whether a closure reaches an årskurs (teaching-weeks.ts's rule). */
function closesGrade(closure: ClosedRange, grade: number | null): boolean {
  const min = closure.minGradeLevel ?? null;
  const max = closure.maxGradeLevel ?? null;
  if (min === null && max === null) return true;
  if (grade === null) return false;
  return (min === null || grade >= min) && (max === null || grade <= max);
}

/**
 * The planned minutes of a post's teaching days in [from, to], day by day: a
 * fifth of its weekly minutes for each Mon–Fri inside the post's window and
 * the year, in a week its recurrence runs, that no lov closes for the grade.
 * Exact to the day, where teachingWeeks charges a partly covered edge week
 * whole — the unrecorded days start and end mid-week.
 */
export function plannedMinutesBetween(
  row: PlannedRequirement,
  from: string,
  to: string,
  year: { startDate: string; endDate: string },
  closures: ClosedRange[],
  grade: number | null,
): number {
  const start = [from, row.startDate ?? year.startDate, year.startDate].reduce((a, b) => (a > b ? a : b));
  const end = [to, row.endDate ?? year.endDate, year.endDate].reduce((a, b) => (a < b ? a : b));
  if (start > end) return 0;
  const perDay = weeklyMinutesOf(row) / 5;
  const recurrence = row.recurrence ?? 'ALL_WEEKS';
  const applicable = closures.filter((closure) => closesGrade(closure, grade));
  let minutes = 0;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (isoWeekday(day) > 5) continue;
    if (recurrence !== 'ALL_WEEKS') {
      const odd = isoWeekNumber(parseUtcDate(day)) % 2 === 1;
      if ((recurrence === 'ODD_WEEKS') !== odd) continue;
    }
    if (applicable.some((closure) => day >= closure.startDate && day <= closure.endDate)) continue;
    minutes += perDay;
  }
  return minutes;
}

/**
 * The dates statement D is asked about: every credit date inside the year and
 * every past day a break covers (some group) — a delivered lesson on either is
 * a notice. The service and the tests ask this one function.
 */
export function deliveredDatesToAsk(
  credits: readonly { date: string }[],
  breaks: readonly PublishBreak[],
  year: { startDate: string; endDate: string },
  asOfDate: string,
): string[] {
  const dates = new Set<string>();
  for (const credit of credits) {
    if (credit.date >= year.startDate && credit.date <= year.endDate) dates.add(credit.date);
  }
  const lastPast = addDays(asOfDate, -1);
  if (lastPast >= year.startDate) {
    for (const day of breakDaysOf(breaks, year.startDate, lastPast < year.endDate ? lastPast : year.endDate).keys()) {
      dates.add(day);
    }
  }
  return [...dates].sort();
}

/** Planned minutes of days nothing records, by where they lie (R3). */
interface UnrecordedParts {
  late: number;
  behind: number;
  gap: number;
}
const unrecordedTotal = (parts: UnrecordedParts): number => parts.late + parts.behind + parts.gap;

/** A line being assembled for one group or one pupil. */
interface Tally {
  buckets: Map<DeliveredBucket, number>;
  creditsPast: number;
  creditsAhead: number;
  creditIds: string[];
  masterAhead: number;
  masterAheadTeacherless: number;
  masterLessonIds: Set<string>;
  plannedYear: number;
  /** By window: before the calendar, after it, and gaps inside it. */
  unrecorded: UnrecordedParts;
  target: number | null;
  shortest: number;
  /** pupils only: delivered minutes per via group, and the groups shared with. */
  sources?: Map<string, { minutes: number; sharedWith: Set<string> }>;
  /** pupils only: every group whose line reaches the pupil in this line. */
  reachedBy?: Set<string>;
}

const newTally = (): Tally => ({
  buckets: new Map(),
  creditsPast: 0,
  creditsAhead: 0,
  creditIds: [],
  masterAhead: 0,
  masterAheadTeacherless: 0,
  masterLessonIds: new Set(),
  plannedYear: 0,
  unrecorded: { late: 0, behind: 0, gap: 0 },
  target: null,
  shortest: Infinity,
});

interface Figures {
  published: number;
  delivered: number;
  lost: number;
  lostByCause: Partial<Record<LostCause, number>>;
  cancelledOnBreak: number;
  credited: number;
  calendarAhead: number;
  aheadTeacherless: number;
  aheadCancelled: number;
  masterAhead: number;
  creditsAhead: number;
  deliveredSoFar: number;
  projected: number;
  plannedYear: number;
  unrecorded: number;
  delta: number;
  scheduleGap: number;
  status: 'ON_TRACK' | 'SHORT' | 'NO_PLAN';
}

/** A tally's figures, every one rounded once to whole minutes. */
function figuresOf(tally: Tally): Figures {
  const b = (bucket: DeliveredBucket) => tally.buckets.get(bucket) ?? 0;
  const lostByCause: Partial<Record<LostCause, number>> = {};
  let lost = 0;
  for (const [bucket, cause] of Object.entries(LOST) as [DeliveredBucket, LostCause][]) {
    const minutes = b(bucket);
    if (minutes > 0) {
      lostByCause[cause] = Math.round(minutes);
      lost += minutes;
    }
  }
  const delivered = b('DELIVERED');
  const credited = tally.creditsPast;
  const calendarAhead = b('AHEAD');
  const aheadTeacherless = b('AHEAD_TEACHERLESS') + tally.masterAheadTeacherless;
  const aheadCancelled = b('AHEAD_CANCELLED') + b('AHEAD_OTHER');
  const deliveredSoFar = delivered + credited;
  const projected = deliveredSoFar + calendarAhead + tally.masterAhead + tally.creditsAhead;
  const unrecorded = unrecordedTotal(tally.unrecorded);
  const measured = tally.plannedYear - unrecorded;
  const plannedYear = Math.round(tally.plannedYear);
  const delta = Math.round(projected - measured);
  const status: Figures['status'] =
    plannedYear === 0 ? 'NO_PLAN' : Number.isFinite(tally.shortest) && -delta >= tally.shortest ? 'SHORT' : 'ON_TRACK';
  return {
    published: Math.round(delivered + lost),
    delivered: Math.round(delivered),
    lost: Math.round(lost),
    lostByCause,
    // Past or ahead, a cancelled row on a lov day is neither lost nor
    // projected: the plan does not count the day, so the row reads the same
    // before its day and after it.
    cancelledOnBreak: Math.round(b('CANCELLED_ON_BREAK') + b('AHEAD_CANCELLED_ON_BREAK')),
    credited: Math.round(credited),
    calendarAhead: Math.round(calendarAhead),
    aheadTeacherless: Math.round(aheadTeacherless),
    aheadCancelled: Math.round(aheadCancelled),
    masterAhead: Math.round(tally.masterAhead),
    creditsAhead: Math.round(tally.creditsAhead),
    deliveredSoFar: Math.round(deliveredSoFar),
    projected: Math.round(projected),
    plannedYear,
    unrecorded: Math.round(unrecorded),
    delta,
    scheduleGap: Math.round(projected + lost + aheadCancelled + aheadTeacherless - measured),
    status,
  };
}

export function computeDeliveredCoverage(input: DeliveredCoverageInput): DeliveredCoverage {
  const { planned, asOfDate } = input;
  const includePupils = planned.includePupils;
  const year = planned.year;
  const asOf = new Date(input.asOf);
  const empty = (verdicts: DeliveredVerdict[]): DeliveredCoverage => ({
    layer: 'delivered',
    asOf: input.asOf,
    asOfDate,
    published: input.published,
    pupilLevel: includePupils,
    groups: [],
    pupils: includePupils ? [] : null,
    pupilCount: 0,
    pupilsBelowPlanned: includePupils ? 0 : null,
    credits: { count: 0, minutes: 0 },
    drift: null,
    verdicts,
  });
  // Nothing published: the one thing said, and nothing else changes (R3).
  if (input.published === null) {
    return empty([{ code: 'TIMPLAN_NOT_PUBLISHED', severity: 'notice', params: {} }]);
  }

  const subjects = new Map(planned.subjects.filter((s) => s.countsTowardTimplan).map((s) => [s.id, s]));
  const groups = new Map(planned.groups.map((g) => [g.id, g]));
  const groupOrder = (a: string, b: string): number =>
    byName(groups.get(a)?.name ?? '', groups.get(b)?.name ?? '') || byCode(a, b);
  const keyOrder = (a: string, b: string): number => {
    if (a === NONE || b === NONE) return a === b ? 0 : a === NONE ? 1 : -1;
    const sa = a.slice('subject:'.length);
    const sb = b.slice('subject:'.length);
    return byName(subjects.get(sa)?.name ?? '', subjects.get(sb)?.name ?? '') || byCode(sa, sb);
  };
  const keyOf = (subjectId: string | null): string => (subjectId === null ? NONE : `subject:${subjectId}`);
  /**
   * The årskurs a group's posts and the lov are judged at: the group's own,
   * for a teaching group too. Publish skips a lesson on a lov by its owner's
   * gradeLevel (gradeOfGroup, breakCoversGroup) and the walk ahead does the
   * same, so a nivågrupp with årskurs 9 loses the åk 9 prao week on the
   * calendar side; judged at no årskurs, its planned year kept that week and
   * the line read a week SHORT with nothing lost. Layer 2 weighs both sides
   * at none and stays consistent by itself; layer 3 has a walk to agree with.
   */
  const judgedGrade = (group: PlannedGroup): number | null => group.gradeLevel;

  // ---- Pupils on today's rosters: home class of this year, teaching groups.
  interface Pupil {
    id: string;
    home: PlannedGroup;
    grade: number | null;
    groupIds: string[];
  }
  const pupils: Pupil[] = [];
  const membersOf = new Map<string, Pupil[]>();
  for (const entry of [...planned.pupils].sort((a, b) => byCode(a.id, b.id))) {
    const home = entry.homeGroupId === null ? undefined : groups.get(entry.homeGroupId);
    if (!home || home.kind !== 'CLASS') continue;
    const teaching = [...new Set(entry.groupIds)].filter((id) => groups.get(id)?.kind === 'TEACHING_GROUP');
    const pupil: Pupil = { id: entry.id, home, grade: home.gradeLevel, groupIds: [home.id, ...teaching] };
    pupils.push(pupil);
    for (const groupId of pupil.groupIds) {
      const list = membersOf.get(groupId) ?? [];
      list.push(pupil);
      membersOf.set(groupId, list);
    }
  }
  /** A teaching group's members' span (room-eligibility's gradeSpanOf rule). */
  const spanOf = (group: PlannedGroup): { min: number; max: number } | null => {
    const grades = (membersOf.get(group.id) ?? [])
      .map((p) => p.grade)
      .filter((g): g is number => typeof g === 'number');
    if (grades.length === 0) return typeof group.gradeLevel === 'number' ? { min: group.gradeLevel, max: group.gradeLevel } : null;
    return { min: Math.min(...grades), max: Math.max(...grades) };
  };

  // ---- Tallies.
  const groupTallies = new Map<string, Map<string, Tally>>();
  const groupTally = (groupId: string, key: string): Tally => {
    let lines = groupTallies.get(groupId);
    if (!lines) groupTallies.set(groupId, (lines = new Map()));
    let tally = lines.get(key);
    if (!tally) lines.set(key, (tally = newTally()));
    return tally;
  };
  const addBucket = (tally: Tally, bucket: DeliveredBucket, minutes: number) =>
    tally.buckets.set(bucket, (tally.buckets.get(bucket) ?? 0) + minutes);

  // The calendar's minutes on the group lines: the owner's, and each extra group's.
  const audiences = input.audiences.filter((row) => subjects.has(row.subjectId) && groups.has(row.studentGroupId));
  for (const row of audiences) {
    const key = keyOf(row.subjectId);
    for (const groupId of new Set([row.studentGroupId, ...row.extraGroupIds])) {
      if (!groups.has(groupId)) continue;
      addBucket(groupTally(groupId, key), row.bucket, row.minutes);
    }
  }

  // ---- The master lessons ahead of the calendar, and the drift inside it.
  const gradeOfGroup = new Map(planned.groups.map((g) => [g.id, g.gradeLevel]));
  const ctx: PublishDaysContext = {
    breakDays: breakDaysOf(input.publish.breaks, asOfDate, year.endDate),
    closuresByDate: closuresByDateOf(input.publish.closures),
    gradeOfGroup,
    timezone: input.publish.timezone,
  };
  const horizon = new Map(input.horizon.map((row) => [row.masterLessonId, row]));
  const masterLessons = input.masterLessons.filter((m) => subjects.has(m.subjectId) && groups.has(m.studentGroupId));
  const aheadOf = new Map<string, number>();
  let driftExtra = 0;
  let driftMissing = 0;
  let driftLessons = 0;
  for (const m of masterLessons) {
    const row = horizon.get(m.id);
    const minutes = lessonMinutes(m);
    if (m.isParked) {
      // The calendar still holds it; the master does not (R1).
      if (row && row.aheadRows > 0) {
        driftExtra += row.aheadRows * minutes;
        driftLessons += 1;
      }
      continue;
    }
    const window = {
      recurrence: m.recurrence ?? 'ALL_WEEKS',
      startDate: m.startDate ? parseUtcDate(m.startDate) : null,
      endDate: m.endDate ? parseUtcDate(m.endDate) : null,
    };
    const template = { studentGroupId: m.studentGroupId, startTime: clockDate(m.startTime), endTime: clockDate(m.endTime) };
    const runs = (day: string): boolean =>
      runsOn(window, parseUtcDate(day)) &&
      publishSkips(template, day, ctx) === null &&
      (day > asOfDate || zonedTimeToUtc(day, m.endTime, ctx.timezone).getTime() > asOf.getTime());
    // The first occurrence on or after a day, by the lesson's weekday.
    const firstFrom = (day: string): string => addDays(day, (m.dayOfWeek - isoWeekday(day) + 7) % 7);
    let count = 0;
    const start = row && row.lastDate >= asOfDate ? addDays(row.lastDate, 1) : asOfDate;
    for (let day = firstFrom(start); day <= year.endDate; day = addDays(day, 7)) if (runs(day)) count += 1;
    aheadOf.set(m.id, count * minutes);
    if (row && row.lastDate >= asOfDate) {
      let walked = 0;
      for (let day = firstFrom(asOfDate); day <= row.lastDate; day = addDays(day, 7)) if (runs(day)) walked += 1;
      if (walked !== row.aheadRows) {
        if (walked > row.aheadRows) driftMissing += (walked - row.aheadRows) * minutes;
        else driftExtra += (row.aheadRows - walked) * minutes;
        driftLessons += 1;
      }
    }
  }
  const staffed = (m: DeliveredMasterLesson) => m.teacherId !== null || m.coTeacherId !== null;
  const addMaster = (tally: Tally, m: DeliveredMasterLesson) => {
    const minutes = aheadOf.get(m.id) ?? 0;
    if (staffed(m)) tally.masterAhead += minutes;
    else tally.masterAheadTeacherless += minutes;
    tally.masterLessonIds.add(m.id);
  };
  for (const m of masterLessons) {
    if (m.isParked) continue;
    for (const groupId of new Set([m.studentGroupId, ...m.extraGroupIds])) {
      if (groups.has(groupId)) addMaster(groupTally(groupId, keyOf(m.subjectId)), m);
    }
  }

  // The posts per group, for the planned side below and for which subjects a
  // group studies here.
  const rowsByGroup = new Map<string, PlannedRequirement[]>();
  for (const row of planned.requirements) {
    if (!subjects.has(row.subjectId) || !groups.has(row.studentGroupId)) continue;
    const list = rowsByGroup.get(row.studentGroupId) ?? [];
    list.push(row);
    rowsByGroup.set(row.studentGroupId, list);
  }
  /** Whether a group studies a subject: a post in it, or a calendar or grundschema lesson reaching it. */
  const studied = new Map<string, Set<string>>();
  for (const [groupId, lines] of groupTallies) studied.set(groupId, new Set(lines.keys()));
  for (const [groupId, rows] of rowsByGroup) {
    const keys = studied.get(groupId) ?? new Set<string>();
    for (const row of rows) keys.add(keyOf(row.subjectId));
    studied.set(groupId, keys);
  }
  const studies = (groupId: string, subjectId: string | null): boolean =>
    subjectId !== null && (studied.get(groupId)?.has(keyOf(subjectId)) ?? false);

  // ---- Credits: who each reaches, and what is said about it.
  const verdicts: DeliveredVerdict[] = [];
  const classes = planned.groups.filter((g) => g.kind === 'CLASS');
  const teachingGroups = planned.groups.filter((g) => g.kind === 'TEACHING_GROUP');
  interface CreditReach {
    credit: TimplanCreditRow;
    key: string;
    past: boolean;
    groupIds: string[];
    pupilIds: Set<string>;
  }
  const reaches: CreditReach[] = [];
  const datesByGroup = new Map<string, Map<string, number>>();
  for (const row of input.dates) {
    const byDate = datesByGroup.get(row.studentGroupId) ?? new Map<string, number>();
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.minutes);
    datesByGroup.set(row.studentGroupId, byDate);
  }
  let creditCount = 0;
  let creditMinutes = 0;
  for (const credit of [...input.credits].sort((a, b) => byCode(a.date, b.date) || byCode(a.id, b.id))) {
    const named = { creditName: credit.name, date: credit.date, minutes: credit.minutes };
    if (credit.date < year.startDate || credit.date > year.endDate) {
      verdicts.push({ code: 'TIMPLAN_CREDIT_OUTSIDE_YEAR', severity: 'notice', creditId: credit.id, params: { ...named, yearStart: year.startDate, yearEnd: year.endDate } });
      continue;
    }
    let groupIds: string[];
    let reached: Pupil[];
    const studying = teachingGroups.filter((g) => studies(g.id, credit.subjectId));
    if (credit.studentGroupId !== null) {
      const group = groups.get(credit.studentGroupId);
      groupIds = group ? [group.id] : [];
      reached = group
        ? (membersOf.get(group.id) ?? []).filter((p) => group.kind === 'TEACHING_GROUP' || p.home.id === group.id)
        : [];
      // R8 for one class: a teaching group made of this class's pupils only.
      if (group?.kind === 'CLASS') {
        for (const g of studying) {
          const members = membersOf.get(g.id) ?? [];
          if (members.length > 0 && members.every((p) => p.home.id === group.id)) groupIds.push(g.id);
        }
      }
    } else if (credit.minGradeLevel === null || credit.maxGradeLevel === null) {
      groupIds = [...classes.map((g) => g.id), ...studying.map((g) => g.id)];
      reached = pupils;
    } else {
      const inside = (grade: number | null) =>
        typeof grade === 'number' && grade >= credit.minGradeLevel! && grade <= credit.maxGradeLevel!;
      groupIds = [
        ...classes.filter((g) => inside(g.gradeLevel)).map((g) => g.id),
        ...studying
          .filter((g) => {
            const span = spanOf(g);
            return span !== null && inside(span.min) && inside(span.max);
          })
          .map((g) => g.id),
      ];
      reached = pupils.filter((p) => inside(p.grade));
    }
    const counts = credit.subjectId === null || subjects.has(credit.subjectId);
    if (!counts || (groupIds.length === 0 && reached.length === 0)) {
      verdicts.push({
        code: 'TIMPLAN_CREDIT_REACHES_NOBODY',
        severity: 'notice',
        creditId: credit.id,
        params: { ...named, reason: counts ? 'SCOPE' : 'SUBJECT' },
      });
      continue;
    }
    creditCount += 1;
    creditMinutes += credit.minutes;
    const key = keyOf(credit.subjectId);
    const past = credit.date < asOfDate;
    for (const groupId of groupIds) {
      const tally = groupTally(groupId, key);
      if (past) tally.creditsPast += credit.minutes;
      else tally.creditsAhead += credit.minutes;
      tally.creditIds.push(credit.id);
    }
    reaches.push({ credit, key, past, groupIds, pupilIds: new Set(reached.map((p) => p.id)) });
    // Lessons delivered the same day by groups in the credit's scope (R6).
    const overlap = groupIds.reduce((sum, id) => sum + (datesByGroup.get(id)?.get(credit.date) ?? 0), 0);
    if (overlap > 0) {
      verdicts.push({
        code: 'TIMPLAN_CREDIT_OVERLAPS_DELIVERED',
        severity: 'notice',
        creditId: credit.id,
        params: { ...named, deliveredMinutes: overlap },
      });
    }
  }

  // Delivered lessons on a day a break covers for their group: counted, named (R13).
  for (const [groupId, byDate] of [...datesByGroup].sort(([a], [b]) => groupOrder(a, b))) {
    const group = groups.get(groupId);
    if (!group) continue;
    let minutes = 0;
    const days: string[] = [];
    for (const [date, delivered] of [...byDate].sort(([a], [b]) => byCode(a, b))) {
      const covered = input.publish.breaks.some(
        (entry) =>
          date >= toDateString(entry.startDate) &&
          date <= toDateString(entry.endDate) &&
          breakCoversGroup(entry, gradeOfGroup.get(groupId)),
      );
      if (covered && delivered > 0) {
        minutes += delivered;
        days.push(date);
      }
    }
    if (minutes > 0) {
      verdicts.push({
        code: 'TIMPLAN_CALENDAR_ON_BREAK',
        severity: 'notice',
        studentGroupId: groupId,
        params: { groupName: group.name, minutes, days: days.length, dates: days.join(', ') },
      });
    }
  }

  // ---- Planned side: the posts, the year, and the days nothing records.
  const windows: Record<keyof UnrecordedParts, [string, string][]> = { late: [], behind: [], gap: [] };
  const yesterday = addDays(asOfDate, -1);
  const lastRecorded = input.published.through < yesterday ? input.published.through : yesterday;
  {
    const end = [addDays(input.published.from, -1), yesterday].reduce((a, b) => (a < b ? a : b));
    if (end >= year.startDate) windows.late.push([year.startDate, end]);
    const after = addDays(input.published.through, 1);
    if (after <= yesterday && after >= year.startDate) windows.behind.push([after, yesterday < year.endDate ? yesterday : year.endDate]);
  }
  // Gaps inside the published range: a past weekday no lov closes for the
  // whole school on which the calendar holds no row at all. Publishing from
  // today by default, a school that published to Christmas and again from
  // 18 January never wrote 11–15 January; without this the week sat inside
  // [from, through] as neither unrecorded nor drift (the drift walk starts at
  // today) and the line turned SHORT, blamed on the schedule, the moment the
  // second publish ran. A day's rows are all or nothing for this test — any
  // group's row records the day — so a grade's own lov is no gap, and a day
  // a lov closes for every class is no gap either (nothing was to be written).
  let gapDays = 0;
  const gapRange: string[] = [];
  if (input.publishedDays) {
    const recorded = new Set(input.publishedDays);
    const classGrades = [...new Set(classes.map((g) => g.gradeLevel))];
    const closedForAll = (day: string): boolean =>
      classGrades.every((grade) =>
        planned.closures.some((c) => day >= c.startDate && day <= c.endDate && closesGrade(c, grade)),
      );
    let run: [string, string] | null = null;
    for (let day = input.published.from; day <= lastRecorded; day = addDays(day, 1)) {
      const weekday = isoWeekday(day);
      if (weekday > 5) continue;
      if (recorded.has(day) || closedForAll(day)) {
        run = null;
        continue;
      }
      gapDays += 1;
      if (gapRange.length === 0) gapRange.push(day);
      gapRange[1] = day;
      // One window per run of weekdays; the weekend inside a run adds nothing.
      if (run && addDays(run[1], weekday === 1 ? 3 : 1) === day) run[1] = day;
      else windows.gap.push((run = [day, day]));
    }
  }
  const plannedCache = new Map<string, { year: number; unrecorded: UnrecordedParts }>();
  const plannedOf = (row: PlannedRequirement, grade: number | null) => {
    const cacheKey = `${row.id}:${grade}`;
    let found = plannedCache.get(cacheKey);
    if (!found) {
      const between = (list: [string, string][]) =>
        list.reduce((sum, [from, to]) => sum + plannedMinutesBetween(row, from, to, year, planned.closures, grade), 0);
      found = {
        year: weeklyMinutesOf(row) * teachingWeeks(row, year, planned.closures, grade),
        unrecorded: { late: between(windows.late), behind: between(windows.behind), gap: between(windows.gap) },
      };
      plannedCache.set(cacheKey, found);
    }
    return found;
  };
  const addPlanned = (tally: Tally, row: PlannedRequirement, grade: number | null) => {
    const share = plannedOf(row, grade);
    tally.plannedYear += share.year;
    tally.unrecorded.late += share.unrecorded.late;
    tally.unrecorded.behind += share.unrecorded.behind;
    tally.unrecorded.gap += share.unrecorded.gap;
    const shortest = shortestLessonOf(row);
    if (shortest > 0) tally.shortest = Math.min(tally.shortest, shortest);
  };
  for (const group of planned.groups) {
    for (const row of rowsByGroup.get(group.id) ?? []) addPlanned(groupTally(group.id, keyOf(row.subjectId)), row, judgedGrade(group));
  }
  // The timplan's year figure beside a class line, when one is attached.
  const plans = new Map(planned.plans.map((p) => [p.id, p]));
  const yearWeeks = new Map<number, number>();
  for (const attachment of planned.attachments) {
    const plan = plans.get(attachment.localTimplanId);
    if (!plan) continue;
    for (const group of classes.filter((g) => g.gradeLevel === attachment.gradeLevel)) {
      let weeks = yearWeeks.get(attachment.gradeLevel);
      if (weeks === undefined) yearWeeks.set(attachment.gradeLevel, (weeks = teachingWeeks({}, year, planned.closures, attachment.gradeLevel)));
      for (const entry of plan.entries) {
        if (entry.gradeLevel !== attachment.gradeLevel || !subjects.has(entry.subjectId)) continue;
        const lines = groupTallies.get(group.id);
        const tally = lines?.get(keyOf(entry.subjectId));
        if (tally) tally.target = entry.minutesPerWeek * weeks;
      }
    }
  }

  // ---- Pupils: their own tallies.
  const audiencesByGroup = new Map<string, DeliveredAudienceRow[]>();
  const audiencesByPupil = new Map<string, DeliveredAudienceRow[]>();
  for (const row of audiences) {
    for (const groupId of new Set([row.studentGroupId, ...row.extraGroupIds])) {
      const list = audiencesByGroup.get(groupId) ?? [];
      list.push(row);
      audiencesByGroup.set(groupId, list);
    }
    for (const pupilId of new Set(row.studentIds)) {
      const list = audiencesByPupil.get(pupilId) ?? [];
      list.push(row);
      audiencesByPupil.set(pupilId, list);
    }
  }
  const mastersByGroup = new Map<string, DeliveredMasterLesson[]>();
  const mastersByPupil = new Map<string, DeliveredMasterLesson[]>();
  for (const m of masterLessons) {
    if (m.isParked) continue;
    for (const groupId of new Set([m.studentGroupId, ...m.extraGroupIds])) {
      const list = mastersByGroup.get(groupId) ?? [];
      list.push(m);
      mastersByGroup.set(groupId, list);
    }
    for (const pupilId of new Set(m.studentIds)) {
      const list = mastersByPupil.get(pupilId) ?? [];
      list.push(m);
      mastersByPupil.set(pupilId, list);
    }
  }
  const creditsByPupil = new Map<string, CreditReach[]>();
  for (const reach of reaches) {
    for (const pupilId of reach.pupilIds) {
      const list = creditsByPupil.get(pupilId) ?? [];
      list.push(reach);
      creditsByPupil.set(pupilId, list);
    }
  }

  const pupilTallies = new Map<string, Map<string, Tally>>();
  for (const pupil of pupils) {
    const own = new Set(pupil.groupIds);
    const lines = new Map<string, Tally>();
    const tallyFor = (key: string): Tally => {
      let tally = lines.get(key);
      if (!tally) {
        tally = { ...newTally(), sources: new Map(), reachedBy: new Set() };
        lines.set(key, tally);
      }
      return tally;
    };
    const seen = new Set<DeliveredAudienceRow>();
    for (const row of [...pupil.groupIds.flatMap((id) => audiencesByGroup.get(id) ?? []), ...(audiencesByPupil.get(pupil.id) ?? [])]) {
      if (seen.has(row)) continue;
      seen.add(row);
      const tally = tallyFor(keyOf(row.subjectId));
      addBucket(tally, row.bucket, row.minutes);
      const through = [row.studentGroupId, ...row.extraGroupIds].filter((id) => own.has(id));
      tally.reachedBy!.add(row.studentGroupId);
      for (const id of through) tally.reachedBy!.add(id);
      if (row.bucket === 'DELIVERED') {
        const via = through[0] ?? '';
        const source = tally.sources!.get(via) ?? { minutes: 0, sharedWith: new Set<string>() };
        source.minutes += row.minutes;
        for (const id of through.slice(1)) source.sharedWith.add(id);
        tally.sources!.set(via, source);
      }
    }
    const seenMasters = new Set<string>();
    for (const m of [...pupil.groupIds.flatMap((id) => mastersByGroup.get(id) ?? []), ...(mastersByPupil.get(pupil.id) ?? [])]) {
      if (seenMasters.has(m.id)) continue;
      seenMasters.add(m.id);
      const tally = tallyFor(keyOf(m.subjectId));
      addMaster(tally, m);
      tally.reachedBy!.add(m.studentGroupId);
    }
    for (const reach of creditsByPupil.get(pupil.id) ?? []) {
      const tally = tallyFor(reach.key);
      if (reach.past) tally.creditsPast += reach.credit.minutes;
      else tally.creditsAhead += reach.credit.minutes;
      tally.creditIds.push(reach.credit.id);
    }
    for (const groupId of pupil.groupIds) {
      for (const row of rowsByGroup.get(groupId) ?? []) {
        const tally = tallyFor(keyOf(row.subjectId));
        addPlanned(tally, row, pupil.grade);
        tally.reachedBy!.add(groupId);
      }
    }
    pupilTallies.set(pupil.id, lines);
  }

  // ---- Group figures, and the pupil statistics on them.
  const groupFigures = new Map<string, Map<string, Figures>>();
  for (const [groupId, lines] of groupTallies) {
    groupFigures.set(groupId, new Map([...lines].map(([key, tally]) => [key, figuresOf(tally)])));
  }
  const pupilFigures = new Map<string, Map<string, Figures>>();
  for (const [pupilId, lines] of pupilTallies) {
    pupilFigures.set(pupilId, new Map([...lines].map(([key, tally]) => [key, figuresOf(tally)])));
  }
  /** The home class's median delivered per line, for "nothing delivered". */
  const classMedian = new Map<string, number>();

  const drill = input.drillGroupId;
  const summaryOf = (key: string, figures: Figures): DeliveredLineSummary => ({
    key,
    subjectId: key === NONE ? null : key.slice('subject:'.length),
    publishedMinutes: figures.published,
    deliveredMinutes: figures.delivered,
    lostMinutes: figures.lost,
    creditedMinutes: figures.credited,
    projectedMinutes: figures.projected,
    plannedYearMinutes: figures.plannedYear,
    unrecordedMinutes: figures.unrecorded,
    deliveredPercent: figures.published > 0 ? Math.round((100 * figures.delivered) / figures.published) : null,
    status: figures.status,
  });
  const keepLine = (figures: Figures, tally: Tally) =>
    figures.published > 0 ||
    figures.plannedYear > 0 ||
    figures.projected > 0 ||
    figures.cancelledOnBreak > 0 ||
    figures.aheadTeacherless > 0 ||
    tally.creditIds.length > 0;

  const summaries: DeliveredGroupSummary[] = [];
  const ordered = [...planned.groups].sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === 'CLASS' ? -1 : 1) || groupOrder(a.id, b.id),
  );
  const creditsById = new Map(input.credits.map((c) => [c.id, c]));
  for (const group of ordered) {
    const tallies = groupTallies.get(group.id) ?? new Map<string, Tally>();
    const figuresByKey = groupFigures.get(group.id) ?? new Map<string, Figures>();
    const keys = [...tallies.keys()].filter((key) => keepLine(figuresByKey.get(key)!, tallies.get(key)!)).sort(keyOrder);
    if (group.kind === 'TEACHING_GROUP' && keys.length === 0) continue;
    const statPupils = (membersOf.get(group.id) ?? []).filter((p) => group.kind === 'TEACHING_GROUP' || p.home.id === group.id);
    const totals = { published: 0, delivered: 0, lost: 0, credited: 0, projected: 0, plannedYear: 0, unrecorded: 0 };
    const lostByCause: Partial<Record<LostCause, number>> = {};
    let teacherless = 0;
    const lines: (DeliveredLineSummary | DeliveredLineDetail)[] = [];
    for (const key of keys) {
      const tally = tallies.get(key)!;
      const figures = figuresByKey.get(key)!;
      totals.published += figures.published;
      totals.delivered += figures.delivered;
      totals.lost += figures.lost;
      totals.credited += figures.credited;
      totals.projected += figures.projected;
      totals.plannedYear += figures.plannedYear;
      totals.unrecorded += figures.unrecorded;
      for (const cause of CAUSE_ORDER) {
        const minutes = figures.lostByCause[cause];
        if (minutes) lostByCause[cause] = (lostByCause[cause] ?? 0) + minutes;
      }
      teacherless += figures.lostByCause.teacherless ?? 0;
      const line: DeliveredLineSummary | DeliveredLineDetail = summaryOf(key, figures);
      if (includePupils && statPupils.length > 0) {
        const delivered = statPupils.map((p) => pupilFigures.get(p.id)?.get(key)?.delivered ?? 0);
        const deltas = statPupils.map((p) => pupilFigures.get(p.id)?.get(key)?.delta ?? 0);
        const stats = statsOf(delivered, delivered.filter((value) => value < figures.delivered).length);
        if (group.kind === 'CLASS') classMedian.set(`${group.id}|${key}`, stats.median);
        line.pupils = {
          delivered: stats,
          projectedDelta: statsOf(deltas, deltas.filter((value) => value < 0).length),
          belowPlanned: statPupils.filter((p) => pupilFigures.get(p.id)?.get(key)?.status === 'SHORT').length,
          nothingDelivered: 0,
        };
      }
      if (drill === group.id) {
        const detail = line as DeliveredLineDetail;
        const lost: Partial<Record<LostCause, number>> = {};
        for (const cause of CAUSE_ORDER) if (figures.lostByCause[cause]) lost[cause] = figures.lostByCause[cause];
        detail.lost = lost;
        detail.cancelledOnBreak = figures.cancelledOnBreak;
        detail.projection = {
          deliveredSoFar: figures.deliveredSoFar,
          calendarAhead: figures.calendarAhead,
          aheadTeacherless: figures.aheadTeacherless,
          aheadCancelled: figures.aheadCancelled,
          masterAhead: figures.masterAhead,
          creditsAhead: figures.creditsAhead,
          projectedMinutes: figures.projected,
          plannedYearMinutes: figures.plannedYear,
          unrecordedMinutes: figures.unrecorded,
          targetYearMinutes: tally.target === null ? null : Math.round(tally.target),
          deltaMinutes: figures.delta,
          scheduleGapMinutes: figures.scheduleGap,
          lostMinutes: figures.lost + figures.aheadCancelled,
        };
        detail.credits = tally.creditIds
          .map((id) => creditsById.get(id)!)
          .map((c) => ({ id: c.id, date: c.date, name: c.name, minutes: c.minutes }));
        detail.masterLessonIds = [...tally.masterLessonIds].sort(byCode);
      }
      lines.push(line);
      if (figures.status === 'SHORT') {
        verdicts.push({
          code: 'TIMPLAN_PROJECTION_SHORT',
          severity: 'warning',
          studentGroupId: group.id,
          ...(key === NONE ? {} : { subjectIds: [key.slice('subject:'.length)] }),
          params: {
            groupName: group.name,
            subjectName: key === NONE ? 'Utan ämne' : (subjects.get(key.slice('subject:'.length))?.name ?? ''),
            projectedMinutes: figures.projected,
            plannedYearMinutes: figures.plannedYear - figures.unrecorded,
            deficitMinutes: -figures.delta,
            lostMinutes: figures.lost + figures.aheadCancelled,
            scheduleGapMinutes: figures.scheduleGap,
          },
        });
      }
    }
    if (teacherless > 0) {
      verdicts.push({
        code: 'TIMPLAN_DELIVERED_TEACHERLESS',
        severity: 'warning',
        studentGroupId: group.id,
        params: { groupName: group.name, minutes: teacherless },
      });
    }
    summaries.push({
      studentGroupId: group.id,
      kind: group.kind,
      gradeLevel: group.gradeLevel,
      pupilCount: statPupils.length,
      totals,
      lostByCause,
      lines,
    });
  }

  // ---- Pupils: their own findings, and the drill-down.
  const listed: DeliveredPupil[] = [];
  let pupilsBelow = 0;
  const nothingCount = new Map<string, number>();
  for (const pupil of pupils) {
    const tallies = pupilTallies.get(pupil.id)!;
    const figuresByKey = pupilFigures.get(pupil.id)!;
    const drilled = drill !== null && pupil.groupIds.includes(drill);
    let below = false;
    const lines: DeliveredPupil['lines'] = [];
    for (const key of [...tallies.keys()].sort(keyOrder)) {
      const tally = tallies.get(key)!;
      const figures = figuresByKey.get(key)!;
      if (!keepLine(figures, tally)) continue;
      if (figures.status === 'SHORT') below = true;
      const deficit = Math.max(0, -figures.delta);
      const groupDeficit = [...tally.reachedBy!].reduce(
        (sum, id) => sum + Math.max(0, -(groupFigures.get(id)?.get(key)?.delta ?? 0)),
        0,
      );
      const ownFinding = figures.status === 'SHORT' && deficit - groupDeficit >= tally.shortest;
      const median = classMedian.get(`${pupil.home.id}|${key}`) ?? 0;
      const nothing = figures.plannedYear > 0 && figures.delivered === 0 && median > 0;
      const subjectIds = key === NONE ? undefined : [key.slice('subject:'.length)];
      const subjectName = key === NONE ? 'Utan ämne' : (subjects.get(key.slice('subject:'.length))?.name ?? '');
      if (ownFinding) {
        verdicts.push({
          code: 'TIMPLAN_PUPIL_PROJECTION_SHORT',
          severity: 'warning',
          pupilId: pupil.id,
          studentGroupId: pupil.home.id,
          ...(subjectIds ? { subjectIds } : {}),
          params: {
            groupName: pupil.home.name,
            subjectName,
            projectedMinutes: figures.projected,
            plannedYearMinutes: figures.plannedYear - figures.unrecorded,
            deficitMinutes: deficit,
            groupDeficitMinutes: groupDeficit,
          },
        });
      }
      if (nothing) {
        nothingCount.set(`${pupil.home.id}|${key}`, (nothingCount.get(`${pupil.home.id}|${key}`) ?? 0) + 1);
        verdicts.push({
          code: 'TIMPLAN_PUPIL_NOTHING_DELIVERED',
          severity: 'warning',
          pupilId: pupil.id,
          studentGroupId: pupil.home.id,
          ...(subjectIds ? { subjectIds } : {}),
          params: { groupName: pupil.home.name, subjectName, classMedianMinutes: median, publishedMinutes: figures.published },
        });
      }
      if (!ownFinding && !nothing && !drilled) continue;
      lines.push({
        ...summaryOf(key, figures),
        groupDeficitMinutes: groupDeficit,
        sources: [...tally.sources!.entries()]
          .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : groupOrder(a, b)))
          .map(([via, source]) => ({
            studentGroupId: via === '' ? null : via,
            deliveredMinutes: Math.round(source.minutes),
            sharedWith: [...source.sharedWith].sort(groupOrder),
          })),
      });
    }
    if (below) pupilsBelow += 1;
    if (lines.length > 0 || drilled) {
      listed.push({ pupilId: pupil.id, homeGroupId: pupil.home.id, gradeLevel: pupil.grade, lines });
    }
  }
  if (includePupils) {
    for (const summary of summaries) {
      if (summary.kind !== 'CLASS') continue;
      for (const line of summary.lines) {
        if (line.pupils) line.pupils.nothingDelivered = nothingCount.get(`${summary.studentGroupId}|${line.key}`) ?? 0;
      }
    }
  }

  // ---- The year's notices.
  // Each window's own planned minutes over the class lines, so a notice
  // names only the days it speaks of — and is raised only when they hold
  // planned time: a year starting on a Saturday and published from Monday is
  // not late.
  const classUnrecorded: UnrecordedParts = { late: 0, behind: 0, gap: 0 };
  for (const group of classes) {
    for (const tally of groupTallies.get(group.id)?.values() ?? []) {
      classUnrecorded.late += tally.unrecorded.late;
      classUnrecorded.behind += tally.unrecorded.behind;
      classUnrecorded.gap += tally.unrecorded.gap;
    }
  }
  if (Math.round(classUnrecorded.late) > 0) {
    verdicts.push({
      code: 'TIMPLAN_PUBLISHED_LATE',
      severity: 'notice',
      params: { from: input.published.from, yearStart: year.startDate, unrecordedMinutes: Math.round(classUnrecorded.late) },
    });
  }
  if (Math.round(classUnrecorded.behind) > 0) {
    verdicts.push({
      code: 'TIMPLAN_PUBLISHED_BEHIND',
      severity: 'notice',
      params: { through: input.published.through, asOfDate, unrecordedMinutes: Math.round(classUnrecorded.behind) },
    });
  }
  if (Math.round(classUnrecorded.gap) > 0) {
    verdicts.push({
      code: 'TIMPLAN_PUBLISHED_GAP',
      severity: 'notice',
      params: {
        from: gapRange[0]!,
        through: gapRange[1]!,
        days: gapDays,
        unrecordedMinutes: Math.round(classUnrecorded.gap),
      },
    });
  }
  if (year.endDate < asOfDate) {
    verdicts.push({ code: 'TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS', severity: 'notice', params: { yearEnd: year.endDate } });
  }
  const drift =
    driftLessons > 0
      ? { minutes: driftMissing - driftExtra, extraMinutes: driftExtra, missingMinutes: driftMissing, lessons: driftLessons }
      : null;
  if (drift) {
    verdicts.push({ code: 'TIMPLAN_CALENDAR_DRIFT', severity: 'notice', params: { ...drift } });
  }

  verdicts.sort((a, b) => VERDICT_ORDER[a.code] - VERDICT_ORDER[b.code]);
  // The drill-down answers for its group alone — the overview the page
  // already holds has the rest — so that its every-pupil, every-line list
  // stays the size of one class (R20). Year-wide counts stay year-wide.
  const inDrill = (groupId: string | undefined) => drill === null || groupId === undefined || groupId === drill;
  return {
    layer: 'delivered',
    asOf: input.asOf,
    asOfDate,
    published: input.published,
    pupilLevel: includePupils,
    groups: drill === null ? summaries : summaries.filter((summary) => summary.studentGroupId === drill),
    pupils: includePupils
      ? drill === null
        ? listed
        : listed.filter((entry) => pupils.find((p) => p.id === entry.pupilId)!.groupIds.includes(drill))
      : null,
    pupilCount: pupils.length,
    pupilsBelowPlanned: includePupils ? pupilsBelow : null,
    credits: { count: creditCount, minutes: creditMinutes },
    drift,
    verdicts: verdicts.filter(
      (verdict) => (includePupils || verdict.pupilId === undefined) && inDrill(verdict.studentGroupId),
    ),
  };
}
