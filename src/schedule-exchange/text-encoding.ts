import { BadRequestException } from '@nestjs/common';

/**
 * A file's bytes as text, in the encoding the file was saved in, and which one
 * that was, so the preview can say so.
 *
 * THE SAME RULES AS THE WEB'S (web/lib/csv-encoding.ts, #260), so that the same
 * file gives the same text, the same encoding and the same refusal whether the
 * school sends it to the CSV import of the other lists or to Schema som fil. The
 * web and the gateway cannot share code, so this is a copy; the table of files
 * in text-encoding.spec.ts is also in web/lib/csv-encoding-parity.test.ts, and
 * a rule changed in one place changes a test in the other. Read that module's
 * header for why the choice is made by reading the file both ways and not by
 * counting bytes; in short:
 *
 *   UTF-8 first, whenever the bytes are UTF-8, BOM or not (every export of ours
 *   and every "CSV UTF-8" save). A UTF-8 file with a stray byte or two (two
 *   files pasted together) stays UTF-8, losing those bytes, as long as it has
 *   more letters than lost bytes. Otherwise windows-1252 (Excel for Windows,
 *   "CSV (semikolonavgränsad)") or Mac Roman (Excel for Mac), whichever reads
 *   more like names: a letter next to a letter earns a point, å, ä and ö two,
 *   and what a wrong reading produces (a letter with no letter beside it, a
 *   symbol against a letter, a control character, a capital after a small
 *   letter) loses one. Š, š, Ž and ž are letters. A tie is windows-1252.
 *
 *   Refused, with what to do instead, and not read wrongly: UTF-16 ("Unicode
 *   text") and Excel's "CSV (MS-DOS)", code page 850, which Node has no decoder
 *   for and which is recognised through its Nordic letters.
 */

export type TextEncodingName = 'utf-8' | 'windows-1252' | 'macintosh';

export interface DecodedText {
  text: string;
  /** Anything but UTF-8. */
  legacyEncoding: boolean;
  encoding: TextEncodingName;
  /** Bytes that were not UTF-8 in a file read as UTF-8 and were dropped. */
  lossy: boolean;
}

/** Letters a school's names and notes are made of, beyond ASCII; å, ä and ö count twice. */
const SWEDISH = new Set('åäöÅÄÖ');
const COMMON = new Set('æøÆØéèëêüÜçñáíóúàòâôîïÉŠšŽž');

/** What a wrong reading turns letters into; none of it belongs between two letters. */
const SUSPECT = new Set('≈÷‰ˆ˝¯¿®¾¼½ƒ†‡•™¬√∫∆∂∑∏πΩµ¶§¤¦¨´¸˜ˇ˘˙˚˛·‚„ıﬁﬂ◊');

/** Code page 850's upper half as far as letters go (80–A5); the rest reads as U+FFFD. */
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑ';

const isLetter = (char: string | undefined): boolean => char !== undefined && /\p{L}/u.test(char);
const isLower = (char: string | undefined): boolean => char !== undefined && char !== char.toUpperCase();

/** How much a reading looks like a school's text; see the header. */
export function readingScore(text: string): number {
  let score = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char < '\u0080') continue;
    const before = chars[i - 1];
    const after = chars[i + 1];
    const touchesLetter = isLetter(before) || isLetter(after);
    if (char >= '\u0080' && char <= '\u009f') score -= 1;
    else if (SUSPECT.has(char)) score -= touchesLetter ? 1 : 0;
    else if (isLetter(char)) {
      if (!touchesLetter) score -= 1;
      else if (char !== char.toLowerCase() && isLower(before)) score -= 1;
      else if (SWEDISH.has(char)) score += 2;
      else if (COMMON.has(char)) score += 1;
    }
  }
  return score;
}

const decodeCp850 = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : (CP850[byte - 0x80] ?? '�'))).join('');

const UTF16 =
  'Filen är sparad som Unicode-text (UTF-16), som Rastra inte läser. Spara den i Excel som CSV UTF-8 eller CSV (semikolonavgränsad), ' +
  'eller som UTF-8 i andra program, och välj den igen.';
const MS_DOS =
  'Filen ser ut att vara sparad som CSV (MS-DOS), där å, ä och ö inte går att läsa säkert. Spara den i Excel som CSV UTF-8 eller ' +
  'CSV (semikolonavgränsad), och välj den igen.';

/** The refusal code of a file whose encoding is not read. */
export const ENCODING_UNSUPPORTED = 'IMPORT_ENCODING_UNSUPPORTED';

export function decodeText(bytes: Uint8Array): DecodedText {
  const head = bytes.subarray(0, 400);
  const nuls = head.filter((byte) => byte === 0).length;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) || nuls * 4 > head.length) {
    throw new BadRequestException({ message: UTF16, code: ENCODING_UNSUPPORTED });
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), legacyEncoding: false, encoding: 'utf-8', lossy: false };
  } catch {
    // A UTF-8 file with a stray byte or two stays UTF-8, losing those bytes, rather than every å in it.
    const lossy = new TextDecoder('utf-8').decode(bytes);
    const lost = lossy.match(/�/g)?.length ?? 0;
    const kept = lossy.match(/[^\x00-\x7F�]/g)?.length ?? 0;
    if (kept > lost) return { text: lossy, legacyEncoding: false, encoding: 'utf-8', lossy: true };
  }
  const windows = new TextDecoder('windows-1252').decode(bytes);
  const mac = new TextDecoder('macintosh').decode(bytes);
  const windowsScore = readingScore(windows);
  const macScore = readingScore(mac);
  if (readingScore(decodeCp850(bytes)) > Math.max(windowsScore, macScore)) {
    throw new BadRequestException({ message: MS_DOS, code: ENCODING_UNSUPPORTED });
  }
  return macScore > windowsScore
    ? { text: mac, legacyEncoding: true, encoding: 'macintosh', lossy: false }
    : { text: windows, legacyEncoding: true, encoding: 'windows-1252', lossy: false };
}
