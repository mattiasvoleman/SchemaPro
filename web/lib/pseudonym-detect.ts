/**
 * What in a text is personal because of how it LOOKS (Pseudonymiseraren, X1): personnummer and samordningsnummer, e-mail
 * addresses and telephone numbers. Pure functions: no React, no network, no clock, nothing stored.
 *
 * CONSERVATIVE MEANS ERRING TOWARDS REMOVING. The shape of a personnummer is lib/personal-number.ts's, which the gateway's
 * reader holds equal by one list of cases, and which does NOT test the check digit ("a number typed wrong is still a number
 * someone meant"). The check digit is tested HERE, but only to say how a number is counted: a number whose digit does not hold is
 * still replaced, and the report says so ("shape only"), so a school sees that a column of ten-digit ids that happen to read as
 * dates was taken for personnummer, and not that nothing was found.
 *
 * WHAT THIS CANNOT JUDGE. A name in running text; an address written in words ("anna punkt svensson snabel-a skola punkt se"); a
 * number split over two cells ("800101" and "1234"); digits in another script than ASCII and the full-width forms the shape
 * folds. Those are said in the page, the report and the manual, not hidden.
 *
 * ONE VALUE, ONE KEY. Two spellings of one number or address have one `key`, so that the same person is the same marker
 * however a file wrote them (see pseudonym-markers.ts): the ten last digits of a personnummer, a telephone number's digits
 * with +46 and 0046 as 0, an address in lower case.
 */

import { findPersonalNumbers, foldForShape } from "@/lib/personal-number";

export type FindingKind = "pnr" | "sam" | "tf" | "epost" | "tel";

export interface Finding {
  kind: FindingKind;
  /** Index of the first character, and after the last, in the text searched. */
  start: number;
  end: number;
  /** The value's identity: the same value written two ways has one key. Never shown. */
  key: string;
  /** pnr and sam only: whether the check digit (Luhn over the ten last digits) holds. A TF number has none. */
  checkDigit?: boolean;
  /** pnr, sam and tf only: how it was written, as a pattern with no digits of the value in it. */
  spelling?: string;
}

