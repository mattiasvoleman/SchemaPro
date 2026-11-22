/**
 * The shape of a personnummer, in the browser (Kolumnmappning, X2).
 *
 * A COPY of src/schedule-exchange/file-safety.ts's `fold`, expressions and `hasPersonalNumber`, because the mapping of a
 * file's columns happens here, before anything is sent: a column that looks like a personnummer is dropped in the
 * browser and never leaves it (the user's decision of 2026-11-05: Rastra reads, stores and echoes none). The gateway
 * keeps its own doors for the files that go to it unmapped (Excel, Untis, aSc), and the two must agree on what a number
 * is. They are held equal by a shared list of cases, src/schedule-exchange/__fixtures__/personal-number-cases.json,
 * which the gateway's spec (personal-number-cases.spec.ts) and web/lib/personal-number.test.ts both replay.
 *
 * THE SHAPE (CHOICE, as the gateway's). Ten digits YYMMDDNNNN or twelve YYYYMMDDNNNN, with an optional '-' or '+' before the
 * last four, a month 01-12 and a day 01-31 (61-91 for a samordningsnummer). The check digit is NOT tested: a number typed
 * wrong is still a number someone meant as a person's. It errs towards refusing: ten digits that read as a date and four
 * more (a phone number 0701234567) are taken for a personnummer. Spellings are folded first, one character to one, so a
 * match in the folded text is the same place in the text it came from: fullwidth digits, every space-like and invisible
 * character, and every dash-like character, '.', '/' and '_'. A date followed by four digits is a number only when those
 * four do not begin another date, so a period ("2026-08-17-2026-12-18") is not one.
 *
 * THE TF NUMBER (CHOICE, X3, 2026-11-22). Skola24's own files put a TF number where a personnummer goes: eight digits, "TF" and two
 * digits (ÅÅÅÅMMDDTFnn), in the ID columns of all seven course files it publishes (read for their shape on 2026-11-22). It is refused like a
 * personnummer; it has not the shape of one. ONLY ONE FORM IS KNOWN (DOKUMENTERAT): eight digits, TF in upper case, two digits, nothing between.
 * Added, and our reading (TOLKAT): TF in any case, and one blank or hyphen between the date and TF (after the fold also '.', '/', '_' and the
 * dash-like characters). NOT counted, because no file has shown them: a blank inside the date or between TF and the digits, a date of six digits,
 * any other number of digits, a hyphen after TF, and any other temporary or reserve number. src/schedule-exchange/file-safety.ts says the same,
 * and the shared cases say each of these.
 */

/** The marker a redacted number is replaced with. */
export const REDACTED = "[personnummer]";

/** A space between two digits is allowed anywhere in a number; one at most, so the cost stays linear. */
const SP = " ?";
const MONTH = `(?:0${SP}[1-9]|1${SP}[0-2])`;
const DAY = `(?:0${SP}[1-9]|[12]${SP}\\d|3${SP}[01]|6${SP}[1-9]|[78]${SP}\\d|9${SP}[01])`;
const COMPACT = `(?<!\\d)(?:\\d${SP}\\d${SP})?\\d${SP}\\d${SP}${MONTH}${SP}${DAY}[ +\\-]{0,8}\\d${SP}\\d${SP}\\d${SP}\\d(?!\\d)`;
const ISO = `(?<!\\d)(?:\\d{2}|\\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]|6[1-9]|[78]\\d|9[01])[- ]\\d{4}(?!\\d)(?!-\\d{2}-\\d{2})`;
/** The TF number: eight digits, one blank or hyphen at most, TF in any case, two digits. Not preceded and not followed by a digit. */
const TF = `(?<!\\d)\\d{8}[ \\-]?[Tt][Ff]\\d{2}(?!\\d)`;
const SHAPE = new RegExp(`${COMPACT}|${ISO}|(?<tf>${TF})`);
const SHAPE_ALL = new RegExp(SHAPE.source, "g");

/** The text as the shape is looked for in it: the same length, character for character. */
function fold(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[\s­​-‏⁠﻿]/g, " ")
    .replace(/[‐-―−﹘﹣－./_]/g, "-");
}

