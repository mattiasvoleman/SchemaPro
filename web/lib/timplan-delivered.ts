// Genomfört mot schemalagt — layer 3 of the timplan coverage, as the page
// that shows it reads the gateway's answer.
//
// TYPES AND VIEW HELPERS ONLY. What counts as delivered is defined once, in
// SQL, in src/timplan/timplan-delivered.sql.ts, and aggregated by
// src/common/timplan-delivered.ts; nothing on this side recomputes layer 3 —
// a delivered minute only exists once a lesson has been held, so there is no
// edit for the browser to follow ahead of the server, and a second copy of
// the definition would be a second opinion on the one figure Skolinspektionen
// checks. The interfaces below are that module's output written out by hand
// (the gateway's file imports Prisma-free calendar code the web has no copy
// of); a field added there is added here in the same commit.
//
// HOURS TO THE TENTH WITH A DECIMAL COMMA, as P2's Täckning prints a year:
// the gateway answers in whole minutes, and a läsår of minutes reads as
// noise.

/** Lost minutes by cause; a cause with nothing lost is absent. */
export type LostCause =
  | "cancelledTeacherUnavailable"
  | "cancelledRoomUnavailable"
  | "cancelledManual"
  | "cancelledUnknown"
  | "teacherless"
  | "otherStatus";

/** The order the causes are drawn and listed in: the school's own first. */
export const LOST_CAUSES: readonly LostCause[] = [
  "cancelledTeacherUnavailable",
  "cancelledRoomUnavailable",
  "cancelledManual",
  "cancelledUnknown",
  "teacherless",
  "otherStatus",
];

export interface DeltaStats {
  min: number;
  median: number;
  max: number;
  below: number;
}

export type DeliveredStatus = "ON_TRACK" | "SHORT" | "NO_PLAN";

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
  status: DeliveredStatus;
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
  lostMinutes: number;
}

/** A line of the drilled group: the summary plus its breakdowns (R20). */
export interface DeliveredLineDetail extends DeliveredLineSummary {
  lost: Partial<Record<LostCause, number>>;
  cancelledOnBreak: number;
  projection: DeliveredProjection;
  credits: { id: string; date: string; name: string; minutes: number }[];
  masterLessonIds: string[];
}

export interface DeliveredGroupSummary {
  studentGroupId: string;
  kind: "CLASS" | "TEACHING_GROUP";
  gradeLevel: number | null;
  pupilCount: number;
  totals: {
    published: number;
    delivered: number;
    lost: number;
    credited: number;
    projected: number;
    plannedYear: number;
  };
  lostByCause: Partial<Record<LostCause, number>>;
  lines: (DeliveredLineSummary | DeliveredLineDetail)[];
}

export interface DeliveredPupilSource {
  studentGroupId: string | null;
  deliveredMinutes: number;
  sharedWith: string[];
}

export type DeliveredPupilLine = DeliveredLineSummary & {
  groupDeficitMinutes: number;
  sources: DeliveredPupilSource[];
};

export interface DeliveredPupil {
  pupilId: string;
  homeGroupId: string;
  gradeLevel: number | null;
  lines: DeliveredPupilLine[];
}

export type DeliveredVerdictCode =
  | "TIMPLAN_NOT_PUBLISHED"
  | "TIMPLAN_PUBLISHED_LATE"
  | "TIMPLAN_PUBLISHED_BEHIND"
  | "TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS"
  | "TIMPLAN_CALENDAR_DRIFT"
  | "TIMPLAN_DELIVERED_TEACHERLESS"
  | "TIMPLAN_PROJECTION_SHORT"
  | "TIMPLAN_PUPIL_PROJECTION_SHORT"
  | "TIMPLAN_PUPIL_NOTHING_DELIVERED"
  | "TIMPLAN_CREDIT_OUTSIDE_YEAR"
  | "TIMPLAN_CREDIT_REACHES_NOBODY"
  | "TIMPLAN_CREDIT_OVERLAPS_DELIVERED"
  | "TIMPLAN_CALENDAR_ON_BREAK";

export interface DeliveredVerdict {
  code: DeliveredVerdictCode;
  severity: "notice" | "warning";
  studentGroupId?: string;
  subjectIds?: string[];
  pupilId?: string;
  creditId?: string;
  params: Record<string, string | number>;
  /** The gateway's Swedish sentence. */
  message: string;
}

/** Mirror of DeliveredCoverageResponse in src/timplan/timplan-coverage.service.ts. */
export interface DeliveredCoverageResponse {
  academicYearId: string;
  layer: "delivered";
  asOf: string;
  asOfDate: string;
  /** Null when nothing is published: empty lists and one notice. */
  published: { from: string; through: string } | null;
  pupilLevel: boolean;
  groups: DeliveredGroupSummary[];
  pupils: DeliveredPupil[] | null;
  pupilCount: number;
  pupilsBelowPlanned: number | null;
  credits: { count: number; minutes: number };
  drift: { minutes: number; lessons: number } | null;
  verdicts: DeliveredVerdict[];
}

