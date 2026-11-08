/*
 * Analys och planering (K1): the shapes the gateway answers with
 * (src/analysis/analysis.types.ts is the other copy). Ids only, never a name:
 * the page names people from the register it already reads, all but a person
 * the payroll's answer says is marked (PayrollPerson.protectedIdentity), whom it
 * names by signature and Löne-id, or by the code where there is no Löne-id.
 */

export const COST_CATEGORIES = ["TEACHER", "UNQUALIFIED_TEACHER", "SUBSTITUTE"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface SchoolPart {
  id: string;
  name: string;
  account: string;
  gradeFrom: number;
  gradeTo: number;
}

export interface CostRate {
  category: CostCategory;
  hourlyCost: number;
}

export type AnalysisNoticeCode =
  | "ANALYSIS_PUPILS_FROM_ENROLLMENT"
  | "ANALYSIS_GRADES_WITHOUT_PART"
  | "ANALYSIS_NO_SCHOOL_PARTS"
  | "ANALYSIS_RATE_MISSING"
  | "ANALYSIS_NO_FULL_TIME"
  | "ANALYSIS_QUALIFICATIONS_NOT_RECORDED"
  | "ANALYSIS_ROWS_WITHOUT_PUPILS"
  | "ANALYSIS_PERIOD_CLAMPED"
  | "ANALYSIS_NOTHING_PUBLISHED"
  | "ANALYSIS_COVER_TO_CHECK"
  | "ANALYSIS_LEFT_IN_PERIOD"
  | "ANALYSIS_DUTIES_UNALLOCATED"
  | "ANALYSIS_PROTECTED_IN_FILE"
  | "ANALYSIS_PROTECTED_WITHOUT_PAYROLL_NUMBER"
  | "ANALYSIS_CHARACTERS_REPLACED";

export interface AnalysisNotice {
  code: AnalysisNoticeCode;
  params: Record<string, string | number>;
}

export type LoadStatus = "UNDER" | "OK" | "OVER" | "NO_TARGET";

export interface TeacherKeyFigures {
  userId: string;
  teachingMinutesPerWeek: number;
  dutyMinutesPerWeek: number;
  countedMinutesPerWeek: number;
  targetMinutesPerWeek: number | null;
  percentOfTarget: number | null;
  status: LoadStatus;
  scheduledMinutesPerWeek: number | null;
  teachingHoursPerYear: number;
  employmentPercent: number | null;
  groups: number;
  pupils: number;
  qualifiedShare: number | null;
}

export interface SchoolKeyFigures {
  pupils: number;
  teachers: number;
  teachingMinutesPerWeek: number;
  teachingHoursPerYear: number;
  fullTimeTeachingMinutesPerWeek: number | null;
  teachingFte: number | null;
  teachingFtePer100Pupils: number | null;
  teachersPer100Pupils: number | null;
  pupilsPerTeacher: number | null;
  qualificationsRecorded: boolean;
  qualifiedMinutesPerWeek: number;
  unqualifiedMinutesPerWeek: number;
  qualifiedShare: number | null;
  unstaffedMinutesPerWeek: number;
  employmentFte?: number | null;
  employmentFtePer100Pupils?: number | null;
}

export interface KeyFigures {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  loadModel: "MINUTES" | "FACTOR";
  rostersFrom?: "ENROLLMENT";
  hrHidden?: true;
  /** The day tjänstgöringsgrad is read on: the school's today held inside the läsår (the post in force that day). HR-läs only. */
  employmentOn?: string;
  aggregateOnly?: true;
  school: SchoolKeyFigures;
  teachers: TeacherKeyFigures[] | null;
  notices: AnalysisNotice[];
}

export type HoursByCategory = Record<CostCategory, number>;

export interface CostFigures {
  pupils: number;
  hours: HoursByCategory;
  hoursPerPupil: number | null;
  cost: number | null;
  costPerPupil: number | null;
}

export interface CostCell extends CostFigures {
  schoolPartId: string | null;
  gradeLevel: number | null;
}

export interface CostPart extends CostFigures {
  schoolPartId: string | null;
  name: string | null;
  account: string | null;
}

export interface CostBasis {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  gradeNumbering: "NIOARIG" | "TIOARIG";
  rostersFrom?: "ENROLLMENT";
  substitutes: { from: string; to: string } | null;
  rates: CostRate[];
  missingRates: CostCategory[];
  parts: CostPart[];
  cells: CostCell[];
  total: CostFigures;
  aggregateOnly?: true;
  notices: AnalysisNotice[];
}

export type PayrollPersonKind = "STAFF" | "POOL";

export interface PayrollLine {
  userId: string;
  kind: PayrollPersonKind;
  schoolPartId: string | null;
  account: string | null;
  teachingMinutes: number;
  dutyMinutes: number;
  substituteMinutes: number;
}

export interface PayrollPerson {
  userId: string;
  kind: PayrollPersonKind;
  teachingMinutes: number;
  dutyMinutes: number;
  substituteMinutes: number;
  employmentPercent: number | null;
  /** The post's lärarsignatur in the läsår, or null. */
  signature: string | null;
  /** Löne-id on the post (20270206090000), or null. */
  payrollNumber: string | null;
  /** Marked as having a protected identity: named by signature and Löne-id, never by name, on the page as in the file. */
  protectedIdentity: boolean;
  /** A marked person with no Löne-id: the file's code, SKYDDAD-<n>, which the page resolves for its reader alone. */
  pseudonym: string | null;
}

export interface PayrollBasis {
  academicYearId: string;
  from: string;
  to: string;
  parts: SchoolPart[];
  people: PayrollPerson[];
  lines: PayrollLine[];
  protectedInAnswer: number;
  protectedWithoutPayrollNumber: number;
  notices: AnalysisNotice[];
}

export type PayrollFormat = "CSV" | "XLSX";

export interface PayrollFile {
  filename: string;
  contentType: string;
  contentBase64: string;
  notices: AnalysisNotice[];
  protectedInFile: number;
  protectedWithoutPayrollNumber: number;
}

/** The input of a skoldel. */
export interface SchoolPartInput {
  name: string;
  account: string;
  gradeFrom: number;
  gradeTo: number;
}
