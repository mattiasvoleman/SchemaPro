/**
 * The markers a personal value is replaced with, and the book that gives the same value the same marker (Pseudonymiseraren, X1).
 *
 * ONE VALUE, ONE MARKER, WITHIN ONE RUN. A run is every file the school has put in the page since it was opened or cleared;
 * they share one book, so that a teacher is the same marker in the file of the lessons and in the file of the postings, which is
 * what lets a reader be tried on the structure. The book lives in memory for the length of one `pseudonymise` call and is
 * not kept: it is the only place the values and their markers stand side by side, and nothing here writes it anywhere.
 *
 * WHAT A MARKER IS. ASCII, with a prefix that says the kind and a number that follows first appearance (the files in order,
 * then row by row): `PNR-0001`, `SAM-0001`, `epost-0001@exempel.invalid`, `TEL-0001`, `NAMN-0001`, `FORNAMN-0001`,
 * `EFTERNAMN-0001`, `SIGN-0001`, `TEXT-0001`. No marker has the shape of a personnummer, an address that can be delivered to
 * or a telephone number, which the finished file is checked for. A marker is NOT random: the order of the numbers is the order
 * of the file, so a file sorted on surname hands out the alphabetical rank of each person. A weak leak, said in the report;
 * random numbers would make the same run give different files.
 *
 * WHAT COUNTS AS THE SAME VALUE (`keyOf`). A personnummer is its ten last digits, so 800101-1234, 19800101-1234 and 8001011234
 * are one person. A telephone number is its digits with +46 and 0046 as 0. An address is lower case. A name or any other
 * text is Unicode-normalised, with its blanks run together and its case folded (Swedish rules), so "SVENSSON" and "Svensson"
 * are one name, and two values that differ after that have two markers.
 */

import { MARKER_DOMAIN, normaliseTelephone } from "@/lib/pseudonym-detect";

export const MARKER_KINDS = ["pnr", "sam", "tf", "epost", "tel", "namn", "fornamn", "efternamn", "sign", "text"] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

const PREFIX: Readonly<Record<MarkerKind, string>> = {
  pnr: "PNR",
  sam: "SAM",
  tf: "TF",
  epost: "epost",
  tel: "TEL",
  namn: "NAMN",
  fornamn: "FORNAMN",
  efternamn: "EFTERNAMN",
  sign: "SIGN",
  text: "TEXT",
};

/**
 * The digits of a marker's number: four at least (the book pads to four) and six at most, which is a school with a million different persons. A marker is
 * what the book hands out, nothing longer: "TEL-0701234567" and "PNR-198001011234" are not markers but a telephone number and a personnummer that
 * somebody put a prefix on, and an unbounded `\d{4,}` took them for markers: left as they were in a column of personnummer (isMarker), and taken out
 * of the cell before the check looked at it (leftIn), so that the check could not see them either.
 */
export const MARKER_DIGITS = "4,6";

/**
 * Every marker as it stands in text. The sweep for known names and the check on the finished file both take it out first: a marker
 * is made of words a name could be (Text, Sign), and running the pseudonymiser on its own output must change nothing.
 */
export const MARKER_PATTERN = new RegExp(`\\b(?:PNR|SAM|TF|TEL|NAMN|FORNAMN|EFTERNAMN|SIGN|TEXT)-\\d{${MARKER_DIGITS}}\\b|\\bepost-\\d{${MARKER_DIGITS}}@${MARKER_DOMAIN.replace(/\./g, "\\.")}`, "gi");

/** True for a text that is exactly one marker: a cell that has been through the pseudonymiser already, which is left as it is. */
export function isMarker(text: string): boolean {
  const trimmed = text.trim();
  const found = trimmed.match(MARKER_PATTERN);
  return found !== null && found.length === 1 && found[0] === trimmed;
}

/** The marker text for the nth value of a kind (1-based). */
export function markerText(kind: MarkerKind, n: number): string {
  const number = String(n).padStart(4, "0");
  return kind === "epost" ? `${PREFIX.epost}-${number}@${MARKER_DOMAIN}` : `${PREFIX[kind]}-${number}`;
}

/** Normalises text the way a name is compared: the same letters whatever the composition, blanks run together, Swedish case folding. */
export function normaliseText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
}

/** The identity of a value within its kind. The text of a personnummer or telephone number is reduced to its digits. */
export function keyOf(kind: MarkerKind, value: string): string {
  if (kind === "pnr" || kind === "sam") {
    const digits = value.replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : normaliseText(value);
  }
  if (kind === "tf") {
    // A TF number is its eight digits of date and its two after TF, as lib/personal-number.ts keys it: 19000101-tf01 and 19000101TF01 are one.
    const folded = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    return /^\d{8}TF\d{2}$/.test(folded) ? folded : normaliseText(value);
  }
  if (kind === "tel") {
    return /\d/.test(value) ? normaliseTelephone(value) : normaliseText(value);
  }
  if (kind === "epost") return value.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  return normaliseText(value);
}

/** The kind a whole-cell personnummer is: a samordningsnummer when the day is 61-91, as the shape reads it. */
export function personalNumberKind(value: string): "pnr" | "sam" {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && Number(digits.slice(-6, -4)) >= 61 ? "sam" : "pnr";
}

/** The values met so far, kind by kind, in first-seen order. Holds the original values (as keys): do not keep it. */
export class MarkerBook {
  private readonly kinds = new Map<MarkerKind, Map<string, number>>();

  /** The marker of a value of a kind, giving the value the next number if it has not been met. `key` is `keyOf(kind, value)`. */
  marker(kind: MarkerKind, key: string): string {
    let numbers = this.kinds.get(kind);
    if (numbers === undefined) {
      numbers = new Map();
      this.kinds.set(kind, numbers);
    }
    let n = numbers.get(key);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(key, n);
    }
    return markerText(kind, n);
  }

  /** How many different values of a kind have been given a marker. */
  distinct(kind: MarkerKind): number {
    return this.kinds.get(kind)?.size ?? 0;
  }
}
