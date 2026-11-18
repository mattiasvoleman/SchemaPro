import { decodeCsvBytes } from "@/lib/csv-encoding";

/**
 * What a table may be read from: text pasted into a box (a table copied out of Skola24 or a spreadsheet), or a file the user
 * chose, which is decoded in the code page it was saved in (Excel's CSV is Windows-1252, not UTF-8).
 */
export type TableSource = { text: string } | { file: File };

/** A paste or a file this long is not a table of a school, and a browser that parses it freezes: it is turned back with a sentence. */
export const MAX_TABLE_TEXT = 5_000_000;

const ENCODING_NAME = { "windows-1252": "Windows-1252", macintosh: "Mac Roman" } as const;

export type ReadSource =
  | { ok: true; text: string; /** The code page a file that was not UTF-8 was read in. */ encoding: string | null }
  | { ok: false; reason: "tooLong" } /** The text is over MAX_TABLE_TEXT. */
  | { ok: false; reason: "unreadable"; problem: string } /** The file cannot be read as text, and what decodeCsvBytes says to save it as. */;

/** The text of a source, or why there is none. A text source is taken as it is; a file's bytes are decoded first. */
export async function readSource(source: TableSource): Promise<ReadSource> {
  if ("text" in source) {
    return source.text.length > MAX_TABLE_TEXT ? { ok: false, reason: "tooLong" } : { ok: true, text: source.text, encoding: null };
  }
  const decoded = decodeCsvBytes(new Uint8Array(await source.file.arrayBuffer()));
  if (decoded.problem !== null) return { ok: false, reason: "unreadable", problem: decoded.problem };
  if (decoded.text.length > MAX_TABLE_TEXT) return { ok: false, reason: "tooLong" };
  return { ok: true, text: decoded.text, encoding: decoded.encoding === "utf-8" ? null : ENCODING_NAME[decoded.encoding] };
}
