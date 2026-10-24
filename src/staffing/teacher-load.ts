import type {
  StaffingCheckMode,
  TeacherContractKind,
  TeacherQualificationKind,
} from '@prisma/client';
import { lessonCountOf, weeklyMinutesOf } from '../common/lesson-lengths';
import { canonicalShares, hasShares, teacherPartsOf, type LessonShare, type TeacherPart } from '../common/lesson-shares';
import { toNioarigSpan, type GradeNumbering } from '../common/grade-numbering';
import { changesDuringYear, postStretches, type LoadPeriod, type PostStretchDates } from './employment-periods';
import {
  peakPerWeekByKey,
  teachingWeeks,
  type ClosedRange,
  type TeachingPeriod,
  type YearBounds,
} from './teaching-weeks';

/*
 * Tjänstefördelningens belastningsrapport: who carries how many minutes a week,
 * against what target, in which subjects — computed, never stored.
 *
 * PURE ARITHMETIC. No Prisma, no clock, no school. The service hands in the
 * year's requirements, the teachers' posts, the policy, the behörigheter and
 * the lov, and gets the report back; the SS12000 duties export, the SCB CSV and
 * the Phase 4 staffing proposal will call the same function on the same rows,
 * which is why it is computed here rather than in the browser like gaps.ts —
 * and why it is not stored: Skola24's Tidssammanställning, Untis' Weekly values
 * and Lectio's Årsopgørelse are all reports over the rows, and a stored copy
 * would drift from them the first time a requirement changed.
 *
 * TWO WEEKS, NOT ONE. "Minutes per week" is two different numbers the moment a
 * school has an odd-week slöjd or a term-only course, and Skola24 changed its
 * own definition in 2025-12 for exactly that reason. The STANDARDVECKA weights
 * every requirement by how much of the year it runs: an all-year row counts
 * whole, an odd- or even-week row half, a dated row by its share of the year's
 * teaching weeks (lov subtracted, through the same arithmetic the timplan page
 * uses — see teaching-weeks.ts). The TOPPVECKA is the single busiest ISO week,
 * where a term course and a year course collide in September although neither
 * alone is heavy. Both are reported; neither is "the" load.
 *
 * THE RIKTMÄRKE IS THE SCHOOL'S, OR NOTHING. The central agreement fixes no
 * weekly teaching measure, so the policy's fullTimeTeachingMinutesPerWeek is
 * nullable with no default, and a null there makes every teacher NO_TARGET and
 * the tolerance inert. A teacher's own teachingTargetMinutesPerWeek overrides
 * the derivation; otherwise target = round5(riktmärke × (tjänst − nedsättning)
 * / 100), rounded to the solver's five-minute grid because a target of 863
 * minutes is a precision no timetable has.
 *
 * A ROW'S MINUTES ARE ITS LESSONS' MINUTES. "lessons × minutes" below is
 * weeklyMinutesOf (src/common/lesson-lengths.ts): lessonsPerWeek ×
 * minutesPerLesson on a uniform row, as always, and the sum of the lengths on
 * a split one — 1 × 80 + 1 × 40 is 120 minutes, not two lessons of the longest.
 *
 * EACH TEACHER IS CHARGED THE ROW'S OWN PERCENTAGE. A requirement counts for
 * its lead at lessons × minutes × teacherLoadPercent / 100 × the standardvecka
 * weight, and for its co-teacher at × coTeacherLoadPercent / 100 — Skola24's
 * "Justera längd för lärare (%)", per row and per role, 0..200. Both default to
 * 100, so a school that never touches them reads the Fas 1 report unchanged:
 * both teachers fully charged, because both are in the room and the solver
 * holds both in NoOverlap. The percentage reaches every figure charged to a
 * TEACHER — standardvecka, toppvecka, timmar per år, the subject split — and
 * none charged to the LESSON: lektionsminuter stay what the pupils sit through,
 * so the two totals still differ by exactly what the school chose to count.
 * A 0 % row is still the teacher's row (requirementCount, the subject listed at
 * 0 minutes): resurslärare who are in the room but not charged are a real case.
 *
 * A SHARED ROW CHARGES EACH TEACHER THEIR OWN LESSONS. Delade lektioner
 * (src/common/lesson-shares.ts, migration 20261205090000): Bo takes one of
 * 9A's three matematik, so Bo is charged that lesson's minutes and the
 * huvudlärare the two that are left, each × the row's teacherLoadPercent — the
 * percentage is the row's, for whoever teaches its lessons. The medlärare is in
 * the room for all three and is charged the whole row, as before. A row with no
 * share has one part, its teacher's, and every figure is the one it always
 * was: chargedMinutes' `parts` is then the lead alone at the row's minutes.
 *
 * UPPDRAG ARE PART OF THE TJÄNST, NOT OF THE TEACHING. Mentorskap, rastvakt,
 * förstelärare — TeacherDuties — are reported per teacher as dutyMinutesPerWeek.
 * Only the ones the school marked countsAsTeaching are compared with the target:
 * they are added to the teaching minutes in countedMinutesPerWeek, which is what
 * status, saldo and percentOfTarget read. The rest are drawn beside the
 * teaching as "uppdrag" and consume nothing, because the riktmärke is a measure
 * of undervisning and a school that counts mentorskap against it says so on the
 * duty. percentOfEmployment per subject stays a share of the TEACHING minutes:
 * SCB's tjänsteomfattning per ämne has no column for rastvakt.
 *
 * AN UPPDRAG COUNTS THE WEEKS IT RUNS. A duty has Från and Till (migration
 * 20261017090000), and a mentor until the jullov is not a mentor in March.
 * Its standardvecka is minutesPerWeek × its share of the year's teaching
 * weeks — standardWeekWeight, the dated requirement's arithmetic, with
 * school-wide lov only, since an uppdrag sits in no grade. Its annual hours
 * are its minutes over the teaching weeks it runs, and dutyPeakMinutesPerWeek
 * is the busiest ISO week of the teacher's uppdrag, each counted only in the
 * weeks it runs (lov not subtracted, as for the teaching peak);
 * countedDutyPeakMinutesPerWeek is the same over the uppdrag marked
 * countsAsTeaching, which is what a toppvecka view compares with the target
 * beside the teaching's own peak. The teaching toppvecka stays the
 * teaching's. An UNDATED duty runs the whole year and every figure is the one
 * it always was: its weight is exactly 1 (no division), its annual hours are
 * the integer sum × the year's weeks as before, and its peak is its minutes.
 *
 * ÄMNESFLASKHALSAR are the question the unstaffed list cannot answer on its
 * own: is there anybody left to take these rows? Per subject with an unstaffed
 * row, demanded = the minutes those rows would charge their lead, and
 * qualifiedRemaining = Σ max(0, target − counted) over every teacher holding a
 * qualification in the subject valid at some point of the year. A teacher with
 * no target contributes nothing — their room is unknown, not infinite — and is
 * counted separately so the page can say "plus 2 utan riktmärke". Short when
 * demanded > remaining. A school with zero qualification rows gets no
 * bottlenecks at all (`bottlenecksComputed: false`): with nobody recorded as
 * qualified, every subject would read as fully short, which is the same noise
 * the unqualified list refuses to make. The policy's qualificationMode does not
 * switch this off: OFF says "do not warn about assignments", and capacity is a
 * planning figure, not a warning.
 *
 * THE FAKTOR MODEL IS ONE FUNCTION. Under the policy's loadModel FACTOR a
 * teacher is charged tid × the subject's loadFactor — Skola24's Faktor-modell
 * ("tjänstgöring = tid × faktor ämne"), Untis' subject factor. The weight is
 * resolved once per row by loadWeightOf (in readLoadInput, never here) and
 * applied by weigh() at exactly the four places a TEACHER is charged:
 * chargedMinutes' lead and co-teacher shares, the annual minutes and the
 * toppvecka item. Under MINUTES the weight is 1 and weigh() returns its
 * argument untouched — not × 1, which is the same number but a step a reader
 * would have to prove — so a MINUTES school's every figure is the double it
 * always was (teacher-load.minutes-identity.spec.ts runs the whole fixture
 * with random factors to hold that). Lektionsminuter are never weighted: the
 * pupils sit the minutes, and SCB's ämnesomfattning is undervisningstid, so
 * an assignment carries its unweighted timeMinutesPerWeek beside the charged
 * one. Unstaffed demand IS weighted: it is what the row would charge whoever
 * takes it. Uppdrag are not: they are minutes the school negotiated as such.
 * No group factor (Skola24's "Faktor grupp"): a row's teacherLoadPercent
 * already weighs one (group, subject).
 *
 * ÅRSARBETSTID IS THE SCHOOL'S SETTING, STATED BESIDE THE TEACHING. The
 * annual block reads the policy's figures — reglerad arbetstid, årsarbetstid
 * of a ferietjänst, the semestertjänst's week, A-dagar — scaled by the post
 * (tjänst − nedsättning), and never an agreement number of its own: the
 * defaults the table holds are the school's until it changes them. A-dagar
 * are the school's figure unscaled; whether they shrink with a deltid is the
 * school's call, not this module's.
 *
 * A POST THAT CHANGES DURING THE YEAR IS JUDGED PER STRETCH (migration
 * 20261022120000). A post's periods — 80 % from 1 november — cut the year
 * into stretches of whole ISO weeks (employment-periods.ts): the target
 * applies per week, as the post in force on its Monday. Each stretch is
 * reported with its own target, counted minutes, saldo and status
 * (`periods`): the minutes a row charges in a stretch are its standardvecka
 * over the stretch's weeks, the year's arithmetic with the stretch as the
 * frame, so an undated row weighs what it weighs all year and a term course
 * weighs its share of the stretch. The teacher's status is the WORST stretch
 * with teaching weeks — "över mål från 1 nov" is OVER — while the year's
 * target is the stretches' targets weighted by their teaching weeks
 * (school-wide lov subtracted), and saldo and percentOfTarget compare the
 * year's counted minutes with it. The annual block likewise sums the
 * stretches: reglerad arbetstid, årsarbetstid and the semestertjänst's week
 * are the post's percentage weighted by the weeks it held. A post with no
 * period in the year has one stretch and every figure the one it always had
 * (`periods: []`, computed by the code that computed it before). Subjects'
 * percentOfEmployment stays a share of the base row, the post the
 * Anställning card edits. It is informational, and no check or export reads
 * it: the SCB underlag reads the post on its mätdatum (postOn) and the
 * assignments' minutes.
 *
 * BEHÖRIGHET IS CHECKED ONLY WHEN THE SCHOOL HAS SAID SOMETHING. A school with
 * zero qualification rows has not recorded that nobody is qualified, it has
 * recorded nothing, and flagging all 300 of its assignments would be noise that
 * teaches the school to ignore the list. The report says `qualificationsRecorded:
 * false` and leaves unqualifiedAssignments empty, the same reading the substitute
 * picker gives the empty table. With rows present, an assignment is unqualified
 * when no qualification of the teacher in the subject covers the group's whole
 * grade span and is valid at some point in the year.
 */