/** The year-wide notices the tab states above its table, in the gateway's order. */
export const YEAR_NOTICES: readonly DeliveredVerdictCode[] = [
  "TIMPLAN_PUBLISHED_LATE",
  "TIMPLAN_PUBLISHED_BEHIND",
  "TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS",
  "TIMPLAN_CALENDAR_DRIFT",
  "TIMPLAN_CREDIT_OUTSIDE_YEAR",
  "TIMPLAN_CREDIT_REACHES_NOBODY",
  "TIMPLAN_CREDIT_OVERLAPS_DELIVERED",
  "TIMPLAN_CALENDAR_ON_BREAK",
];

/** Minutes as hours to the tenth with a decimal comma: 6300 → "105,0 h". */
export function hoursOf(minutes: number): string {
  const tenths = Math.round(minutes / 6);
  const sign = tenths < 0 ? "−" : "";
  const abs = Math.abs(tenths);
  return `${sign}${Math.floor(abs / 10)},${abs % 10} h`;
}

export const isDetail = (
  line: DeliveredLineSummary | DeliveredLineDetail,
): line is DeliveredLineDetail => "projection" in line;

/** The line's column key's subject, or null for "Utan ämne". */
export const subjectOfKey = (key: string): string | null =>
  key.startsWith("subject:") ? key.slice("subject:".length) : null;

export interface DeliveredMatrix {
  /** Classes, then teaching groups, in the gateway's order. */
  classes: DeliveredGroupSummary[];
  teachingGroups: DeliveredGroupSummary[];
  /** Every line key any group has, subjects in the school's order, "Utan ämne" last. */
  columns: { key: string; subjectId: string | null; name: string | null }[];
  line(groupId: string, key: string): DeliveredLineSummary | null;
}

/**
 * The tab's table. Subjects in the order `subjects` comes in (useSubjects
 * sorts in Swedish), one the list does not know by its id, and the credits
 * without a subject last; name null means "Utan ämne", for the page to say.
 */
export function buildDeliveredMatrix(
  coverage: Pick<DeliveredCoverageResponse, "groups">,
  subjects: readonly { id: string; name: string }[],
): DeliveredMatrix {
  const lines = new Map<string, DeliveredLineSummary>();
  const used = new Set<string>();
  for (const group of coverage.groups) {
    for (const line of group.lines) {
      lines.set(`${group.studentGroupId}|${line.key}`, line);
      used.add(line.key);
    }
  }
  const known = subjects.filter((subject) => used.has(`subject:${subject.id}`));
  const knownKeys = new Set(known.map((subject) => `subject:${subject.id}`));
  const unknown = [...used].filter((key) => key !== "none" && !knownKeys.has(key)).sort();
  return {
    classes: coverage.groups.filter((group) => group.kind === "CLASS"),
    teachingGroups: coverage.groups.filter((group) => group.kind === "TEACHING_GROUP"),
    columns: [
      ...known.map((subject) => ({ key: `subject:${subject.id}`, subjectId: subject.id, name: subject.name })),
      ...unknown.map((key) => ({ key, subjectId: subjectOfKey(key), name: subjectOfKey(key) })),
      ...(used.has("none") ? [{ key: "none", subjectId: null, name: null }] : []),
    ],
    line: (groupId, key) => lines.get(`${groupId}|${key}`) ?? null,
  };
}

/** The pupils with a finding of their own: the ids the pupil verdicts name. */
export function ownFindingPupils(coverage: Pick<DeliveredCoverageResponse, "verdicts">): Set<string> {
  return new Set(
    coverage.verdicts
      .filter(
        (verdict) =>
          verdict.code === "TIMPLAN_PUPIL_PROJECTION_SHORT" || verdict.code === "TIMPLAN_PUPIL_NOTHING_DELIVERED",
      )
      .flatMap((verdict) => (verdict.pupilId ? [verdict.pupilId] : [])),
  );
}

/** A lost-minutes bar: each cause's share of the whole, causes in LOST_CAUSES order. */
export function lostShares(lost: Partial<Record<LostCause, number>>): { cause: LostCause; minutes: number; percent: number }[] {
  const total = LOST_CAUSES.reduce((sum, cause) => sum + (lost[cause] ?? 0), 0);
  if (total === 0) return [];
  return LOST_CAUSES.filter((cause) => (lost[cause] ?? 0) > 0).map((cause) => ({
    cause,
    minutes: lost[cause]!,
    percent: (100 * lost[cause]!) / total,
  }));
}
