// Skolans kalender (P4): the days a läsår has and the timetable does not, worked out instead of typed.
//
// Three sources fill the same list of entries, and one diff measures the list against the lov the school
// already has:
//
//   * the Swedish public holidays, counted from Easter and the calendar (swedishHolidays);
//   * a proposal for the year's lov from the rules the rollover uses for next year's (proposeYearBreaks): the
//     first year needs them most, because there is no last year to copy;
//   * the municipality's own file (lib/school-calendar-file.ts), read into the same entries.
//
// NO LIST OF MUNICIPALITIES. A sportlov in week 9 is Stockholm's and week 7 is Dalarna's, and the school knows
// which one it has; a table of 290 kommuner would be wrong on the day one of them moved its week. The proposal
// takes the most common week and says so, the file says the rest.
//
// Pure functions of strings: a day is "YYYY-MM-DD" throughout, as the API holds it, and nothing here reads the
// clock or the zone.
import {
  addDays,
  dayOfIsoWeek,
  daysBetween,
  easterSunday,
  isoWeekOf,
  type DayBounds,
} from "@/lib/year-rollover";
import type { BreakKind, SchoolBreak } from "@/lib/types";

// ---- the public holidays

export type HolidayKey =
  | "NEW_YEARS_DAY"
  | "EPIPHANY"
  | "GOOD_FRIDAY"
  | "EASTER_SUNDAY"
  | "EASTER_MONDAY"
  | "MAY_DAY"
  | "ASCENSION"
  | "WHIT_SUNDAY"
  | "NATIONAL_DAY"
  | "MIDSUMMER_EVE"
  | "MIDSUMMER_DAY"
  | "ALL_SAINTS"
  | "CHRISTMAS_EVE"
  | "CHRISTMAS_DAY"
  | "BOXING_DAY"
  | "NEW_YEARS_EVE";

export interface Holiday {
  key: HolidayKey;
  /** YYYY-MM-DD. */
  date: string;
  /** As the school writes it: the name a lov of the day is saved under. */
  name: string;
  /** A röd dag by law. The three eves are not, and a school is shut on them all the same. */
  official: boolean;
}

/** The first day on or after `from` that falls on `weekday` (1 = Monday … 7 = Sunday). */
function onOrAfter(from: string, weekday: number): string {
  const here = isoWeekOf(from).weekday;
  return addDays(from, (weekday - here + 7) % 7);
}

/**
 * The year's public holidays and the eves a school is shut on, earliest first.
 *
 * Fixed: 1 and 6 January, 1 May, 6 June, 24, 25, 26 and 31 December. Moving with Easter: Good Friday, Easter
 * Sunday and Monday, Ascension Day (39 days after Easter) and Whit Sunday (49). Moving with the weekday:
 * Midsummer Day is the Saturday of 20-26 June (the eve is the Friday before), All Saints' Day the Saturday of
 * 31 October - 6 November. Whit Monday has not been a holiday since 2005 and Epiphany Eve is not one.
 */
export function swedishHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const midsummerDay = onOrAfter(`${year}-06-20`, 6);
  const fixed = (key: HolidayKey, month: string, name: string, official = true): Holiday => ({
    key,
    date: `${year}-${month}`,
    name,
    official,
  });
  const list: Holiday[] = [
    fixed("NEW_YEARS_DAY", "01-01", "Nyårsdagen"),
    fixed("EPIPHANY", "01-06", "Trettondedag jul"),
    { key: "GOOD_FRIDAY", date: addDays(easter, -2), name: "Långfredagen", official: true },
    { key: "EASTER_SUNDAY", date: easter, name: "Påskdagen", official: true },
    { key: "EASTER_MONDAY", date: addDays(easter, 1), name: "Annandag påsk", official: true },
    fixed("MAY_DAY", "05-01", "Första maj"),
    { key: "ASCENSION", date: addDays(easter, 39), name: "Kristi himmelsfärdsdag", official: true },
    { key: "WHIT_SUNDAY", date: addDays(easter, 49), name: "Pingstdagen", official: true },
    fixed("NATIONAL_DAY", "06-06", "Sveriges nationaldag"),
    { key: "MIDSUMMER_EVE", date: addDays(midsummerDay, -1), name: "Midsommarafton", official: false },
    { key: "MIDSUMMER_DAY", date: midsummerDay, name: "Midsommardagen", official: true },
    { key: "ALL_SAINTS", date: onOrAfter(`${year}-10-31`, 6), name: "Alla helgons dag", official: true },
    fixed("CHRISTMAS_EVE", "12-24", "Julafton", false),
    fixed("CHRISTMAS_DAY", "12-25", "Juldagen"),
    fixed("BOXING_DAY", "12-26", "Annandag jul"),
    fixed("NEW_YEARS_EVE", "12-31", "Nyårsafton", false),
  ];
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