export type LoadStatus = 'UNDER' | 'OK' | 'OVER' | 'NO_TARGET';

export interface GradeSpan {
  min: number;
  max: number;
}

/** MINUTES: load is lesson minutes. FACTOR: lesson minutes × the subject's loadFactor. */
export type LoadModel = 'MINUTES' | 'FACTOR';

/** The policy fields the report reads. Null policy = the school has none yet. */
export interface LoadPolicy {
  fullTimeTeachingMinutesPerWeek: number | null;
  overAllocationTolerancePercent: number;
  fullTimeRegulatedHoursPerYear: number;
  workDaysPerYear: number;
  qualificationMode: StaffingCheckMode;
  /** Årsarbetstid of a full ferietjänst, the school's setting. Absent = the table default. */
  fullTimeAnnualHours?: number;
  /** The week of a full semestertjänst, the school's setting. Absent = the table default. */
  semesterHoursPerWeek?: number;
  /** Absent = MINUTES. The weights themselves are on the rows (loadWeight). */
  loadModel?: LoadModel;
}

/**
 * What the table's defaults say when no row exists: the Bilaga M frame and
 * WARN, with no riktmärke. Stated here so a school without a policy row reads
 * the same report it would read the moment an admin saves the form untouched.
 */
export const DEFAULT_LOAD_POLICY: LoadPolicy = {
  fullTimeTeachingMinutesPerWeek: null,
  overAllocationTolerancePercent: 10,
  fullTimeRegulatedHoursPerYear: 1360,
  workDaysPerYear: 194,
  qualificationMode: 'WARN',
  fullTimeAnnualHours: 1767,
  semesterHoursPerWeek: 40,
  loadModel: 'MINUTES',
};

/**
 * Skola24's Faktor-modell: tjänstgöring = tid × faktor ämne. 1 under MINUTES,
 * whatever the subject's factor says; under FACTOR the factor, with anything
 * not a positive finite number read as 1 (the column is NOT NULL and CHECKed
 * 0.5..3, so that branch is for a caller that has none to give).
 */
