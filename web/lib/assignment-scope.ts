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

/**
 * The rektor's assessment of one teacher (AssignmentScopeAssessments, 20270306090000): a level within the span and a registered
 * exception under 11 §. A reader without HR-läs gets the exception kind alone: the level, the day, the note and the time are null.
 */
export interface ScopeAssessmentView {
  /** The teacher's highest level at full time, hours per läsår; null = none set (the ordinance's edge holds). */
  levelHours: number | null;
  exceptionKind: "OWN_INITIATIVE" | "SMALL_GROUP" | null;
  /** yyyy-mm-dd; set exactly when the exception is OWN_INITIATIVE. */
  ownInitiativeOn: string | null;
  note: string | null;
  decidedAt: string | null;
}

export interface TeacherScope {
  userId: string;
  verdict: ScopeVerdict;
  notJudged: ScopeNotJudged | null;
  teachingHours: number;
  stages: ScopeStageHours[];
  /** Förskoleklass, or a year the lydelse has no band for. */
  unregulatedHours: number;
  /**
   * Of unregulatedHours, the part that is förskoleklass (årskurs 0 and nothing else): present exactly when unregulatedHours is above 0, from a
   * gateway that tells the two apart. Absent from an older one, and every unregulated hour is then said as förskoleklass, as it was.
   */
  preschoolHours?: number;
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
  /**
   * True when the teacher is past the ordinance's upper edge only because hours outside every stage are counted in (förskoleklass,
   * groups with no årskurs; T7): the verdict is then not OVER_MAX. Absent otherwise.
   */
  overOnlyWithUnregulated?: true;
  /** The rektor's assessment of the teacher: absent (not null) where none is written. */
  assessment?: ScopeAssessmentView;
}

export interface ScopeVersionInfo {
  code: string;
  sfs: string;
  title: string;
  validFrom: string;
  validTo: string | null;
  source: string;
}

/**
 * What a figure rests on beyond the ordinance's own words. `cause` says whose row it explains: absent for a band's note (every card
 * shows it), UNREGULATED_HOURS for the interpretation (T7) of a teacher marked `overOnlyWithUnregulated`, which only that card shows.
 */
export interface ScopeInterpretation {
  section: string;
  note: string;
  cause?: "UNREGULATED_HOURS";
  /**
   * The stages (årskurs spans) of the bands whose note this is: the card of a teacher with no hours in any of them does not carry it. Absent on
   * a row with a `cause`, and from a gateway older than the field, where every card carries the note as it did.
   */
  grades?: Array<{ from: number; to: number }>;
}

export interface ScopeReport {
  /** The lydelse the year was judged against; null when none holds on the year's first day. */
  version: ScopeVersionInfo | null;
  yearReason: ScopeYearReason | null;
  /** For a year that begins before every lydelse: the first one that holds after it, so that the page can say from when. */
  upcoming?: { sfs: string; validFrom: string };
  /** What the bands rest on beyond the ordinance's own words. */
  interpretations: ScopeInterpretation[];
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
  // The interpretation of the hours outside the stages explains one kind of row: the card of a teacher without it does not carry it. And an
  // interpretation of a band (5 §, årskurs 7-9) is the card of a teacher with hours in that band's stage, not of every teacher of the school
  // (the review of #387, L-2, and of #397, L-4). One with no stages named is every card's, as it was.
  const interpretations = scope.interpretations.filter((one) => {
    if (one.cause === "UNREGULATED_HOURS") return teacher.overOnlyWithUnregulated === true;
    return one.grades === undefined || teacherHasHoursIn(teacher, one.grades);
  });
  return { teacher, version: scope.version, yearReason: scope.yearReason, interpretations };
}

/**
 * Whether a teacher has hours in a stage that overlaps one of `grades`. The report lists a stage only where a row of the teacher runs in it
 * (the gateway adds a stage with its first hour), so a stage in the list is a stage with hours, however few the one decimal rounds to.
 */
function teacherHasHoursIn(teacher: TeacherScope, grades: ReadonlyArray<{ from: number; to: number }>): boolean {
  return teacher.stages.some((stage) => grades.some((span) => stage.gradeFrom <= span.to && stage.gradeTo >= span.from));
}

/**
 * The two notes the gateway's data holds today, by their Swedish text (the band note of årskurs 7-9, written by migration 20270301090000,
 * and T7, a constant of the gateway), with the key of their English in the catalogue. The notes are data and are kept in Swedish; a card in
 * English shows the English only for a note that IS one of these, word for word, so that a note the school's database changes tomorrow is
 * shown as recorded and never under a translation of the old one (the review of #397, L-4). src/staffing/scope-interpretations.contract.spec.ts
 * holds the Swedish here to the migration and to the constant.
 */
export const KNOWN_INTERPRETATIONS: ReadonlyArray<{ key: "band7to9" | "unregulated"; sv: string }> = [
  {
    key: "band7to9",
    sv: "Tolkning: 5 § säger \"Utöver den tid som anges i 4 §\" men 4 § räknar inte upp årskurs 7-9. Läst som 100 % (4 §) och ytterligare minst 10 % (5 §), vilket är utredningens egen sammanfattning (prop. 2025/26:196 bilaga 1 s. 125).",
  },
  {
    key: "unregulated",
    sv: "Tolkning (T7): timmar i förskoleklass och i grupper utan årskurs ligger utanför förordningens stadier (3 § nämner årskurs 1-6 och 7-9, och propositionen säger att förskoleklassen inte omfattas) men är undervisningstid enligt 2 §. Räknas de med är undervisningstiden över högsta nivån, och räknas de inte med är den det inte. Rastra Schema säger över högsta nivån bara när timmarna i stadierna ensamma går över, och visar annars den här orsaken.",
  },
];

