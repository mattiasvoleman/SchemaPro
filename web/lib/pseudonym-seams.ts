/**
 * A number cut in two by where a text was broken (Pseudonymiseraren, review of #396 L-3 and #398): "Elev 19000101" on one line and "TF01 ingår i grupp 7A" on the next, a
 * hard-wrapped letter, or "820477,1913" in a text where the comma was read as the delimiter of a table. Every cell and every line is searched on its own, so the two halves
 * were two pieces of text and neither held a number.
 *
 * A FLOW is the segments of a text in the order they are read, and what stands between each: a line break, or the delimiter. Of the pair of segments either side of a seam, the end of the
 * first and the beginning of the second are put together as the seam would have them (nothing, for a line break, and the delimiter itself for a comma or a semicolon) and searched. A text wrapped
 * at a blank and a text of fixed width, wrapped anywhere, are both read as they were before they were cut. A number that stands across the seam is taken: the marker goes in the first segment, in the place the number began, and
 * the rest of the number is cut off the front of the second. Nothing else of either is touched.
 *
 * WHERE A FLOW IS DRAWN, AND WHERE NOT. In a text that is not a table, and in a table of ONE column (a list, a paste: most of its rows have one cell). Not in a table of several columns:
 * there the last cell of one row and the first cell of the next are different records, and "2026-11-21" at the end of one and "0810" at the start of the next is a date and a time, not a
 * personnummer. The page says it (limit2 of the report): a number split over two cells, or over two rows of a table with several columns, is not found.
 *
 * AND ONLY WHERE THERE IS TEXT. A seam is bridged when there is something other than the number on at least one side of it (two letters in a row): "Elev 19000101 / TF01 ingår"
 * is, and "20261121 / 0810" in a list of dates on one line each and times on the next is not. The cost of the rule is a number cut in two with nothing else on either line.
 *
 * AND NOT INTO THE MIDDLE OF A WORD, AND NOT FOR A SHORT TELEPHONE NUMBER (X1b, the review of #403, M-1). Almost every row of a list has a word, so "text beside the number" says little, and a list of lessons
 * with no delimiter ("0001 7A MAT 0815 0900" over "0002 7A ENG 0910 0955") had the end of one row and the start of the next read as a telephone number: the row's number and the first digit of a class were gone,
 * and nothing leaked, but the safe file no longer showed the form of the file, which is what it is sent for. A number that ends in the middle of a word on the second side ("0002 7" before the A of 7A) is not
 * one that was cut there; and a telephone number across a seam has nine digits or more (a Swedish number has nine or ten, a Stockholm one eight: eight digits across a line break are as often a time and a time).
 * The cost: a Stockholm number cut in two, which is left as it stood, and the page says it.
 */

import { findUnmerged, type Finding } from "@/lib/pseudonym-detect";
import { MARKER_PATTERN } from "@/lib/pseudonym-markers";
import type { Body } from "@/lib/pseudonym-input";

/** How far from a seam a number may begin and end: the longest a number is written is a dozen digits with their separators, and invisible characters between them. */
const REACH = 64;

/** Two letters in a row: a word. The number's own letters (TF) are not counted, they are cut out before. */
const WORD = /\p{L}{2,}/u;

/** The kinds of finding a seam is bridged for: numbers. An address is not broken across a line. */
const NUMBERS: ReadonlySet<Finding["kind"]> = new Set(["pnr", "sam", "tf", "tel"]);

/** A digit, in the ASCII or the full-width form (a file from a Japanese keyboard): the search folds the second to the first. */
const hasDigit = (text: string): boolean => /[\d\uff10-\uff19]/.test(text);

/** Markers the page wrote are not what is looked for: made blanks of the same length, so that places stay. */
const withoutMarkers = (text: string): string => text.replace(MARKER_PATTERN, (marker) => " ".repeat(marker.length));

export interface Flow {
  segments: string[];
  /** seams[i] is what stands between segments[i] and segments[i + 1]: "\n" for a line break, otherwise the delimiter. */
  seams: string[];
  /** The body of a text with the segments of the flow put back in it. */
  rebuild: (segments: readonly string[]) => Body;
}

/** The width most rows have, as bodyOf (lib/pseudonym-input.ts) reads a table. */
function commonestWidth(rows: readonly (readonly string[])[]): number {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let width = 0;
  let most = 0;
  for (const [candidate, count] of counts) {
    if (count > most) {
      width = candidate;
      most = count;
    }
  }
  return width;
}