export function loadWeightOf(
  model: LoadModel | null | undefined,
  subjectLoadFactor: number | null | undefined,
): number {
  if (model !== 'FACTOR') return 1;
  const factor = subjectLoadFactor ?? 1;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * Minutes × a row's weight — and the minutes themselves, untouched, when the
 * weight is absent or 1, so a MINUTES school's figures are the same doubles
 * they were before the factor existed.
 */
export function weigh(minutes: number, weight: number | undefined): number {
  return weight === undefined || weight === 1 ? minutes : minutes * weight;
}

export interface LoadEmployment {
  userId: string;
  employmentPercent: number;
  reductionPercent: number;
  contractKind: TeacherContractKind;
  teachingTargetMinutesPerWeek: number | null;
  signature: string | null;
  /**
   * The post's periods (migration 20261022120000), each overriding the three
   * figures above on the days it covers. Absent or empty: the post is the
   * same all year, and every figure is the one it always was.
   */
  periods?: readonly LoadPeriod[];
}

export interface LoadRequirement extends TeachingPeriod {
  id: string;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /**
   * The row's lektionslängder, longest first; empty or absent when uniform.
   * Every minute below is read through weeklyMinutesOf
   * (src/common/lesson-lengths.ts), so 1 × 80 + 1 × 40 charges 120, not 160.
   */
  lessonLengths?: readonly number[];
  /**
   * Delade lektioner: the lessons other teachers take; the lead
   * (teacherId) has the rest. Absent or empty: the lead has every lesson.
   */
  shares?: readonly LessonShare[];
  /**
   * How much of the row the lead is charged, 0..200; 100 = all of it. On a
   * shared row, how much of THEIR OWN lessons each teacher is charged.
   */
  teacherLoadPercent: number;
  /** How much of the row the co-teacher is charged, 0..200. */
  coTeacherLoadPercent: number;
  /**
   * loadWeightOf(policy.loadModel, subject.loadFactor), resolved once by the
   * reader. Absent = 1: every row a MINUTES school reads.
   */
  loadWeight?: number;
  /**
   * The years the group actually holds, derived as the optimisation proxy
   * derives it (room-eligibility.ts gradeSpanOf): members' home classes, the
   * group's own gradeLevel when it has no members with one, null when neither
   * says anything.
   */
  gradeSpan: GradeSpan | null;
}

/** One uppdrag of the year: what it costs a week, whether it is teaching, and when it runs. */
export interface LoadDuty {
  userId: string;
  minutesPerWeek: number;
  countsAsTeaching: boolean;
  /** Från, yyyy-mm-dd inclusive; null or absent = the year's first day. */
  validFrom?: string | null;
  /** Till, yyyy-mm-dd inclusive; null or absent = the year's last day. */
  validTo?: string | null;
}

export interface LoadQualification {
  userId: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  /** yyyy-mm-dd or null. */
  validFrom: string | null;
  validTo: string | null;
}

export interface LoadInput {
  /** With its numbering when tioårig: the behörigheter are judged through it (qualificationCovers). */
  year: JudgedYear;
  policy: LoadPolicy | null;
  employments: LoadEmployment[];
  requirements: LoadRequirement[];
  qualifications: LoadQualification[];
  closures: ClosedRange[];
  duties: LoadDuty[];
  /**
   * Users who hold a behörighet but are deactivated: no capacity in a
   * bottleneck, since nobody can give them a row (the picker ranks active
   * staff only). Optional and empty by default, so an input without it reads
   * as it always did.
   */
  inactiveUserIds?: string[];
}

export interface SubjectLoad {
  subjectId: string;
  subjectName: string;
  /** Standardvecka minutes in this subject, whole minutes. */
  minutesPerWeek: number;
  /** minutes / the teacher's total, 0..1 to four decimals. */
  shareOfTeaching: number;
  /**
   * employmentPercent × share — SCB's "tjänsteomfattning per ämne" under
   * MINUTES. Under FACTOR the share is of räknad tid (minutes × factor), so
   * this is a weighted figure; the SCB underlag reads assignments'
   * timeMinutesPerWeek instead. Null without a post.
   */
  percentOfEmployment: number | null;
  /** minutes / the policy riktmärke. Null without one. */
  percentOfFullTime: number | null;
}

/** One row a teacher carries, as the uppdragsbeskrivning and the SCB underlag list it. */
export interface TeacherAssignment {
  requirementId: string;
  role: 'TEACHER' | 'CO_TEACHER';
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  gradeSpan: GradeSpan | null;
  recurrence: TeachingPeriod['recurrence'] | null;
  startDate: string | null;
  endDate: string | null;
  /** The row's lektionsminuter, standardvecka, at 100 % and never weighted. */
  lessonMinutesPerWeek: number;
  /**
   * Delade lektioner: the lessons a week this teacher has of the row, and
   * the row's own count — present only on a shared row, for its lead and its
   * share teachers ("1 av 3 lektioner"). A row with no share has no key.
   */
  ownLessonsPerWeek?: number;
  rowLessonsPerWeek?: number;
  /**
   * The role's share of the lesson time, standardvecka, never weighted: the
   * time SCB's ämnesomfattning asks about ("hur lärarens undervisningstid
   * fördelas"), whatever the school's load model.
   */
  timeMinutesPerWeek: number;
  /** What the row charges this teacher, standardvecka: × the role's % × the weight. */
  minutesPerWeek: number;
  /** The charge over the year's teaching weeks, lov subtracted, one decimal. */
  hoursPerYear: number;
}

/**
 * One stretch of a post that changes during the year, judged on its own: the
 * dates it states, the figures it carries, and the load in its weeks.
 */
export interface PeriodLoad {
  /** The stretch's dates as the school stated them, yyyy-mm-dd inclusive. */
  from: string;
  to: string;
  /** BASE: on the base row, between or around the periods. PERIOD: a period of the post. */
  kind: 'BASE' | 'PERIOD';
  /**
   * The first and last day of the whole weeks the stretch's figures hold for
   * (a week is the post in force on its Monday); null when it holds none.
   */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  employmentPercent: number;
  reductionPercent: number;
  /** The own riktmärke stated for the stretch; null = derived from the school's. */
  ownTargetMinutesPerWeek: number | null;
  targetMinutesPerWeek: number | null;
  /** Teaching weeks of the stretch, school-wide lov subtracted, one decimal. */
  teachingWeeks: number;
  /** Teaching plus counted uppdrag, as a standardvecka over the stretch's weeks. */
  countedMinutesPerWeek: number;
  balanceMinutesPerWeek: number | null;
  percentOfTarget: number | null;
  status: LoadStatus;
}

export interface TeacherLoad {
  userId: string;
  employment: LoadEmployment | null;
  targetMinutesPerWeek: number | null;
  /** Teaching charged by the requirements, standardvecka, whole minutes. */
  assignedMinutesPerWeek: number;
  /** Toppvecka of the teaching, whole minutes. */
  peakMinutesPerWeek: number;
  /** Every uppdrag of the year, counted or not: standardvecka, whole minutes. */
  dutyMinutesPerWeek: number;
  /** Toppvecka of the uppdrag, each in the weeks it runs, whole minutes. */
  dutyPeakMinutesPerWeek: number;
  /** The uppdrag marked countsAsTeaching — the part of dutyMinutes that meets the target. */
  countedDutyMinutesPerWeek: number;
  /**
   * Toppvecka of the uppdrag marked countsAsTeaching, each in the weeks it
   * runs, whole minutes: the part of a toppvecka that meets the target. Never
   * above dutyPeakMinutesPerWeek; a peak of its own, so not always in the same
   * week as it.
   */
  countedDutyPeakMinutesPerWeek: number;
  /** assigned + counted uppdrag: what the target is compared with. */
  countedMinutesPerWeek: number;
  /** target − counted: kvar till mål when positive, över mål when negative. */
  balanceMinutesPerWeek: number | null;
  percentOfTarget: number | null;
  /** The worst stretch's status when the post changes during the year. */
  status: LoadStatus;
  /**
   * The post's stretches when it changes during the year, in date order;
   * empty when it does not, and the figures above are the whole story.
   */
  periods: PeriodLoad[];
  requirementCount: number;
  dutyCount: number;
  subjects: SubjectLoad[];
  /** Every row the teacher carries, by group name then subject name (Swedish order). */
  assignments: TeacherAssignment[];
  annual: {
    /** Σ lessons × minutes × teaching weeks (lov subtracted) / 60, one decimal; charged (× factor under FACTOR). */
    assignedHoursPerYear: number;
    /** policy.fullTimeRegulatedHoursPerYear × (tjänst − nedsättning) / 100. */
    regulatedHoursPerYear: number | null;
    /** The school's A-dagar, unscaled. */
    workDaysPerYear: number;
    /** The post's avtalsform; null without a post. */
    contractKind: TeacherContractKind | null;
    /** FERIE: policy.fullTimeAnnualHours × (tjänst − nedsättning) / 100, one decimal; else null. */
    annualHours: number | null;
    /** FERIE: annualHours − regulatedHoursPerYear, the school's "övrig arbetstid"; else null. */
    unregulatedHoursPerYear: number | null;
    /** SEMESTER: policy.semesterHoursPerWeek × (tjänst − nedsättning) / 100, one decimal; else null. */
    semesterHoursPerWeek: number | null;
    /** Each uppdrag's minutes over the teaching weeks it runs (school-wide lov out) / 60, one decimal. */
    dutyHoursPerYear: number;
    /** The year's teaching weeks with school-wide lov subtracted. */
    teachingWeeksPerYear: number;
    /** assigned / regulated × 100, one decimal; null without a regulated figure above 0. */
    percentOfRegulated: number | null;
  };
}

export interface UnstaffedRequirement {
  requirementId: string;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  /** Lektionsminuter, standardvecka: what the pupils sit through. */
  minutesPerWeek: number;
  /** What the row would charge the teacher who takes it (× teacherLoadPercent). */
  teacherMinutesPerWeek: number;
  gradeSpan: GradeSpan | null;
  /**
   * Delade lektioner: a share of the row that nobody teaches — its teacher
   * deleted, or not kept by a rollover — rather than the row's lead. The
   * minutes above are then the share's own, and Tilldela gives the share a
   * teacher. Absent for the row's lead, as it always was.
   */
  share?: { lessons: number; minutes: number };
}

/** Per subject with an unstaffed row: is there anybody qualified left to take it? */
export interface SubjectBottleneck {
  subjectId: string;
  subjectName: string;
  unstaffedCount: number;
  /** Σ teacherMinutesPerWeek of the subject's unstaffed rows. */
  demandedMinutesPerWeek: number;
  /** Σ max(0, target − counted) over qualified teachers with a target. */
  qualifiedRemainingMinutesPerWeek: number;
  /** Qualified teachers with a target, whether or not they have room left. */
  qualifiedTeacherCount: number;
  /** Qualified teachers with no target: room unknown, so not in the sum. */
  qualifiedNoTargetCount: number;
  short: boolean;
}

export interface UnqualifiedAssignment {
  requirementId: string;
  userId: string;
  role: 'TEACHER' | 'CO_TEACHER';
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  gradeSpan: GradeSpan | null;
}

export interface TeacherLoadReport {
  /** The policy's model the figures were charged under. */
  loadModel: LoadModel;
  teachers: TeacherLoad[];
  unstaffedRequirements: UnstaffedRequirement[];
  unqualifiedAssignments: UnqualifiedAssignment[];
  /** False when the school has no qualification rows, so nothing was checked. */
  qualificationsRecorded: boolean;
  /** Short first, then by deficit. Empty when bottlenecksComputed is false. */
  subjectBottlenecks: SubjectBottleneck[];
  /** False with zero qualification rows: capacity cannot be known. */
  bottlenecksComputed: boolean;
  totals: {
    /** Σ over teachers of assigned minutes, each at its row's percentage. */
    teacherMinutesPerWeek: number;
    /** Σ over requirements of standardvecka minutes: every row once, at 100 %. */
    lessonMinutesPerWeek: number;
    /** Σ over teachers of every uppdrag. */
    dutyMinutesPerWeek: number;
  };
}

/** Rounded to the solver's grid, like every other target this app states. */
export function round5(value: number): number {
  return Math.round(value / 5) * 5;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Counted minutes as a percentage of the target, one decimal, or null without
 * a target (or with a target of 0, a 100 % nedsättning: no share of nothing).
 * The report's figure, exported so the staffing proposal's before → after and
 * its dialog state the same percentage the matrix prints for the same minutes.
 */
export function percentOfTarget(counted: number, target: number | null): number | null {
  return target === null || target === 0 ? null : round1((counted / target) * 100);
}
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv');
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * How much of a standardvecka one requirement is worth, 0..1.
 *
 * Undated rows are the two flat figures Skola24 and the timplan page agree on:
 * every week 1, varannan vecka 0.5. A dated row is its share of the year's
 * teaching weeks, lov and studiedagar subtracted from both numerator and
 * denominator — the recurrence is inside the numerator, so an odd-week autumn
 * course is roughly a quarter. A year with no teaching weeks weighs nothing,
 * rather than dividing by zero.
 *
 * `gradeLevel` is handed to the closure arithmetic only when the group sits in
 * ONE grade. A teaching group spanning several has no single answer to "does
 * this lågstadiet studiedag close it", so only school-wide closures apply there.
 */
export function standardWeekWeight(
  requirement: TeachingPeriod & { gradeSpan?: GradeSpan | null },
  year: YearBounds,
  closures: ClosedRange[],
): number {
  if (!requirement.startDate && !requirement.endDate) {
    return (requirement.recurrence ?? 'ALL_WEEKS') === 'ALL_WEEKS' ? 1 : 0.5;
  }
  const gradeLevel = singleGrade(requirement.gradeSpan ?? null);
  const yearWeeks = teachingWeeks({}, year, closures, gradeLevel);
  if (yearWeeks === 0) return 0;
  return teachingWeeks(requirement, year, closures, gradeLevel) / yearWeeks;
}

function singleGrade(span: GradeSpan | null): number | null {
  return span !== null && span.min === span.max ? span.min : null;
}

const isDated = (duty: Pick<LoadDuty, 'validFrom' | 'validTo'>): boolean =>
  Boolean(duty.validFrom) || Boolean(duty.validTo);

/** An uppdrag's dates as the period the week arithmetic reads. */
const dutyPeriod = (duty: Pick<LoadDuty, 'validFrom' | 'validTo'>): TeachingPeriod => ({
  startDate: duty.validFrom ?? null,
  endDate: duty.validTo ?? null,
});

/**
 * An uppdrag's standardvecka, before rounding: its minutes, untouched, when
 * it is undated — so every figure an undated duty reaches is the integer it
 * always was — and otherwise × its share of the year's teaching weeks, lov
 * that close the whole school subtracted (standardWeekWeight with no grade).
 * The report, countedMinutesByTeacher and the staffing proposal's basis all
 * charge a duty through here.
 */
export function dutyStandardWeekMinutes(
  duty: Pick<LoadDuty, 'minutesPerWeek' | 'validFrom' | 'validTo'>,
  year: YearBounds,
  closures: ClosedRange[],
): number {
  if (!isDated(duty)) return duty.minutesPerWeek;
  return duty.minutesPerWeek * standardWeekWeight(dutyPeriod(duty), year, closures);
}

/**
 * The teacher's target for the week, or null for NO_TARGET.
 *
 * The per-teacher override wins outright, even over a null riktmärke: a school
 * that has agreed 900 minutes with one teacher has a target for that teacher
 * whether or not it has decided on a school-wide measure.
 */
export function targetMinutesPerWeek(
  employment: LoadEmployment | null,
  policy: LoadPolicy,
): number | null {
  if (!employment) return null;
  if (employment.teachingTargetMinutesPerWeek !== null) {
    return employment.teachingTargetMinutesPerWeek;
  }
  if (policy.fullTimeTeachingMinutesPerWeek === null) return null;
  const activePercent = employment.employmentPercent - employment.reductionPercent;
  return round5((policy.fullTimeTeachingMinutesPerWeek * activePercent) / 100);
}

/**
 * UNDER / OK / OVER against the target with the policy's tolerance on BOTH
 * sides. Over-allocation is what the policy mode refuses, so the upper edge is
 * the one that matters: exactly target × (1 + tolerance / 100) is still OK, one
 * minute more is OVER. The same band downward keeps a teacher 3 % under from
 * reading as a problem to fix.
 *
 * Judged on the WHOLE minutes, Math.round, the figure every reader prints
 * beside the status (the matrix's counted minutes, the 409's `minutes`, the
 * picker's kvar). Load percentages and odd weeks make fractions ordinary, and
 * judging the unrounded 990.15 against a 990 limit said OVER beside a printed
 * 990 — a refusal that contradicted its own sentence. The report, the two
 * write-time checks and the picker all come through here, so the threshold
 * stays one.
 */
export function loadStatus(
  assigned: number,
  target: number | null,
  tolerancePercent: number,
): LoadStatus {
  if (target === null) return 'NO_TARGET';
  const minutes = Math.round(assigned);
  const band = (target * tolerancePercent) / 100;
  if (minutes > target + band) return 'OVER';
  if (minutes < target - band) return 'UNDER';
  return 'OK';
}

/** Whether a qualification is valid at some point of the year. */
export function qualificationValidInYear(
  qualification: Pick<LoadQualification, 'validFrom' | 'validTo'>,
  year: YearBounds,
): boolean {
  if (qualification.validFrom && qualification.validFrom > year.endDate) return false;
  if (qualification.validTo && qualification.validTo < year.startDate) return false;
  return true;
}

/**
 * The year a behörighet is judged in: its bounds, and its numbering when it is
 * the tioårig one (absent is NIOARIG, so a nine-year year is the object it
 * always was).
 */
export type JudgedYear = YearBounds & { gradeNumbering?: GradeNumbering };

/**
 * Whether one qualification covers a requirement: same subject, the whole
 * grade span inside the qualification's, and valid at some point of the year.
 * A requirement whose group has no derivable grade is covered by any
 * qualification in the subject — the span cannot be judged, and refusing it
 * would flag every memberless teaching group.
 *
 * A behörighet is stated in the nine-year numbering for good (grade-numbering.ts):
 * the requirement's span, in its year's numbering, is read in NIOARIG first, so
 * a tioårig läsår's 10A is judged as the 9 a "7–9" holds — as the rollover
 * judges it.
 */
export function qualificationCovers(
  qualification: LoadQualification,
  requirement: Pick<LoadRequirement, 'subjectId' | 'gradeSpan'>,
  year: JudgedYear,
): boolean {
  if (qualification.subjectId !== requirement.subjectId) return false;
  if (!qualificationValidInYear(qualification, year)) return false;
  const span = toNioarigSpan(requirement.gradeSpan, year.gradeNumbering ?? 'NIOARIG');
  if (span === null) return true;
  return qualification.minGradeLevel <= span.min && qualification.maxGradeLevel >= span.max;
}

/**
 * LEGITIMATION over BEHORIG over TILLATEN, as skollagen ranks them — the same
 * order the substitute picker sorts by (calendar-lessons.service.ts).
 */
export const QUALIFICATION_RANK: Record<LoadQualification['kind'], number> = {
  LEGITIMATION: 3,
  BEHORIG: 2,
  TILLATEN: 1,
};

/**
 * The strongest of `held` that covers the requirement, or null. `held` may
 * carry anybody's rows; only `userId`'s are read.
 */
export function strongestCoveringQualification(
  held: LoadQualification[],
  userId: string,
  requirement: Pick<LoadRequirement, 'subjectId' | 'gradeSpan'>,
  year: JudgedYear,
): LoadQualification['kind'] | null {
  let best: LoadQualification['kind'] | null = null;
  for (const qualification of held) {
    if (qualification.userId !== userId) continue;
    if (!qualificationCovers(qualification, requirement, year)) continue;
    if (best === null || QUALIFICATION_RANK[qualification.kind] > QUALIFICATION_RANK[best]) {
      best = qualification.kind;
    }
  }
  return best;
}

/** One teacher's own lessons of a row, charged: see chargedMinutes. */
export interface ChargedPart extends TeacherPart {
  /** Their lessons' minutes, standardvecka, never weighted. */
  lesson: number;
  /** What those lessons charge them: × teacherLoadPercent × the weight. */
  charged: number;
}

/**
 * The minutes one requirement charges each role, before rounding. `parts` is
 * every teacher's own lessons, the lead first (teacherPartsOf): on a row with
 * no share it is the lead alone at the row's whole lesson minutes, and
 * `teacher` is exactly the figure it always was. On a shared row `teacher` is
 * the lead's own part, which is also what the row would charge whoever is
 * given its lead (suggest-teachers, the staffing proposal, unstaffed demand).
 */
export function chargedMinutes(
  requirement: Pick<
    LoadRequirement,
    | 'teacherId'
    | 'shares'
    | 'lessonsPerWeek'
    | 'minutesPerLesson'
    | 'lessonLengths'
    | 'teacherLoadPercent'
    | 'coTeacherLoadPercent'
    | 'recurrence'
    | 'startDate'
    | 'endDate'
    | 'gradeSpan'
    | 'loadWeight'
  >,
  year: YearBounds,
  closures: ClosedRange[],
): { lesson: number; teacher: number; coTeacher: number; parts: ChargedPart[] } {
  const weight = standardWeekWeight(requirement, year, closures);
  const lesson = weeklyMinutesOf(requirement) * weight;
  const charge = (minutes: number, percent: number): number =>
    weigh((minutes * percent) / 100, requirement.loadWeight);
  const parts: ChargedPart[] = hasShares(requirement)
    ? teacherPartsOf(requirement).map((part) => {
        const own = part.minutes * weight;
        return { ...part, lesson: own, charged: charge(own, requirement.teacherLoadPercent) };
      })
    : [
        {
          teacherId: requirement.teacherId,
          role: 'LEAD',
          lessons: lessonCountOf(requirement),
          minutes: weeklyMinutesOf(requirement),
          lesson,
          charged: charge(lesson, requirement.teacherLoadPercent),
        },
      ];
  return {
    lesson,
    teacher: parts[0]!.charged,
    coTeacher: charge(lesson, requirement.coTeacherLoadPercent),
    parts,
  };
}

/** A dated period cut to a window of whole weeks; teachingWeeks clamps the rest. */
const within = (period: TeachingPeriod, window: YearBounds): TeachingPeriod => ({
  recurrence: period.recurrence,
  startDate: period.startDate && period.startDate > window.startDate ? period.startDate : window.startDate,
  endDate: period.endDate && period.endDate < window.endDate ? period.endDate : window.endDate,
});

/**
 * standardWeekWeight with a stretch of whole weeks as the frame instead of
 * the year: an undated row weighs its flat figure in every stretch, as it
 * does in the year; a dated row its teaching weeks in the stretch over the
 * stretch's teaching weeks, lov subtracted from both, by the same grade rule.
 */
export function stretchWeight(
  requirement: TeachingPeriod & { gradeSpan?: GradeSpan | null },
  year: YearBounds,
  window: YearBounds,
  closures: ClosedRange[],
): number {
  if (!requirement.startDate && !requirement.endDate) {
    return (requirement.recurrence ?? 'ALL_WEEKS') === 'ALL_WEEKS' ? 1 : 0.5;
  }
  const gradeLevel = singleGrade(requirement.gradeSpan ?? null);
  const frameWeeks = teachingWeeks(window, year, closures, gradeLevel);
  if (frameWeeks === 0) return 0;
  return teachingWeeks(within(requirement, window), year, closures, gradeLevel) / frameWeeks;
}

/** An uppdrag's minutes in a stretch: whole when undated, else its share of the stretch's weeks. */
function dutyMinutesInWindow(
  duty: Pick<LoadDuty, 'minutesPerWeek' | 'validFrom' | 'validTo'>,
  year: YearBounds,
  window: YearBounds,
  closures: ClosedRange[],
): number {
  if (!isDated(duty)) return duty.minutesPerWeek;
  const frameWeeks = teachingWeeks(window, year, closures, null);
  if (frameWeeks === 0) return 0;
  return (duty.minutesPerWeek * teachingWeeks(within(dutyPeriod(duty), window), year, closures, null)) / frameWeeks;
}

type StretchInput = Pick<LoadInput, 'year' | 'closures' | 'requirements' | 'duties' | 'policy'>;

/** One teacher's counted minutes in a window of whole weeks, unrounded: chargedMinutes' roles at stretchWeight. */
function countedInWindow(userId: string, input: StretchInput, window: YearBounds): number {
  let counted = 0;
  for (const requirement of input.requirements) {
    const shared = hasShares(requirement);
    if (
      requirement.teacherId !== userId &&
      requirement.coTeacherId !== userId &&
      !(shared && requirement.shares!.some((share) => share.teacherId === userId))
    ) {
      continue;
    }
    const weight = stretchWeight(requirement, input.year, window, input.closures);
    if (weight === 0) continue;
    const lesson = weeklyMinutesOf(requirement) * weight;
    if (shared) {
      // Each teacher's own lessons; the lead is the first part, a share's
      // teacher one of the rest (never both: the trigger's rule (d)).
      for (const part of teacherPartsOf(requirement)) {
        if (part.teacherId !== userId) continue;
        counted += weigh((part.minutes * weight * requirement.teacherLoadPercent) / 100, requirement.loadWeight);
      }
    } else if (requirement.teacherId === userId) {
      counted += weigh((lesson * requirement.teacherLoadPercent) / 100, requirement.loadWeight);
    }
    if (requirement.coTeacherId === userId) {
      counted += weigh((lesson * requirement.coTeacherLoadPercent) / 100, requirement.loadWeight);
    }
  }
  for (const duty of input.duties) {
    if (duty.userId !== userId || !duty.countsAsTeaching) continue;
    counted += dutyMinutesInWindow(duty, input.year, window, input.closures);
  }
  return counted;
}

/** One stretch of a post with what the target is compared with in it, unrounded. */
export interface StretchLoad {
  stretch: PostStretchDates;
  target: number | null;
  /** Teaching plus counted uppdrag, standardvecka over the stretch's weeks. */
  counted: number;
  /** The stretch's teaching weeks, school-wide lov subtracted. */
  weeks: number;
}

/**
 * A post over the läsår, stretch by stretch (employment-periods.ts): each
 * with its target and the employment's teacher's counted minutes in its
 * weeks. The report's `periods`, the two write-time checks and the picker
 * all come through here, so a stretch the matrix calls OVER is the stretch a
 * write is refused for.
 */
export function stretchLoads(input: StretchInput, employment: LoadEmployment): StretchLoad[] {
  const policy = input.policy ?? DEFAULT_LOAD_POLICY;
  return postStretches(employment, input.year).map((stretch) => ({
    stretch,
    target: targetMinutesPerWeek({ ...employment, ...stretch.figures }, policy),
    counted: stretch.window ? countedInWindow(employment.userId, input, stretch.window) : 0,
    weeks: stretch.window ? teachingWeeks(stretch.window, input.year, input.closures, null) : 0,
  }));
}

/**
 * A changing post's figure for the year: each stretch's value weighted by its
 * teaching weeks. Null when a stretch's value is null (a target the school
 * has not set for part of the year), and `fallback` for a year with no
 * teaching weeks at all.
 */
function weightedByWeeks(
  stretches: readonly StretchLoad[],
  valueOf: (stretch: StretchLoad) => number | null,
  fallback: number | null,
): number | null {
  const weeks = stretches.reduce((sum, stretch) => sum + stretch.weeks, 0);
  if (weeks === 0) return fallback;
  let sum = 0;
  for (const stretch of stretches) {
    if (stretch.weeks === 0) continue;
    const value = valueOf(stretch);
    if (value === null) return null;
    sum += value * stretch.weeks;
  }
  return sum / weeks;
}

/**
 * A post's target for the year as the report states it (buildTeacherLoadReport):
 * a post that changes during the year has its stretches' targets weighted by
 * their teaching weeks, one that does not has its own. For a reader who may
 * not see when a post changes (Roller i skolan), in place of a stretch's.
 */
export function yearTargetMinutesPerWeek(input: StretchInput, employment: LoadEmployment): number | null {
  const base = targetMinutesPerWeek(employment, input.policy ?? DEFAULT_LOAD_POLICY);
  if (!changesDuringYear(employment, input.year)) return base;
  const year = weightedByWeeks(stretchLoads(input, employment), (stretch) => stretch.target, base);
  return year === null ? null : Math.round(year);
}

/**
 * The worst status among the stretches that hold teaching weeks — OVER, then
 * UNDER, OK and NO_TARGET, as the matrix sorts — or null when none holds any.
 */
export function worstStretchStatus(
  stretches: readonly StretchLoad[],
  tolerancePercent: number,
): LoadStatus | null {
  let worst: LoadStatus | null = null;
  for (const stretch of stretches) {
    if (stretch.weeks === 0) continue;
    const status = loadStatus(stretch.counted, stretch.target, tolerancePercent);
    if (worst === null || STATUS_ORDER[status] < STATUS_ORDER[worst]) worst = status;
  }
  return worst;
}

interface Accumulator {
  assigned: number;
  annualMinutes: number;
  requirementCount: number;
  /** Standardvecka of every uppdrag; an integer while every one is undated. */
  dutyMinutes: number;
  countedDutyMinutes: number;
  /** Σ minutes of the undated uppdrag, × the year's weeks for the annual hours. */
  undatedDutyMinutes: number;
  /** Σ minutes × teaching weeks run, of the dated ones. */
  datedDutyAnnualMinutes: number;
  dutyCount: number;
  subjects: Map<string, { subjectName: string; minutes: number }>;
  assignments: TeacherAssignment[];
}

const STATUS_ORDER: Record<LoadStatus, number> = { OVER: 0, UNDER: 1, OK: 2, NO_TARGET: 3 };

export function buildTeacherLoadReport(input: LoadInput): TeacherLoadReport {
  const policy = input.policy ?? DEFAULT_LOAD_POLICY;
  const { year, closures } = input;
  // The year's teaching weeks with school-wide lov out: the frame an undated
  // uppdrag, which runs every week, is taken over.
  const schoolTeachingWeeks = teachingWeeks({}, year, closures, null);

  const employmentByUser = new Map(input.employments.map((row) => [row.userId, row]));
  const accumulators = new Map<string, Accumulator>();
  const accumulatorFor = (userId: string): Accumulator => {
    let acc = accumulators.get(userId);
    if (!acc) {
      acc = {
        assigned: 0,
        annualMinutes: 0,
        requirementCount: 0,
        dutyMinutes: 0,
        countedDutyMinutes: 0,
        undatedDutyMinutes: 0,
        datedDutyAnnualMinutes: 0,
        dutyCount: 0,
        subjects: new Map(),
        assignments: [],
      };
      accumulators.set(userId, acc);
    }
    return acc;
  };
  // A teacher with a post and no requirement is still a row: their whole
  // target is unfilled, which is the thing the matrix exists to show.
  for (const employment of input.employments) accumulatorFor(employment.userId);

  // Uppdrag before requirements, so a teacher whose only line is a mentorskap
  // is a row in the matrix like one whose only line is a post.
  for (const duty of input.duties) {
    const acc = accumulatorFor(duty.userId);
    const minutes = dutyStandardWeekMinutes(duty, year, closures);
    acc.dutyMinutes += minutes;
    acc.dutyCount += 1;
    if (duty.countsAsTeaching) acc.countedDutyMinutes += minutes;
    if (isDated(duty)) {
      acc.datedDutyAnnualMinutes +=
        duty.minutesPerWeek * teachingWeeks(dutyPeriod(duty), year, closures, null);
    } else {
      acc.undatedDutyMinutes += duty.minutesPerWeek;
    }
  }
  // The uppdrag's own toppvecka: an undated one is in every week, a dated one
  // only in the weeks its dates touch. Once over all of them, once over the
  // ones that count toward the target.
  const dutyPeakItems = input.duties.map((duty) => ({
    key: duty.userId,
    minutes: duty.minutesPerWeek,
    counted: duty.countsAsTeaching,
    ...dutyPeriod(duty),
  }));
  const dutyPeaks = peakPerWeekByKey(dutyPeakItems, year, (item) => item.key, (item) => item.minutes);
  const countedDutyPeaks = peakPerWeekByKey(
    dutyPeakItems.filter((item) => item.counted),
    year,
    (item) => item.key,
    (item) => item.minutes,
  );

  const unstaffedRequirements: UnstaffedRequirement[] = [];
  const unqualifiedAssignments: UnqualifiedAssignment[] = [];
  const qualificationsRecorded = input.qualifications.length > 0;
  const checkQualifications = qualificationsRecorded && policy.qualificationMode !== 'OFF';
  const qualificationsByUser = new Map<string, LoadQualification[]>();
  for (const qualification of input.qualifications) {
    const list = qualificationsByUser.get(qualification.userId) ?? [];
    list.push(qualification);
    qualificationsByUser.set(qualification.userId, list);
  }

  let lessonMinutesPerWeek = 0;
  // Per teacher so the peak sums only that teacher's rows; a co-taught row is
  // handed in once per teacher, under each one's key and at each one's share.
  const peakItems: (TeachingPeriod & { key: string; minutes: number })[] = [];
  // Per subject, the demand the unstaffed rows put on whoever takes them.
  const demand = new Map<string, { subjectName: string; minutes: number; count: number }>();

  for (const requirement of input.requirements) {
    const weeklyMinutes = weeklyMinutesOf(requirement);
    const charged = chargedMinutes(requirement, year, closures);
    const weeks = teachingWeeks(requirement, year, closures, singleGrade(requirement.gradeSpan));
    const yearMinutes = weeklyMinutes * weeks;
    lessonMinutesPerWeek += charged.lesson;
    const shared = hasShares(requirement);

    // The lessons nobody teaches: the lead's when the row has none, and — on
    // a shared row — a share whose teacher was deleted (delade lektioner). A
    // row with no share is its lead alone, so this is the row exactly when it
    // has no teacher, as always.
    const nobody = charged.parts.filter((part) => part.teacherId === null);
    if (requirement.teacherId === null) {
      unstaffedRequirements.push({
        requirementId: requirement.id,
        subjectId: requirement.subjectId,
        subjectName: requirement.subjectName,
        studentGroupId: requirement.studentGroupId,
        groupName: requirement.groupName,
        // The lead's own lessons: the whole row unless it is shared, when the
        // shares' teachers have theirs and only the rest wants a teacher.
        minutesPerWeek: Math.round(charged.parts[0]!.lesson),
        teacherMinutesPerWeek: Math.round(charged.teacher),
        gradeSpan: requirement.gradeSpan,
      });
    }
    // Delade lektioner: each share nobody teaches is listed as its own row,
    // with its own lessons, so that what the generation and the publication
    // count as unstaffed (readUnstaffedRequirements) is what the panel shows
    // and Tilldela can give a teacher. Per stored share (one per length),
    // each its part of the teacherless lessons' minutes.
    const teacherless = nobody.find((part) => part.role === 'SHARE');
    if (teacherless && teacherless.minutes > 0) {
      for (const share of canonicalShares(requirement.shares ?? [])) {
        if (share.teacherId !== null) continue;
        const part = (share.lessons * share.minutes) / teacherless.minutes;
        unstaffedRequirements.push({
          requirementId: requirement.id,
          subjectId: requirement.subjectId,
          subjectName: requirement.subjectName,
          studentGroupId: requirement.studentGroupId,
          groupName: requirement.groupName,
          minutesPerWeek: Math.round(teacherless.lesson * part),
          teacherMinutesPerWeek: Math.round(teacherless.charged * part),
          gradeSpan: requirement.gradeSpan,
          share: { lessons: share.lessons, minutes: share.minutes },
        });
      }
    }
    if (nobody.length > 0) {
      const subjectDemand = demand.get(requirement.subjectId) ?? {
        subjectName: requirement.subjectName,
        minutes: 0,
        count: 0,
      };
      subjectDemand.minutes += nobody.reduce((sum, part) => sum + part.charged, 0);
      subjectDemand.count += 1;
      demand.set(requirement.subjectId, subjectDemand);
    }

    // Every teacher's own lessons (chargedMinutes' parts: the lead, then each
    // share's teacher, as TEACHER), then the medlärare over the whole row. A
    // row with no share is the lead and the medlärare at the row's minutes,
    // exactly the two roles it always was.
    const assignees: {
      userId: string | null;
      role: UnqualifiedAssignment['role'];
      percent: number;
      standardMinutes: number;
      lesson: number;
      weekly: number;
      yearly: number;
      lessons: number | null;
    }[] = [
      ...charged.parts.map((part) => ({
        userId: part.teacherId,
        role: 'TEACHER' as const,
        percent: requirement.teacherLoadPercent,
        standardMinutes: part.charged,
        lesson: part.lesson,
        weekly: shared ? part.minutes : weeklyMinutes,
        yearly: shared ? part.minutes * weeks : yearMinutes,
        lessons: shared ? part.lessons : null,
      })),
      {
        userId: requirement.coTeacherId,
        role: 'CO_TEACHER' as const,
        percent: requirement.coTeacherLoadPercent,
        standardMinutes: charged.coTeacher,
        lesson: charged.lesson,
        weekly: weeklyMinutes,
        yearly: yearMinutes,
        lessons: null,
      },
    ];
    for (const { userId, role, percent, standardMinutes, lesson, weekly, yearly, lessons } of assignees) {
      if (userId === null) continue;
      const share = percent / 100;
      const annualMinutes = weigh(yearly * share, requirement.loadWeight);
      const acc = accumulatorFor(userId);
      acc.assigned += standardMinutes;
      acc.annualMinutes += annualMinutes;
      acc.requirementCount += 1;
      acc.assignments.push({
        requirementId: requirement.id,
        role,
        subjectId: requirement.subjectId,
        subjectName: requirement.subjectName,
        studentGroupId: requirement.studentGroupId,
        groupName: requirement.groupName,
        gradeSpan: requirement.gradeSpan,
        recurrence: requirement.recurrence ?? null,
        startDate: requirement.startDate ?? null,
        endDate: requirement.endDate ?? null,
        lessonMinutesPerWeek: Math.round(charged.lesson),
        ...(lessons !== null
          ? { ownLessonsPerWeek: lessons, rowLessonsPerWeek: lessonCountOf(requirement) }
          : {}),
        timeMinutesPerWeek: Math.round((lesson * percent) / 100),
        minutesPerWeek: Math.round(standardMinutes),
        hoursPerYear: round1(annualMinutes / 60),
      });
      const subject = acc.subjects.get(requirement.subjectId) ?? {
        subjectName: requirement.subjectName,
        minutes: 0,
      };
      subject.minutes += standardMinutes;
      acc.subjects.set(requirement.subjectId, subject);
      peakItems.push({
        key: userId,
        minutes: weigh(weekly * share, requirement.loadWeight),
        recurrence: requirement.recurrence,
        startDate: requirement.startDate,
        endDate: requirement.endDate,
      });

      if (checkQualifications) {
        const held = qualificationsByUser.get(userId) ?? [];
        if (!held.some((q) => qualificationCovers(q, requirement, year))) {
          unqualifiedAssignments.push({
            requirementId: requirement.id,
            userId,
            role,
            subjectId: requirement.subjectId,
            subjectName: requirement.subjectName,
            studentGroupId: requirement.studentGroupId,
            groupName: requirement.groupName,
            gradeSpan: requirement.gradeSpan,
          });
        }
      }
    }
  }

  const peaks = peakPerWeekByKey(
    peakItems,
    year,
    (item) => item.key,
    (item) => item.minutes,
  );

  let teacherMinutesPerWeek = 0;
  let dutyMinutesPerWeek = 0;
  const teachers: TeacherLoad[] = [];
  // The year's target per teacher, as the report states it: the bottlenecks
  // below measure room against the same figure.
  const reportedTargets = new Map<string, number | null>();
  const tolerance = policy.overAllocationTolerancePercent;
  for (const [userId, acc] of accumulators) {
    const employment = employmentByUser.get(userId) ?? null;
    const assigned = Math.round(acc.assigned);
    const counted = acc.assigned + acc.countedDutyMinutes;
    teacherMinutesPerWeek += acc.assigned;
    dutyMinutesPerWeek += acc.dutyMinutes;
    // A post that changes during the year is judged stretch by stretch; one
    // that does not reads exactly the figures it always did, by the same code.
    const stretches =
      employment !== null && changesDuringYear(employment, year) ? stretchLoads(input, employment) : null;
    const baseTarget = targetMinutesPerWeek(employment, policy);
    const yearTarget = stretches
      ? weightedByWeeks(stretches, (stretch) => stretch.target, baseTarget)
      : baseTarget;
    const target = yearTarget === null ? null : Math.round(yearTarget);
    reportedTargets.set(userId, target);
    const baseActive = employment
      ? employment.employmentPercent - employment.reductionPercent
      : null;
    const activePercent = stretches
      ? weightedByWeeks(
          stretches,
          (stretch) => stretch.stretch.figures.employmentPercent - stretch.stretch.figures.reductionPercent,
          baseActive,
        )
      : baseActive;
    const regulated =
      activePercent === null ? null : (policy.fullTimeRegulatedHoursPerYear * activePercent) / 100;
    const ferie = employment !== null && employment.contractKind === 'FERIE';
    const semester = employment !== null && employment.contractKind === 'SEMESTER';
    const annualHours =
      ferie && activePercent !== null
        ? ((policy.fullTimeAnnualHours ?? DEFAULT_LOAD_POLICY.fullTimeAnnualHours!) * activePercent) / 100
        : null;

    // Shares are taken on the unrounded minutes, so 600 of 900 is exactly
    // two thirds whatever the rounding did to either figure. Teaching minutes
    // only: an uppdrag is no subject's share.
    const subjects: SubjectLoad[] = [...acc.subjects.entries()]
      .map(([subjectId, subject]) => {
        const share = acc.assigned > 0 ? subject.minutes / acc.assigned : 0;
        return {
          subjectId,
          subjectName: subject.subjectName,
          minutesPerWeek: Math.round(subject.minutes),
          shareOfTeaching: round4(share),
          percentOfEmployment:
            employment === null ? null : round1(employment.employmentPercent * share),
          percentOfFullTime:
            policy.fullTimeTeachingMinutesPerWeek === null
              ? null
              : round1((subject.minutes / policy.fullTimeTeachingMinutesPerWeek) * 100),
        };
      })
      .sort((a, b) => b.minutesPerWeek - a.minutesPerWeek || a.subjectId.localeCompare(b.subjectId));

    teachers.push({
      userId,
      employment,
      targetMinutesPerWeek: target,
      assignedMinutesPerWeek: assigned,
      peakMinutesPerWeek: Math.round(peaks.get(userId) ?? 0),
      dutyMinutesPerWeek: Math.round(acc.dutyMinutes),
      dutyPeakMinutesPerWeek: Math.round(dutyPeaks.get(userId) ?? 0),
      countedDutyMinutesPerWeek: Math.round(acc.countedDutyMinutes),
      countedDutyPeakMinutesPerWeek: Math.round(countedDutyPeaks.get(userId) ?? 0),
      countedMinutesPerWeek: Math.round(counted),
      balanceMinutesPerWeek: target === null ? null : target - Math.round(counted),
      percentOfTarget: percentOfTarget(counted, target),
      status:
        (stretches && worstStretchStatus(stretches, tolerance)) ?? loadStatus(counted, target, tolerance),
      periods: (stretches ?? []).map((stretch) => periodLoad(stretch, tolerance)),
      requirementCount: acc.requirementCount,
      dutyCount: acc.dutyCount,
      subjects,
      assignments: acc.assignments.sort(
        (a, b) =>
          byName(a.groupName, b.groupName) ||
          byName(a.subjectName, b.subjectName) ||
          byCode(a.requirementId, b.requirementId) ||
          byCode(a.role, b.role),
      ),
      annual: {
        assignedHoursPerYear: round1(acc.annualMinutes / 60),
        regulatedHoursPerYear: regulated === null ? null : round1(regulated),
        workDaysPerYear: policy.workDaysPerYear,
        contractKind: employment?.contractKind ?? null,
        annualHours: annualHours === null ? null : round1(annualHours),
        unregulatedHoursPerYear:
          annualHours === null || regulated === null ? null : round1(annualHours - regulated),
        semesterHoursPerWeek:
          semester && activePercent !== null
            ? round1(((policy.semesterHoursPerWeek ?? DEFAULT_LOAD_POLICY.semesterHoursPerWeek!) * activePercent) / 100)
            : null,
        // The undated sum × the year's weeks is the figure this always was;
        // the dated ones add their own weeks (0 without any, which adds
        // nothing to the double).
        dutyHoursPerYear: round1(
          (acc.undatedDutyMinutes * schoolTeachingWeeks + acc.datedDutyAnnualMinutes) / 60,
        ),
        teachingWeeksPerYear: schoolTeachingWeeks,
        percentOfRegulated:
          regulated === null || regulated <= 0
            ? null
            : round1((acc.annualMinutes / 60 / regulated) * 100),
      },
    });
  }

  // OVER first: the matrix is read to find the problem rows. Then by id, so
  // the order is stable rather than the order the rows were typed in.
  teachers.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.userId.localeCompare(b.userId),
  );

  const subjectBottlenecks: SubjectBottleneck[] = [];
  if (qualificationsRecorded) {
    // Who holds a qualification in which subject this year, any span: the
    // question is whether the subject has teachers left, not who takes which row.
    const holders = new Map<string, Set<string>>();
    const inactive = new Set(input.inactiveUserIds ?? []);
    for (const qualification of input.qualifications) {
      if (!qualificationValidInYear(qualification, year)) continue;
      if (inactive.has(qualification.userId)) continue;
      const set = holders.get(qualification.subjectId) ?? new Set<string>();
      set.add(qualification.userId);
      holders.set(qualification.subjectId, set);
    }
    for (const [subjectId, subjectDemand] of demand) {
      let remaining = 0;
      let withTarget = 0;
      let noTarget = 0;
      for (const userId of holders.get(subjectId) ?? []) {
        const target = reportedTargets.has(userId)
          ? reportedTargets.get(userId)!
          : targetMinutesPerWeek(employmentByUser.get(userId) ?? null, policy);
        if (target === null) {
          noTarget += 1;
          continue;
        }
        withTarget += 1;
        const acc = accumulators.get(userId);
        const counted = acc ? acc.assigned + acc.countedDutyMinutes : 0;
        remaining += Math.max(0, target - counted);
      }
      const demanded = Math.round(subjectDemand.minutes);
      const qualifiedRemaining = Math.round(remaining);
      subjectBottlenecks.push({
        subjectId,
        subjectName: subjectDemand.subjectName,
        unstaffedCount: subjectDemand.count,
        demandedMinutesPerWeek: demanded,
        qualifiedRemainingMinutesPerWeek: qualifiedRemaining,
        qualifiedTeacherCount: withTarget,
        qualifiedNoTargetCount: noTarget,
        short: demanded > qualifiedRemaining,
      });
    }
    // Short first, the deepest deficit first among them; then by id.
    subjectBottlenecks.sort(
      (a, b) =>
        Number(b.short) - Number(a.short) ||
        b.demandedMinutesPerWeek -
          b.qualifiedRemainingMinutesPerWeek -
          (a.demandedMinutesPerWeek - a.qualifiedRemainingMinutesPerWeek) ||
        a.subjectId.localeCompare(b.subjectId),
    );
  }

  return {
    loadModel: policy.loadModel ?? 'MINUTES',
    teachers,
    unstaffedRequirements,
    unqualifiedAssignments,
    qualificationsRecorded,
    subjectBottlenecks,
    bottlenecksComputed: qualificationsRecorded,
    totals: {
      teacherMinutesPerWeek: Math.round(teacherMinutesPerWeek),
      lessonMinutesPerWeek: Math.round(lessonMinutesPerWeek),
      dutyMinutesPerWeek: Math.round(dutyMinutesPerWeek),
    },
  };
}

/** A stretch as the report hands it out: whole minutes, one-decimal weeks. */
function periodLoad(stretch: StretchLoad, tolerancePercent: number): PeriodLoad {
  const { figures, window } = stretch.stretch;
  return {
    from: stretch.stretch.from,
    to: stretch.stretch.to,
    kind: stretch.stretch.kind,
    effectiveFrom: window?.startDate ?? null,
    effectiveTo: window?.endDate ?? null,
    employmentPercent: figures.employmentPercent,
    reductionPercent: figures.reductionPercent,
    ownTargetMinutesPerWeek: figures.teachingTargetMinutesPerWeek,
    targetMinutesPerWeek: stretch.target,
    teachingWeeks: round1(stretch.weeks),
    countedMinutesPerWeek: Math.round(stretch.counted),
    balanceMinutesPerWeek: stretch.target === null ? null : stretch.target - Math.round(stretch.counted),
    percentOfTarget: percentOfTarget(stretch.counted, stretch.target),
    status: loadStatus(stretch.counted, stretch.target, tolerancePercent),
  };
}

/**
 * Per teacher, the minutes the target is compared with — teaching at each
 * row's percentage plus the uppdrag marked countsAsTeaching — UNROUNDED.
 *
 * The report's countedMinutesPerWeek is this, rounded; its status is
 * loadStatus over this. Exposed on its own for the two questions asked about
 * one hypothetical write rather than about the year: "how much room would
 * this teacher have left after taking that row" (suggest-teachers) and "would
 * this write put them over" (STAFF_TEACHER_OVER_TARGET). Both add one row's
 * charge to this figure and ask loadStatus, so a candidate the picker calls
 * OVER is exactly the one the write would refuse (loadStatus rounds once,
 * for all of them).
 * No peaks and no subjects, so it is cheap enough to ask per request.
 *
 * Gateway-only: the browser reads these answers from the endpoints, so the
 * web mirror has no copy (the contract test ties this to the report instead).
 */
export function countedMinutesByTeacher(
  input: Pick<LoadInput, 'year' | 'closures' | 'requirements' | 'duties'>,
): Map<string, number> {
  const counted = new Map<string, number>();
  const add = (userId: string, minutes: number) =>
    counted.set(userId, (counted.get(userId) ?? 0) + minutes);
  for (const duty of input.duties) {
    add(
      duty.userId,
      duty.countsAsTeaching ? dutyStandardWeekMinutes(duty, input.year, input.closures) : 0,
    );
  }
  for (const requirement of input.requirements) {
    const charged = chargedMinutes(requirement, input.year, input.closures);
    // The lead's own part first, then each share's teacher: a row with no
    // share is its lead alone, at charged.teacher, as it always was.
    for (const part of charged.parts) {
      if (part.teacherId !== null) add(part.teacherId, part.charged);
    }
    if (requirement.coTeacherId !== null) add(requirement.coTeacherId, charged.coTeacher);
  }
  return counted;
}
