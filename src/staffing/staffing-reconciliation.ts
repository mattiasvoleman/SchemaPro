import {
  breakDaysOf,
  closuresByDateOf,
  type PublishBreak,
  type PublishClosure,
  type PublishDaysContext,
} from '../calendar/publish-days';
import {
  masterOccurrencesBetween,
  plannedMinutesBetween,
  publishedGaps,
} from '../common/timplan-delivered';
import { lessonMinutes } from '../common/timplan-scheduled';
import { slotPercentOf, type LessonSlot, type ScheduledMaster } from './scheduled-load';
import { weigh, type LoadModel, type LoadRequirement } from './teacher-load';
import type { ClosedRange, YearBounds } from './teaching-weeks';

/*
 * Avstämning per lärare: planerat, schemalagt och genomfört över ett datumintervall.
 *
 * Three columns per teacher, per (subject, group) line, each charged the way
 * the load report charges — the row's percentage per role (slotPercentOf,
 * src/staffing/scheduled-load.ts), × the subject's weight under FACTOR
 * (weigh) — so a teacher whose year went to plan reads the same figure three
 * times:
 *
 *   PLANNED    each timplanspost's minutes on the teaching days of the range
 *              (plannedMinutesBetween, P3's day-exact helper: a fifth of a
 *              week per Mon–Fri the row runs and no lov closes for its
 *              group's own årskurs — the grade publish skips by, so the three
 *              columns agree on lov days).
 *   SCHEDULED  every non-parked grundschema lesson's occurrences in the range
 *              that publish would write (masterOccurrencesBetween: runsOn ∧
 *              publishSkips, P3's walk), × its own length. TODAY's grundschema
 *              counted over the period; what changed during it shows in
 *              Genomfört.
 *   DELIVERED  the calendar's HELD lessons — P3's one definition, statement E
 *              over deliveredLessons with every subject — credited to the
 *              CalendarLessonTeachers rows on them:
 *                - LEAD and ASSISTANT at their slot's percentage; a SUBSTITUTE
 *                  at 100 % (Lectio credits the vikarie the same way);
 *                - a LEAD/ASSISTANT row beside a SUBSTITUTE is DISPLACED and
 *                  credits nobody (counted for the admin's notice);
 *                - the lessons a substitute OTHER than the grundschema's lead
 *                  or co-teacher took are those people's coveredByOthers —
 *                  read off the master lesson's CURRENT slots;
 *                - a cancelled lesson keeps its rows: those teachers' lost
 *                  minutes, by cause (a vikarie assigned to a lesson later
 *                  cancelled carries its loss);
 *                - not yet ended: ahead; CANCELLED_ON_BREAK: neither.
 *              Plus, for the admin, the bortfall per group and subject — every
 *              lost lesson once, in the pupils' lesson minutes, never charged.
 *
 * THE COMPARISON STARTS WHERE THE CALENDAR DOES. A range from the year's start
 * when the school first published in October would read August and September
 * as a deficit that is only "not yet published". So planned and scheduled are
 * measured over [max(from, published.from), min(to, published.through)] and
 * the notices say so; gaps between two publishes are named (P3's finder) and
 * not adjusted.
 *
 * ROUNDED ONCE. Every line, every teacher total and the totals are rounded
 * from their unrounded sums; a teacher's total is NOT the sum of the rounded
 * lines (the UI says "avrundat per rad").
 *
 * PURE. Ids only, never a name; the service reads the rows.
 */

/** A lost bucket of P3's CASE, as the reconciliation names its cause. */
const LOST_BUCKETS = {
  CANCELLED_TEACHER_UNAVAILABLE: 'cancelledTeacherUnavailable',
  CANCELLED_ROOM_UNAVAILABLE: 'cancelledRoomUnavailable',
  CANCELLED_MANUAL: 'cancelledManual',
  CANCELLED_UNKNOWN: 'cancelledUnknown',
  OTHER: 'otherStatus',
} as const;
type LostKey = (typeof LOST_BUCKETS)[keyof typeof LOST_BUCKETS];

