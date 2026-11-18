/**
 * The mapping of a file's columns to a kind's fields (Kolumnmappning, X2): pure functions, no React, no network, no clock.
 *
 * THE IDEA. The user points out which column of their own file is which field of Rastra's, once, and a template keeps it.
 * `applyMapping` then rewrites the file to what the kind's reader already reads: every placed column under the field's own
 * header (lib/column-fields.ts), in a table the importers' mappers (lib/csv.ts) and the gateway's reader
 * (src/schedule-exchange/lesson-table.ts) take as they take their own. The rules of Rastra (the lengths, the grid, who may
 * be a teacher) are those readers' and are not repeated here. What is the mapping's own is small: which column is which,
 * which is dropped, what is named, and the two combined fields.
 *
 * NOTHING IS GUESSED. A column is placed by a template the user saved, by a header the importer already accepts
 * (lib/csv-aliases.ts: the same list the mappers use), or by the user. Every other column is `unplaced` and is NAMED, never
 * matched by likeness; a column two things claim is `duplicate` and the user chooses, never "the first one wins".
 *
 * NO PERSONNUMMER LEAVES THE BROWSER. A column that looks like personnummer is dropped here, before anything is sent
 * (web/lib/personal-number.ts holds the shape, equal to the gateway's). A cell in a column that IS read that has the shape
 * holds its row back, with a message that names the row and the column and never the value, as the gateway's reader does
 * (src/schedule-exchange/lesson-table.ts: the row is unreadable). Nothing the mapping answers holds a number: not a cell, not a
 * header (a header that is one is not named), not a message.
 */

import { COMBINED_OUTPUT, FIELDS, FIELD_CONFLICTS, fieldOf, type CombinedField, type FieldSpec, type TemplateKind } from "@/lib/column-fields";
import { writeMappedTable, type RawTable } from "@/lib/column-table";
import { normalizeHeader } from "@/lib/csv-export";
import { hasPersonalNumber, isPersonalNumberHeader, redactPersonalNumbers } from "@/lib/personal-number";

// ---------------------------------------------------------------------------
// The header row and its columns
// ---------------------------------------------------------------------------

/** The header row chosen, and what lies below it. */
export interface Block {
  /** The file row the headers stand on, as Excel numbers it. */
  headerRowNumber: number;
  /** The header cells, trimmed. */
  headers: string[];
  /** A header's key: normalised, `#2`, `#3` for a header that stands twice, `kolumn<n>` for one that normalises to nothing. */
  keys: string[];
  /** The rows below the header, each as wide as the header (a cell right of the last header is dropped and the row listed in `overflowRows`). */
  body: string[][];
  /** The file row of each body row. */
  rowNumbers: number[];
  overflowRows: number[];
  unterminated: boolean;
}

/** The keys of a header row: unique, and stable under case, spacing, punctuation and diacritics. */
export function keysOf(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    // A header that has the shape of a number is never a key (a key is stored and sent): that column is known by its position.
    const normalised = normalizeHeader(header);
    const base = normalised === "" || hasPersonalNumber(header) || hasPersonalNumber(normalised) ? `kolumn${index + 1}` : normalised;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}

