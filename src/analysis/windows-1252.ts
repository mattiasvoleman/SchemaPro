import { encodeWindows1252 as encodeCodePage } from '../common/windows-1252';

/*
 * Text as Windows-1252 bytes: what a Swedish Excel writes for "CSV
 * (semikolonavgränsad)" and reads without a question. The schedule exchange
 * and the web write UTF-8 with a BOM, which Excel reads too; the löneunderlag
 * is the file a payroll office opens in a system older than that, which is
 * why the school asked for 1252.
 *
 * Node has a decoder for windows-1252 and none for encoding, so the table is
 * here. Code points U+0000–U+007F and U+00A0–U+00FF are the same byte; the
 * 27 characters Windows put in 0x80–0x9F (the euro sign, the curly quotes, the
 * dashes, Š and Ž …) are listed below. Everything else a name can hold — a
 * Polish ł, a Hungarian ő — has no byte. It is written as its base letter
 * where Unicode gives one (é stays, ő becomes o, ł becomes l by the small table)
 * and as '?' otherwise, and the caller is told how many it replaced so the
 * file can say so. The Excel file keeps every character.
 *
 * A control character below U+0020 is not a letter for any table to find the
 * nearest of, and is not left as the byte it is either: a NUL or a BEL in a
 * name is the one thing that makes Excel call the file corrupt (the review of
 * #280, LÅG-5). The code page's own encoder (common/windows-1252.ts, D8's)
 * already says what is written for each: tab, line feed and carriage return as
 * they are, anything else as a space. This one asks it, for those characters,
 * before it looks anything up here, so that the two encoders cannot come to
 * differ; a control character it changed counts as replaced.
 *
 * PURE.
 */


const HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Letters Unicode does not decompose, and the nearest letter 1252 has. */
const BASE: ReadonlyMap<string, string> = new Map([
  ['Ł', 'L'], ['ł', 'l'], ['Đ', 'D'], ['đ', 'd'], ['Ħ', 'H'], ['ħ', 'h'], ['ı', 'i'], ['Ŀ', 'L'], ['ŀ', 'l'],
  ['ẞ', 'SS'], ['Ə', 'E'], ['ə', 'e'], ['Ʒ', 'Z'], ['ʒ', 'z'],
]);

function byteOf(code: number): number | null {
  if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
  return HIGH.get(code) ?? null;
}

/** A character with no byte, as the nearest letters that have one; '?' where there is none. */
function nearest(char: string): string {
  const mapped = BASE.get(char);
  if (mapped !== undefined) return mapped;
  const letters = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return letters !== char && [...letters].every((c) => byteOf(c.codePointAt(0)!) !== null) ? letters : '?';
}

export interface Encoded1252 {
  bytes: Buffer;
  /** How many characters had no byte and were written as another letter or '?'. */
  replaced: number;
}

export function encodeWindows1252(text: string): Encoded1252 {
  const out: number[] = [];
  let replaced = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20) {
      const byte = encodeCodePage(char)[0]!;
      out.push(byte);
      if (byte !== code) replaced += 1;
      continue;
    }
    const byte = byteOf(code);
    if (byte !== null) {
      out.push(byte);
      continue;
    }
    replaced += 1;
    for (const c of nearest(char)) out.push(byteOf(c.codePointAt(0)!) ?? 0x3f);
  }
  return { bytes: Buffer.from(out), replaced };
}