/** The flow of a body, or null where a seam is not bridged: a table of several columns. */
export function flowOf(body: Body, delimiter: string | null): Flow | null {
  if (body.shape === "lines") {
    return { segments: [...body.lines], seams: body.lines.slice(1).map(() => "\n"), rebuild: (segments) => ({ shape: "lines", lines: [...segments] }) };
  }
  if (commonestWidth(body.rows) !== 1) return null;
  const segments: string[] = [];
  const seams: string[] = [];
  const places: [number, number][] = [];
  body.rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (segments.length > 0) seams.push(c === 0 ? "\n" : (delimiter ?? ";"));
      segments.push(cell);
      places.push([r, c]);
    });
  });
  return {
    segments,
    seams,
    rebuild: (changed) => {
      const rows = body.rows.map((row) => [...row]);
      changed.forEach((value, i) => {
        const [r, c] = places[i]!;
        rows[r]![c] = value;
      });
      return { shape: "table", rows, rowNumbers: body.rowNumbers };
    },
  };
}

/**
 * The segments of a flow with every number that stands across a seam replaced: `take` is given the finding and returns what stands where the number was (a marker, and counts it).
 * The segments are the ones given when nothing is bridged.
 */
export function bridgeFlow(flow: Flow, take: (found: Finding) => string): string[] {
  const out = [...flow.segments];
  for (let i = 0; i + 1 < out.length; i += 1) {
    const tail = out[i]!;
    const head = out[i + 1]!;
    if (tail === "" || head === "") continue;
    const before = withoutMarkers(tail.slice(-REACH));
    const after = withoutMarkers(head.slice(0, REACH));
    // Most seams have no number on either side of them: the cheap way out. A plus at the end of the first side is the start of a number cut right after it ("+" over "46 70 123 45 67").
    if ((!hasDigit(before) && !/\+\s*$/.test(before)) || !hasDigit(after)) continue;
    // A line break is read as nothing and a delimiter as itself. Every separator a search takes is OPTIONAL (a blank, a hyphen, a full stop), so what a number is with a blank put where the
    // text was broken it is without one too, and a text cut at a fixed width, anywhere, is read as it was before it was cut.
    const join = flow.seams[i] === "\n" ? "" : flow.seams[i]!;
    const crossing = across(before, join, after);
    if (crossing === undefined) continue;
    const startsAt = tail.length - before.length + crossing.start;
    const endsAt = Math.max(0, crossing.end - before.length - join.length);
    // Only where there is text beside the number: two letters, on the first segment before it or on the second after it.
    if (!WORD.test(`${tail.slice(0, startsAt)} ${head.slice(endsAt)}`)) continue;
    out[i] = tail.slice(0, startsAt) + take(crossing);
    out[i + 1] = head.slice(endsAt);
  }
  return out;
}

/**
 * The number that stands across the seam, or undefined. The findings are looked at apart (not merged): one that begins before the seam and ends after it is a candidate. It is not one if it
 * lies over a finding of either side (the side searched alone, or in the same text) without taking the whole of it in: that is a number the side has already, and a second reading of its digits
 * that happens to run on into the next line ("19580410-6309" at the end of a line and "151122-2166" at the start of the next, read without a blank between, are "6309151122" and a number that is not
 * there). A candidate that takes a side's finding in whole is that finding grown by what stands beyond the seam: "070-123 45" and "67".
 */
function across(before: string, join: string, after: string): Finding | undefined {
  const text = before + join + after;
  const beyond = before.length + join.length;
  const found = findUnmerged(text);
  const others = [
    ...found.filter((one) => one.end <= before.length || one.start >= beyond),
    ...findUnmerged(before),
    ...findUnmerged(after).map((one) => ({ ...one, start: one.start + beyond, end: one.end + beyond })),
  ];
  return found
    .filter((one) => NUMBERS.has(one.kind) && one.start < before.length && one.end > before.length)
    // Not ended in the middle of a word on the second side, and a telephone number of nine digits or more (see the head of this file).
    .filter((one) => !/^\p{L}/u.test(text.slice(one.end, one.end + 1)) && (one.kind !== "tel" || text.slice(one.start, one.end).replace(/\D/g, "").length >= 9))
    .filter((one) => others.every((other) => other.start >= one.end || other.end <= one.start || (one.start <= other.start && one.end >= other.end)))
    .sort((a, b) => Number(a.kind === "tel") - Number(b.kind === "tel") || b.end - b.start - (a.end - a.start))[0];
}

/** How many numbers stand across a seam of the flow: the check on a finished text, which must find none. */
export function countBridges(flow: Flow): number {
  let count = 0;
  bridgeFlow(flow, () => {
    count += 1;
    return "";
  });
  return count;
}
