/*
 * Undervisningsuppdragets omfattning (SFS 2026:1487): what GET /staffing/load's `scope` block says about one teacher's
 * teaching hours over the läsår, against the ordinance's span for their stage. Its own module, without hooks, so a page
 * test that mocks the staffing queries still has it.
 *
 * NO ARITHMETIC HERE. The gateway computes every figure (src/staffing/assignment-scope.ts): the hours are the lessons'
 * own, unweighted, the span scales with the post, a mixed stage is blended by hours. A second copy in the browser would be a
 * contract to keep, and the post's percentage is HR data the browser has no business computing from. What is here is the
 * block's shape, which teachers to mark, and when a card has something to say.
 *
 * NOT THE PUPIL'S GUARANTEED TEACHING TIME (the timplan cards) and NOT THE RIKTMÄRKE (the matrix's mål). The ordinance's
 * measure is the law's, in clock hours; the riktmärke is the school's own.
 */

export type ScopeVerdict = "OVER_MAX" | "OVER_OWN" | "INSIDE" | "NOT_JUDGED";
export type ScopeNotJudged = "NO_TEACHING" | "NO_POST" | "NO_STAGE";
export type ScopeYearReason = "NOT_IN_FORCE" | "NUMBERING_NOT_COVERED";

export interface ScopeStageHours {
  gradeFrom: number;
  gradeTo: number;
  /** Teaching hours in the stage, one decimal. */
  hours: number;
  teachingHoursLow: number;
  teachingHoursHigh: number;
  planningFloorPercent: number;
}

export interface TeacherScope {
  userId: string;
  verdict: ScopeVerdict;
  notJudged: ScopeNotJudged | null;
  teachingHours: number;
  stages: ScopeStageHours[];
  /** Förskoleklass, or a year the lydelse has no band for. */
  unregulatedHours: number;
  /** Groups with no derivable årskurs. */
  unknownGradeHours: number;
  /** The span's edges for a full-time teacher, blended over the stages by hours. */
  fullTimeHighestHours: number | null;
  fullTimeLowestHours: number | null;
  /** The teacher's own upper edge (the span × the post): null for a reader without HR-läs. */
  highestHours: number | null;
  /** What OVER_MAX is judged against: null for a reader without HR-läs. */
  ordinanceHighestHours: number | null;
  planningFloorHours: number | null;
  /** Null unless a full ferietjänst, and for a reader without HR-läs. */
  remainingHours: number | null;
  planningFits: boolean | null;
}

export interface ScopeVersionInfo {
  code: string;
  sfs: string;
  title: string;
  validFrom: string;
  validTo: string | null;
  source: string;
}

export interface ScopeReport {
  /** The lydelse the year was judged against; null when none holds on the year's first day. */
  version: ScopeVersionInfo | null;
  yearReason: ScopeYearReason | null;
  /** What the bands rest on beyond the ordinance's own words. */
  interpretations: { section: string; note: string }[];
  teachers: TeacherScope[];
}

/** What a teacher's card is drawn from. */
export interface ScopeCardData {
  teacher: TeacherScope;
  version: ScopeVersionInfo;
  yearReason: ScopeYearReason | null;
  interpretations: ScopeReport["interpretations"];
}

type WithScope = { scope?: ScopeReport | null } | undefined;

/**
 * The card for one teacher, or null when it has nothing to say: a report without the block, a läsår the ordinance does not
 * reach (no lydelse holds on its first day: the card would say "not in force" on every teacher, all of 2026/27), a teacher
 * with no teaching, or no row.
 */
export function scopeCardOf(report: WithScope, userId: string): ScopeCardData | null {
  const scope = report?.scope;
  if (!scope || scope.version === null) return null;
  const teacher = scope.teachers.find((row) => row.userId === userId);
  if (!teacher || (teacher.notJudged === "NO_TEACHING" && teacher.teachingHours === 0)) return null;
  return { teacher, version: scope.version, yearReason: scope.yearReason, interpretations: scope.interpretations };
}

/** The teachers the matrix marks: over the ordinance's highest level, or over the level set for them. */
export function overScopeIds(report: WithScope): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of report?.scope?.teachers ?? []) {
    if (row.verdict === "OVER_MAX" || row.verdict === "OVER_OWN") ids.add(row.userId);
  }
  return ids;
}

/** Hours over the line the verdict was judged against, one decimal; null where the reader may not see the line. */
export function hoursOver(teacher: TeacherScope): number | null {
  const line = teacher.verdict === "OVER_OWN" ? teacher.highestHours : teacher.ordinanceHighestHours;
  if (line === null) return null;
  return Math.round((teacher.teachingHours - line) * 10) / 10;
}
