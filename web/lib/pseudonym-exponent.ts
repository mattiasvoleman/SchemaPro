/**
 * A whole number written in scientific notation (Pseudonymiseraren, X1b; the review of #398, H-1, which found it in the xlsx reader, and the note of the fix that said a CSV had it too).
 *
 * A writer that prints a double the way Java does (Apache POI, many exporters) stores the personnummer 8001011234 as 8.001011234E9, and Excel with a Swedish locale shows and saves it as
 * 8,00101E+09 (six digits kept, the rest of the number gone, and what is left is still the first six of a personnummer). A search for a personnummer reads digits, so a CSV with such a cell
 * in a column the header calls Id was KEPT whole, with nothing on the page about it. The xlsx reader writes a number out before anything reads it (lib/pseudonym-xlsx.ts, `plainNumber`); a CSV
 * is text, and the same text is searched where it stands, so this is a third VIEW of the text: every number in exponent form that is a whole number of ten to twelve digits is written out, and what the
 * search finds in that view is carried back to the place of the number as it was written.
 *
 * ONLY TEN TO TWELVE DIGITS. That is what a personnummer is (ten, or twelve with a century); a shorter whole number in this form is a quantity or an id and the page asks about a column of them as it
 * always did (seven digits or more is asked), and a longer one is not a personnummer. Nothing is guessed about a fraction, a negative exponent or an exponent that would need more zeros than the
 * digits it has: those are not whole numbers of this length and are left as they were.
 */

/** The number as the text writes it: one digit, an optional fraction after a full stop or a comma, E and an exponent of one or two digits. No sign: a negative number is nobody's personnummer. */
const TOKEN = /(?<![\w.,+-])(\d)(?:[.,](\d{1,17}))?[eE]\+?(\d{1,2})(?![\w])/g;

/** A cheap look before the expression is tried at each place of a long cell: a digit, an E and a digit, in that order and next to each other. */
const MAYBE = /\d[.,]?\d*[eE]\+?\d/;

/** The text with each such number written out, and where each of its characters stood. */
export interface ExponentView {
  text: string;
  /** For each character of `text`: where it begins in the text as it was written, and where it ends. A character of a written-out number stands for the whole number. */
  startAt: Int32Array;
  endAt: Int32Array;
}

/** The digits of a whole number written with an exponent, or null when it is not one of ten to twelve digits. "8.001011234E9" is 8001011234 and "8,00101E+09" is 8001010000. */
export function wholeNumberOf(token: string): string | null {
  const match = /^(\d)(?:[.,](\d{1,17}))?[eE]\+?(\d{1,2})$/.exec(token);
  if (match === null) return null;
  return digitsOf(match[1]!, match[2] ?? "", Number(match[3]));
}

function digitsOf(whole: string, fraction: string, exponent: number): string | null {
  if (exponent < fraction.length) return null;
  const digits = `${whole}${fraction}${"0".repeat(exponent - fraction.length)}`.replace(/^0+(?=\d)/, "");
  return digits.length >= 10 && digits.length <= 12 ? digits : null;
}

/** The text as the search reads it with its numbers in exponent form written out, or null when there is none to write out. */
export function expandExponents(original: string): ExponentView | null {
  if (original.length < 5 || !MAYBE.test(original)) return null;
  const tokens: { start: number; end: number; digits: string }[] = [];
  for (const match of original.matchAll(TOKEN)) {
    const digits = digitsOf(match[1]!, match[2] ?? "", Number(match[3]));
    if (digits !== null) tokens.push({ start: match.index, end: match.index + match[0].length, digits });
  }
  if (tokens.length === 0) return null;
  let text = "";
  let length = 0;
  for (const token of tokens) length += token.digits.length - (token.end - token.start);
  const startAt = new Int32Array(original.length + length + 1);
  const endAt = new Int32Array(original.length + length + 1);
  let at = 0;
  let from = 0;
  const copy = (to: number): void => {
    for (let i = from; i < to; i += 1) {
      startAt[at] = i;
      endAt[at] = i + 1;
      at += 1;
    }
    text += original.slice(from, to);
  };
  for (const token of tokens) {
    copy(token.start);
    for (let i = 0; i < token.digits.length; i += 1) {
      startAt[at] = token.start;
      endAt[at] = token.end;
      at += 1;
    }
    text += token.digits;
    from = token.end;
  }
  copy(original.length);
  startAt[at] = original.length;
  endAt[at] = original.length;
  return { text, startAt, endAt };
}
