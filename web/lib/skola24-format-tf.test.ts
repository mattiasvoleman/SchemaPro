import { describe, expect, it } from "vitest";
import { placementsOf } from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { normalizeHeader } from "@/lib/csv-export";
import { decodeCsvBytes } from "@/lib/csv-encoding";
import { detectFormats, readFormat } from "@/lib/skola24-format";
import { formatById } from "@/lib/skola24-formats";

/**
 * Skola24's own example files (the seven course CSVs) have one shape: no header row, ';' between the fields, CRLF at the end of every row,
 * Windows-1252, and an id column that holds a TF-nummer (ÅÅÅÅMMDDTFnn), not a personnummer. These are synthetic files of that shape, built from
 * bytes as a school's file arrives (no real person: the names are invented and every id is 99999NNNTFnn). On such a file
 *   - the first row is a ROW (nothing is lost, and none of its cells is a header, a label or a key of a template),
 *   - the reading says what format it is (offered, never applied as exact) and drops the id column.
 * The reviewer's own acceptance test of the author's TF fix (X3 del 1): it fails on f9789b7 (12 of 15) and passes on 14dd5f8.
 */
interface Case {
  name: string;
  format: string;
  rows: string[][];
  /** The columns that are an id (a TF-nummer). */
  ids: number[];
}

const CASES: Case[] = [
  {
    name: "personal (förskola/fritids)",
    format: "skola24-personal-csv",
    rows: [
      ["Testskolan", "Avdelning Ärlig", "99999001TF01", "Åsa", "Öberg", "ÅÖ", "asa.oberg@example.invalid", ""],
      ["Testskolan", "Avdelning Björk", "99999001TF02", "Håkan", "Ström", "HST", "hakan.strom@example.invalid", ""],
      ["Testskolan", "", "99999001TF03", "Märta", "Lärkan", "", "marta.larkan@example.invalid", ""],
    ],
    ids: [2],
  },
  {
    name: "barn (förskola/fritids)",
    format: "skola24-barn-csv",
    rows: [
      ["Testskolan", "Avdelning Ärlig", "99999002TF01", "Lo", "Björkström", ""],
      ["Testskolan", "Avdelning Ärlig", "99999002TF02", "Mio", "Källström", ""],
      ["Testskolan", "Avdelning Björk", "99999002TF03", "Åke", "Mjölner", ""],
    ],
    ids: [2],
  },
  {
    name: "föräldrar",
    format: "skola24-foraldrar-csv",
    rows: [
      ["99999002TF01", "99999003TF01", "Åsa", "Öberg", "asa.oberg@example.invalid", "0701234567"],
      ["99999002TF02", "99999003TF02", "Bo", "Björkström", "", ""],
      ["99999002TF03", "99999003TF03", "Märta", "Källström"],
    ],
    ids: [0, 1],
  },
];

const bytesOf = (rows: string[][]): Uint8Array => Uint8Array.from(Buffer.from(rows.map((row) => `${row.join(";")}\r\n`).join(""), "latin1"));

describe.each(CASES.map((entry) => [entry.name, entry] as const))("a Skola24 file with no header row and TF-nummer: %s", (_name, entry) => {
  const decoded = decodeCsvBytes(bytesOf(entry.rows));
  const table = readTable(decoded.text);
  const descriptor = formatById(entry.format)!;
  const cells = new Set(entry.rows.flat().filter((cell) => cell !== ""));
  const keys = new Set([...cells].map((cell) => normalizeHeader(cell)).filter((key) => key !== ""));

  it("is read as the file it is: Windows-1252, every row a row", () => {
    expect(decoded.encoding).toBe("windows-1252");
    expect(table.rows).toHaveLength(entry.rows.length);
    expect(table.delimiter).toBe(";");
    expect(table.rows[0]).toEqual(entry.rows[0]);
  });

  it("is offered as its format, and by position, never as exact", () => {
    const fits = detectFormats(table).filter((fit) => fit.format === entry.format);
    expect(fits.map((fit) => [fit.by, fit.exact])).toEqual([["position", false]]);
  });

  it("loses no row: every row of the file is a row of the reading, or held back by its number", () => {
    const reading = readFormat(table, descriptor)!;
    expect(reading).not.toBeNull();
    expect(reading.by).toBe("position");
    expect([...new Set([...reading.block.rowNumbers, ...reading.heldRows])].sort()).toEqual(entry.rows.map((_, at) => at + 1));
  });

  it("makes no cell of any row a header, a label or a key of a template, however the columns are then placed", () => {
    const reading = readFormat(table, descriptor)!;
    for (const header of reading.block.headers) expect(cells.has(header), `header ${header}`).toBe(false);
    for (const key of reading.block.keys) expect(keys.has(key), `key ${key}`).toBe(false);
    for (const column of reading.columns) expect(column.label === null || !cells.has(column.label), `label ${column.label}`).toBe(true);
    // The user may say "read nothing" of every column nobody placed: the template that would keep that holds none of the file's cells either.
    const skipped = reading.assignment.map((field) => (field === undefined ? null : field));
    for (const kind of ["teachers", "guardians", "students"] as const) {
      for (const assignment of [reading.assignment, skipped]) {
        for (const post of placementsOf(reading.block, kind, assignment)) {
          expect(keys.has(post.key), `template key ${post.key}`).toBe(false);
          expect(cells.has(post.label), `template label ${post.label}`).toBe(false);
        }
      }
    }
  });

  it("drops the id column, whatever its form", () => {
    const reading = readFormat(table, descriptor)!;
    for (const at of entry.ids) {
      expect(reading.columns[at]!.verdict.status).toBe("personalNumber");
      expect(reading.assignment[at]).toBeNull();
    }
    expect(JSON.stringify({ ...reading, block: undefined })).not.toContain("TF0");
  });
});
