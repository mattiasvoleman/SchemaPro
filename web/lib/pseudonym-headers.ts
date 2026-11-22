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
    withPersonalNumber: 0,
    withAddress: 0,
    withTelephone: 0,
    samples: [],
  };
  const seen = new Set<string>();
  for (const raw of cells) {
    const cell = raw.trim();
    if (cell === "") continue;
    stats.filled += 1;
    const shape = shapeOf(cell);
    stats.shapes[shape] += 1;
    if (shape === "number" && /^[+-]?\d{7,}$/.test(cell)) stats.longNumbers += 1;
    const found = findPersonalData(cell);
    if (found.some((f) => f.kind === "pnr" || f.kind === "sam")) stats.withPersonalNumber += 1;
    if (found.some((f) => f.kind === "epost")) stats.withAddress += 1;
    if (found.some((f) => f.kind === "tel")) stats.withTelephone += 1;
    if (seen.size < DISTINCT_CAP && !seen.has(cell)) {
      seen.add(cell);
      if (stats.samples.length < SAMPLES) stats.samples.push(cell.length > SAMPLE_LENGTH ? `${cell.slice(0, SAMPLE_LENGTH)}…` : cell);
    }
  }
  stats.distinct = seen.size;
  return stats;
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
export function proposalFor(header: string, stats: ColumnStats): Proposal | null {
  const content = contentKind(stats);
  if (content !== null) return { treatment: mark(content), reason: "content", detail: content };
  const group = headerGroup(header);
  if (group !== null) return { treatment: GROUP_TREATMENT[group], reason: "header", detail: group };
  if (stats.filled === 0) return { treatment: KEEP, reason: "values", detail: "empty" };
  const plain = stats.shapes.number + stats.shapes.time + stats.shapes.date;
  // A column of numbers is kept without asking only when none of them is long enough to be somebody's: Excel stores 0701234567 as the number 701234567,
  // and a column of those under a header the lists do not know (Ring, Kontakt2) was kept, whole, with no choice for the user to make.
  if (plain === stats.filled && stats.longNumbers === 0 && stats.withPersonalNumber + stats.withAddress + stats.withTelephone === 0) {
    return { treatment: KEEP, reason: "values", detail: "numbers" };
  }
  return null;
}