/** The key of the English text of a note, when the note is one of the known ones as recorded; null otherwise. */
export function knownInterpretationKey(note: string): "band7to9" | "unregulated" | null {
  return KNOWN_INTERPRETATIONS.find((known) => known.sv === note)?.key ?? null;
}

/** A day a lydelse holds from (yyyy-mm-dd), as the reader's language writes it: "1 juli 2027", "1 July 2027". What is not a day is returned as it came. */
export function scopeDayText(day: string, locale: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(at);
}

/** What a page says once, over every teacher, about a läsår the ordinance does not judge. */
export type ScopeYearNote =
  | { kind: "NOT_IN_FORCE"; sfs: string | null; from: string | null }
  | { kind: "NUMBERING_NOT_COVERED" };

/**
 * Why nothing on the page is judged against the ordinance, once, for the page and not for each teacher: a läsår that begins before the ordinance
 * holds (every one before 2027-07-01) has no card, and a page that said nothing of it left a rektor to wonder whether the ordinance had been
 * forgotten (the review of #387, L-8, and of #397, L-1; the assignment said a year that is not judged says why). Null for a year the ordinance
 * reaches, from a gateway with no block, and where the report names no reason. `from` is the day the lydelse that follows holds from, where the
 * table has one.
 */
export function scopeYearNote(report: WithScope): ScopeYearNote | null {
  const scope = report?.scope;
  if (!scope || scope.yearReason === null) return null;
  if (scope.yearReason === "NUMBERING_NOT_COVERED") return { kind: "NUMBERING_NOT_COVERED" };
  return { kind: "NOT_IN_FORCE", sfs: scope.upcoming?.sfs ?? null, from: scope.upcoming?.validFrom ?? null };
}

/** What the rektor's assessment card is drawn from: the teacher's row of the report (where the assessment is, if one is written) and the span's edge. */
export interface ScopeAssessmentSlot {
  assessment: ScopeAssessmentView | undefined;
  fullTimeHighestHours: number | null;
}

/**
 * Where the rektor's assessment can be written, and what it holds now: any teacher the report has a row for in a läsår the ordinance
 * reaches, WITH OR WITHOUT TEACHING HOURS. scopeCardOf gives no card to a teacher with nothing to judge, and the assessment card was drawn
 * from that, so a rektor could not set a level for a teacher who had no hours yet (the gateway allows it: "a teacher with no teaching
 * yet has none [edge]", scope-assessments.service.ts), which is the teacher the level is wanted for before Föreslå bemanning hands out
 * hours. Null for a läsår the ordinance does not reach, and for the ten-year numbering, where the gateway refuses every write
 * (SCOPE_NUMBERING_NOT_COVERED): a card that can only be refused is not drawn.
 */
export function scopeAssessmentOf(report: WithScope, userId: string): ScopeAssessmentSlot | null {
  const scope = report?.scope;
  if (!scope || scope.version === null || scope.yearReason !== null) return null;
  const row = scope.teachers.find((teacher) => teacher.userId === userId);
  if (!row) return null;
  return { assessment: row.assessment, fullTimeHighestHours: row.fullTimeHighestHours };
}

/** The teachers the matrix marks: over the ordinance's highest level, or over the level set for them. */
export function overScopeIds(report: WithScope): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of report?.scope?.teachers ?? []) {
    if (row.verdict === "OVER_MAX" || row.verdict === "OVER_OWN") ids.add(row.userId);
  }
  return ids;
}

/**
 * The teachers over the ORDINANCE's highest level (OVER_MAX), a subset of overScopeIds. "Över förordningen" and "mer än förordningen
 * tillåter" are said of them alone: a teacher over the level the rektor set (OVER_OWN) is, in the verdict's own words, "inte över
 * förordningens", and the card on the same page says so.
 */
export function overOrdinanceIds(report: WithScope): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of report?.scope?.teachers ?? []) {
    if (row.verdict === "OVER_MAX") ids.add(row.userId);
  }
  return ids;
}

/**
 * Hours over the line the verdict was judged against, one decimal; null where the reader may not see the line.
 *
 * Over the ORDINANCE's line the gateway judges the hours in a stage and nothing else (T7), so the amount is the stage hours over it:
 * a teacher with 358,3 h in årskurs 1-6 against 357,5 h and 258 h of förskoleklass is 0,8 h over, not 259,3 (the 258 h are the ones
 * the card says the ordinance gives no level for). Over the rektor's own level the gateway judges the whole total, so that amount is
 * the total over it. Never under 0,1 over the ordinance's line: the three figures print one decimal each, and the gateway's OVER_MAX is
 * at least a tenth over.
 */
export function hoursOver(teacher: TeacherScope): number | null {
  const own = teacher.verdict === "OVER_OWN";
  const line = own ? teacher.highestHours : teacher.ordinanceHighestHours;
  if (line === null) return null;
  const hours = own ? teacher.teachingHours : teacher.teachingHours - teacher.unregulatedHours - teacher.unknownGradeHours;
  const over = Math.round((hours - line) * 10) / 10;
  return own ? over : Math.max(over, 0.1);
}