/** Monday to Friday: the days of the school week. A holiday on any other day costs a school nothing. */
export const isSchoolWeekday = (day: string): boolean => isoWeekOf(day).weekday <= 5;

/** The school days of the weekdays in a range, as a count: 0 for a lov of a weekend alone. */
export function weekdaysIn(start: string, end: string): number {
  let count = 0;
  for (let day = start; day <= end; day = addDays(day, 1)) if (isSchoolWeekday(day)) count += 1;
  return count;
}

/**
 * The holidays inside a läsår that fall on a school day, earliest first: the ones that are a lov to make. A year
 * runs over New Year, so both calendar years are asked.
 */
export function holidaysDuring(year: DayBounds): Holiday[] {
  const first = Number(year.startDate.slice(0, 4));
  const last = Number(year.endDate.slice(0, 4));
  const found: Holiday[] = [];
  for (let calendarYear = first; calendarYear <= last; calendarYear += 1) {
    for (const holiday of swedishHolidays(calendarYear)) {
      if (holiday.date >= year.startDate && holiday.date <= year.endDate && isSchoolWeekday(holiday.date)) {
        found.push(holiday);
      }
    }
  }
  return found;
}

// ---- the entries a calendar is made of

export type CalendarSource = "HOLIDAY" | "PROPOSAL" | "FILE";

export interface CalendarEntry {
  /** Stable within one open dialog, so a ticked row stays ticked when the list is rebuilt. */
  key: string;
  source: CalendarSource;
  name: string;
  kind: BreakKind;
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  /** What the entry came from, for the row: the rule of a proposal, the line of a file. */
  origin?: string;
  /** A row of a file that reads as a term date (terminsstart) and not as a lov: unticked by default. */
  looksLikeTermDate?: boolean;
}

/** A lov as the school writes it: the whole school, a name and a day. */
export function holidayEntry(holiday: Holiday): CalendarEntry {
  return {
    key: `HOLIDAY:${holiday.key}:${holiday.date}`,
    source: "HOLIDAY",
    name: holiday.name,
    kind: "HOLIDAY",
    startDate: holiday.date,
    endDate: holiday.date,
    minGradeLevel: null,
    maxGradeLevel: null,
  };
}

export function holidayEntries(year: DayBounds): CalendarEntry[] {
  return holidaysDuring(year).map(holidayEntry);
}

// ---- a proposal for the year's lov

/** The week most municipalities take for each lov. Said on the proposal, because a school's municipality may not. */
export const SPORTLOV_WEEK = 9;
export const HOSTLOV_WEEK = 44;

export type BreakRule = "ISO_WEEK" | "CHRISTMAS" | "EASTER";

export interface BreakProposal extends CalendarEntry {
  source: "PROPOSAL";
  /** The rollover's own anchor for it (year-rollover.ts BreakAnchor): the next year's will follow the same rule. */
  rule: BreakRule;
  /** The week number a rule of weeks stands on, 0 for the others. */
  week: number;
}

/** Monday to Friday of an ISO week, or null when the year has no such week. */
function weekdays(year: number, week: number): { startDate: string; endDate: string } | null {
  const monday = dayOfIsoWeek(year, week, 1);
  const friday = dayOfIsoWeek(year, week, 5);
  return monday === null || friday === null ? null : { startDate: monday, endDate: friday };
}

/**
 * The year's lov, proposed on the anchors the rollover proposes the next year's on (proposeBreak in
 * year-rollover.ts: a week number, whole weeks around julafton, Easter), so the first year and the second follow
 * the same rules and nothing is typed twice. The rollover moves a lov by what it was, so its jullov ends on the
 * same weekday and this one on 6 January; the two can differ by a day, and both are proposals:
 *
 *  - höstlov: ISO week 44 of the autumn, Monday to Friday (rule ISO_WEEK);
 *  - jullov: from the first school day on or after 21 December to Trettondedag, 6 January (CHRISTMAS): julafton is
 *    inside it, which is the anchor the rollover moves it by;
 *  - sportlov: ISO week 9 of the spring (ISO_WEEK). A municipality's own week, 7 to 12, is the admin's to say;
 *  - påsklov: the week of Annandag påsk, Monday to Friday (EASTER), which the rollover carries with Easter.
 *
 * A proposal that does not lie inside the läsår is not made (a short year with no autumn break week). Studiedagar
 * are not proposed: they are the school's own, and the file or the page has them.
 */
