import { describe, expect, it } from "vitest";
import posts from "../../src/import/__fixtures__/skola24-posts.json";
import { applyMapping } from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { mapTeacherRows } from "@/lib/csv";
import { decodeCsvBytes } from "@/lib/csv-encoding";
import { detectFormats, formatAssignment, readFormat } from "@/lib/skola24-format";
import { formatById } from "@/lib/skola24-formats";

/**
 * The shared fixture holds a file as text. A school's file is BYTES: Skola24's own course files are Windows-1252 (å is E5), and a sheet Excel has
 * formatted past its data is saved with empty cells to the right of every row (grundskolan_barn.csv has fourteen). This is the same file in
 * those bytes, through the same steps the dialog takes (the bytes, the encoding, the table, the description, X2's mapping, the importer's
 * mapper), and it must give the body the gateway's e2e spec posts: a file saved by Excel is not a different file.
 */

/** As Excel saves "CSV (semikolonavgränsad)": Windows-1252 (every letter in the fixtures is Latin-1, whose bytes are the same), CRLF, `pad` empty cells on every row. */
const savedByExcel = (file: string, pad: string): Uint8Array => new Uint8Array(Buffer.from(file.split("\r\n").map((line) => (line === "" ? line : line + pad)).join("\r\n"), "latin1"));

describe.each([
  ["a personnummer file", posts.teachers],
  ["a file of TF numbers", posts.teachersTf],
] as const)("%s, as the bytes a school's Excel saves", (_name, staff) => {
  it.each([
    ["as it is", ""],
    ["padded with three empty columns", ";;;"],
  ])("%s gives the body the gateway's e2e spec posts", (_how, pad) => {
    const decoded = decodeCsvBytes(savedByExcel(staff.file, pad));
    expect(decoded.problem).toBeNull();
    expect(decoded.encoding).toBe("windows-1252");
    const table = readTable(decoded.text);

    // Offered, never applied by itself, and the user chooses it as the dialog's button does.
    expect(detectFormats(table).map((fit) => [fit.format, fit.by, fit.exact])).toEqual([[staff.description, "position", false]]);
    const reading = readFormat(table, formatById(staff.description)!)!;
    const applied = applyMapping(reading.block, "teachers", formatAssignment(reading, "teachers"));
    const mapped = mapTeacherRows(applied.parsed);
    expect(applied.problems).toEqual([]);
    expect(mapped.errors).toEqual([]);
    expect({ rows: mapped.rows, rowNumbers: mapped.rowNumbers }).toEqual(staff.body);
  });
});
