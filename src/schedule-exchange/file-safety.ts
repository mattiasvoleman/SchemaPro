/**
 * What every reader of an uploaded file shares: the personnummer filter, the
 * way a value is quoted in a message, and the cap on how many problems one
 * file may report.
 *
 * WHY THIS IS ONE MODULE. A reader sees text a stranger wrote. Three rules
 * hold for all four formats, and a rule kept in four places is kept in three:
 *
 *  1. NO PERSONNUMMER OUT. Rastra stores none, not even as a hash (the user's
 *     decision of 2026-11-05), and a number that is read can be echoed: in an
 *     error message, in a label, in a note, in a name that is then written to
 *     the database. So the shape is recognised in a value wherever it sits,
 *     whole or inside longer text, with or without the hyphen, and a value that
 *     has it makes the ROW (the cell's row, the card, the DIF line) unreadable
 *     without quoting it. `hasPersonalNumber` decides; `redactPersonalNumbers`
 *     is for a text that has to be shown anyway; `scrubPersonalNumbers` is the
 *     last door, applied to everything the service answers with.
 *
 *  2. NO LONG QUOTES. A message that quotes a cell quotes at most MAX_QUOTE
 *     characters of it, redacted first and cut after. A shared string in an
 *     xlsx may be 32 767 characters long and used by five thousand cells; a
 *     message per cell that quoted all of it was 650 million characters.
 *
 *  3. NO UNBOUNDED LIST OF PROBLEMS. A file of nothing but bad rows reports at
 *     most MAX_PROBLEMS of them and one closing line that says how many more
 *     there were (ProblemLog).
 *
 * THE SHAPE (CHOICE). A personnummer is ten digits YYMMDDNNNN or twelve
 * YYYYMMDDNNNN, with an optional '-' (or '+', for a person over a hundred)
 * before the last four, and with a month 01-12 and a day 01-31. A
 * samordningsnummer has 60 added to the day (61-91). The filter does NOT test
 * the check digit: a number typed wrong, or made up, is still a number someone
 * meant as a person's, and a file that carries it is not one Rastra reads. It
 * errs towards refusing: ten digits that happen to read as a date and four more
 * (a phone number 0701234567) are taken for a personnummer. That costs one
 * unreadable row with a plain message; the other error costs a personnummer in
 * a database.
 *
 * Source of the shape: Skatteverket, "Personnummer" and "Samordningsnummer"
 * (skatteverket.se), and SKV 704 for the format of the number.
 */
import type { ReadProblem } from './exchange-model';

/** The most characters of a file's value a message quotes. */
export const MAX_QUOTE = 40;

/** The most problems one file reports; the rest are counted. */
export const MAX_PROBLEMS = 500;

/** The marker a redacted number is replaced with. */
export const REDACTED = '[personnummer]';

/**
 * Not preceded and not followed by a digit; at most two spaces either side of
 * the separator (the hyphen is often written with spaces around it, or an
 * en dash by a word processor). Every quantifier is bounded, so the cost is
 * linear in the text.
 */
const SHAPE = /(?<!\d)(?:\d{2})?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]|6[1-9]|[78]\d|9[01])[ \t]{0,2}[-+‐-―−]?[ \t]{0,2}\d{4}(?!\d)/;
const SHAPE_ALL = new RegExp(SHAPE.source, 'g');

/** True when the text holds a personnummer or a samordningsnummer, whole or as a part. */
export function hasPersonalNumber(text: string | null | undefined): boolean {
  if (!text || text.length < 10) return false;
  return SHAPE.test(text);
}

/** The text with every personnummer-shaped part replaced by REDACTED. */
export function redactPersonalNumbers(text: string): string {
  if (text.length < 10) return text;
  return text.replace(SHAPE_ALL, REDACTED);
}

/**
 * A value as a message may show it: redacted, flattened to one line, at most
 * MAX_QUOTE characters and in quotation marks. The redaction comes first so a
 * number is never cut in two and shown in half.
 */
export function excerpt(value: string | null | undefined): string {
  const flat = redactPersonalNumbers(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return `”${flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE)}…` : flat}”`;
}

/**
 * The last door: every string in a value, however deep, redacted. An object is
 * rebuilt only when something in it changed, so a clean plan is returned as it
 * is. Dates and other non-plain objects pass through (no reader makes one).
 */
export function scrubPersonalNumbers<T>(value: T): T {
  return scrub(value, 0) as T;
}

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactPersonalNumbers(value);
  if (value === null || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const scrubbed = scrub(item, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return changed ? next : value;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const scrubbed = scrub(item, depth + 1);
    if (scrubbed !== item) changed = true;
    next[redactPersonalNumbers(key)] = scrubbed;
    if (redactPersonalNumbers(key) !== key) changed = true;
  }
  return changed ? next : value;
}

/**
 * The problems of one file, capped. `add` keeps the first MAX_PROBLEMS and
 * counts the rest; `close` appends one line that says how many more there
 * were. A reader calls `close` once, when it returns.
 */
export class ProblemLog {
  private readonly kept: ReadProblem[] = [];
  private hidden = 0;

  constructor(private readonly closingCode: string) {}

  add(ref: string, code: string, message: string): void {
    if (this.kept.length < MAX_PROBLEMS) this.kept.push({ ref, code, message });
    else this.hidden += 1;
  }

  /** The kept problems, and the closing line when some were not kept. */
  close(): ReadProblem[] {
    if (this.hidden > 0) {
      return [...this.kept, { ref: '', code: this.closingCode, message: `Ytterligare ${this.hidden} problem visas inte.` }];
    }
    return [...this.kept];
  }

  get size(): number {
    return this.kept.length + this.hidden;
  }
}
