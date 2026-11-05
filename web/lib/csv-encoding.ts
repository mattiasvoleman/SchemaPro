/**
 * A chosen file's bytes as text, in the encoding the file was saved in, and
 * which encoding that was, so the dialog can say so.
 *
 * File.text() reads UTF-8 and nothing else, and a file opened and saved in
 * Excel as "CSV (semikolonavgränsad)" is NOT UTF-8: Excel writes the Windows
 * code page, 1252, where å is the single byte E5. Read as UTF-8 every å, ä
 * and ö became U+FFFD, and the header row, being ASCII, gave no warning.
 * Excel for Mac has saved the same format in Mac Roman, where ö is 9A.
 *
 * UTF-8 first, whenever the bytes are UTF-8 (every export of ours and every
 * "CSV UTF-8" save, BOM or not): no older file is valid UTF-8 by accident in
 * any text a school writes. Then the two code pages, chosen by READING the
 * file both ways and asking which reading looks like names. Counting bytes in
 * the two code pages' letter ranges was not enough: 1252 keeps its dashes and
 * curly quotes where Mac Roman keeps å, ä and ö, so a notes column of
 * "Åk 7–9 – ”klar”" outvoted the names and read Åke as ≈ke, and Mac Roman's
 * Æ and Ø lie in a range neither count saw.
 *
 * A reading earns a point for each common Nordic or Western letter that stands
 * next to another letter (Ærø, José), two for å, ä and ö (Ström, Åsa), and
 * loses one for what a
 * wrong reading produces and a school's text does not contain: a non-ASCII
 * letter with no letter on either side (a dash read as " ñ "), a symbol such
 * as ≈ ÷ ‰ ® ¿ ¾ against a letter (Str÷m, ®rø), a control character, and an
 * accented capital right after a small letter (an ellipsis read as "osvÖ").
 * Š, š, Ž and ž count as letters: they are Windows-1252's own, in Czech,
 * Slovak and Bosnian-Croatian-Serbian names (Šehić, Dušan), and counted
 * against the reading a class list of them read as Mac Roman, Håkan as
 * HÂkan. A small file of such names and no Swedish letter at all is the
 * case left that a guess cannot tell, and the preview says which it chose.
 * The higher score wins; a tie, nothing either way, is 1252.
 *
 * Two formats are refused, with what to do instead, rather than read wrongly:
 * UTF-16 ("Unicode-text"), and Excel's "CSV (MS-DOS)", code page 850, which
 * the browser has no decoder for. Code page 850 is recognised the same way,
 * through its Nordic letters.
 */

export type CsvEncoding = "utf-8" | "windows-1252" | "macintosh";

export type DecodedCsv =
  | { text: string; encoding: CsvEncoding; problem: null }
  | { text: ""; encoding: "utf-16" | "cp850"; problem: string };

/** Letters a school's names and notes are made of, beyond ASCII; å, ä and ö count twice. */
const SWEDISH = new Set("åäöÅÄÖ");
const COMMON = new Set("æøÆØéèëêüÜçñáíóúàòâôîïÉŠšŽž");

/** What a wrong reading turns letters into; none of it belongs between two letters. */
const SUSPECT = new Set("≈÷‰ˆ˝¯¿®¾¼½ƒ†‡•™¬√∫∆∂∑∏πΩµ¶§¤¦¨´¸˜ˇ˘˙˚˛·‚„ıﬁﬂ◊");

/** Code page 850's upper half as far as letters go (80–A5); the rest reads as U+FFFD. */
const CP850 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑ";

const isLetter = (char: string | undefined) => char !== undefined && /\p{L}/u.test(char);
const isLower = (char: string | undefined) => char !== undefined && char !== char.toUpperCase();

/** How much a reading looks like a school's text; see the module comment. */
export function readingScore(text: string): number {
  let score = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char < "\u0080") continue;
    const before = chars[i - 1];
    const after = chars[i + 1];
    const touchesLetter = isLetter(before) || isLetter(after);
    if (char >= "\u0080" && char <= "\u009f") score -= 1;
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

const decodeCp850 = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : (CP850[byte - 0x80] ?? "\uFFFD"))).join("");

const UTF16 =
  "Filen är sparad som Unicode-text (UTF-16), som importen inte läser. Spara den i Excel som " +
  "CSV UTF-8 eller CSV (semikolonavgränsad), och välj den igen.";
const MS_DOS =
  "Filen ser ut att vara sparad som CSV (MS-DOS), där å, ä och ö inte går att läsa säkert. Spara den i " +
  "Excel som CSV UTF-8 eller CSV (semikolonavgränsad), och välj den igen.";

export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  const head = bytes.subarray(0, 400);
  const nuls = head.filter((byte) => byte === 0).length;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) || nuls * 4 > head.length) {
    return { text: "", encoding: "utf-16", problem: UTF16 };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", problem: null };
  } catch {
    // A UTF-8 file with a stray byte or two (two files pasted together) stays
    // UTF-8, losing those bytes as File.text() did, rather than every å in it.
    const lossy = new TextDecoder("utf-8").decode(bytes);
    const lost = lossy.match(/\uFFFD/g)?.length ?? 0;
    const kept = lossy.match(/[^\x00-\x7F\uFFFD]/g)?.length ?? 0;
    if (kept > lost) return { text: lossy, encoding: "utf-8", problem: null };
  }
  const windows = new TextDecoder("windows-1252").decode(bytes);
  const mac = new TextDecoder("macintosh").decode(bytes);
  const windowsScore = readingScore(windows);
  const macScore = readingScore(mac);
  if (readingScore(decodeCp850(bytes)) > Math.max(windowsScore, macScore)) {
    return { text: "", encoding: "cp850", problem: MS_DOS };
  }
  return macScore > windowsScore
    ? { text: mac, encoding: "macintosh", problem: null }
    : { text: windows, encoding: "windows-1252", problem: null };
}
