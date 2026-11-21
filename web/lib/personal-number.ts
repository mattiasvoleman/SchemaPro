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
 */

/** The marker a redacted number is replaced with. */
export const REDACTED = "[personnummer]";

/** A space between two digits is allowed anywhere in a number; one at most, so the cost stays linear. */
const SP = " ?";
const MONTH = `(?:0${SP}[1-9]|1${SP}[0-2])`;
const DAY = `(?:0${SP}[1-9]|[12]${SP}\\d|3${SP}[01]|6${SP}[1-9]|[78]${SP}\\d|9${SP}[01])`;
const COMPACT = `(?<!\\d)(?:\\d${SP}\\d${SP})?\\d${SP}\\d${SP}${MONTH}${SP}${DAY}[ +\\-]{0,8}\\d${SP}\\d${SP}\\d${SP}\\d(?!\\d)`;
const ISO = `(?<!\\d)(?:\\d{2}|\\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]|6[1-9]|[78]\\d|9[01])[- ]\\d{4}(?!\\d)(?!-\\d{2}-\\d{2})`;
const SHAPE = new RegExp(`${COMPACT}|${ISO}`);
const SHAPE_ALL = new RegExp(SHAPE.source, "g");

/** The text as the shape is looked for in it: the same length, character for character. */
function fold(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[\s­​-‏⁠﻿]/g, " ")
    .replace(/[‐-―−﹘﹣－./_]/g, "-");
}

/** True when the text holds a personnummer or a samordningsnummer, whole or as a part, in any of the spellings above. */
export function hasPersonalNumber(text: string | null | undefined): boolean {
  if (!text || text.length < 10) return false;
  return SHAPE.test(fold(text));
}

/** The text with every personnummer-shaped part replaced by REDACTED, whatever its spelling. */
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

/** A personnummer-shaped part of a text: where it stands, its digits and the text as it was folded (for the spelling). */
export interface PersonalNumberMatch {
  /** Index of the first character in the text it was found in. */
  start: number;
  /** Index after the last character. */
  end: number;
  /** The digits and nothing else: ten, or twelve with a century. */
  digits: string;
  /** The matched text with the spellings folded as above (one character to one): what `digits` was taken from. */
  folded: string;
}

/**
 * Every personnummer-shaped part of the text, where redactPersonalNumbers replaces them: the same expressions and the same
 * folding, so that the two agree on what a number is (personal-number.test.ts replays the shared cases against both).
 * Added for the pseudonymiser (X1), which has to know WHICH number it replaced, to give the same person the same marker
 * however it was written. Nothing here changes what the other functions do.
 */
export function findPersonalNumbers(text: string): PersonalNumberMatch[] {
  if (text.length < 10) return [];
  const found: PersonalNumberMatch[] = [];
  for (const match of fold(text).matchAll(SHAPE_ALL)) {
    found.push({ start: match.index, end: match.index + match[0].length, digits: match[0].replace(/\D/g, ""), folded: match[0] });
  }
  return found;
}

/** Headers of a personal-number column, as the gateway's reader knows them: exact for the short forms, contained for the long. */
const PERSONAL_EXACT = new Set(["pnr", "personnr", "ssn"]);
const PERSONAL_CONTAINS = ["personnummer", "samordningsnummer", "socialsecuritynumber", "civicnumber", "personalnumber"];

/** `normalized` is a header after normalizeHeader (lib/csv-export.ts): lower case, letters and digits only. */
export function isPersonalNumberHeader(normalized: string): boolean {
  return PERSONAL_EXACT.has(normalized) || PERSONAL_CONTAINS.some((word) => normalized.includes(word));
}
