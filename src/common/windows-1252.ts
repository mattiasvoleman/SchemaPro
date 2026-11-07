/**
 * Windows-1252, the code page Excel for Windows opens a Swedish `;`-separated
 * file in when it has no byte-order mark to go by: å ä ö Å Ä Ö and é are the
 * same bytes as in ISO 8859-1, and the 27 printable characters in 0x80-0x9F
 * (the euro sign, the typographic quotes, the dashes) are where 1252 differs
 * from Latin-1. Node's 'latin1' encoder keeps only the low byte of a code
 * point above 0xFF (the euro sign comes out as ¬, an en dash as 0x13), so the
 * table is here.
 *
 * A character the page has no byte for is written as `?`, one for each code
 * point: an emoji is one question mark, not two halves of a surrogate pair.
 * A control character below 0x20 other than tab, line feed and carriage return
 * is written as a space; a file is read by people, and a stray NUL is the one
 * thing that makes Excel call it corrupt.
 */

const HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

const QUESTION_MARK = 0x3f;
const SPACE = 0x20;

/** The text as windows-1252 bytes. */
export function encodeWindows1252(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20) {
      bytes.push(code === 0x09 || code === 0x0a || code === 0x0d ? code : SPACE);
    } else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
    } else {
      bytes.push(HIGH[code] ?? QUESTION_MARK);
    }
  }
  return Buffer.from(bytes);
}
