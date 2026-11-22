/**
 * The pseudonymiser's run (Pseudonymiseraren, X1): plan the columns of each file, resolve what is to be done to each, replace,
 * count, and check the result. Pure functions, no React, no network, no clock, nothing stored; the marker book that holds the
 * values is made inside `pseudonymise` and gone when it returns.
 *
 * THE ORDER OF WHAT HAPPENS TO A CELL.
 *   - A column treated CLEAR is emptied.
 *   - A column treated MARK has each cell (or each part of a list in it) replaced whole by a marker of the column's kind.
 *   - Every other cell, a title above the header, the header row and every line of a text that is not a table: what looks like a
 *     personnummer, an address or a telephone number is replaced by its own marker, then the known names (pseudonym-names.ts).
 *
 * NO COLUMN IS DECIDED FOR THE USER IN SILENCE. A column with no proposal (pseudonym-headers.ts) and no choice stops the run:
 * `pseudonymise` returns the columns that are undecided and writes nothing.
 *
 * WHAT A REPORT HOLDS. Counts, kinds, headers (after the same replacement as the file's own), the form of the file and the notes of
 * what could not be judged. Never a value from a cell, and never a file name: it is made to be sent with the file. It does hold the TEXT OF THE HEADERS and the names of the sheets, as they stand in the safe
 * file (replaced there as any cell is, and not otherwise): a header that is a person's name, in a matrix nobody ticked as names, is in the report as it is in the file (the review of #398, L-7).
 *
 * THE CHECK. The finished cells are searched again, as the originals were: nothing personnummer-, address- or telephone-shaped
 * may be left in them (but the markers), and no known name in a cell that is running text. A run that does not pass is returned as
 * not passed, with where and how many, and the page does not hand out the file.
 */

import { findPersonalData, type Finding } from "@/lib/pseudonym-detect";
import { columnStats, headerGroup, proposalFor, type ColumnStats, type Proposal, type ProposalReason, type Treatment } from "@/lib/pseudonym-headers";
import type { Body, ParsedInput, InputFacts } from "@/lib/pseudonym-input";
import { KnownNames, runningWords } from "@/lib/pseudonym-names";
import { isMarker, keyOf, MarkerBook, MARKER_KINDS, MARKER_PATTERN, personalNumberKind, type MarkerKind } from "@/lib/pseudonym-markers";
import { bridgeFlow, countBridges, flowOf } from "@/lib/pseudonym-seams";
import { encodeText, writeTable, type OutputEncoding } from "@/lib/pseudonym-write";

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ColumnPlan {
  index: number;
  /** The header as written; empty when there is no header row or the header cell is empty. */
  header: string;
  stats: ColumnStats;
  proposal: Proposal | null;
}

export interface FilePlan {
  shape: "table" | "lines";
  /** The row the header stands on (null: none), and where it was chosen from. */
  headerRow: number | null;
  /** The numbers of the first rows, among which the user picks the header row. */
  headerCandidates: number[];
  /** The rows above the header. */
  titleRows: number;
  columns: ColumnPlan[];
}

const CANDIDATES = 10;

/**
 * The first of the first rows that is nearly as full as the fullest of them (four fifths of its filled cells), in a table of at
 * least two columns; null otherwise. A two-cell title above a six-column header is not mistaken for the header; a list of one
 * column has no header to guess.
 */
function defaultHeaderRow(rows: readonly (readonly string[])[], rowNumbers: readonly number[]): number | null {
  if (rows.reduce((width, row) => Math.max(width, row.length), 0) < 2) return null;
  const filled = rows.slice(0, CANDIDATES).map((row) => row.filter((cell) => cell.trim() !== "").length);
  const most = Math.max(...filled);
  if (most < 2) return null;
  const at = filled.findIndex((n) => n >= Math.ceil(most * 0.8));
  // A header names its columns and never holds a personnummer, an address or a telephone number as a whole cell; a record does. A file with no header row
  // would otherwise have its first person taken for the header: the names in that row are not collected as known names, the row is searched by shape
  // only, and "Anna Svensson" in the first row is left standing. The user can still say which row is the header (FileChoices.headerRow).
  if (rows[at]!.some(isWholePersonalValue)) return null;
  return rowNumbers[at]!;
}

