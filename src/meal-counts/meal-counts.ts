import { isoWeekday, iterateDates } from '../calendar/publish-days';
import { encodeWindows1252 } from '../common/windows-1252';
import { guardFormula } from '../schedule-exchange/csv';

/*
 * Måltidskollen (20270123090000): the portions of each lunch sitting, for the
 * kitchen. app.meal_counts counts them per class and day from CalendarLunches
 * (the published schedule) and answers a document; this module is the other
 * half of the contract, the vocabulary and the pure reading of that document
 * into the days, the sittings and the totals. The page, the file and the
 * letter are all made from the one view this builds, so a figure cannot be
 * different in two of them.
 *
 * What is counted, in the one sentence the page also says: the pupils of the
 * classes that eat in the sitting, less those reported absent for the whole
 * sitting before the school's cut-off (brytpunkten), plus the staff whose
 * pedagogisk lunch the school has placed there. Absence reported after the
 * cut-off is shown and never taken off; a class with a replacement lesson over
 * the sitting is shown and counted. Nothing here knows a pupil's name, a diet
 * or an allergy: they are not stored, and they are not asked for.
 */

/** The job's name in the runner, in JobRuns and in JobClaims. */
export const MEAL_LETTER_JOB = 'meal-letter';
/** The tick: whether a school's letter is due is the database's question, asked every two minutes. */
export const MEAL_LETTER_INTERVAL_MS = 2 * 60 * 1000;
/**
 * How long after the cut-off a letter may still go: a letter after the lunch is no letter. Also what a
 * claim that was not finished (a crash, a failed mail) may be retried within: the claim is taken again
 * two hours on (app.job_claim_nightly), which is inside this.
 */
export const MEAL_LETTER_GRACE_MINUTES = 180;
/** Schools claimed per tick, run one after another. */
export const SCHOOLS_PER_TICK = 5;
/** The most days one read covers: the week ahead and then some. The database allows 31. */
export const MEAL_COUNTS_MAX_DAYS = 14;

export const MEAL_COUNTS_RANGE = 'MEAL_COUNTS_RANGE';
export const MEAL_COUNTS_PAST = 'MEAL_COUNTS_PAST';
export const MEAL_COUNTS_BAD_ANSWER = 'MEAL_COUNTS_BAD_ANSWER';
export const MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR = 'MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR';

