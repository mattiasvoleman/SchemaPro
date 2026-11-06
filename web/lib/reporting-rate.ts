/**
 * Rapporteringsgrad, the web's side of the figures (/admin/reporting-rate, and
 * the teacher's own page /teacher/reporting-rate).
 *
 * A lesson is reported when its register is saved: at least one pupil has a
 * mark that is not UNKNOWN. The gateway (src/reporting-rate/) counts the
 * lessons a teacher held and the ones reported, per teacher and day, and the
 * web only adds, sorts and words them. Free of React and of imports, so a test
 * can read it as it is.
 *
 * Nothing here is a verdict on a person: the figures are lessons and a share
 * of them. The page says what is counted, and a notice or an e-mail never says
 * who (migration 20270112090100).
 */

export const REPORTING_PERIODS = ["WEEK", "MONTH", "YEAR"] as const;
export type ReportingPeriod = (typeof REPORTING_PERIODS)[number];

/** The days a lesson may stand open before the school's reminder (the gateway's DTO says the same bounds). */
export const OPEN_AFTER_DAYS = { min: 1, max: 30, standard: 2 } as const;

/** Lessons held, and of them the ones whose register is saved. */
export interface ReportingFigures {
  held: number;
  reported: number;
}

/** One teacher of GET /api/v1/reporting-rate: only teachers with a held lesson in the period. */
export interface ReportingTeacherRow extends ReportingFigures {
  teacherId: string;
  firstName: string;
  lastName: string;
}

/** GET /api/v1/reporting-rate. The interval is in the school's dates; all of it null when the läsår is missing. */
export interface ReportingRateView {
  period: ReportingPeriod;
  anchor: string;
  from: string | null;
  to: string | null;
  /** The läsår's name for the YEAR period. */
  yearName: string | null;
  /** The day before `from` and the day after `to`: where the arrows lead. */
  previousAnchor: string | null;
  nextAnchor: string | null;
  /** The last day stored for the school, or null before the first night's count. */
  through: string | null;
  total: ReportingFigures;
  teachers: ReportingTeacherRow[];
}

/** GET and PUT /api/v1/reporting-rate/settings. */
export interface ReportingSettings {
  teacherReminders: boolean;
  rektorDigest: boolean;
  openAfterDays: number;
}

/** What PUT /settings takes: a save names what changed. */
export type ReportingSettingsChange = Partial<ReportingSettings>;

/** One lesson of GET /api/v1/reporting-rate/mine whose register is not saved. */
export interface OpenLesson {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
  /** Open for longer than the school's limit. */
  overdue: boolean;
}

export interface ReportingInterval extends ReportingFigures {
  from: string;
  to: string;
}

/** GET /api/v1/reporting-rate/mine: the teacher's own, and nobody else's. */
export interface MyReportingRate {
  openAfterDays: number;
  through: string | null;
  open: OpenLesson[];
  week: ReportingInterval;
  month: ReportingInterval;
  year: (ReportingInterval & { name: string }) | null;
}

/**
 * The day to ask for to land in the period before (-1) or after (+1) the one
 * shown, or null when there is none to go to.
 *
 * A week and a month are what the gateway names: the day before the period and
 * the day after it. A läsår is not: it runs from mid-August to mid-June, so the
 * day before it falls in the summer between two years, where the school has no
 * läsår and the page would say so instead of showing last year. For a läsår
 * the arrows therefore aim at the middle of the year shown, a year back or on,
 * which is inside the neighbour whatever its exact dates.
 */
export function neighbourAnchor(view: ReportingRateView, direction: -1 | 1): string | null {
  const named = direction < 0 ? view.previousAnchor : view.nextAnchor;
  if (view.period !== "YEAR" || named === null || view.from === null || view.to === null) return named;
  const middle = new Date((Date.parse(`${view.from}T12:00:00Z`) + Date.parse(`${view.to}T12:00:00Z`)) / 2);
  middle.setUTCFullYear(middle.getUTCFullYear() + direction);
  return middle.toISOString().slice(0, 10);
}

/** The open lessons the oldest first: the order the teacher's page promises, whatever order the gateway answered in. */
export function oldestFirst(lessons: readonly OpenLesson[]): OpenLesson[] {
  return [...lessons].sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.lessonId < b.lessonId ? -1 : a.lessonId > b.lessonId ? 1 : 0),
  );
}

/** The lessons held and not reported. Never below zero, whatever a figure says. */
export function openOf({ held, reported }: ReportingFigures): number {
  return Math.max(0, held - reported);
}

/**
 * The share as a whole percent, or null when nothing was held (a rate of
 * nothing is not 0 %). Never 100 while a lesson is open: 998 of 1 000 is 99,
 * not a rounded "all done" beside a column that shows two open.
 */
export function percentOf({ held, reported }: ReportingFigures): number | null {
  if (held <= 0) return null;
  if (reported >= held) return 100;
  if (reported <= 0) return 0;
  return Math.min(99, Math.round((reported * 100) / held));
}

export type ReportingSortKey = "teacher" | "held" | "reported" | "open" | "share";
export type SortDirection = "asc" | "desc";

export interface ReportingSort {
  key: ReportingSortKey;
  direction: SortDirection;
}

/** The lowest share first: the table opens on those who have most to catch up on. */
export const DEFAULT_SORT: ReportingSort = { key: "share", direction: "asc" };

const NAMES = new Intl.Collator("sv");

const byName = (a: ReportingTeacherRow, b: ReportingTeacherRow): number =>
  NAMES.compare(a.lastName, b.lastName) ||
  NAMES.compare(a.firstName, b.firstName) ||
  (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0);

/** A teacher's share as a number to order by. Equal fractions divide to equal doubles. */
const shareOf = (row: ReportingFigures): number => (row.held > 0 ? row.reported / row.held : 1);

function primary(key: ReportingSortKey, a: ReportingTeacherRow, b: ReportingTeacherRow): number {
  switch (key) {
    case "teacher":
      return NAMES.compare(a.lastName, b.lastName) || NAMES.compare(a.firstName, b.firstName);
    case "held":
      return a.held - b.held;
    case "reported":
      return a.reported - b.reported;
    case "open":
      return openOf(a) - openOf(b);
    case "share":
      return shareOf(a) - shareOf(b);
  }
}

/** A sorted copy. Ties fall back on the name, the same way whichever way the column goes. */
export function sortTeachers(rows: readonly ReportingTeacherRow[], sort: ReportingSort): ReportingTeacherRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * primary(sort.key, a, b) || byName(a, b));
}

/**
 * The sort a press on a column header gives: the same column turns the
 * direction round; another column starts where its reader looks first (names
 * A to Ö, the lowest share, the most lessons).
 */
export function nextSort(current: ReportingSort, key: ReportingSortKey): ReportingSort {
  if (current.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: key === "teacher" || key === "share" ? "asc" : "desc" };
}

/** The header's aria-sort: only the sorted column says so. */
export function ariaSortOf(current: ReportingSort, key: ReportingSortKey): "ascending" | "descending" | undefined {
  if (current.key !== key) return undefined;
  return current.direction === "asc" ? "ascending" : "descending";
}