export type StaffingNoticeCode =
  | 'STAFFING_NOTHING_PUBLISHED'
  | 'STAFFING_RANGE_CLAMPED'
  | 'STAFFING_RANGE_INCLUDES_FUTURE'
  | 'STAFFING_RANGE_BEFORE_PUBLISHED'
  | 'STAFFING_RANGE_AFTER_PUBLISHED'
  | 'STAFFING_RANGE_HAS_GAPS'
  | 'STAFFING_LEAD_BESIDE_SUBSTITUTE';

export interface StaffingNotice {
  code: StaffingNoticeCode;
  params: Record<string, string | number>;
}

export type LostMinutes = Record<LostKey, number>;

export interface ReconciliationLine {
  subjectId: string;
  /** The owner group of the rows and lessons on the line. */
  studentGroupId: string;
  /** Every extra group the line's lessons were also for (samläsning), sorted. */
  extraGroupIds: string[];
  planned: number;
  scheduled: number;
  delivered: number;
  substituteMinutes: number;
  lostMinutes: number;
}

export interface TeacherReconciliation {
  userId: string;
  /** Charged minutes in the comparison window / the range, whole minutes, each rounded once. */
  planned: number;
  scheduled: number;
  delivered: number;
  /** The part of `delivered` this teacher held as a vikarie. */
  substituteMinutes: number;
  /** Delivered minutes of this teacher's grundschema slots that another person substituted. */
  coveredByOthersMinutes: number;
  /** Lessons in the range that have not yet ended, with this teacher on them. */
  aheadMinutes: number;
  lost: LostMinutes;
  lostMinutes: number;
  deliveredLessons: number;
  /** LEAD/ASSISTANT rows beside a SUBSTITUTE, credited to nobody. Null for a teacher's own read. */
  displacedLessons: number | null;
  lines: ReconciliationLine[];
}

export interface GroupLoss extends LostMinutes {
  studentGroupId: string;
  subjectId: string;
  teacherless: number;
  lessons: number;
}

export interface StaffingReconciliation {
  from: string;
  to: string;
  /** The window planned and scheduled are measured over; null when it is empty. */
  comparison: { from: string; to: string } | null;
  loadModel: LoadModel;
  published: { from: string; through: string } | null;
  teachers: TeacherReconciliation[];
  /** Admin only; [] for a teacher. */
  groupLosses: GroupLoss[];
  /** Admin only; null for a teacher. */
  totals: {
    planned: number;
    scheduled: number;
    delivered: number;
    substituteMinutes: number;
    coveredByOthersMinutes: number;
    lostMinutes: number;
    aheadMinutes: number;
  } | null;
  notices: StaffingNotice[];
}

/** A row of statement E (src/timplan/timplan-delivered.sql.ts). */
export interface CreditRow {
  kind: 'T' | 'C' | 'G';
  personId: string | null;
  role: string | null;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: readonly string[] | null;
  bucket: string;
  minutes: number;
  lessons: number;
}

export interface ReconciliationInput {
  year: YearBounds;
  /** The range, already clamped into the year. */
  from: string;
  to: string;
  /** Whether the service clamped the asked range; the notice names the result. */
  clamped: boolean;
  /** The school's today. */
  asOfDate: string;
  loadModel: LoadModel;
  published: { from: string; through: string } | null;
  publishedDays: readonly string[];
  /** The year's timplansposter, weights set as readLoadInput sets them. */
  requirements: readonly LoadRequirement[];
  /** Everybody with a post this year. */
  employmentUserIds: readonly string[];
  groups: readonly { id: string; gradeLevel: number | null; kind: string }[];
  /** The year's lov, as day ranges. */
  closures: readonly ClosedRange[];
  masters: readonly ScheduledMaster[];
  publish: { breaks: readonly PublishBreak[]; closures: readonly PublishClosure[]; timezone: string };
  credits: readonly CreditRow[];
  weightOf: (subjectId: string) => number;
  /** A TEACHER's own id: only their row, no group losses, no totals. Null for the admin. */
  own: string | null;
}