/** One address, as the database's CHECK says it (KitchenSettings_the_address_is_one_address). */
export const KITCHEN_EMAIL = /^[^@\s,;<>"()]+@[^@\s,;<>"()]+\.[^@\s,;<>"()]+$/;
export const KITCHEN_EMAIL_MAX = 254;
/** A time of day, 00:00 to 23:59. */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// What app.meal_counts answers
// ---------------------------------------------------------------------------

export interface MealClassRow {
  /** yyyy-mm-dd, the school's date. */
  day: string;
  groupId: string;
  name: string;
  /** HH:MM in the school's time. */
  start: string;
  end: string;
  pupils: number;
  /** Pupils reported absent for the whole sitting, first reported before the cut-off. */
  absentBefore: number;
  /** The same, first reported at or after it. */
  absentAfter: number;
  /** The class has a replacement lesson (a schemabrytande aktivitet) over the sitting. */
  underActivity: boolean;
}

export interface MealStaffRow {
  day: string;
  start: string;
  end: string;
  staff: number;
}

export interface MealRows {
  /** HH:MM, or null: no cut-off, so no absence is taken off. */
  cutoff: string | null;
  /** Whether the school has placed a pedagogisk lunch with a fixed time in the period. */
  staffModelled: boolean;
  classes: MealClassRow[];
  staff: MealStaffRow[];
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * The document, checked to be what this module reads: the SQL and this file are two halves of a contract,
 * and a half that has drifted should be a refusal that names it, not a page of NaN.
 */
export function parseMealRows(raw: unknown): MealRows {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const doc = value as Partial<Record<keyof MealRows, unknown>> | null;
  const ok =
    doc !== null &&
    typeof doc === 'object' &&
    (doc.cutoff === null || (typeof doc.cutoff === 'string' && CLOCK.test(doc.cutoff))) &&
    typeof doc.staffModelled === 'boolean' &&
    Array.isArray(doc.classes) &&
    Array.isArray(doc.staff) &&
    doc.classes.every((row: Record<string, unknown>) =>
      isText(row['day']) && isText(row['groupId']) && isText(row['name']) && isText(row['start']) && isText(row['end']) &&
      isCount(row['pupils']) && isCount(row['absentBefore']) && isCount(row['absentAfter']) && typeof row['underActivity'] === 'boolean',
    ) &&
    doc.staff.every((row: Record<string, unknown>) => isText(row['day']) && isText(row['start']) && isText(row['end']) && isCount(row['staff']));
  if (!ok) throw new Error(MEAL_COUNTS_BAD_ANSWER);
  return doc as unknown as MealRows;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface MealClassView {
  groupId: string;
  name: string;
  pupils: number;
  absentBefore: number;
  absentAfter: number;
  underActivity: boolean;
  /** pupils - absentBefore: what the class adds to the sitting. */
  portions: number;
}

export interface MealTotals {
  pupils: number;
  /** Reported absent for the whole sitting before the cut-off: taken off. */
  absentBefore: number;
  staff: number;
  /** pupils - absentBefore + staff. */
  portions: number;
  /** Reported after the cut-off: shown, never taken off. */
  absentAfter: number;
  /** Pupils in classes with a replacement lesson over the sitting: counted all the same. */
  underActivity: number;
}

export interface MealSittingView extends MealTotals {
  /** HH:MM, in the school's time. */
  start: string;
  end: string;
  classes: MealClassView[];
}

export interface MealDayView {
  /** yyyy-mm-dd. */
  date: string;
  /** ISO weekday, 1 (Monday) to 7. */
  weekday: number;
  sittings: MealSittingView[];
  totals: MealTotals;
}

export interface MealCountsView {
  from: string;
  to: string;
  /** HH:MM, or null: no cut-off, so no absence is taken off. */
  cutoff: string | null;
  /** False: the school has placed no pedagogisk lunch with a fixed time, and no staff are in the counts. */
  staffModelled: boolean;
  /** Every day from `from` to `to`, a day without a sitting with an empty list. */
  days: MealDayView[];
}

const collator = new Intl.Collator('sv', { numeric: true });

function totalsOf(parts: readonly MealTotals[]): MealTotals {
  const sum = (pick: (part: MealTotals) => number) => parts.reduce((total, part) => total + pick(part), 0);
  return {
    pupils: sum((part) => part.pupils),
    absentBefore: sum((part) => part.absentBefore),
    staff: sum((part) => part.staff),
    portions: sum((part) => part.portions),
    absentAfter: sum((part) => part.absentAfter),
    underActivity: sum((part) => part.underActivity),
  };
}

/** The document as days, sittings and totals. The sittings of a day are its distinct windows, earliest first. */
export function buildMealView(rows: MealRows, from: string, to: string): MealCountsView {
  const staffBy = new Map(rows.staff.map((row) => [`${row.day}|${row.start}|${row.end}`, row.staff]));
  const days: MealDayView[] = [];
  for (const date of iterateDates(from, to)) {
    const windows = new Map<string, MealClassRow[]>();
    for (const row of rows.classes) {
      if (row.day !== date) continue;
      const key = `${row.start}|${row.end}`;
      const list = windows.get(key);
      if (list) list.push(row);
      else windows.set(key, [row]);
    }
    const sittings: MealSittingView[] = [...windows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, members]) => {
        const [start, end] = key.split('|') as [string, string];
        const classes: MealClassView[] = members
          .map((row) => ({
            groupId: row.groupId,
            name: row.name,
            pupils: row.pupils,
            absentBefore: row.absentBefore,
            absentAfter: row.absentAfter,
            underActivity: row.underActivity,
            portions: row.pupils - row.absentBefore,
          }))
          .sort((a, b) => collator.compare(a.name, b.name));
        const staff = staffBy.get(`${date}|${start}|${end}`) ?? 0;
        const pupils = classes.reduce((total, c) => total + c.pupils, 0);
        const absentBefore = classes.reduce((total, c) => total + c.absentBefore, 0);
        return {
          start,
          end,
          classes,
          pupils,
          absentBefore,
          staff,
          portions: pupils - absentBefore + staff,
          absentAfter: classes.reduce((total, c) => total + c.absentAfter, 0),
          underActivity: classes.filter((c) => c.underActivity).reduce((total, c) => total + c.pupils, 0),
        };
      });
    days.push({ date, weekday: isoWeekday(date), sittings, totals: totalsOf(sittings) });
  }
  return { from, to, cutoff: rows.cutoff, staffModelled: rows.staffModelled, days };
}

// ---------------------------------------------------------------------------
// The file: windows-1252, ;, CRLF, the way Swedish Excel opens it
// ---------------------------------------------------------------------------

export const CSV_HEADER: readonly string[] = [
  'Datum',
  'Veckodag',
  'Sittning från',
  'Sittning till',
  'Klasser',
  'Elever',
  'Frånvaro före brytpunkten',
  'Personal',
  'Portioner',
  'Anmäld efter brytpunkten',
  'Elever i klasser med aktivitet',
];

function quoteField(value: string): string {
  return /[";,\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The view as rows: one per day and sitting, a day without a sitting left out. */
export function mealCsvRows(view: MealCountsView): string[][] {
  const rows: string[][] = [[...CSV_HEADER]];
  for (const day of view.days) {
    for (const sitting of day.sittings) {
      rows.push([
        day.date,
        WEEKDAYS[day.weekday - 1]!,
        sitting.start,
        sitting.end,
        sitting.classes.map((c) => `${c.name} ${c.portions}`).join(', '),
        String(sitting.pupils),
        String(sitting.absentBefore),
        String(sitting.staff),
        String(sitting.portions),
        String(sitting.absentAfter),
        String(sitting.underActivity),
      ]);
    }
  }
  return rows;
}

/**
 * The file's bytes: windows-1252 with no byte-order mark, `;` between the cells, CRLF after every line (the last
 * too), a cell quoted only where it must be, and the formula guard on every cell (a class is named by a person).
 * Numbers and times pass the guard unchanged.
 */
export function mealCsv(view: MealCountsView): Buffer {
  const lines = mealCsvRows(view).map((row) => row.map((cell) => quoteField(guardFormula(cell))).join(';'));
  return encodeWindows1252(lines.map((line) => `${line}\r\n`).join(''));
}

/** The file's name: the day, or the first and the last day. */
export function mealCsvName(view: MealCountsView): string {
  return view.from === view.to ? `portioner-${view.from}.csv` : `portioner-${view.from}-${view.to}.csv`;
}

// ---------------------------------------------------------------------------
// The letter
// ---------------------------------------------------------------------------

export const WEEKDAYS: readonly string[] = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
const MONTHS: readonly string[] = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december',
];

/** "torsdag 4 februari 2027". */
export function swedishDate(day: MealDayView): string {
  const [year, month, date] = day.date.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[day.weekday - 1]} ${date} ${MONTHS[month - 1]} ${year}`;
}

export interface MealLetter {
  subject: string;
  body: string;
}

/**
 * The day's letter to the kitchen, in Swedish, plain text. Counts and the names of the classes, never a pupil's
 * and never a diet: Rastra stores neither. `cutoff` is the time the figures are as of; without a cut-off no
 * letter is made (the database does not name a school without one).
 */
export function mealLetter(day: MealDayView, school: string, cutoff: string, staffModelled: boolean): MealLetter {
  const when = swedishDate(day);
  const lines: string[] = [`Portioner ${when} – ${school}`, `Läget klockan ${cutoff}.`, ''];
  for (const sitting of day.sittings) {
    lines.push(`Sittning ${sitting.start}–${sitting.end}: ${sitting.portions} portioner`);
    lines.push(
      `  elever ${sitting.pupils}, anmäld frånvaro −${sitting.absentBefore}` + (staffModelled ? `, personal +${sitting.staff}` : ''),
    );
    lines.push(`  ${sitting.classes.map((c) => `${c.name} ${c.portions}`).join(', ')}`);
    const active = sitting.classes.filter((c) => c.underActivity);
    if (active.length > 0) {
      lines.push(`  schemabrytande aktivitet över sittningen (räknas med): ${active.map((c) => c.name).join(', ')}`);
    }
    lines.push('');
  }
  lines.push(`Totalt: ${day.totals.portions} portioner.`);
  lines.push('');
  if (day.totals.absentAfter > 0) {
    lines.push(`Anmäld efter klockan ${cutoff} och inte avdragen: ${day.totals.absentAfter}.`);
  } else {
    lines.push(`Frånvaro som anmäls efter klockan ${cutoff} är inte avdragen.`);
  }
  if (!staffModelled) lines.push('Personal ingår inte: ingen pedagogisk lunch med fast tid är lagd i Rastra.');
  lines.push('Allergier och kostval ingår inte: de lagras inte i Rastra.');
  return { subject: `Portioner ${when}`, body: `${lines.join('\n')}\n` };
}
