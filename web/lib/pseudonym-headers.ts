/**
 * What a column holds, as far as its header and its values say (Pseudonymiseraren, X1): the proposals the page shows, and
 * the statistics the user is shown to decide the rest. Pure functions.
 *
 * NOTHING IS GUESSED SILENTLY. A column is given a proposal only when its header is in one of the lists below, when its VALUES prove it
 * (half or more of the filled cells are personnummer, addresses or telephone numbers; every filled cell is a number, a time or a
 * date), and the page then shows the proposal with its reason, and it can be changed. A column that neither header nor values
 * place gets NO proposal: the user chooses, shown the header and what kinds of values it holds. Nothing here knows what
 * Skola24 calls its columns (no field-level description of its files is public); the lists are words a school uses, in
 * Swedish and English, and are not complete: a column they miss is asked about, which is the safe direction.
 *
 * Three treatments exist: keep the cells (anything personnummer-, address- or telephone-shaped in them is still replaced), replace
 * every cell with a marker of a kind, or clear the cells and keep the column and its header.
 */

import { findPersonalData } from "@/lib/pseudonym-detect";
import { isPersonalNumberHeader, hasPersonalNumber } from "@/lib/personal-number";
import type { MarkerKind } from "@/lib/pseudonym-markers";

export type Treatment = { kind: "keep" } | { kind: "clear" } | { kind: "mark"; marker: MarkerKind };

export const KEEP: Treatment = { kind: "keep" };
export const CLEAR: Treatment = { kind: "clear" };
export const mark = (marker: MarkerKind): Treatment => ({ kind: "mark", marker });

/** What a header says its column holds. */
export type HeaderGroup = "pnr" | "epost" | "tel" | "sign" | "fornamn" | "efternamn" | "namn" | "text" | "structure";

/** How a proposal was reached. */
export type ProposalReason = "header" | "content" | "values";

export interface Proposal {
  treatment: Treatment;
  reason: ProposalReason;
  /** The group the header was in, the kind the values were, or what the values were ("numbers", "empty"). */
  detail: string;
}

/** A header as it is compared: lower case, the letters and digits only, no diacritics (the algorithm of normalizeHeader in lib/csv-export.ts, kept here so the page does not carry that module). */
export function foldHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

const has = (key: string, words: readonly string[]): boolean => words.some((word) => key.includes(word));

const EPOST_WORDS = ["epost", "email", "mejl", "mailadress"] as const;
const TEL_WORDS = ["telefon", "mobil", "phone", "mobile"] as const;
const SIGN_WORDS = ["signatur", "signature"] as const;
const FORNAMN_WORDS = ["fornamn", "tilltalsnamn", "firstname", "givenname", "forename"] as const;
const EFTERNAMN_WORDS = ["efternamn", "slaktnamn", "lastname", "surname", "familyname", "familjenamn"] as const;
const TEXT_WORDS = [
  "fodelse",
  "fodd",
  "birth",
  "adress",
  "address",
  "postnummer",
  "postnr",
  "postort",
  "anteckning",
  "kommentar",
  "notering",
  "fritext",
  "remark",
  "comment",
  "modersmal",
  "hemsprak",
  "medborgarskap",
  "nationalitet",
  "sekretess",
  "skyddad",
  "diagnos",
] as const;
const TEXT_EXACT = new Set(["ort", "stad", "city", "info", "information", "beskrivning", "note", "notes", "text", "anm", "anmarkning"]);