export function proposeYearBreaks(year: DayBounds): BreakProposal[] {
  const autumn = Number(year.startDate.slice(0, 4));
  const spring = Number(year.endDate.slice(0, 4));
  const proposals: BreakProposal[] = [];
  const inYear = (start: string, end: string) => start >= year.startDate && end <= year.endDate && start <= end;
  const add = (name: string, start: string, end: string, rule: BreakRule, week: number, origin: string) => {
    if (!inYear(start, end)) return;
    proposals.push({
      key: `PROPOSAL:${rule}:${name}`,
      source: "PROPOSAL",
      name,
      kind: "HOLIDAY",
      startDate: start,
      endDate: end,
      minGradeLevel: null,
      maxGradeLevel: null,
      origin,
      rule,
      week,
    });
  };

  const autumnBreak = weekdays(autumn, HOSTLOV_WEEK);
  if (autumnBreak) add("Höstlov", autumnBreak.startDate, autumnBreak.endDate, "ISO_WEEK", HOSTLOV_WEEK, "ISO_WEEK");

  // From the first school day on or after 21 December (21 to 23 December, so julafton is always inside it) to
  // Trettondedag. A school resumes on the first school day after it.
  const christmasStart = isSchoolWeekday(`${autumn}-12-21`) ? `${autumn}-12-21` : onOrAfter(`${autumn}-12-21`, 1);
  add("Jullov", christmasStart, `${autumn + 1}-01-06`, "CHRISTMAS", 0, "CHRISTMAS");

  const springBreak = weekdays(spring, SPORTLOV_WEEK);
  if (springBreak) add("Sportlov", springBreak.startDate, springBreak.endDate, "ISO_WEEK", SPORTLOV_WEEK, "ISO_WEEK");

  const easterMonday = addDays(easterSunday(spring), 1);
  const easterWeek = isoWeekOf(easterMonday);
  const easterBreak = weekdays(easterWeek.year, easterWeek.week);
  if (easterBreak) add("Påsklov", easterBreak.startDate, easterBreak.endDate, "EASTER", 0, "EASTER");

  return proposals.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ---- measured against what the school has

export type EntryStatus =
  /** Nothing like it in the year: made. */
  | "NEW"
  /** The same name, kind, days and årskurser as a lov the year has: nothing to do. */
  | "SAME"
  /** The name of a lov the year has, on other days: moved, when ticked. */
  | "CHANGED"
  /** Inside a lov the year has or another entry makes: no need for it. */
  | "COVERED"
  /** Outside the läsår, or its end before its start: cannot be saved. */
  | "OUTSIDE"
  /** Only Saturdays and Sundays: no school day is lost. */
  | "WEEKEND";

export interface DiffRow {
  entry: CalendarEntry;
  status: EntryStatus;
  /** The lov a SAME or CHANGED entry is, or the one that covers a COVERED one. */
  existing?: SchoolBreak;
  /** The entry that covers a COVERED one, when it is another entry and not a lov the year has. */
  coveredBy?: CalendarEntry;
  /** Other lov of the year that share days with a NEW or CHANGED entry (a warning, not a stop). */
  overlaps: SchoolBreak[];
}

export interface CalendarDiff {
  rows: DiffRow[];
  /** The lov the year has that no entry named: only worth saying for a file. They are never removed. */
  onlyHere: SchoolBreak[];
}

const nameKey = (name: string): string => name.trim().toLowerCase();

const sameGrades = (
  a: { minGradeLevel: number | null; maxGradeLevel: number | null },
  b: { minGradeLevel: number | null; maxGradeLevel: number | null },
): boolean => a.minGradeLevel === b.minGradeLevel && a.maxGradeLevel === b.maxGradeLevel;

/** Whether `outer` takes at least every day and every årskurs that `inner` takes. */
function covers(
  outer: { startDate: string; endDate: string; minGradeLevel: number | null; maxGradeLevel: number | null },
  inner: { startDate: string; endDate: string; minGradeLevel: number | null; maxGradeLevel: number | null },
): boolean {
  if (outer.startDate > inner.startDate || outer.endDate < inner.endDate) return false;
  if (outer.minGradeLevel === null || outer.maxGradeLevel === null) return true;
  return (
    inner.minGradeLevel !== null &&
    inner.maxGradeLevel !== null &&
    outer.minGradeLevel <= inner.minGradeLevel &&
    outer.maxGradeLevel >= inner.maxGradeLevel
  );
}

const overlap = (
  a: { startDate: string; endDate: string },
  b: { startDate: string; endDate: string },
): boolean => a.startDate <= b.endDate && b.startDate <= a.endDate;

const SOURCE_RANK: Record<CalendarSource, number> = { FILE: 0, PROPOSAL: 1, HOLIDAY: 2 };

/**
 * Measures the entries against the lov the school has, one row each, in the order they were given.
 *
 * The rules, in the order they decide a row:
 *  1. OUTSIDE the läsår, or an end before the start;
 *  2. WEEKEND, when no day of it is a school day;
 *  3. SAME as a lov of the year (name without regard to case, kind, days, årskurser);
 *  4. CHANGED when it has the name of ONE lov of the year and no other entry has it: a name that several lov share
 *     (Studiedag) says nothing about which of them moved, and the entry is NEW beside them;
 *  5. COVERED when a lov of the year, or another entry that is not itself covered or the same, takes all its days
 *     and årskurser: Annandag påsk inside Påsklov. Of two entries that cover each other (the same days), the
 *     one from the more specific source stays: a file over a proposal over a holiday;
 *  6. NEW.
 * Overlaps with lov the year has are named for NEW and CHANGED rows, as a warning.
 */
export function diffCalendar(entries: readonly CalendarEntry[], existing: readonly SchoolBreak[], year: DayBounds): CalendarDiff {
  const namesOfEntries = new Map<string, number>();
  for (const entry of entries) namesOfEntries.set(nameKey(entry.name), (namesOfEntries.get(nameKey(entry.name)) ?? 0) + 1);
  const existingByName = new Map<string, SchoolBreak[]>();
  for (const lov of existing) existingByName.set(nameKey(lov.name), [...(existingByName.get(nameKey(lov.name)) ?? []), lov]);

  const rows: DiffRow[] = entries.map((entry) => {
    const overlaps = existing.filter((lov) => overlap(lov, entry) && !(lov.startDate === entry.startDate && lov.endDate === entry.endDate && nameKey(lov.name) === nameKey(entry.name)));
    if (entry.endDate < entry.startDate || entry.startDate < year.startDate || entry.endDate > year.endDate) {
      return { entry, status: "OUTSIDE" as const, overlaps: [] };
    }
    if (weekdaysIn(entry.startDate, entry.endDate) === 0) return { entry, status: "WEEKEND" as const, overlaps: [] };
    const same = existing.find(
      (lov) =>
        nameKey(lov.name) === nameKey(entry.name) &&
        lov.kind === entry.kind &&
        lov.startDate === entry.startDate &&
        lov.endDate === entry.endDate &&
        sameGrades(lov, entry),
    );
    if (same) return { entry, status: "SAME" as const, existing: same, overlaps: [] };
    const namesake = existingByName.get(nameKey(entry.name));
    if (namesake?.length === 1 && namesOfEntries.get(nameKey(entry.name)) === 1) {
      return { entry, status: "CHANGED" as const, existing: namesake[0]!, overlaps: overlaps.filter((lov) => lov.id !== namesake[0]!.id) };
    }
    const cover = existing.find((lov) => covers(lov, entry));
    if (cover) return { entry, status: "COVERED" as const, existing: cover, overlaps: [] };
    return { entry, status: "NEW" as const, overlaps };
  });

  // Entries that cover each other: the longer one stays and the shorter is covered by it; of two with the same days
  // the one from the more specific source stays (a file over a proposal over a holiday), then the first given.
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === "NEW" || row.status === "CHANGED")
    .sort(
      (a, b) =>
        daysBetween(b.row.entry.startDate, b.row.entry.endDate) - daysBetween(a.row.entry.startDate, a.row.entry.endDate) ||
        SOURCE_RANK[a.row.entry.source] - SOURCE_RANK[b.row.entry.source] ||
        a.index - b.index,
    );
  const kept: DiffRow[] = [];
  for (const { row } of ordered) {
    const keeper = row.status === "NEW" ? kept.find((other) => covers(other.entry, row.entry)) : undefined;
    if (keeper) {
      row.status = "COVERED";
      row.coveredBy = keeper.entry;
      row.overlaps = [];
    } else {
      kept.push(row);
    }
  }

  const named = new Set(rows.filter((row) => row.existing).map((row) => row.existing!.id));
  const onlyHere = existing.filter((lov) => !named.has(lov.id));
  return { rows, onlyHere };
}

/** The rows a calendar is saved from: the ones that make or move a lov, ticked. */
export function savableRows(diff: CalendarDiff, ticked: ReadonlySet<string>): DiffRow[] {
  return diff.rows.filter((row) => (row.status === "NEW" || row.status === "CHANGED") && ticked.has(row.entry.key));
}

/** The body of POST /api/v1/school-breaks/calendar for the ticked rows (a CHANGED row names the lov it moves). */
export function calendarBody(
  academicYearId: string,
  rows: readonly DiffRow[],
  dryRun: boolean,
): {
  academicYearId: string;
  dryRun: boolean;
  breaks: Array<{
    id?: string;
    name: string;
    kind: BreakKind;
    startDate: string;
    endDate: string;
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
  }>;
} {
  return {
    academicYearId,
    dryRun,
    breaks: rows.map(({ entry, status, existing }) => ({
      ...(status === "CHANGED" && existing ? { id: existing.id } : {}),
      name: entry.name,
      kind: entry.kind,
      startDate: entry.startDate,
      endDate: entry.endDate,
      minGradeLevel: entry.minGradeLevel,
      maxGradeLevel: entry.maxGradeLevel,
    })),
  };
}
