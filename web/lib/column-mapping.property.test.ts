import { describe, expect, it } from "vitest";
import cases from "../../src/schedule-exchange/__fixtures__/personal-number-cases.json";
import { FIELDS, type TemplateKind } from "@/lib/column-fields";
import {
  applyMapping,
  aliasAssignment,
  chooseHeaderRow,
  describeColumns,
  personalNumberColumns,
  placementsOf,
  recognise,
  type Assignment,
  type Block,
  type MappingTemplate,
} from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { normalizeHeader } from "@/lib/csv-export";
import { hasPersonalNumber } from "@/lib/personal-number";

/*
 * Property tests with a seeded generator of tables (no new package: the disk and the install rule). Each property runs over
 * ROUNDS random tables; the seed is in the test's name so a red run is run again, and the failing round says which it was.
 * The headers are INVENTED words: they claim nothing about any program.
 */

const ROUNDS = 400;

/** mulberry32: a small, good PRNG from a 32-bit seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const bool = (p = 0.5): boolean => next() < p;
  const shuffle = <T>(list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { next, int, pick, bool, shuffle };
}
type Rng = ReturnType<typeof rng>;

const NUMBERS = cases.cases.filter((c) => c.has).map((c) => c.text);
const WORDS = ["Kurs", "Ped", "Rum", "Tid", "Fack", "Vecka", "Grupp", "Elev", "Mall", "Notis", "Ort", "Kod", "Typ", "Sida", "Zon", "Kolonn"];
/** Cells that are no personnummer and no 10-digit run, with the characters a CSV has trouble with. */
const SAFE = ["Anna", "7A", "Matematik", "A1", "Mån", "08:10-09:00", "", "x;y", 'he said "hi"', "=SUM(1)", "'quoted", "ö ä å", "two\nlines", "-5", "ABC, DEF", "t\tt", "  padded  ", "7B Svenska", "9.40 – 10.20", "12"];
const KINDS: readonly TemplateKind[] = ["scheduleLessons", "students", "requirements", "rooms", "classes", "teacherDuties"];

interface World {
  kind: TemplateKind;
  records: string[][];
  text: string;
  block: Block;
  assignment: Assignment;
}