const EXACT: Readonly<Record<"epost" | "tel" | "sign" | "namn" | "structure", ReadonlySet<string>>> = {
  epost: new Set(["mail", "mailadress"]),
  tel: new Set(["tel", "telnr", "tfn", "cell"]),
  sign: new Set(["sign", "sig", "initialer", "initials"]),
  namn: new Set([
    "namn", "name", "fullstandigtnamn", "fullname", "larare", "teacher", "elev", "student", "pupil", "vardnadshavare", "guardian",
    "foralder", "parent", "kontaktperson", "kontakt", "contact", "mentor", "handledare", "personal", "anstalld", "employee", "person",
    "vikarie", "substitute", "klasslarare", "klassforestandare", "ansvarig", "forestandare",
  ]),
  structure: new Set([
    "dag", "veckodag", "weekday", "day", "start", "starttid", "slut", "sluttid", "tid", "fran", "till", "from", "to", "period", "vecka",
    "veckor", "week", "weeks", "lektion", "lektionslangd", "langd", "minuter", "antal", "antalelever", "timmar", "tim", "amne", "amnen",
    "amneskod", "kurs", "kurskod", "subject", "klass", "klasser", "class", "grupp", "grupper", "group", "sal", "salar", "lokal", "lokaler",
    "room", "skola", "skolenhet", "enhet", "termin", "lasar", "ar", "year", "block", "rotation", "skolform", "arskurs", "kod", "id",
  ]),
};

/** A "…namn" that is the name of a thing and not of a person. */
const THING_NAME = /^(amnes|klass|grupp|sal|rums|lokal|skol|kurs|period|termins|lasars|veckodags|dag|enhets|schema|fil|tabell|block|rotations)(namn|name)$/;

/** The group a header is in, or null for a header the lists do not know. The order is the safe one: what says "person" is tried before what says "structure". */
export function headerGroup(header: string): HeaderGroup | null {
  const key = foldHeader(header);
  if (key === "") return null;
  if (isPersonalNumberHeader(key) || hasPersonalNumber(header)) return "pnr";
  if (has(key, EPOST_WORDS) || EXACT.epost.has(key)) return "epost";
  if (has(key, TEL_WORDS) || EXACT.tel.has(key)) return "tel";
  if (has(key, SIGN_WORDS) || EXACT.sign.has(key)) return "sign";
  if (has(key, FORNAMN_WORDS)) return "fornamn";
  if (has(key, EFTERNAMN_WORDS)) return "efternamn";
  if (has(key, TEXT_WORDS) || TEXT_EXACT.has(key)) return "text";
  if (THING_NAME.test(key)) return "structure";
  if (EXACT.namn.has(key) || key.endsWith("namn") || key.endsWith("name")) return "namn";
  if (EXACT.structure.has(key)) return "structure";
  return null;
}

const GROUP_TREATMENT: Readonly<Record<HeaderGroup, Treatment>> = {
  pnr: mark("pnr"),
  epost: mark("epost"),
  tel: mark("tel"),
  sign: mark("sign"),
  fornamn: mark("fornamn"),
  efternamn: mark("efternamn"),
  namn: mark("namn"),
  text: mark("text"),
  structure: KEEP,
};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** What a single value is. `code` is a short token with a digit or in capitals (7A, MA, ANSV); `word` is one token of letters. */
export type ValueShape = "number" | "time" | "date" | "code" | "word" | "text";

const NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;
const TIME = /^\d{1,2}[:.]\d{2}(?::\d{2})?$/;
const DATE = /^(?:\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/;

export function shapeOf(cell: string): ValueShape {
  const value = cell.trim();
  if (NUMBER.test(value)) return "number";
  if (TIME.test(value)) return "time";
  if (DATE.test(value)) return "date";
  if (value.length <= 12 && !/\s/.test(value) && (/\d/.test(value) || (value === value.toUpperCase() && /\p{L}/u.test(value)))) return "code";
  if (/^[\p{L}\p{M}'’-]+$/u.test(value)) return "word";
  return "text";
}

export interface ColumnStats {
  /** Cells with something in them. */
  filled: number;
  /** Different values, counted to a thousand and no further. */
  distinct: number;
  shapes: Record<ValueShape, number>;
  /** Whole numbers of seven digits or more, counted among the `number` shapes: a telephone number whose leading 0 a spreadsheet dropped (701234567), a personnummer of someone born after 1999 in the same way. */
  longNumbers: number;
  /** Days from the first to the last of the dates in the column (YYYY-MM-DD, or D/M/YYYY with a slash, a full stop or a hyphen), or null when fewer than two are. A column of lesson dates spans a term; one of birth dates, years. */
  dateSpanDays: number | null;
  /** The first and the last of those dates as UTC times, or null when there is none. */
  firstDay: number | null;
  lastDay: number | null;
  /** Cells that are a date written without separators and nothing else: YYMMDD or YYYYMMDD, with a month of 01-12 and a day of 01-31 (and 19 or 20 for a century). */
  compactDates: number;
  /** Cells that hold a personnummer or samordningsnummer, an address, a telephone number. */
  withPersonalNumber: number;
  withAddress: number;
  withTelephone: number;
  /** The first different values, cut at 40 characters: shown on the screen of the person deciding, never put in a file or a report. */
  samples: string[];
}

const DISTINCT_CAP = 1000;
const SAMPLES = 5;
const SAMPLE_LENGTH = 40;

export function columnStats(cells: readonly string[]): ColumnStats {
  const stats: ColumnStats = {
    filled: 0,
    distinct: 0,
    shapes: { number: 0, time: 0, date: 0, code: 0, word: 0, text: 0 },
    longNumbers: 0,
    dateSpanDays: null,
    firstDay: null,
    lastDay: null,
    compactDates: 0,
    withPersonalNumber: 0,
    withAddress: 0,
    withTelephone: 0,
    samples: [],
  };
  const seen = new Set<string>();
  let first = Infinity;
  let last = -Infinity;
  let dates = 0;
  for (const raw of cells) {
    const cell = raw.trim();
    if (cell === "") continue;
    stats.filled += 1;
    const shape = shapeOf(cell);
    stats.shapes[shape] += 1;
    if (shape === "number" && /^[+-]?\d{7,}$/.test(cell)) stats.longNumbers += 1;
    const day = dayOf(cell);
    if (day !== null) {
      dates += 1;
      if (day < first) first = day;
      if (day > last) last = day;
    }
    if (shape === "number" && isCompactDate(cell)) stats.compactDates += 1;
    const found = findPersonalData(cell);
    // A TF number counts as one: a column of Skola24's ID numbers under the header Id or Kod is a column of personnummer, and is proposed as one.
    if (found.some((f) => f.kind === "pnr" || f.kind === "sam" || f.kind === "tf")) stats.withPersonalNumber += 1;
    if (found.some((f) => f.kind === "epost")) stats.withAddress += 1;
    if (found.some((f) => f.kind === "tel")) stats.withTelephone += 1;
    if (seen.size < DISTINCT_CAP && !seen.has(cell)) {
      seen.add(cell);
      if (stats.samples.length < SAMPLES) stats.samples.push(cell.length > SAMPLE_LENGTH ? `${cell.slice(0, SAMPLE_LENGTH)}…` : cell);
    }
  }
  stats.distinct = seen.size;
  if (dates >= 1) {
    stats.firstDay = first;
    stats.lastDay = last;
  }
  if (dates >= 2) stats.dateSpanDays = Math.round((last - first) / 86_400_000);
  return stats;
}

/**
 * The day of a cell written YYYY-MM-DD (a time after it is allowed), or D/M/YYYY, D.M.YYYY or D-M-YYYY (the way a spreadsheet in Swedish or British settings writes a date, and a file from Skola24's Tabell), as a UTC
 * time, or null. A year of two digits is not read: 14.02.13 is as much a time of day as a date.
 */
function dayOf(cell: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(cell);
  const dmy = iso === null ? /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(cell) : null;
  if (iso === null && dmy === null) return null;
  const [year, month, day] = iso !== null ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [Number(dmy![3]), Number(dmy![2]), Number(dmy![1])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day);
}

/** A date written with no separators: 130214 (YYMMDD) or 20130214 (YYYYMMDD with a century of 19 or 20), a month of 01-12 and a day of 01-31. A spreadsheet keeps a birth date in this form as a number. */
function isCompactDate(cell: string): boolean {
  const match = /^(?:(?:19|20)\d{2}|\d{2})(\d{2})(\d{2})$/.exec(cell);
  if (match === null || !(cell.length === 6 || cell.length === 8)) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** A column of dates that spans more than a year is asked about: lesson dates span a term, birth dates span years, and nothing but the column's own header tells them apart. */
export const DATE_SPAN_ASKED = 366;

/**
 * A date this long before today is not a lesson's (X1b, the review of #377 L-5 and #398 L-5): a class is born in one year, so six birth dates from 2013 span less than a year and were kept without
 * a question, under a header the lists do not know (F-datum, Datum). A column of dates is a column of lesson dates in the school year of the file, or it is of people, and the clock tells which: the file
 * is looked at on the day it is pseudonymised, and three years is further back than a timetable goes and nearer than the youngest pupil's birth.
 */
export const DATE_OLD_DAYS = 3 * 366;

/** Why a column of dates is asked about and not kept: it spans more than a year, a date in it is older than three years, or most of its cells are a date written as six or eight digits. */
export type DatesAsked = "span" | "old" | "compact";

/** At least this share of a column's filled cells (four in five) must read as a date for a column of numbers to be taken for one: a code that happens to read as YYMMDD is about one in thirty. */
const COMPACT_SHARE = 0.8;

/** Whether a column's dates are a reason to ask, and which: `today` is a UTC time, the day the file is looked at. */
export function datesAsked(stats: ColumnStats, today: number): DatesAsked | null {
  if (stats.compactDates > 0 && stats.compactDates >= stats.filled * COMPACT_SHARE) return "compact";
  if (stats.dateSpanDays !== null && stats.dateSpanDays > DATE_SPAN_ASKED) return "span";
  if (stats.firstDay !== null && today - stats.firstDay > DATE_OLD_DAYS * 86_400_000) return "old";
  return null;
}

/**
 * True when a row that was taken for the header has cells that a header does not have: a number, a time or a date. A file with no header row begins with a
 * record ("Mån;08:10;Anna Exempel;7A"), and the page says so and asks, because only a person can tell the two apart.
 */
export function headerLooksLikeData(cells: readonly string[]): boolean {
  return cells.some((cell) => {
    const shape = cell.trim() === "" ? null : shapeOf(cell);
    return shape === "number" || shape === "time" || shape === "date";
  });
}

/** The kind a column's values prove it to be: at least one cell, and at least half of the filled cells. */
function contentKind(stats: ColumnStats): "pnr" | "epost" | "tel" | null {
  const half = (n: number): boolean => n >= 1 && n * 2 >= stats.filled;
  if (half(stats.withPersonalNumber)) return "pnr";
  if (half(stats.withAddress)) return "epost";
  if (half(stats.withTelephone)) return "tel";
  return null;
}

/**
 * The proposal for a column, or null when the user must choose. Values that prove a column holds personnummer, addresses or
 * telephone numbers come first (a column called Klass full of personnummer is a column of personnummer), then the header, then
 * "nothing but numbers, times and dates".
 */
export function proposalFor(header: string, stats: ColumnStats, today: number = Date.now()): Proposal | null {
  const content = contentKind(stats);
  if (content !== null) return { treatment: mark(content), reason: "content", detail: content };
  const group = headerGroup(header);
  if (group !== null) return { treatment: GROUP_TREATMENT[group], reason: "header", detail: group };
  if (stats.filled === 0) return { treatment: KEEP, reason: "values", detail: "empty" };
  const plain = stats.shapes.number + stats.shapes.time + stats.shapes.date;
  // A column of numbers is kept without asking only when none of them is long enough to be somebody's: Excel stores 0701234567 as the number 701234567,
  // and a column of those under a header the lists do not know (Ring, Kontakt2) was kept, whole, with no choice for the user to make.
  // Nor are dates that span more than a year, or reach back more than three years, or are written as six or eight digits: birth dates look like lesson dates, and the user is asked what a column of them is.
  const datesAreAsked = datesAsked(stats, today) !== null;
  if (plain === stats.filled && stats.longNumbers === 0 && !datesAreAsked && stats.withPersonalNumber + stats.withAddress + stats.withTelephone === 0) {
    return { treatment: KEEP, reason: "values", detail: "numbers" };
  }
  return null;
}