/** The key without its `#n`: the spelling a field's aliases are compared to. */
const baseOf = (key: string): string => key.replace(/#\d+$/, "");

/**
 * The block under the header row. `headerRow` is the file row the headers stand on (a title above them is skipped), or null
 * for the first row with content. Null when the table is empty or has no row with that number.
 */
export function chooseHeaderRow(table: RawTable, headerRow: number | null): Block | null {
  if (table.rows.length === 0) return null;
  const at = headerRow === null ? 0 : table.rowNumbers.indexOf(headerRow);
  if (at === -1) return null;
  const headers = table.rows[at]!.map((cell) => cell.trim());
  const body: string[][] = [];
  const rowNumbers: number[] = [];
  const overflowRows: number[] = [];
  for (let i = at + 1; i < table.rows.length; i += 1) {
    const raw = table.rows[i]!;
    if (raw.slice(headers.length).some((cell) => cell.trim() !== "")) overflowRows.push(table.rowNumbers[i]!);
    const row = raw.slice(0, headers.length).map((cell) => cell.trim());
    while (row.length < headers.length) row.push("");
    body.push(row);
    rowNumbers.push(table.rowNumbers[i]!);
  }
  return { headerRowNumber: table.rowNumbers[at]!, headers, keys: keysOf(headers), body, rowNumbers, overflowRows, unterminated: table.unterminated };
}

/** The first rows of a table, for the user to say which one holds the headers: their file row numbers. */
export function headerRowCandidates(table: RawTable, most = 10): number[] {
  return table.rowNumbers.slice(0, most);
}

// ---------------------------------------------------------------------------
// Personnummer
// ---------------------------------------------------------------------------

/**
 * The columns that look like personnummer: a header that says so (or is one), or a column where at least half of the filled
 * cells have the shape. A single cell with the shape in another column is not this: it holds its row back (applyMapping).
 */
export function personalNumberColumns(block: Block): Set<number> {
  const found = new Set<number>();
  block.headers.forEach((header, index) => {
    if (isPersonalNumberHeader(normalizeHeader(header)) || hasPersonalNumber(header)) {
      found.add(index);
      return;
    }
    let filled = 0;
    let numbers = 0;
    for (const row of block.body) {
      const cell = row[index]!;
      if (cell === "") continue;
      filled += 1;
      if (hasPersonalNumber(cell)) numbers += 1;
    }
    if (numbers >= 1 && numbers * 2 >= filled) found.add(index);
  });
  return found;
}

/** A header as a message may show it: redacted, one line, at most 40 characters; null for a header that is itself a number (not named). */
function labelOf(header: string): string | null {
  if (hasPersonalNumber(header)) return null;
  const flat = redactPersonalNumbers(header).replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

// ---------------------------------------------------------------------------
// Templates and recognition
// ---------------------------------------------------------------------------

export interface TemplatePlacement {
  key: string;
  label: string;
  field: string | null;
}

/** A school's saved mapping, as the gateway answers it (src/import-templates). */
export interface MappingTemplate {
  id: string;
  kind: TemplateKind;
  name: string;
  headerRow: number | null;
  placements: TemplatePlacement[];
}

/**
 * What a column is to be: a field id; null for "read nothing from it" (the user's choice, kept); undefined for "not placed",
 * which is the state of a column nobody has said anything about.
 */
export type Assignment = (string | null | undefined)[];

export type Source = "template" | "alias" | "user";
export type ColumnStatus = "placed" | "skipped" | "unplaced" | "personalNumber" | "duplicate";

export interface ColumnState {
  index: number;
  /** The header as written, redacted; null for a header that has the shape of a number. */
  label: string | null;
  key: string;
  status: ColumnStatus;
  /** The field it is placed on, for a placed or a duplicate column. */
  field: string | null;
  /** Up to three filled cells, for the user to see what the column holds; empty for a personnummer column. */
  sample: string[];
}

export interface Recognition {
  block: Block;
  /** The template that fits and was applied, or null. */
  template: MappingTemplate | null;
  /** "exact": the file has the template's columns and no others; "subset": it has them and more. */
  reason: "exact" | "subset" | null;
  /** Templates that expect a column the file does not have, with the keys that are missing: offered, never applied by themselves. */
  offered: { template: MappingTemplate; missing: string[] }[];
  /** Templates that fit equally well, when none could be chosen: the user chooses. */
  ambiguous: MappingTemplate[];
  /** The columns as placed by the template, or by the importer's own spellings when there is none. */
  assignment: Assignment;
}

/** The fields whose aliases (the importer's own spellings) include a key's base. */
function fieldsNaming(kind: TemplateKind, key: string): FieldSpec[] {
  // A header that stands twice names the same fields twice: both columns claim them, and neither is placed until the user chooses.
  const base = baseOf(key);
  return FIELDS[kind].filter((field) => field.aliases.includes(base));
}

/**
 * The columns placed by the importer's own spellings: a column whose header the importer already reads is that field. A
 * header two fields claim, and a field two columns claim, are left unplaced (and shown as duplicate): the user chooses.
 */
export function aliasAssignment(block: Block, kind: TemplateKind): Assignment {
  const dropped = personalNumberColumns(block);
  const claims = new Map<string, number[]>();
  block.keys.forEach((key, index) => {
    if (dropped.has(index)) return;
    const named = fieldsNaming(kind, key);
    if (named.length !== 1) return;
    const field = named[0]!.id;
    claims.set(field, [...(claims.get(field) ?? []), index]);
  });
  const assignment: Assignment = block.headers.map(() => undefined);
  for (const [field, columns] of claims) {
    // Two columns for one field are both shown as claiming it; neither is placed until the user chooses.
    if (columns.length === 1) assignment[columns[0]!] = field;
  }
  return assignment;
}

/** A template's own columns against the file's keys. */
function fitOf(template: MappingTemplate, keys: ReadonlySet<string>): { missing: string[]; placed: number } {
  const own = template.placements.map((post) => post.key);
  return { missing: own.filter((key) => !keys.has(key)), placed: own.length };
}

/**
 * Which saved template, if any, fits these headers. Reading the file's keys against each template's:
 *   - the file has every column the template names (and may have more): the template fits; "exact" when the sets are equal.
 *   - the most columns placed wins; two that tie fit equally, and none is chosen.
 *   - a template that expects a column the file lacks is not applied by itself, only offered.
 * A template with no posts says nothing and is not considered.
 */
export function matchTemplates(block: Block, templates: readonly MappingTemplate[]): Omit<Recognition, "block" | "assignment"> {
  const keys = new Set(block.keys);
  const fitting: { template: MappingTemplate; placed: number; exact: boolean }[] = [];
  const offered: { template: MappingTemplate; missing: string[] }[] = [];
  for (const template of templates) {
    if (template.placements.length === 0) continue;
    const { missing, placed } = fitOf(template, keys);
    if (missing.length === 0) {
      fitting.push({ template, placed, exact: placed === keys.size });
    } else if (missing.length < placed) {
      offered.push({ template, missing });
    }
  }
  const best = Math.max(0, ...fitting.map((entry) => entry.placed));
  const top = fitting.filter((entry) => entry.placed === best);
  if (top.length === 1) {
    return { template: top[0]!.template, reason: top[0]!.exact ? "exact" : "subset", offered, ambiguous: [] };
  }
  return { template: null, reason: null, offered, ambiguous: top.map((entry) => entry.template) };
}

/** The assignment a template makes of a block: its posts by key; every other column left unplaced, to be named. */
export function templateAssignment(block: Block, template: MappingTemplate): Assignment {
  const byKey = new Map(template.placements.map((post) => [post.key, post.field]));
  return block.keys.map((key) => (byKey.has(key) ? byKey.get(key)! : undefined));
}

/**
 * The header row, the template and the columns for a table, in one: tries the first row with content, and the header row
 * each template names, and takes the first that one of the templates fits. With no template, the first row with content and
 * the importer's own spellings. Null when the table has no rows.
 *
 * With `fixedHeaderRow` (the user said where the headers stand) only that row is tried, and the templates that are for it:
 * those that name it, and those that name none when it is the first row with content.
 */
export function recognise(table: RawTable, kind: TemplateKind, templates: readonly MappingTemplate[], fixedHeaderRow: number | null = null): Recognition | null {
  const own = templates.filter((template) => template.kind === kind);
  const rows = fixedHeaderRow !== null ? [fixedHeaderRow] : [null, ...new Set(own.map((template) => template.headerRow).filter((row): row is number => row !== null))];
  const forRow = (row: number | null) =>
    own.filter((template) => (fixedHeaderRow === null ? template.headerRow === row : template.headerRow === row || (template.headerRow === null && row === table.rowNumbers[0])));
  // No template fits on any row: the row that comes nearest (a template is offered there, or two tie) is the one shown, else the first.
  let fallback: { found: Recognition; score: number } | null = null;
  for (const headerRow of rows) {
    const block = chooseHeaderRow(table, headerRow);
    if (block === null) continue;
    const match = matchTemplates(block, forRow(headerRow));
    if (match.template !== null) {
      return { block, ...match, assignment: templateAssignment(block, match.template) };
    }
    const score = match.offered.length + match.ambiguous.length;
    if (fallback === null || score > fallback.score) fallback = { found: { block, ...match, assignment: aliasAssignment(block, kind) }, score };
  }
  return fallback?.found ?? null;
}

/** The state of every column under an assignment: placed, skipped, unplaced, a personnummer column, or a duplicate. */
export function describeColumns(block: Block, kind: TemplateKind, assignment: Assignment): ColumnState[] {
  const dropped = personalNumberColumns(block);
  const claimed = new Map<string, number>();
  assignment.forEach((field, index) => {
    if (typeof field === "string" && !dropped.has(index)) claimed.set(field, (claimed.get(field) ?? 0) + 1);
  });
  // Two columns the importer's own spellings both read as one field are a duplicate too, though neither is placed.
  const spelled = new Map<string, number>();
  block.keys.forEach((key, index) => {
    const named = fieldsNaming(kind, key);
    if (named.length === 1 && !dropped.has(index) && assignment[index] === undefined) spelled.set(named[0]!.id, (spelled.get(named[0]!.id) ?? 0) + 1);
  });
  return block.keys.map((key, index): ColumnState => {
    // A cell with the shape of a number is never shown, in a column that is not a personnummer column either.
    const sample = dropped.has(index) ? [] : block.body.map((row) => row[index]!).filter((cell) => cell !== "" && !hasPersonalNumber(cell)).slice(0, 3);
    const base = { index, label: labelOf(block.headers[index]!), key, sample };
    if (dropped.has(index)) return { ...base, status: "personalNumber", field: null };
    const field = assignment[index];
    if (typeof field === "string") return { ...base, status: (claimed.get(field) ?? 0) > 1 ? "duplicate" : "placed", field };
    if (field === null) return { ...base, status: "skipped", field: null };
    const named = fieldsNaming(kind, key);
    if (named.length === 1 && (spelled.get(named[0]!.id) ?? 0) > 1) return { ...base, status: "duplicate", field: named[0]!.id };
    return { ...base, status: "unplaced", field: null };
  });
}

/** The posts of a template for this block's columns: every column that has been said something about; unplaced columns have no post. */
export function placementsOf(block: Block, kind: TemplateKind, assignment: Assignment): TemplatePlacement[] {
  const dropped = personalNumberColumns(block);
  const posts: TemplatePlacement[] = [];
  block.keys.forEach((key, index) => {
    const field = assignment[index];
    if (field === undefined) return;
    if (typeof field === "string" && fieldOf(kind, field) === undefined) return;
    // A header that is itself a number is kept by position (keysOf) and says no label; a personnummer column is kept as one to read nothing from.
    posts.push({ key, label: labelOf(block.headers[index]!) ?? "", field: dropped.has(index) ? null : field });
  });
  return posts;
}

// ---------------------------------------------------------------------------
// Applying a mapping
// ---------------------------------------------------------------------------

export interface ColumnRef {
  index: number;
  /** As a message may show it; null for a header that has the shape of a number. */
  label: string | null;
}

/** Something wrong with the mapping as a whole: said by a code and the field or columns it is about, worded by the page. */
export interface FileProblem {
  code: "MISSING_REQUIRED" | "DUPLICATE_TARGET" | "FIELDS_CONFLICT" | "UNKNOWN_FIELD";
  field?: string;
  /** For a conflict: the other field. For a duplicate: the labels of the columns placed on the field. */
  other?: string;
  columns?: (string | null)[];
}

/** A row that was held back and why. `message` is Swedish prose with the row's number, like the importers' own. */
export interface RowProblem {
  row: number;
  code: "PERSONAL_NUMBER_IN_CELL" | "TIME_RANGE_UNREADABLE" | "TOO_MANY_TEACHERS";
  message: string;
}

export interface Warning {
  code: "UNTERMINATED_QUOTE" | "CELLS_RIGHT_OF_HEADER" | "REPLACEMENT_CHARACTER";
  /** The file rows it concerns, for the second kind. */
  rows?: number[];
}

export interface Applied {
  /** Nothing is wrong: no problem of the mapping, and no row held back. */
  ok: boolean;
  problems: FileProblem[];
  /** The first MAX_ROW_PROBLEMS, and how many more there were. */
  rowProblems: RowProblem[];
  hiddenRowProblems: number;
  /**
   * Rows with nothing in any column that is read: a blank line to the readers at both ends, so they are not written, and
   * their file rows are named here instead of vanishing.
   */
  emptied: number[];
  /** The headers each placed field is written under, and the rows as cells under them. */
  headers: string[];
  rows: string[][];
  rowNumbers: number[];
  dropped: ColumnRef[];
  unplaced: ColumnRef[];
  skipped: ColumnRef[];
  /** The table as text for the gateway's reader: the header and each row on the row it came from, in UTF-8. */
  csv: string;
  /** The table as the importers' mappers take it (lib/csv.ts ParsedCsv). */
  parsed: {
    headers: string[];
    rows: string[][];
    delimiter: ";";
    rowNumbers: number[];
    unterminatedAt: number | null;
    overflowRows: number[];
  };
  warnings: Warning[];
}

/** The most row problems one mapping reports; the rest are counted. */
export const MAX_ROW_PROBLEMS = 200;

const TIME_RANGE = /^(\d{1,2}[:.]\d{2})\s*[-‐-―−]\s*(\d{1,2}[:.]\d{2})$/;
const TEACHER_SEPARATOR = /\s*(?:[,;/|&]|\soch\s)\s*/i;

const refOf = (block: Block, index: number): ColumnRef => ({ index, label: labelOf(block.headers[index]!) });
const nameOf = (label: string | null): string => (label === null ? "(rubriken visas inte)" : `”${label}”`);

/** What the combined fields write, in the plain fields' ids, in the order of `COMBINED_OUTPUT`. */
function splitCombined(kind: CombinedField, cell: string): { cells: [string, string] } | { problem: "TIME_RANGE_UNREADABLE" | "TOO_MANY_TEACHERS"; count?: number } {
  if (cell === "") return { cells: ["", ""] };
  if (kind === "timeRange") {
    const match = TIME_RANGE.exec(cell);
    return match === null ? { problem: "TIME_RANGE_UNREADABLE" } : { cells: [match[1]!, match[2]!] };
  }
  const parts = cell.split(TEACHER_SEPARATOR).map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length > 2) return { problem: "TOO_MANY_TEACHERS", count: parts.length };
  return { cells: [parts[0] ?? "", parts[1] ?? ""] };
}

/**
 * The file as the user's mapping says. `assignment[i]` is column i's field (null to read nothing from it, undefined for not
 * placed). A personnummer column is dropped whatever the assignment says of it. Problems of the mapping as a whole (a
 * required field not placed, a field placed on two columns, two fields that read the same cells, a field that is not the
 * kind's) leave no rows: the file cannot be read as it stands. A row with a personnummer in a column that is read, or with a
 * combined cell that does not split, is held back and named; the rest are mapped, and `ok` is false.
 */
export function applyMapping(block: Block, kind: TemplateKind, assignment: Assignment): Applied {
  const dropped = personalNumberColumns(block);
  const columns = block.headers.map((_, index) => index);
  const droppedRefs = columns.filter((index) => dropped.has(index)).map((index) => refOf(block, index));
  const skipped = columns.filter((index) => !dropped.has(index) && assignment[index] === null).map((index) => refOf(block, index));
  const unplaced = columns.filter((index) => !dropped.has(index) && assignment[index] === undefined).map((index) => refOf(block, index));

  // Which column holds each field, and the problems of the mapping as a whole.
  const problems: FileProblem[] = [];
  const holders = new Map<string, number[]>();
  for (const index of columns) {
    const field = assignment[index];
    if (typeof field !== "string" || dropped.has(index)) continue;
    if (fieldOf(kind, field) === undefined) {
      problems.push({ code: "UNKNOWN_FIELD", field });
      continue;
    }
    holders.set(field, [...(holders.get(field) ?? []), index]);
  }
  for (const [field, at] of holders) {
    if (at.length > 1) problems.push({ code: "DUPLICATE_TARGET", field, columns: at.map((index) => labelOf(block.headers[index]!)) });
  }
  for (const [a, b] of FIELD_CONFLICTS[kind] ?? []) {
    if (holders.has(a) && holders.has(b)) problems.push({ code: "FIELDS_CONFLICT", field: a, other: b });
  }
  for (const field of FIELDS[kind]) {
    if (!field.required || holders.has(field.id)) continue;
    if (field.requiredUnless !== undefined && holders.has(field.requiredUnless)) continue;
    problems.push({ code: "MISSING_REQUIRED", field: field.id });
  }

  const warnings: Warning[] = [];
  if (block.unterminated) warnings.push({ code: "UNTERMINATED_QUOTE" });
  if (block.overflowRows.length > 0) warnings.push({ code: "CELLS_RIGHT_OF_HEADER", rows: block.overflowRows.slice(0, 20) });

  const empty = (extra: Partial<Applied> = {}): Applied => ({
    ok: false,
    problems,
    rowProblems: [],
    hiddenRowProblems: 0,
    emptied: [],
    headers: [],
    rows: [],
    rowNumbers: [],
    dropped: droppedRefs,
    unplaced,
    skipped,
    csv: "",
    parsed: { headers: [], rows: [], delimiter: ";", rowNumbers: [], unterminatedAt: null, overflowRows: [] },
    warnings,
    ...extra,
  });
  if (problems.length > 0) return empty();

  // The output columns: every placed plain field in the catalogue's order, then what each combined field fills in.
  const plain = FIELDS[kind].filter((field) => field.combined === undefined && holders.has(field.id));
  const combined = FIELDS[kind].filter((field) => field.combined !== undefined && holders.has(field.id));
  const outFields: FieldSpec[] = [...plain];
  for (const field of combined) {
    for (const id of COMBINED_OUTPUT[field.combined!]) {
      const target = fieldOf(kind, id);
      if (target !== undefined) outFields.push(target);
    }
  }
  const headers = outFields.map((field) => field.header);

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  const rowProblems: RowProblem[] = [];
  const emptied: number[] = [];
  let hidden = 0;
  const hold = (row: number, code: RowProblem["code"], message: string): void => {
    if (rowProblems.length < MAX_ROW_PROBLEMS) rowProblems.push({ row, code, message });
    else hidden += 1;
  };

  // Where each placed column's cell goes, once, instead of a lookup per cell.
  const plainAt = plain.map((field) => holders.get(field.id)![0]!);
  const combinedAt = combined.map((field) => ({ field, index: holders.get(field.id)![0]! }));
  const read = [...plainAt, ...combinedAt.map((entry) => entry.index)];
  const replacement = new Set<number>();

  block.body.forEach((cells, at) => {
    const number = block.rowNumbers[at]!;
    // A personnummer in a column that is read: the row is not read, and the message says where and not what.
    const numbered = read.filter((index) => hasPersonalNumber(cells[index]!));
    if (numbered.length > 0) {
      const names = numbered.slice(0, 3).map((index) => nameOf(labelOf(block.headers[index]!)));
      const more = numbered.length > 3 ? ` och ${numbered.length - 3} till` : "";
      hold(number, "PERSONAL_NUMBER_IN_CELL", `Rad ${number}: kolumnen ${names.join(", ")}${more} har en cell som ser ut som ett personnummer, så raden läses inte in. Rastra tar inte emot personnummer, och värdet visas aldrig.`);
      return;
    }
    const out: string[] = plainAt.map((index) => cells[index]!);
    for (const { field, index } of combinedAt) {
      const split = splitCombined(field.combined!, cells[index]!);
      if ("problem" in split) {
        const label = nameOf(labelOf(block.headers[index]!));
        hold(
          number,
          split.problem,
          split.problem === "TIME_RANGE_UNREADABLE"
            ? `Rad ${number}: kolumnen ${label} går inte att dela i start och slut. Skriv tiden som 08:10–09:00.`
            : `Rad ${number}: kolumnen ${label} har ${split.count} lärare, men en lektion har högst två (lärare och medlärare).`,
        );
        return;
      }
      out.push(...split.cells);
    }
    if (out.every((cell) => cell === "")) {
      emptied.push(number);
      return;
    }
    if (out.some((cell) => cell.includes("\uFFFD"))) replacement.add(number);
    rows.push(out);
    rowNumbers.push(number);
  });
  if (replacement.size > 0) warnings.push({ code: "REPLACEMENT_CHARACTER", rows: [...replacement].slice(0, 20) });

  return {
    ok: rowProblems.length === 0 && hidden === 0,
    problems,
    rowProblems,
    hiddenRowProblems: hidden,
    emptied,
    headers,
    rows,
    rowNumbers,
    dropped: droppedRefs,
    unplaced,
    skipped,
    csv: writeMappedTable(block.headerRowNumber, headers, rows, rowNumbers),
    parsed: { headers, rows, delimiter: ";", rowNumbers, unterminatedAt: block.unterminated ? (block.rowNumbers.at(-1) ?? block.headerRowNumber) : null, overflowRows: block.overflowRows },
    warnings,
  };
}