function quote(cell: string, delimiter: string): string {
  return /["\n\r]/.test(cell) || cell.includes(delimiter) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** A random table of a random kind, its text, and a random assignment. `numbers` lets personnummer in; `plain` keeps every header usable as a key. */
function world(r: Rng, options: { numbers?: boolean; plain?: boolean } = {}): World {
  const kind = r.pick(KINDS);
  const width = 3 + r.int(7);
  const headers: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < width; i += 1) {
    let header = r.bool(0.3) ? r.pick(FIELDS[kind].filter((field) => field.header !== "")).header : `${r.pick(WORDS)}${r.int(4)}`;
    // Plain: no two headers read as one key (case, spacing and punctuation dropped), so a column is known by its header alone.
    if (options.plain) while (used.has(normalizeHeader(header))) header = `${r.pick(WORDS)}${r.int(100)}`;
    used.add(normalizeHeader(header));
    if (!options.plain && r.bool(0.05)) header = "";
    headers.push(header);
  }
  if (options.numbers && r.bool(0.3)) headers[r.int(width)] = r.bool() ? "Personnr" : r.pick(NUMBERS);
  const rowCount = 1 + r.int(8);
  const records: string[][] = [];
  for (let i = 0; i < r.int(3); i += 1) records.push([`Titel ${i}`]);
  const headerAt = records.length;
  records.push(headers);
  const numberColumn = options.numbers && r.bool(0.3) ? r.int(width) : -1;
  for (let i = 0; i < rowCount; i += 1) {
    records.push(
      headers.map((_, column) => {
        if (column === numberColumn) return r.pick(NUMBERS);
        if (options.numbers && r.bool(0.05)) return r.pick(NUMBERS);
        return r.pick(SAFE);
      }),
    );
  }
  const delimiter = r.bool() ? ";" : "\t";
  const blanks = r.bool(0.3);
  const text = records.map((record) => `${record.map((cell) => quote(cell, delimiter)).join(delimiter)}\n${blanks && r.bool(0.2) ? "\n" : ""}`).join("");
  const table = readTable(text);
  const block = chooseHeaderRow(table, table.rowNumbers[headerAt]!)!;
  // Each field at most once.
  const fields = r.shuffle(FIELDS[kind].map((field) => field.id));
  const assignment: Assignment = block.headers.map(() => {
    const roll = r.next();
    if (roll < 0.4) return undefined;
    if (roll < 0.55) return null;
    return fields.pop();
  });
  return { kind, records, text, block, assignment };
}

const seeded = (name: string, seed: number, body: (r: Rng, round: number) => void): void => {
  it(`${name} (seed ${seed}, ${ROUNDS} tables)`, () => {
    const r = rng(seed);
    for (let round = 0; round < ROUNDS; round += 1) {
      try {
        body(r, round);
      } catch (error) {
        throw new Error(`round ${round} of seed ${seed}: ${(error as Error).message}`);
      }
    }
  });
};

const stable = (value: unknown): string => JSON.stringify(value);

describe("applyMapping, over random tables", () => {
  seeded("puts every column in exactly one place: placed, skipped, unplaced or dropped", 101, (r) => {
    const w = world(r, { numbers: true });
    const done = applyMapping(w.block, w.kind, w.assignment);
    const all = [...done.dropped, ...done.skipped, ...done.unplaced].map((ref) => ref.index);
    expect(new Set(all).size).toBe(all.length);
    const placedIndexes = w.assignment.map((field, index) => (typeof field === "string" ? index : -1)).filter((index) => index >= 0 && !done.dropped.some((d) => d.index === index));
    expect([...all, ...placedIndexes].sort((a, b) => a - b)).toEqual(w.block.headers.map((_, index) => index));
    // The states the user is shown cover every column, once.
    const states = describeColumns(w.block, w.kind, w.assignment);
    expect(states.map((state) => state.index)).toEqual(w.block.headers.map((_, index) => index));
  });

  seeded("is the same whatever order the columns are in, the assignment following them", 202, (r) => {
    const w = world(r, { numbers: true });
    const order = r.shuffle(w.block.headers.map((_, index) => index));
    const permuted: Block = {
      ...w.block,
      headers: order.map((i) => w.block.headers[i]!),
      keys: order.map((i) => w.block.keys[i]!),
      body: w.block.body.map((row) => order.map((i) => row[i]!)),
    };
    const a = applyMapping(w.block, w.kind, w.assignment);
    const b = applyMapping(permuted, w.kind, order.map((i) => w.assignment[i]));
    expect(b.headers).toEqual(a.headers);
    expect(b.rows).toEqual(a.rows);
    expect(b.rowNumbers).toEqual(a.rowNumbers);
    expect(b.rowProblems.map((p) => [p.row, p.code])).toEqual(a.rowProblems.map((p) => [p.row, p.code]));
    expect(b.hiddenRowProblems).toBe(a.hiddenRowProblems);
    const norm = (problems: typeof a.problems) => problems.map((p) => stable({ ...p, columns: p.columns ? [...p.columns].sort() : undefined })).sort();
    expect(norm(b.problems)).toEqual(norm(a.problems));
    const labels = (refs: typeof a.dropped) => refs.map((ref) => ref.label).sort();
    expect(labels(b.unplaced)).toEqual(labels(a.unplaced));
    expect(labels(b.skipped)).toEqual(labels(a.skipped));
    expect(labels(b.dropped)).toEqual(labels(a.dropped));
  });

  seeded("never writes a column nobody placed: not its header, not one of its cells", 303, (r) => {
    const w = world(r);
    const tokens: string[] = [];
    const body = w.block.body.map((row) => [...row]);
    const headers = [...w.block.headers];
    w.assignment.forEach((field, index) => {
      if (field !== undefined || personalNumberColumns(w.block).has(index)) return;
      headers[index] = `Hdr~${index}~`;
      tokens.push(`Hdr~${index}~`);
      body.forEach((row, at) => {
        row[index] = `~tok${index}.${at}~`;
        tokens.push(row[index]!);
      });
    });
    const marked: Block = { ...w.block, headers, body };
    const done = applyMapping(marked, w.kind, w.assignment);
    const written = JSON.stringify([done.headers, done.rows, done.csv, done.rowProblems, done.parsed]);
    for (const token of tokens) expect(written).not.toContain(token);
    // But each is named, by its header.
    for (const ref of done.unplaced) expect(ref.label).toBe(headers[ref.index]);
  });

  seeded("refuses a field placed on two columns, naming it, and writes no rows", 404, (r) => {
    const w = world(r);
    const usable = w.block.headers.map((_, index) => index).filter((index) => !personalNumberColumns(w.block).has(index));
    if (usable.length < 2) return;
    const [a, b] = r.shuffle(usable);
    const field = r.pick(FIELDS[w.kind]).id;
    const assignment = w.assignment.map((value, index) => (index === a || index === b ? field : value === field ? undefined : value));
    const done = applyMapping(w.block, w.kind, assignment);
    expect(done.problems.some((p) => p.code === "DUPLICATE_TARGET" && p.field === field)).toBe(true);
    expect(done.rows).toEqual([]);
    expect(done.ok).toBe(false);
  });

  seeded("reads a file whose headers are the kind's own as it is, in the catalogue's order, with nothing named", 505, (r) => {
    const kind = r.pick(["students", "requirements", "rooms", "classes", "teacherDuties", "subjects", "timplan"] as const);
    const fields = FIELDS[kind];
    const chosen = r.shuffle(fields.filter((field) => field.required || r.bool(0.5)));
    const records = [chosen.map((field) => field.header), ...Array.from({ length: 1 + r.int(5) }, () => chosen.map(() => r.pick(SAFE.filter((cell) => cell !== ""))))];
    const b = chooseHeaderRow(readTable(records.map((record) => record.map((cell) => quote(cell, ";")).join(";")).join("\n")), null)!;
    const assignment = aliasAssignment(b, kind);
    expect(assignment).toEqual(chosen.map((field) => field.id));
    const done = applyMapping(b, kind, assignment);
    expect(done.ok).toBe(true);
    expect(done.unplaced).toEqual([]);
    expect(done.dropped).toEqual([]);
    const ordered = fields.filter((field) => chosen.includes(field));
    expect(done.headers).toEqual(ordered.map((field) => field.header));
    expect(done.rows).toEqual(b.body.map((row) => ordered.map((field) => row[chosen.indexOf(field)]!)));
  });

  seeded("carries no personnummer in anything it answers, whatever is put in headers, columns and cells", 606, (r) => {
    const w = world(r, { numbers: true });
    const done = applyMapping(w.block, w.kind, w.assignment);
    const answered = [
      done.headers,
      done.rows,
      done.rowProblems.map((p) => p.message),
      done.dropped,
      done.unplaced,
      done.skipped,
      done.problems,
      done.warnings,
      done.csv,
      describeColumns(w.block, w.kind, w.assignment),
      placementsOf(w.block, w.kind, w.assignment),
      w.block.keys,
    ];
    for (const part of answered) {
      const text = JSON.stringify(part);
      expect(hasPersonalNumber(text), `a personnummer in ${text.slice(0, 200)}`).toBe(false);
    }
    // No kept row holds a cell with the shape either: a row with one is held back.
    for (const row of done.rows) for (const cell of row) expect(hasPersonalNumber(cell)).toBe(false);
  });

  seeded("writes text that reads back as the headers and the kept rows, each on the row it came from", 707, (r) => {
    const w = world(r, { numbers: true });
    const done = applyMapping(w.block, w.kind, w.assignment);
    if (done.problems.length > 0) return;
    const back = readTable(done.csv);
    expect(back.rows).toEqual([done.headers, ...done.rows]);
    expect(back.rowNumbers).toEqual([w.block.headerRowNumber, ...done.rowNumbers]);
    expect(back.unterminated).toBe(false);
  });

  seeded("accounts for every row: kept or held back, by the number it has in the file", 808, (r) => {
    const w = world(r, { numbers: true });
    const done = applyMapping(w.block, w.kind, w.assignment);
    if (done.problems.length > 0) return;
    const held = done.rowProblems.map((p) => p.row);
    expect(new Set([...done.rowNumbers, ...held, ...done.emptied].sort((a, b) => a - b))).toEqual(new Set(w.block.rowNumbers));
    expect(done.rowNumbers.length + held.length + done.hiddenRowProblems + done.emptied.length).toBe(w.block.rowNumbers.length);
    for (const row of held) expect(w.block.rowNumbers).toContain(row);
  });
});

describe("recognising a template, over random tables", () => {
  seeded("finds the template the table was made with, under other case and spacing and any column order", 909, (r) => {
    const w = world(r, { plain: true });
    const posts = placementsOf(w.block, w.kind, w.assignment);
    if (posts.length === 0) return;
    const template: MappingTemplate = { id: "t", kind: w.kind, name: "T", headerRow: null, placements: posts };
    // The same table, its headers recased and respaced and punctuated, its columns in another order, and no title above.
    const order = r.shuffle(w.block.headers.map((_, index) => index));
    const respell = (header: string): string => r.pick([(h: string) => h.toUpperCase(), (h: string) => `  ${h} `, (h: string) => `${h}.`, (h: string) => h.toLowerCase(), (h: string) => h])(header);
    const headers = order.map((i) => respell(w.block.headers[i]!));
    const clean = (cell: string): string => cell.replace(/[;\n\r"\t]/g, "");
    const text = `${headers.map(clean).join(";")}\n${w.block.body.map((row) => order.map((i) => clean(row[i]!)).join(";")).join("\n")}\n`;
    const found = recognise(readTable(text), w.kind, [template]);
    expect(found?.template?.id).toBe("t");
    const expected = order.map((i) => (posts.some((post) => post.key === w.block.keys[i]) ? w.assignment[i] : undefined));
    expect(found!.assignment).toEqual(expected);
  });

  seeded("does not apply a template of one kind to another, and applies none to a table that has none of its columns", 1010, (r) => {
    const w = world(r, { plain: true });
    const posts = placementsOf(w.block, w.kind, w.assignment);
    if (posts.length === 0) return;
    const other = KINDS.find((kind) => kind !== w.kind)!;
    expect(recognise(readTable(w.text), other, [{ id: "t", kind: w.kind, name: "T", headerRow: null, placements: posts }])?.template ?? null).toBeNull();
    const strangers = readTable("Zzz;Yyy\n1;2\n");
    expect(recognise(strangers, w.kind, [{ id: "t", kind: w.kind, name: "T", headerRow: null, placements: posts }])?.template ?? null).toBeNull();
  });
});
