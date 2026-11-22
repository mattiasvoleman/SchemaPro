/**
 * Names that are KNOWN, found again in running text (Pseudonymiseraren, X1).
 *
 * A name cannot be recognised by how it looks, and this does not try. What it does is smaller and certain: a name that stands in
 * a column the header or the user says holds names, or in the list of words the user typed in, is also looked for in the cells
 * and rows of free text, so that "Anna ringde" in a comment does not outlive "Anna Svensson" in the column of teachers. A name
 * nobody has pointed out stays where it is, and the page says so.
 *
 * WHAT IS LOOKED FOR, AND WHERE.
 *   - Whole words only ("Lind" is not found in "Lindström"), case ignored, with the genitive -s ("Annas" is "Anna").
 *   - A name from a name COLUMN is looked for in cells of two or more words, and in rows outside the table (a title above the
 *     header), not in a cell of one word: a surname that is also a room ("Hall") would otherwise take the room column with it.
 *     Words of fewer than three letters are not looked for (a first name "Bo" is a word of Swedish), but are replaced in their own column.
 *   - A word from the USER'S LIST is looked for everywhere, one word cells included, from two letters. The user said so.
 *   - A SIGNATURE is not looked for outside its own column: a teacher whose signature is SVE would otherwise take the subject
 *     column with her. Signatures are replaced where the header says they are.
 */

import { MARKER_PATTERN, normaliseText, type MarkerKind } from "@/lib/pseudonym-markers";

/** A word: letters, with an apostrophe between letters (D'Angelo). A hyphen ends a word, so "Anna-Lena" is two. */
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?/gu;

/** The least letters of a name taken from a column that is looked for in running text. */
const MIN_DERIVED = 3;
/** The least letters of a word from the user's list. */
const MIN_EXPLICIT = 2;

export interface NameHit {
  start: number;
  end: number;
  /** The kind of marker, and the key it has in the marker book. */
  kind: MarkerKind;
  key: string;
}

/** The words of a text with where they stand. */
function wordsOf(text: string): { word: string; start: number; end: number }[] {
  const found: { word: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(WORD)) found.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  return found;
}

const lettersIn = (word: string): number => word.replace(/['’]/g, "").length;

/** How many words of two letters or more a text has: the test of "running text" against "a code or a name on its own". */
export function runningWords(text: string): number {
  let n = 0;
  for (const match of text.matchAll(WORD)) if (lettersIn(match[0]) >= 2) n += 1;
  return n;
}

export class KnownNames {
  /** Name -> the kind of the column it came from (the first it was met in). Looked for in running text. */
  private readonly derived = new Map<string, MarkerKind>();
  /** The user's words. Looked for everywhere. */
  private readonly explicit = new Map<string, MarkerKind>();

  get size(): number {
    return this.derived.size + this.explicit.size;
  }

  /** The words of a cell of a name column (a cell that is already a marker is no name: running the tool on its own output changes nothing). */
  addCell(value: string, kind: MarkerKind): void {
    for (const { word } of wordsOf(value.replace(MARKER_PATTERN, " "))) {
      if (lettersIn(word) >= MIN_DERIVED) {
        const key = normaliseText(word);
        if (!this.derived.has(key)) this.derived.set(key, kind);
      }
    }
  }

  /** A line of the user's list: each word of it is a name. */
  addLine(line: string): void {
    for (const { word } of wordsOf(line)) {
      if (lettersIn(word) >= MIN_EXPLICIT) {
        const key = normaliseText(word);
        if (!this.explicit.has(key)) this.explicit.set(key, "namn");
      }
    }
  }

  private lookUp(word: string, running: boolean): { kind: MarkerKind; key: string } | null {
    const normal = normaliseText(word);
    const candidates = normal.endsWith("s") && normal.length > 3 ? [normal, normal.slice(0, -1)] : [normal];
    for (const candidate of candidates) {
      const kind = this.explicit.get(candidate) ?? (running ? this.derived.get(candidate) : undefined);
      if (kind !== undefined) return { kind, key: candidate };
    }
    return null;
  }

  /**
   * The known names in a text. `running` says the text is running text (more than one word, or a row outside the table), where
   * names from columns are looked for as well as the user's own words.
   */
  find(text: string, running: boolean): NameHit[] {
    if (this.size === 0) return [];
    const markers = [...text.matchAll(MARKER_PATTERN)].map((match) => [match.index, match.index + match[0].length] as const);
    const hits: NameHit[] = [];
    for (const { word, start, end } of wordsOf(text)) {
      // The words a marker is made of are not names.
      if (markers.some(([from, to]) => start < to && end > from)) continue;
      const found = this.lookUp(word, running);
      if (found !== null) hits.push({ start, end, kind: found.kind, key: found.key });
    }
    return hits;
  }
}