/** The Luhn check of ten digits, as the check digit of a personnummer or a samordningsnummer is made. */
export function luhnHolds(ten: string): boolean {
  if (!/^\d{10}$/.test(ten)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    let digit = ten.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** True for the day of a samordningsnummer: 61-91 (the day plus 60) in the ten last digits. */
const isCoordinationDay = (ten: string): boolean => Number(ten.slice(4, 6)) >= 61;

/**
 * How a TF number was written, as a pattern: the separator before TF, and the two letters as they stood (TF, tf or Tf). It holds no digit of the
 * value. (lib/personal-number.ts: these are the only things the shape lets differ.)
 */
function tfSpellingOf(folded: string): string {
  const parts = /^\d{4}([ -]*)\d{2}([ -]*)\d{2}([ +-]*)([Tt][ -]?[Ff])([ -]*)\d{2}$/.exec(folded);
  if (parts === null) return "ÅÅÅÅMMDDTFNN";
  // The date's digits are told by their place and the separators and letters stand as they were written: nothing of the value is left in it.
  return `ÅÅÅÅ${parts[1]}MM${parts[2]}DD${parts[3]}${parts[4]}${parts[5]}NN`;
}

/**
 * A TF number in the spellings the shared shape does NOT know (lib/personal-number.ts counts one form as documented and a few as our reading): blanks and hyphens
 * between the parts of the date and around TF, a plus before it, a date written ÅÅÅÅ-MM-DD, a line break between the date and TF (two blanks after the fold), two
 * letters with a blank between them, a hyphen or a blank after TF. THE DOOR STAYS STRICT AND THIS SEARCH IS WIDE, because the costs differ: a form the door does not
 * know is a cell read as text (a refusal that is missing), a form this search does not know is a number left in a file that is sent on, and the check on the
 * finished file looks with the same search and cannot see it either (the review of #383, L-4). What is asked of a spelling is what the door asks: eight digits
 * of a date, TF in either case, two digits, and no digit before or after. A date of six digits is NOT taken (no file has shown one), nor a code like 7ATF12,
 * TF2026, Block TF-12 or Sal TF12345678; "20261121 TF 15", a date that a school wrote and two digits, is taken, and costs a marker.
 */
const LOOSE_TF = /(?<!\d)\d{4}[ -]{0,2}\d{2}[ -]{0,2}\d{2}[ +-]{0,4}[Tt][ -]?[Ff][ -]{0,4}\d{2}(?!\d)/g;

/** Every TF number in the text in the wide spellings above, with the key the shared shape gives the same number (ÅÅÅÅMMDDTFNN). */
function findLooseTfNumbers(text: string): Finding[] {
  if (text.length < 12) return [];
  const folded = foldForShape(text);
  // Nearly every cell has no TF in it: this is the cheap way out, before the expression is tried at each place of a long cell.
  if (!/[Tt][ -]?[Ff]/.test(folded)) return [];
  const found: Finding[] = [];
  for (const match of folded.matchAll(LOOSE_TF)) {
    const digits = match[0].replace(/\D/g, "");
    found.push({ kind: "tf", start: match.index, end: match.index + match[0].length, key: `${digits.slice(0, 8)}TF${digits.slice(8)}`, spelling: tfSpellingOf(match[0]) });
  }
  return found;
}

/**
 * How a personnummer was written, as a pattern: the century or not, the separator, and whether blanks stood between digits.
 * It holds no digit of the value, so it may be counted and reported.
 */
function spellingOf(folded: string, digits: string): string {
  const iso = /^\d{2,4}-\d{2}-\d{2}([- ])\d{4}$/.exec(folded);
  if (iso !== null) return `${digits.length === 12 ? "ÅÅÅÅ" : "ÅÅ"}-MM-DD${iso[1] === " " ? " " : "-"}NNNN`;
  const blanks = /\d {1,2}\d/.test(folded.replace(/[ +-]{1,8}\d{4}$/, ""));
  const separator = /([ +-]{1,8})\d{4}$/.exec(folded)?.[1] ?? "";
  const sign = separator.includes("+") ? "+" : separator.includes("-") ? "-" : separator.length > 0 ? " " : "";
  return `${digits.length === 12 ? "ÅÅÅÅ" : "ÅÅ"}MMDD${sign}NNNN${blanks ? " (med blanksteg i siffrorna)" : ""}`;
}

// ---------------------------------------------------------------------------
// The spellings a search looks through
// ---------------------------------------------------------------------------

/**
 * The text as telephone numbers and addresses are looked for in it: the same length, character for character, so that a finding's place is the place
 * in the text it came from. A copy of what personal-number.ts folds before it looks for a personnummer, and the same for the same reason: a number
 * copied from a web page or a Word file stands with a no-break space (U+00A0) or a narrow one (U+202F) between its groups, an en dash or a
 * non-breaking hyphen for the hyphen, and a file from a Japanese keyboard in full-width digits. Without it the shape of a personnummer was found in
 * "070\u00a0123\u00a045\u00a067" and the telephone number "+46\u00a070\u00a0123\u00a045\u00a067" was left standing. A full stop, a slash and an underscore are
 * NOT made hyphens here (personal-number.ts does): "0.1234567" and "07.08.2026" are told from a number by the full stop.
 */
function foldSpellings(text: string): string {
  return text
    .replace(/[\uff10-\uff19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[\s\u00ad\u200b-\u200f\u2060\ufeff]/g, " ")
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(/[\uff20\ufe6b]/g, "@");
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/** A character that ends an address: blanks, a second @, and the punctuation that surrounds one in running text. */
const ADDRESS_STOP = /[\s@;,<>()"'[\]{}|\\]/;

/**
 * Every `text@text` with no blank in it. BROAD ON PURPOSE: "anna@skola" with no top domain is taken too, because it is
 * what a person typed as an address, and what is taken is a part of a cell, never a whole cell by guess. Found by walking out
 * from each @, so that a cell of a million characters with no @ costs one scan and not a quadratic number of attempts.
 */
function findAddresses(text: string): { start: number; end: number; key: string }[] {
  const found: { start: number; end: number; key: string }[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && !ADDRESS_STOP.test(text[start - 1]!)) start -= 1;
    let end = at + 1;
    while (end < text.length && !ADDRESS_STOP.test(text[end]!)) end += 1;
    // A full stop or a colon that ends a sentence is not the address's.
    while (end > at + 1 && /[.:!?…\-_]/.test(text[end - 1]!)) end -= 1;
    if (start === at || end === at + 1) continue;
    const previous = found[found.length - 1];
    if (previous !== undefined && start < previous.end) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    found.push({ start, end, key: "" });
  }
  for (const part of found) part.key = text.slice(part.start, part.end).replace(/^mailto:/i, "").trim().toLowerCase();
  return found;
}

/** The reserved top domain the markers' addresses use: nothing can be delivered to it, so it is never somebody's address. */
export const MARKER_DOMAIN = "exempel.invalid";

/**
 * An address as the book writes it: epost-0001@exempel.invalid. Any number of digits, because markerText is a pure function of n and its test
 * (pseudonym-markers.test.ts) holds that no marker has a shape "whatever the number"; the prefix and the digits alone are what make it one.
 */
const MARKER_ADDRESS = new RegExp(`^epost-\\d{4,}@${MARKER_DOMAIN.replace(/\./g, "\\.")}$`, "i");

/**
 * True for an address the pseudonymiser wrote itself, and for nothing else. Any address that ENDS in @exempel.invalid used to count, so that
 * "anna.svensson@exempel.invalid" (a name in an address, on a domain that cannot be delivered to but is written by whoever typed it) went through every
 * search, and the check.
 */
export const isMarkerAddress = (address: string): boolean => MARKER_ADDRESS.test(address);

// ---------------------------------------------------------------------------
// Telephone
// ---------------------------------------------------------------------------

/**
 * Two clock times written the way Untis and some Skola24 exports write them, 0800-0845: four digits each, an hour of 00-23 and minutes of 00-59, with a
 * hyphen, a blank or a slash between. Eight digits that begin with 0 are a national telephone number's length, and every lesson of a timetable was replaced by
 * TEL-n. A Swedish number does not have two groups of four with a valid time in both: its numbers have nine or ten digits.
 */
const TIME_RANGE = /^(?:[01]\d|2[0-3])[0-5]\d[ /-]{1,2}(?:[01]\d|2[0-3])[0-5]\d$/;
const DATE_LIKE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;
/** A date wherever it stands in a text: 2026-08-17, and 17-08-2026 or 17.8.2026 with a year of four digits. */
const DATE_SPAN = /\d{4}-\d{2}-\d{2}|(?<!\d)\d{1,2}[-/.]\d{1,2}[-/.]\d{4}(?!\d)/g;

/**
 * A telephone number as the one value it is, however it was written: its digits, a national number as written (070…), +46 and 0046 as 0
 * (with a trunk 0 in brackets, +46 (0)70, counted once), any other country with a +. The marker book keys a whole cell by the same.
 */
export function normaliseTelephone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const international = value.trim().startsWith("+") || digits.startsWith("00");
  const national = international ? digits.replace(/^00/, "") : digits;
  if (!international) return national;
  if (national.startsWith("46")) {
    const rest = national.slice(2);
    return rest.startsWith("0") ? rest : `0${rest}`;
  }
  return `+${national}`;
}

/**
 * The key of a candidate that is a telephone number, or null. A number begins with 0 (the national form: 070-123 45 67,
 * 08-123 456 78) or with + or 00 (the international), has between seven and fifteen digits, and is not a date. A full stop
 * separates the groups of an international number only: "0.1234567" and "07.08.2026" are not telephone numbers.
 */
function telephoneKey(candidate: string): string | null {
  const digits = candidate.replace(/\D/g, "");
  const international = candidate.startsWith("+") || digits.startsWith("00");
  if (!international && !digits.startsWith("0")) return null;
  if (DATE_LIKE.test(candidate) || TIME_RANGE.test(candidate)) return null;
  if (!candidate.startsWith("+") && candidate.includes(".")) return null;
  const national = international ? digits.replace(/^00/, "") : digits;
  if (international ? national.length < 8 || national.length > 15 : national.length < 7 || national.length > 11) return null;
  return normaliseTelephone(candidate);
}

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";
/** What may stand between two digits of a telephone number: at most two of these, so "070-123 45 67" and "08) 123" are one number and a sentence is not. */
const SEPARATOR = new Set([" ", "-", ".", "/", "(", ")"]);

/** The most digits a telephone number may be written with, whole: +46 (0)70 123 45 67 is twelve. */
const MOST_DIGITS = 18;
/** The most groups of digits one number is written in: +46 (0)70 123 45 67 is six. A cut is never tried over more, so that a megabyte of "0 0 0 0" costs a few steps a group and not a dozen. */
const MOST_GROUPS = 10;
/** A national number has at most this many digits, an international one (+ or 00) at most this many with its 00. */
const MOST_NATIONAL = 11;
const MOST_INTERNATIONAL = 17;

/**
 * Every telephone number in a text. The digits are cut into RUNS (digit groups joined by at most two separators), and each run into numbers
 * by the cut that COVERS THE MOST DIGITS that no personnummer or address already covers, and on a tie uses the earlier start and the fewest numbers. A number that is not a number in itself ("0237 072") has to
 * give way to the one that covers more ("072-7691023"); a rule that took the longest or the first number that fits left the end of the
 * next one in the text, in three different ways, before the property tests were made to look for it. A long number with nothing next to it
 * is one number, and a run no cut makes a number of is not one.
 */
function findTelephones(original: string, existing: readonly { start: number; end: number }[]): { start: number; end: number; key: string }[] {
  // Dates are masked first, by characters of the same length: a number is never found inside "2026-08-17-2026-12-18" or "07.08.2026", and what a masked date stood next to is read as it was.
  const text = original.replace(DATE_SPAN, (date) => "#".repeat(date.length));
  const found: { start: number; end: number; key: string }[] = [];

  // The findings of other kinds, by start, with the furthest end among those up to each: "does anything cover this group" is one binary search, however many there are.
  const others = [...existing].sort((a, b) => a.start - b.start);
  const furthest: number[] = [];
  others.forEach((other, index) => furthest.push(Math.max(other.end, furthest[index - 1] ?? 0)));
  const coveredBy = (start: number, end: number): boolean => {
    let low = 0;
    let high = others.length - 1;
    let last = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (others[middle]!.start < end) {
        last = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return last >= 0 && furthest[last]! > start;
  };

  let i = 0;
  while (i < text.length) {
    const plus = text[i] === "+" && isDigit(text[i + 1]);
    if (!(isDigit(text[i]) || plus) || (i > 0 && isDigit(text[i - 1]))) {
      i += 1;
      continue;
    }
    // The run from here: its digit groups, each with where it stands and how many digits.
    const groups: { start: number; end: number; digits: number }[] = [];
    let at = i;
    for (;;) {
      let end = plus && groups.length === 0 ? at + 1 : at;
      while (isDigit(text[end])) end += 1;
      groups.push({ start: at, end, digits: end - (plus && groups.length === 0 ? at + 1 : at) });
      let next = end;
      while (next < text.length && next - end < 2 && SEPARATOR.has(text[next]!)) next += 1;
      if (next === end || !isDigit(text[next])) break;
      at = next;
    }
    i = groups[groups.length - 1]!.end;

    // A group a finding of another kind stands on is covered already: a number is worth the digits it adds.
    const covered = groups.map((group) => coveredBy(group.start, group.end));
    // best[k]: the best cut of the groups from k on, as a score (new digits covered, less one for each number); take[k]: how it starts.
    const best = new Array<number>(groups.length + 1).fill(0);
    const take = new Array<{ last: number; key: string } | null>(groups.length).fill(null);
    for (let k = groups.length - 1; k >= 0; k -= 1) {
      best[k] = best[k + 1]!;
      const first = text[groups[k]!.start];
      if (first !== "0" && first !== "+") continue;
      // Written +… or 00…: the digits of its first two groups begin with 00 (the second group's, when the first is a single 0).
      const international = first === "+" || (groups[k]!.digits >= 2 ? text.startsWith("00", groups[k]!.start) : text[groups[k + 1]?.start ?? -1] === "0");
      const most = international ? MOST_INTERNATIONAL : MOST_NATIONAL;
      let digits = 0;
      let added = 0;
      for (let last = k; last < groups.length && last < k + MOST_GROUPS; last += 1) {
        digits += groups[last]!.digits;
        if (!covered[last]) added += groups[last]!.digits;
        if (digits > Math.min(MOST_DIGITS, most)) break;
        if (digits < 7) continue;
        const key = telephoneKey(text.slice(groups[k]!.start, groups[last]!.end));
        if (key === null) continue;
        const score = added * 1000 - 1 + best[last + 1]!;
        // On a tie the earlier start is taken: it is the same coverage, read from the left.
        if (added > 0 && score >= best[k]!) {
          best[k] = score;
          take[k] = { last, key };
        }
      }
    }
    for (let k = 0; k < groups.length; ) {
      const chosen = take[k];
      if (chosen === null || chosen === undefined) {
        k += 1;
        continue;
      }
      found.push({ start: groups[k]!.start, end: groups[chosen.last]!.end, key: chosen.key });
      k = chosen.last + 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Everything in a text
// ---------------------------------------------------------------------------

/**
 * A bare ten-digit number that begins with 0, has no separator and whose check digit does not hold is a telephone number
 * (0701234567) far more often than a personnummer of someone born in the 2000s. Both are removed; this only chooses the label.
 */
function isRatherATelephoneNumber(folded: string, digits: string, checkDigit: boolean): boolean {
  return digits.length === 10 && digits.startsWith("0") && !checkDigit && /^[\d ]+$/.test(folded);
}

/** Which finding gives a merged span its kind and key: an address first, then a personnummer, then a telephone number. */
const PRIORITY: Readonly<Record<FindingKind, number>> = { epost: 0, pnr: 1, sam: 1, tf: 1, tel: 2 };

/**
 * Every personnummer, samordningsnummer, e-mail address and telephone number in the text, in order of position and not overlapping.
 *
 * WHEN TWO FINDINGS OVERLAP THEY ARE ONE SPAN, and the lead (an address, then a personnummer, then a number) gives its kind and key. The shape
 * of a personnummer lets a blank stand between any two digits, so in "+46 78 430 19 16 074 114 72 54" twelve digits in the middle read as a
 * samordningsnummer, across two telephone numbers. Letting that one win and dropping the numbers it overlaps left the digits at both ends
 * of them in the text; the property tests found it. Merged, nothing of the span stays, and what is lost is only which of the values it was.
 */
export function findPersonalData(original: string): Finding[] {
  if (original.length < 4) return [];
  const text = foldSpellings(original);
  const all: Finding[] = [];

  if (text.includes("@")) {
    for (const part of findAddresses(text)) {
      if (!isMarkerAddress(text.slice(part.start, part.end))) all.push({ kind: "epost", start: part.start, end: part.end, key: part.key });
    }
  }
  for (const found of findPersonalNumbers(text)) {
    // A TF number is no person's date and serial and has no check digit: nothing below that reads a personnummer's digits may read it.
    if (found.kind === "tf") {
      all.push({ kind: "tf", start: found.start, end: found.end, key: found.key, spelling: tfSpellingOf(found.folded) });
      continue;
    }
    const ten = found.digits.slice(-10);
    const checkDigit = luhnHolds(ten);
    if (isRatherATelephoneNumber(found.folded, found.digits, checkDigit)) {
      const key = telephoneKey(found.digits);
      if (key !== null) {
        all.push({ kind: "tel", start: found.start, end: found.end, key });
        continue;
      }
    }
    all.push({ kind: found.kind === "samordning" ? "sam" : "pnr", start: found.start, end: found.end, key: found.key, checkDigit, spelling: spellingOf(found.folded, found.digits) });
  }
  // The wide search for a TF number. A number the shape found too is found twice, at one place with one key, and the merge below makes the two one.
  all.push(...findLooseTfNumbers(text));
  if (/\d/.test(text)) all.push(...findTelephones(text, all).map((found) => ({ kind: "tel" as const, ...found })));

  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Finding[] = [];
  let lead: Finding | null = null;
  for (const finding of all) {
    const last = merged[merged.length - 1];
    if (last === undefined || finding.start >= last.end) {
      lead = finding;
      merged.push({ ...finding });
      continue;
    }
    // Overlaps the span so far: the span grows, and the better lead gives it its kind and key.
    if (PRIORITY[finding.kind] < PRIORITY[lead!.kind]) {
      lead = finding;
      Object.assign(last, { kind: finding.kind, key: finding.key, checkDigit: finding.checkDigit, spelling: finding.spelling });
    }
    last.end = Math.max(last.end, finding.end);
  }
  return merged;
}

/** True when the text holds something personnummer-, e-mail- or telephone-shaped that is not one of the markers: the check run on the finished file. */
export const holdsPersonalData = (text: string): boolean => findPersonalData(text).length > 0;