/** True when the text holds a personnummer, a samordningsnummer or a TF number, whole or as a part, in any of the spellings above. */
export function hasPersonalNumber(text: string | null | undefined): boolean {
  if (!text || text.length < 10) return false;
  return SHAPE.test(fold(text));
}

/** The text with every personnummer-, samordningsnummer- or TF-shaped part replaced by REDACTED, whatever its spelling. */
export function redactPersonalNumbers(text: string): string {
  if (text.length < 10) return text;
  const folded = fold(text);
  let out = "";
  let from = 0;
  for (const found of folded.matchAll(SHAPE_ALL)) {
    out += text.slice(from, found.index) + REDACTED;
    from = found.index + found[0].length;
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * What kind of number a part is: a personnummer, a samordningsnummer (the day plus 60, so 61-91), or a TF number (ÅÅÅÅMMDDTFnn, Skola24's).
 * A TF number has no check digit and is no person's date and serial: nothing that reads a personnummer's digits may read it.
 */
export type PersonalNumberKind = "personnummer" | "samordning" | "tf";

/** A personnummer-, samordningsnummer- or TF-shaped part of a text: where it stands, its digits and the text as it was folded (for the spelling). */
export interface PersonalNumberMatch {
  /** Index of the first character in the text it was found in. */
  start: number;
  /** Index after the last character. */
  end: number;
  /** The digits and nothing else: for a personnummer or a samordningsnummer ten, or twelve with a century; for a TF number the ten (the eight of the date and the two after TF). */
  digits: string;
  /** The matched text with the spellings folded as above (one character to one): what `digits` was taken from. */
  folded: string;
  /** Which kind of number it is. */
  kind: PersonalNumberKind;
  /** The value's identity: two spellings of one number have one key. A personnummer or samordningsnummer: its ten last digits. A TF number: "ÅÅÅÅMMDDTFNN" in upper case. */
  key: string;
}

/**
 * Every personnummer-shaped part of the text, where redactPersonalNumbers replaces them: the same expressions and the same
 * folding, so that the two agree on what a number is (personal-number.test.ts replays the shared cases against both).
 * Added for the pseudonymiser (X1), which has to know WHICH number it replaced, to give the same person the same marker
 * however it was written. The parts come in the order of the text and do not overlap. Nothing here changes what the other functions do.
 */
export function findPersonalNumbers(text: string): PersonalNumberMatch[] {
  if (text.length < 10) return [];
  const found: PersonalNumberMatch[] = [];
  for (const match of fold(text).matchAll(SHAPE_ALL)) {
    const digits = match[0].replace(/\D/g, "");
    const base = { start: match.index, end: match.index + match[0].length, digits, folded: match[0] };
    if (match.groups?.["tf"] !== undefined) {
      // Eight digits of a date and two after TF: the key spells it the way Skola24 does, so ÅÅÅÅMMDD-TF01, 19000101tf01 and 19000101TF01 are one number.
      found.push({ ...base, kind: "tf", key: `${digits.slice(0, 8)}TF${digits.slice(8)}` });
      continue;
    }
    const ten = digits.slice(-10);
    found.push({ ...base, kind: Number(ten.slice(4, 6)) >= 61 ? "samordning" : "personnummer", key: ten });
  }
  return found;
}

/** Headers of a personal-number column, as the gateway's reader knows them: exact for the short forms, contained for the long. */
const PERSONAL_EXACT = new Set(["pnr", "personnr", "ssn", "tfnr"]);
const PERSONAL_CONTAINS = ["personnummer", "samordningsnummer", "socialsecuritynumber", "civicnumber", "personalnumber", "tfnummer"];

/** `normalized` is a header after normalizeHeader (lib/csv-export.ts): lower case, letters and digits only. */
export function isPersonalNumberHeader(normalized: string): boolean {
  return PERSONAL_EXACT.has(normalized) || PERSONAL_CONTAINS.some((word) => normalized.includes(word));
}