/** True when a cell is, as a whole, one personnummer, address or telephone number. */
function isWholePersonalValue(cell: string): boolean {
  const trimmed = cell.trim();
  if (trimmed === "") return false;
  const found = findPersonalData(trimmed);
  return found.length === 1 && found[0]!.start === 0 && found[0]!.end === trimmed.length;
}

export function planFile(input: ParsedInput, headerRow?: number | null): FilePlan {
  if (input.body.shape === "lines") return { shape: "lines", headerRow: null, headerCandidates: [], titleRows: 0, columns: [] };
  const { rows, rowNumbers } = input.body;
  const chosen = headerRow === undefined || (headerRow !== null && !rowNumbers.includes(headerRow)) ? defaultHeaderRow(rows, rowNumbers) : headerRow;
  const at = chosen === null ? -1 : rowNumbers.indexOf(chosen);
  const body = rows.slice(at + 1);
  let width = at === -1 ? 0 : rows[at]!.length;
  for (const row of body) if (row.length > width) width = row.length;
  const columns: ColumnPlan[] = [];
  for (let index = 0; index < width; index += 1) {
    const header = at === -1 ? "" : (rows[at]![index] ?? "").trim();
    const stats = columnStats(body.map((row) => row[index] ?? ""));
    columns.push({ index, header, stats, proposal: proposalFor(header, stats) });
  }
  return { shape: "table", headerRow: chosen, headerCandidates: rowNumbers.slice(0, CANDIDATES), titleRows: Math.max(0, at), columns };
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

export interface FileChoices {
  /** undefined: the default (the first row with two filled cells); null: no header row. */
  headerRow?: number | null;
  /** The header row holds names (a matrix with a teacher to a column): its cells are replaced. */
  headersAreNames?: boolean;
  /** What the user chose for a column; a column not in it has its proposal. */
  treatments?: Readonly<Record<number, Treatment>>;
}

export interface RunChoices {
  /** The user's list of names and words to remove, one to a line. */
  words?: readonly string[];
  files: readonly FileChoices[];
}

/** The treatment of each column: the user's choice, else the proposal, else null (undecided). */
export function resolveTreatments(plan: FilePlan, choices: FileChoices | undefined): (Treatment | null)[] {
  return plan.columns.map((column) => choices?.treatments?.[column.index] ?? column.proposal?.treatment ?? null);
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export interface KindTally {
  /** Cells (or parts of a list) of a column treated as this kind. */
  column: number;
  /** Found in a cell by how it looks. */
  content: number;
  /** Known names found in running text (and the user's words everywhere). */
  names: number;
}

export type Tally = Record<MarkerKind, KindTally>;

const emptyTally = (): Tally => Object.fromEntries(MARKER_KINDS.map((kind) => [kind, { column: 0, content: 0, names: 0 }])) as Tally;

export const occurrencesOf = (tally: KindTally): number => tally.column + tally.content + tally.names;

export interface ColumnReport {
  index: number;
  /** The header as it stands in the safe file. */
  header: string;
  treatment: Treatment;
  /** Who decided: the header, the values, or the user's own choice. */
  by: ProposalReason | "user";
  detail: string;
  filled: number;
  /** Cells that differ from the original. */
  changed: number;
}

export type Note =
  | { code: "lines"; file: number }
  | { code: "titleRows"; file: number; rows: number }
  | { code: "freeText"; file: number; column: number }
  | { code: "manyReplaced"; file: number; column: number }
  | { code: "unterminated"; file: number }
  | { code: "encodingFellBack"; file: number };

export interface FileReport {
  facts: Pick<InputFacts, "origin" | "encoding" | "bom" | "eol" | "delimiter" | "unterminated">;
  /** The sheet's name as it stands in the safe copy. */
  sheet: string | null;
  shape: "table" | "lines";
  /** Rows (non-empty records) or lines. */
  rows: number;
  columns: ColumnReport[];
  headerRow: number | null;
  titleRows: number;
  tally: Tally;
  /** Cells that got the formula guard, and cells that were cleared. */
  guarded: number;
  cleared: number;
  /** The encoding of the bytes, which is UTF-8 when the file's own could not hold the text. */
  encoding: OutputEncoding;
}

export interface PreviewRow {
  number: number;
  cells: string[];
}

export interface SafeFile {
  text: string;
  bytes: Uint8Array;
  encoding: OutputEncoding;
  /** The title rows, the header and the first rows of what was written. */
  preview: PreviewRow[];
}

export interface RunReport {
  files: FileReport[];
  /** Run-wide: how many were replaced and how many different values (markers) that made. */
  totals: Record<MarkerKind, { occurrences: number; distinct: number }>;
  /** Of the personnummer and samordningsnummer FOUND BY SHAPE in a cell: how many had a check digit that holds. A number whose digit does not hold is replaced all the same. */
  checkDigit: { pnr: { holds: number; fails: number }; sam: { holds: number; fails: number } };
  /** How personnummer were written (a pattern, never a value), commonest first. */
  spellings: { spelling: string; count: number }[];
  /** Names known from columns, and words in the user's list. */
  knownNames: number;
  notes: Note[];
}

export type RunResult =
  | { ok: false; undecided: { file: number; columns: number[] }[] }
  | {
      ok: true;
      files: SafeFile[];
      report: RunReport;
      /** The check of the finished cells: where something was left that should not be, as a count and never a value. */
      check: { passed: boolean; failures: { file: number; count: number }[] };
    };

// ---------------------------------------------------------------------------
// Replacing
// ---------------------------------------------------------------------------

interface Context {
  book: MarkerBook;
  names: KnownNames;
  tally: Tally;
  checks: RunReport["checkDigit"];
  spellings: Map<string, number>;
}

interface Span {
  start: number;
  end: number;
  marker: string;
}

/** Replaces the spans (not overlapping, in any order) of a text. */
function applySpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let from = 0;
  for (const span of spans) {
    out += text.slice(from, span.start) + span.marker;
    from = span.end;
  }
  return out + text.slice(from);
}

/** What a cell becomes when it is searched for what looks personal and for known names. `running`: look for names from columns too. */
function replaceFound(value: string, running: boolean, ctx: Context): string {
  const spans: Span[] = [];
  for (const found of findPersonalData(value)) {
    ctx.tally[found.kind].content += 1;
    spans.push({ start: found.start, end: found.end, marker: ctx.book.marker(found.kind, found.key) });
    recordNumber(found, ctx);
  }
  for (const hit of ctx.names.find(value, running)) {
    if (spans.some((span) => hit.start < span.end && hit.end > span.start)) continue;
    ctx.tally[hit.kind].names += 1;
    spans.push({ start: hit.start, end: hit.end, marker: ctx.book.marker(hit.kind, hit.key) });
  }
  return applySpans(value, spans);
}

/**
 * A number that stands across a seam (lib/pseudonym-seams.ts: a line break in a text that is no table, or a comma read as a delimiter in a list) is replaced like any other number found in a cell
 * by how it looks, counted as one, and the marker it gets is what the seam's first segment ends with.
 */
function replaceBridged(found: Finding, ctx: Context): string {
  ctx.tally[found.kind].content += 1;
  recordNumber(found, ctx);
  return ctx.book.marker(found.kind, found.key);
}

/** A list in a cell is replaced item by item: names split on ; / | and line breaks, signatures on commas too. */
const LIST: Partial<Record<MarkerKind, RegExp>> = {
  namn: /([;/|\r\n]+)/,
  fornamn: /([;/|\r\n]+)/,
  efternamn: /([;/|\r\n]+)/,
  sign: /([;,/|\r\n]+)/,
};

/** The pieces of a cell of a marked column: [text, separator, text, …]. */
const piecesOf = (value: string, kind: MarkerKind): string[] => {
  const separator = LIST[kind];
  return separator === undefined ? [value] : value.split(separator);
};

/** The marker kind of a whole cell of a personnummer column: a samordningsnummer when the day says so. */
const wholeKind = (kind: MarkerKind, value: string): MarkerKind => (kind === "pnr" || kind === "sam" ? personalNumberKind(value) : kind);

/** How a personnummer was written and whether its check digit holds: counted for every number found by shape, in a marked column or a free cell. */
function recordNumber(found: Finding, ctx: Context): void {
  if (found.kind !== "pnr" && found.kind !== "sam" && found.kind !== "tf") return;
  // A TF number has no check digit: it is counted by how it was written and never as a number whose digit does not hold.
  if (found.kind !== "tf") ctx.checks[found.kind][found.checkDigit ? "holds" : "fails"] += 1;
  if (found.spelling !== undefined) ctx.spellings.set(found.spelling, (ctx.spellings.get(found.spelling) ?? 0) + 1);
}

/** What a cell of a MARKED column becomes. */
function replaceMarked(value: string, kind: MarkerKind, ctx: Context): string {
  // A cell that is a marker already has been through here: it stays, so that running the tool on its own output changes nothing.
  if (value.trim() === "" || isMarker(value)) return value;
  if (kind === "pnr" || kind === "epost" || kind === "tel") {
    // A cell that is what the column says it is (one or several, with separators) keeps each as its own marker; anything else in it is replaced whole.
    // A column of personnummer holds TF numbers too (Skola24's ID columns do): each is its own marker, counted as TF and not as a number with a bad check digit.
    const sameKind = findPersonalData(value).filter((f) => (kind === "pnr" ? f.kind === "pnr" || f.kind === "sam" || f.kind === "tf" : f.kind === kind));
    const rest = applySpans(
      value,
      sameKind.map((f) => ({ start: f.start, end: f.end, marker: "" })),
    );
    if (sameKind.length > 0 && rest.replace(/[\s;,/|]/g, "") === "") {
      for (const f of sameKind) {
        ctx.tally[f.kind].column += 1;
        recordNumber(f, ctx);
      }
      return applySpans(
        value,
        sameKind.map((f) => ({ start: f.start, end: f.end, marker: ctx.book.marker(f.kind, f.key) })),
      );
    }
    // A cell of a personnummer column that holds TF numbers and other text (and nothing else that is personal) is replaced whole, but as what it holds: the
    // marker the number has on its own, and counted as TF. wholeKind reads the cell's digits for a day and would call it PNR, a second marker for the same TF.
    if (kind === "pnr" && sameKind.length > 0 && sameKind.every((f) => f.kind === "tf")) {
      ctx.tally.tf.column += 1;
      return ctx.book.marker("tf", [...new Set(sameKind.map((f) => f.key))].sort().join("|"));
    }
    const whole = wholeKind(kind, value);
    ctx.tally[whole].column += 1;
    return ctx.book.marker(whole, keyOf(whole, value));
  }
  return piecesOf(value, kind)
    .map((piece, i) => {
      if (i % 2 === 1 || piece.trim() === "" || isMarker(piece)) return piece;
      ctx.tally[kind].column += 1;
      const lead = piece.slice(0, piece.length - piece.trimStart().length);
      const tail = piece.slice(piece.trimEnd().length);
      return lead + ctx.book.marker(kind, keyOf(kind, piece)) + tail;
    })
    .join("");
}

/** The names in a marked name column and in the user's list, collected before anything is replaced. */
function collectNames(inputs: readonly ParsedInput[], plans: readonly FilePlan[], resolved: readonly (readonly (Treatment | null)[])[], choices: RunChoices): KnownNames {
  const names = new KnownNames();
  for (const line of choices.words ?? []) names.addLine(line);
  inputs.forEach((input, f) => {
    if (input.body.shape !== "table") return;
    const { rows, rowNumbers } = input.body;
    const plan = plans[f]!;
    const at = plan.headerRow === null ? -1 : rowNumbers.indexOf(plan.headerRow);
    if (choices.files[f]?.headersAreNames === true && at !== -1) for (const cell of rows[at]!) if (headerGroup(cell) !== "structure") names.addCell(cell, "namn");
    resolved[f]!.forEach((treatment, column) => {
      if (treatment?.kind !== "mark") return;
      const kind = treatment.marker;
      if (kind !== "namn" && kind !== "fornamn" && kind !== "efternamn") return;
      for (const row of rows.slice(at + 1)) {
        const cell = row[column];
        if (cell === undefined) continue;
        piecesOf(cell, kind).forEach((piece, i) => {
          if (i % 2 === 0) names.addCell(piece, kind);
        });
      }
    });
  });
  return names;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** How many things that should be gone are left in a cell (the check, and its test). */
export function leftIn(cell: string, names: KnownNames): number {
  const bare = cell.replace(MARKER_PATTERN, " ");
  return findPersonalData(bare).length + names.find(bare, runningWords(bare) >= 2).length;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const PREVIEW_ROWS = 25;
const FREE_TEXT_WORDS = 3;

export function pseudonymise(inputs: readonly ParsedInput[], choices: RunChoices): RunResult {
  const plans = inputs.map((input, f) => planFile(input, choices.files[f]?.headerRow));
  const resolved = plans.map((plan, f) => resolveTreatments(plan, choices.files[f]));
  const undecided = resolved
    .map((treatments, file) => ({ file, columns: treatments.flatMap((t, column) => (t === null ? [column] : [])) }))
    .filter((entry) => entry.columns.length > 0);
  if (undecided.length > 0) return { ok: false, undecided };

  const names = collectNames(inputs, plans, resolved, choices);
  const book = new MarkerBook();
  const checks: RunReport["checkDigit"] = { pnr: { holds: 0, fails: 0 }, sam: { holds: 0, fails: 0 } };
  const spellings = new Map<string, number>();
  const notes: Note[] = [];
  const files: SafeFile[] = [];
  const reports: FileReport[] = [];
  const failures: { file: number; count: number }[] = [];

  inputs.forEach((input, f) => {
    const plan = plans[f]!;
    const tally = emptyTally();
    const ctx: Context = { book, names, tally, checks, spellings };
    const fileChoices = choices.files[f];
    let guarded = 0;
    let cleared = 0;
    let columns: ColumnReport[] = [];
    let preview: PreviewRow[] = [];
    let text: string;
    let outputCells: readonly string[] = [];
    /** What was written, as a body: the check looks across its seams too. */
    let written: Body;
    let rowCount: number;
    let sheet = input.facts.sheet;

    if (input.facts.sheet !== null) sheet = replaceFound(input.facts.sheet, true, ctx);
    if (input.facts.unterminated) notes.push({ code: "unterminated", file: f });

    // A number cut by a line break, or by a comma read as a delimiter, is put together before each piece is searched on its own.
    const flow = flowOf(input.body, input.facts.delimiter);
    const body = flow === null ? input.body : flow.rebuild(bridgeFlow(flow, (found) => replaceBridged(found, ctx)));

    if (body.shape === "lines") {
      notes.push({ code: "lines", file: f });
      const lines = body.lines.map((line) => replaceFound(line, true, ctx));
      text = lines.join(input.facts.eol);
      outputCells = lines;
      written = { shape: "lines", lines };
      rowCount = lines.filter((line) => line.trim() !== "").length;
      preview = lines.slice(0, PREVIEW_ROWS + 10).map((line, i) => ({ number: i + 1, cells: [line] }));
    } else {
      const { rows, rowNumbers } = body;
      const original = input.body.shape === "table" ? input.body.rows : rows;
      const treatments = resolved[f]!;
      const at = plan.headerRow === null ? -1 : rowNumbers.indexOf(plan.headerRow);
      const changed = new Array<number>(treatments.length).fill(0);
      const longText = new Array<number>(treatments.length).fill(0);
      const out: string[][] = [];

      rows.forEach((row, r) => {
        if (r < at) {
          // A title or anything else above the header: free text, searched for everything.
          out.push(row.map((cell) => replaceFound(cell, true, ctx)));
        } else if (r === at) {
          // With "the header holds names" on, every header cell is a name but the words the lists know as structure (Tid, Dag): a matrix keeps its corner.
          const namesInHeader = fileChoices?.headersAreNames === true;
          out.push(
            row.map((cell) =>
              namesInHeader && cell.trim() !== "" && headerGroup(cell) !== "structure" ? replaceMarked(cell, "namn", ctx) : replaceFound(cell, runningWords(cell) >= 2, ctx),
            ),
          );
        } else {
          out.push(
            row.map((cell, c) => {
              const treatment = treatments[c]!;
              let next: string;
              if (treatment.kind === "clear") {
                next = "";
                if (cell !== "") cleared += 1;
              } else if (treatment.kind === "mark") {
                next = replaceMarked(cell, treatment.marker, ctx);
              } else {
                const running = runningWords(cell);
                if (running >= FREE_TEXT_WORDS) longText[c]! += 1;
                next = replaceFound(cell, running >= 2, ctx);
              }
              if (next !== original[r]![c]) changed[c]! += 1;
              return next;
            }),
          );
        }
      });

      const wrote = writeTable(out, rowNumbers, input.facts.delimiter ?? ";", input.facts.eol, input.facts.finalEol);
      text = wrote.text;
      guarded = wrote.guarded;
      outputCells = out.flat();
      written = { shape: "table", rows: out, rowNumbers };
      rowCount = rows.length;
      preview = out.slice(0, Math.max(0, at) + 1 + PREVIEW_ROWS).map((cells, i) => ({ number: rowNumbers[i]!, cells }));
      if (at > 0) notes.push({ code: "titleRows", file: f, rows: at });
      columns = plan.columns.map((column) => {
        const treatment = treatments[column.index]!;
        const user = fileChoices?.treatments?.[column.index];
        const filled = column.stats.filled;
        if (treatment.kind === "keep" && longText[column.index]! > 0 && longText[column.index]! * 10 >= filled) notes.push({ code: "freeText", file: f, column: column.index });
        if (treatment.kind === "keep" && filled > 0 && changed[column.index]! * 10 >= filled * 3) notes.push({ code: "manyReplaced", file: f, column: column.index });
        return {
          index: column.index,
          header: at === -1 ? "" : (out[at]![column.index] ?? "").trim(),
          treatment,
          by: user !== undefined ? "user" : column.proposal!.reason,
          detail: user !== undefined ? "" : column.proposal!.detail,
          filled,
          changed: changed[column.index]!,
        } satisfies ColumnReport;
      });
    }

    const encoded = encodeText(text, input.facts.encoding, input.facts.bom);
    if (encoded.fellBack) notes.push({ code: "encodingFellBack", file: f });

    // The check, on the finished cells and not on the joined text: a number split over two cells is two cells here as it was in the original.
    let left = 0;
    for (const cell of outputCells) left += leftIn(cell, names);
    // And a number that stands across a seam of the finished text: the cells are each clean and the text read as it was written is not.
    const finished = flowOf(written, input.facts.delimiter);
    if (finished !== null) left += countBridges(finished);
    if (left > 0) failures.push({ file: f, count: left });

    files.push({ text, bytes: encoded.bytes, encoding: encoded.encoding, preview });
    reports.push({
      facts: { origin: input.facts.origin, encoding: input.facts.encoding, bom: input.facts.bom, eol: input.facts.eol, delimiter: input.facts.delimiter, unterminated: input.facts.unterminated },
      sheet,
      shape: plan.shape,
      rows: rowCount,
      columns,
      headerRow: plan.headerRow,
      titleRows: plan.titleRows,
      tally,
      guarded,
      cleared,
      encoding: encoded.encoding,
    });
  });

  const totals = Object.fromEntries(
    MARKER_KINDS.map((kind) => [kind, { occurrences: reports.reduce((sum, r) => sum + occurrencesOf(r.tally[kind]), 0), distinct: book.distinct(kind) }]),
  ) as RunReport["totals"];

  return {
    ok: true,
    files,
    report: {
      files: reports,
      totals,
      checkDigit: checks,
      spellings: [...spellings].map(([spelling, count]) => ({ spelling, count })).sort((a, b) => b.count - a.count || a.spelling.localeCompare(b.spelling)),
      knownNames: names.size,
      notes,
    },
    check: { passed: failures.length === 0, failures },
  };
}