const addDays = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
const minDay = (a: string, b: string): string => (a < b ? a : b);
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface LineTally {
  subjectId: string;
  studentGroupId: string;
  extra: Set<string>;
  planned: number;
  scheduled: number;
  delivered: number;
  substitute: number;
  lost: number;
}

interface TeacherTally {
  lines: Map<string, LineTally>;
  coveredByOthers: number;
  ahead: number;
  lost: LostMinutes;
  deliveredLessons: number;
  displacedLessons: number;
}

const noLoss = (): LostMinutes => ({
  cancelledTeacherUnavailable: 0,
  cancelledRoomUnavailable: 0,
  cancelledManual: 0,
  cancelledUnknown: 0,
  otherStatus: 0,
});

const lostTotal = (lost: LostMinutes): number => Object.values(lost).reduce((sum, value) => sum + value, 0);

export function buildReconciliation(input: ReconciliationInput): StaffingReconciliation {
  const { from, to, published } = input;
  const notices: StaffingNotice[] = [];
  if (input.clamped) notices.push({ code: 'STAFFING_RANGE_CLAMPED', params: { from, to } });
  if (published === null) notices.push({ code: 'STAFFING_NOTHING_PUBLISHED', params: {} });
  if (to >= input.asOfDate) notices.push({ code: 'STAFFING_RANGE_INCLUDES_FUTURE', params: { asOfDate: input.asOfDate } });

  // The window the plan is compared over: where the calendar is.
  let cmpFrom = from;
  let cmpTo = to;
  if (published !== null) {
    if (from < published.from) {
      notices.push({ code: 'STAFFING_RANGE_BEFORE_PUBLISHED', params: { publishedFrom: published.from } });
      cmpFrom = published.from;
    }
    if (to > published.through) {
      notices.push({ code: 'STAFFING_RANGE_AFTER_PUBLISHED', params: { publishedThrough: published.through } });
      cmpTo = published.through;
    }
    // Gaps two publishes left, in the past part of the range (P3's finder).
    const lastRecorded = minDay(minDay(cmpTo, published.through), addDays(input.asOfDate, -1));
    if (cmpFrom <= lastRecorded) {
      const gaps = publishedGaps({
        from: cmpFrom,
        lastRecorded,
        publishedDays: input.publishedDays,
        closures: input.closures,
        classGrades: [...new Set(input.groups.filter((g) => g.kind === 'CLASS').map((g) => g.gradeLevel))],
      });
      if (gaps.days > 0) {
        notices.push({
          code: 'STAFFING_RANGE_HAS_GAPS',
          params: { days: gaps.days, from: gaps.first!, through: gaps.last! },
        });
      }
    }
  }
  const comparison = cmpFrom <= cmpTo ? { from: cmpFrom, to: cmpTo } : null;

  const keep = (userId: string): boolean => input.own === null || userId === input.own;
  const tallies = new Map<string, TeacherTally>();
  const tallyOf = (userId: string): TeacherTally => {
    let tally = tallies.get(userId);
    if (!tally) {
      tally = { lines: new Map(), coveredByOthers: 0, ahead: 0, lost: noLoss(), deliveredLessons: 0, displacedLessons: 0 };
      tallies.set(userId, tally);
    }
    return tally;
  };
  const lineOf = (userId: string, subjectId: string, studentGroupId: string): LineTally => {
    const tally = tallyOf(userId);
    const key = `${studentGroupId}|${subjectId}`;
    let line = tally.lines.get(key);
    if (!line) {
      line = { subjectId, studentGroupId, extra: new Set(), planned: 0, scheduled: 0, delivered: 0, substitute: 0, lost: 0 };
      tally.lines.set(key, line);
    }
    return line;
  };
  for (const userId of input.employmentUserIds) if (keep(userId)) tallyOf(userId);

  const gradeOfGroup = new Map(input.groups.map((g) => [g.id, g.gradeLevel]));
  const charge = (minutes: number, percent: number, subjectId: string): number =>
    weigh((minutes * percent) / 100, input.weightOf(subjectId));

  // ---- Planned: every timplanspost, each role at its own percentage.
  for (const row of input.requirements) {
    const minutes = comparison
      ? plannedMinutesBetween(row, comparison.from, comparison.to, input.year, [...input.closures], gradeOfGroup.get(row.studentGroupId) ?? null)
      : 0;
    const roles: [string | null, number][] = [
      [row.teacherId, row.teacherLoadPercent],
      [row.coTeacherId, row.coTeacherLoadPercent],
    ];
    for (const [userId, percent] of roles) {
      if (userId === null || !keep(userId)) continue;
      // weigh(), not charge(): the row carries the weight readLoadInput gave it.
      lineOf(userId, row.subjectId, row.studentGroupId).planned += weigh((minutes * percent) / 100, row.loadWeight);
    }
  }

  // ---- Scheduled: today's grundschema walked over the window as publish would.
  if (comparison) {
    const ctx: PublishDaysContext = {
      breakDays: breakDaysOf(input.publish.breaks, comparison.from, comparison.to),
      closuresByDate: closuresByDateOf(input.publish.closures),
      gradeOfGroup,
      timezone: input.publish.timezone,
    };
    for (const m of input.masters) {
      if (m.isParked) continue;
      const people: [string | null, LessonSlot][] = [
        [m.teacherId, 'LEAD'],
        [m.coTeacherId, 'ASSISTANT'],
      ];
      if (!people.some(([userId]) => userId !== null && keep(userId))) continue;
      const minutes = masterOccurrencesBetween(m, comparison.from, comparison.to, ctx) * lessonMinutes(m);
      const groups = [m.studentGroupId, ...m.extraGroupIds];
      for (const [userId, slot] of people) {
        if (userId === null || !keep(userId)) continue;
        const line = lineOf(userId, m.subjectId, m.studentGroupId);
        line.scheduled += charge(minutes, slotPercentOf(groups, m.subjectId, slot, userId, input.requirements), m.subjectId);
        for (const id of m.extraGroupIds) if (id !== m.studentGroupId) line.extra.add(id);
      }
    }
  }

  // ---- Delivered, lost and ahead: statement E's rows.
  const groupLosses = new Map<string, GroupLoss>();
  for (const row of input.credits) {
    const extras = row.extraGroupIds ?? [];
    const groups = [row.studentGroupId, ...extras];
    if (row.kind === 'G') {
      if (input.own !== null) continue;
      const key = `${row.studentGroupId}|${row.subjectId}`;
      const loss = groupLosses.get(key) ?? {
        studentGroupId: row.studentGroupId,
        subjectId: row.subjectId,
        teacherless: 0,
        ...noLoss(),
        lessons: 0,
      };
      if (row.bucket === 'TEACHERLESS') loss.teacherless += row.minutes;
      else if (row.bucket in LOST_BUCKETS) loss[LOST_BUCKETS[row.bucket as keyof typeof LOST_BUCKETS]] += row.minutes;
      loss.lessons += row.lessons;
      groupLosses.set(key, loss);
      continue;
    }
    if (row.personId === null || !keep(row.personId)) continue;
    const slot: LessonSlot = row.role === 'SUBSTITUTE' ? 'SUBSTITUTE' : row.role === 'ASSISTANT' ? 'ASSISTANT' : 'LEAD';
    const charged = charge(row.minutes, slotPercentOf(groups, row.subjectId, slot, row.personId, input.requirements), row.subjectId);
    const tally = tallyOf(row.personId);
    if (row.kind === 'C') {
      if (row.bucket === 'DELIVERED') tally.coveredByOthers += charged;
      continue;
    }
    if (row.bucket === 'DISPLACED') {
      tally.displacedLessons += row.lessons;
      continue;
    }
    if (row.bucket === 'DELIVERED') {
      const line = lineOf(row.personId, row.subjectId, row.studentGroupId);
      line.delivered += charged;
      if (slot === 'SUBSTITUTE') line.substitute += charged;
      for (const id of extras) if (id !== row.studentGroupId) line.extra.add(id);
      tally.deliveredLessons += row.lessons;
    } else if (row.bucket in LOST_BUCKETS) {
      tally.lost[LOST_BUCKETS[row.bucket as keyof typeof LOST_BUCKETS]] += charged;
      lineOf(row.personId, row.subjectId, row.studentGroupId).lost += charged;
    } else if (row.bucket === 'AHEAD') {
      tally.ahead += charged;
    }
    // CANCELLED_ON_BREAK and the other AHEAD_* buckets: neither held nor lost.
  }

  // ---- Rounded once, from the unrounded sums.
  const teachers: TeacherReconciliation[] = [];
  const sums = { planned: 0, scheduled: 0, delivered: 0, substitute: 0, covered: 0, lost: 0, ahead: 0 };
  let displaced = 0;
  for (const [userId, tally] of [...tallies].sort(([a], [b]) => byCode(a, b))) {
    const lines = [...tally.lines.values()].sort(
      (a, b) => byCode(a.studentGroupId, b.studentGroupId) || byCode(a.subjectId, b.subjectId),
    );
    const total = (pick: (line: LineTally) => number) => lines.reduce((sum, line) => sum + pick(line), 0);
    const planned = total((line) => line.planned);
    const scheduled = total((line) => line.scheduled);
    const delivered = total((line) => line.delivered);
    const substitute = total((line) => line.substitute);
    const lost = lostTotal(tally.lost);
    sums.planned += planned;
    sums.scheduled += scheduled;
    sums.delivered += delivered;
    sums.substitute += substitute;
    sums.covered += tally.coveredByOthers;
    sums.lost += lost;
    sums.ahead += tally.ahead;
    displaced += tally.displacedLessons;
    teachers.push({
      userId,
      planned: Math.round(planned),
      scheduled: Math.round(scheduled),
      delivered: Math.round(delivered),
      substituteMinutes: Math.round(substitute),
      coveredByOthersMinutes: Math.round(tally.coveredByOthers),
      aheadMinutes: Math.round(tally.ahead),
      lost: Object.fromEntries(Object.entries(tally.lost).map(([key, value]) => [key, Math.round(value)])) as LostMinutes,
      lostMinutes: Math.round(lost),
      deliveredLessons: tally.deliveredLessons,
      displacedLessons: input.own === null ? tally.displacedLessons : null,
      lines: lines.map((line) => ({
        subjectId: line.subjectId,
        studentGroupId: line.studentGroupId,
        extraGroupIds: [...line.extra].sort(),
        planned: Math.round(line.planned),
        scheduled: Math.round(line.scheduled),
        delivered: Math.round(line.delivered),
        substituteMinutes: Math.round(line.substitute),
        lostMinutes: Math.round(line.lost),
      })),
    });
  }
  if (input.own === null && displaced > 0) {
    notices.push({ code: 'STAFFING_LEAD_BESIDE_SUBSTITUTE', params: { lessons: displaced } });
  }

  return {
    from,
    to,
    comparison,
    loadModel: input.loadModel,
    published,
    teachers,
    groupLosses:
      input.own === null
        ? [...groupLosses.values()].sort(
            (a, b) => byCode(a.studentGroupId, b.studentGroupId) || byCode(a.subjectId, b.subjectId),
          )
        : [],
    totals:
      input.own === null
        ? {
            planned: Math.round(sums.planned),
            scheduled: Math.round(sums.scheduled),
            delivered: Math.round(sums.delivered),
            substituteMinutes: Math.round(sums.substitute),
            coveredByOthersMinutes: Math.round(sums.covered),
            lostMinutes: Math.round(sums.lost),
            aheadMinutes: Math.round(sums.ahead),
          }
        : null,
    notices,
  };
}
