/*
 * Analys och planering (K1): the shapes the gateway answers with. The web's
 * copy is web/lib/analysis-types.ts; the two are held equal by the
 * OpenAPI document (docs/api/openapi.json) and by the fixtures both sides
 * read (src/analysis/__fixtures__).
 *
 * Ids only, never a name, in every JSON answer: the web names people from the
 * lists it already reads, as the load report does. The one answer that names
 * people is the payroll file, which is built here (payroll-files.ts) because
 * it must be Excel's Swedish CSV (windows-1252) and an .xlsx, which the web
 * cannot write.
 */

/**
 * The personalkategorier a school states an hourly cost for. Derived when the
 * cost basis is made, never kept on a person (StaffCostRates, 20270130090000).
 */
export const COST_CATEGORIES = ['TEACHER', 'UNQUALIFIED_TEACHER', 'SUBSTITUTE'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** A skoldel: a kostnadsställe holding årskurser, stated in the nine-year numbering. */
export interface SchoolPartView {
  id: string;
  name: string;
  account: string;
  gradeFrom: number;
  gradeTo: number;
}

/** The school's cost of one hour in a category, in SEK. */
export interface CostRateView {
  category: CostCategory;
  hourlyCost: number;
}

export interface AnalysisNotice {
  code: AnalysisNoticeCode;
  params: Record<string, string | number>;
}

export type AnalysisNoticeCode =
  /** Pupils were read from the class history, as the year's classes were then (a past year). */
  | 'ANALYSIS_PUPILS_FROM_ENROLLMENT'
  /** A skoldel is stated but no class of the year falls in it, or a class falls in none. */
  | 'ANALYSIS_GRADES_WITHOUT_PART'
  /** The school has no skoldel: the cost basis is per årskurs alone. */
  | 'ANALYSIS_NO_SCHOOL_PARTS'
  /** A category that carries hours has no rate: the cost of those rows is unknown, never zero. */
  | 'ANALYSIS_RATE_MISSING'
  /** The school has no riktmärke, so a teaching FTE cannot be stated. */
  | 'ANALYSIS_NO_FULL_TIME'
  /** The school has recorded no behörigheter: nobody is judged, and every teacher's time is the TEACHER category. */
  | 'ANALYSIS_QUALIFICATIONS_NOT_RECORDED'
  /** A row has no pupils on its roster (a group before its pupils are placed): its time stands on the group's own årskurs. */
  | 'ANALYSIS_ROWS_WITHOUT_PUPILS'
  /** The payroll period was cut to the läsår it is read in. */
  | 'ANALYSIS_PERIOD_CLAMPED'
  /** Nothing is published, so no lesson has been held and no teaching time is stated. */
  | 'ANALYSIS_NOTHING_PUBLISHED'
  /** Held cover lessons whose substitute was away over the lesson are left out of the file, as in the vikarie export. */
  | 'ANALYSIS_COVER_TO_CHECK'
  /** Uppdrag with no teaching to follow are on a line of their own: no skoldel, no konto. */
  | 'ANALYSIS_DUTIES_UNALLOCATED'
  /** People with a protected identity are in the file, as payroll pays everyone. */
  | 'ANALYSIS_PROTECTED_IN_FILE'
  /** Characters windows-1252 cannot hold were replaced in the CSV (the Excel file keeps them). */
  | 'ANALYSIS_CHARACTERS_REPLACED';

// ---------------------------------------------------------------------------
// Nyckeltal
// ---------------------------------------------------------------------------

export type LoadStatusView = 'UNDER' | 'OK' | 'OVER' | 'NO_TARGET';

export interface TeacherKeyFigures {
  userId: string;
  /** Undervisning enligt tjänstefördelningen: what the rows charge the teacher, a standardvecka, whole minutes (the load report's assignedMinutesPerWeek). */
  teachingMinutesPerWeek: number;
  /** Every uppdrag of the year, counted or not, a standardvecka (the report's dutyMinutesPerWeek). */
  dutyMinutesPerWeek: number;
  /** Undervisning plus the uppdrag marked as teaching: what the target is compared with. */
  countedMinutesPerWeek: number;
  targetMinutesPerWeek: number | null;
  percentOfTarget: number | null;
  status: LoadStatusView;
  /** Undervisning enligt grundschemat, a standardvecka; null when no lesson is laid for the year. */
  scheduledMinutesPerWeek: number | null;
  /** What the rows charge the teacher over the year's teaching weeks, hours, one decimal. */
  teachingHoursPerYear: number;
  /** Tjänstgöringsgrad, %. HR data: null with `hrHidden` on the answer for a reader without HR-läs. */
  employmentPercent: number | null;
  /** The groups the teacher teaches. */
  groups: number;
  /** Distinct pupils the teacher teaches. */
  pupils: number;
  /**
   * The share of the teacher's teaching time (clock minutes) that a behörighet
   * covers, 0..1, four decimals; null when the school has recorded none or the
   * teacher teaches nothing.
   */
  qualifiedShare: number | null;
}

export interface SchoolKeyFigures {
  /** Pupils with a class in the year. */
  pupils: number;
  /** Teachers with at least one row. */
  teachers: number;
  /** Σ over teachers of the charged teaching, a standardvecka. */
  teachingMinutesPerWeek: number;
  teachingHoursPerYear: number;
  /** The policy's riktmärke; null without one. */
  fullTimeTeachingMinutesPerWeek: number | null;
  /** The teaching in heltidstjänster: teaching over the riktmärke, two decimals; null without a riktmärke. */
  teachingFte: number | null;
  /** Lärartäthet: teachingFte per 100 pupils, two decimals. */
  teachingFtePer100Pupils: number | null;
  /** The same by head: teachers per 100 pupils, two decimals. */
  teachersPer100Pupils: number | null;
  /** Pupils per teacher by head, one decimal. */
  pupilsPerTeacher: number | null;
  qualificationsRecorded: boolean;
  qualifiedMinutesPerWeek: number;
  unqualifiedMinutesPerWeek: number;
  /** Behöriga lärares andel av undervisningen, 0..1, four decimals; null when nothing is recorded or taught. */
  qualifiedShare: number | null;
  /** The lessons of rows nobody leads: what the pupils sit through, a standardvecka. */
  unstaffedMinutesPerWeek: number;
  /** Σ tjänstgöringsgrad / 100 of the teachers with a row. HR data: present only for a reader with HR-läs. */
  employmentFte?: number | null;
  /** The same per 100 pupils. HR data. */
  employmentFtePer100Pupils?: number | null;
}

export interface KeyFiguresResponse {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  loadModel: 'MINUTES' | 'FACTOR';
  /** Where the pupils come from: 'ENROLLMENT' for a past year (its class history), absent for the rosters as they are. */
  rostersFrom?: 'ENROLLMENT';
  /** True when tjänstgöringsgrad was left out for a reader without HR-läs. */
  hrHidden?: true;
  /**
   * The day every teacher's tjänstgöringsgrad (and employmentFte) is read on: the school's today held inside the
   * läsår. A post that changes during the year has no one figure; this is the one in force that day (postOn).
   * Present only where tjänstgöringsgrad is stated, i.e. for a reader with HR-läs.
   */
  employmentOn?: string;
  /** True for the huvudman's reader: the school's figures, and no teacher's. */
  aggregateOnly?: true;
  school: SchoolKeyFigures;
  /** Null for the huvudman's reader. */
  teachers: TeacherKeyFigures[] | null;
  notices: AnalysisNotice[];
}

// ---------------------------------------------------------------------------
// Kostnadsunderlag per elev
// ---------------------------------------------------------------------------

/** Hours per category, over the year (planned rows) or the range (cover). */
export type HoursByCategory = Record<CostCategory, number>;

export interface CostBasisCell {
  /** The skoldel holding the årskurs, null when none does. */
  schoolPartId: string | null;
  /** The årskurs in the läsår's own numbering; null for pupils and rows that have none. */
  gradeLevel: number | null;
  pupils: number;
  hours: HoursByCategory;
  /** All categories' hours per pupil, two decimals; null without pupils. */
  hoursPerPupil: number | null;
  /** SEK, two decimals; null when a category with hours has no rate. */
  cost: number | null;
  costPerPupil: number | null;
}

export interface CostBasisPart {
  schoolPartId: string | null;
  name: string | null;
  account: string | null;
  pupils: number;
  hours: HoursByCategory;
  hoursPerPupil: number | null;
  cost: number | null;
  costPerPupil: number | null;
}

export interface CostBasisResponse {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  gradeNumbering: 'NIOARIG' | 'TIOARIG';
  rostersFrom?: 'ENROLLMENT';
  /** The days held cover lessons were counted over; null when the school states no rate for the vikarie or nothing is published. */
  substitutes: { from: string; to: string } | null;
  rates: CostRateView[];
  /** Categories that carry hours and have no rate. */
  missingRates: CostCategory[];
  parts: CostBasisPart[];
  cells: CostBasisCell[];
  total: Omit<CostBasisPart, 'schoolPartId' | 'name' | 'account'>;
  /** True for the huvudman's reader: this answer is aggregates throughout; kept so the page can say so. */
  aggregateOnly?: true;
  notices: AnalysisNotice[];
}

// ---------------------------------------------------------------------------
// Löneunderlag
// ---------------------------------------------------------------------------

export type PayrollPersonKind = 'STAFF' | 'POOL';

/** One person's time in one skoldel in the period, in minutes. */
export interface PayrollLine {
  userId: string;
  kind: PayrollPersonKind;
  /** The skoldel; null for the line of time no skoldel holds (uppdrag with no teaching to follow, an årskurs in none). */
  schoolPartId: string | null;
  account: string | null;
  /** Held teaching, clock minutes. */
  teachingMinutes: number;
  /** The year's uppdrag over the period's teaching weeks, minutes, shared across the person's skoldelar by their other time. */
  dutyMinutes: number;
  /** Held cover (the vikarie export's lessons), clock minutes. */
  substituteMinutes: number;
}

export interface PayrollPerson {
  userId: string;
  kind: PayrollPersonKind;
  teachingMinutes: number;
  dutyMinutes: number;
  substituteMinutes: number;
  /** Tjänstgöringsgrad. HR data; the whole answer is for readers of HR data. */
  employmentPercent: number | null;
}

export interface PayrollBasisResponse {
  academicYearId: string;
  from: string;
  to: string;
  parts: SchoolPartView[];
  people: PayrollPerson[];
  lines: PayrollLine[];
  /** People with a protected identity who are in the answer, as payroll pays everyone. */
  protectedInAnswer: number;
  notices: AnalysisNotice[];
}

export const PAYROLL_FORMATS = ['CSV', 'XLSX'] as const;
export type PayrollFormat = (typeof PAYROLL_FORMATS)[number];

export interface PayrollFileResponse {
  filename: string;
  contentType: string;
  contentBase64: string;
  notices: AnalysisNotice[];
  protectedInFile: number;
}
