import { describe, expect, it } from "vitest";
import posts from "../../src/import/__fixtures__/skola24-posts.json";
import { applyMapping } from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { mapTeacherRows } from "@/lib/csv";
import { hasPersonalNumber } from "@/lib/personal-number";
import { formatAssignment, readFormat } from "@/lib/skola24-format";
import { formatById } from "@/lib/skola24-formats";

/**
 * What a file from Skola24 becomes on its way to the gateway (Formatbeskrivare, X3), held to the gateway's side by one shared
 * fixture: this file regenerates the body from the table in the fixture, and test/import-skola24.e2e-spec.ts posts that body through
 * the global pipe, the controller and ImportService. The web's own tests check the mapping; the gateway's check the DTO; neither alone
 * says that what the one produces is what the other takes (the subject export's empty colour, #260, was exactly that).
 */

/** The panel's own steps, without the panel: the description, X2's mapping with the rows a confidential mark holds back, the importer's mapper. */
function bodyOf(file: string, id: string, kind: "teachers") {
  const reading = readFormat(readTable(file), formatById(id)!)!;
  const applied = applyMapping(reading.block, kind, formatAssignment(reading, kind), { held: reading.heldRows });
  const mapped = mapTeacherRows(applied.parsed);
  return { reading, applied, mapped, body: { rows: mapped.rows, rowNumbers: mapped.rowNumbers } };
}

describe.each([
  ["a personnummer file", posts.teachers, [2], [1, 3]],
  ["a file of TF numbers, as Skola24's own course files are", posts.teachersTf, [3], [1, 2]],
] as const)("%s, as the gateway is sent it", (_name, staff, held, rowNumbers) => {
  it("is the body the gateway's e2e spec posts", () => {
    const { applied, mapped, body } = bodyOf(staff.file, staff.description, "teachers");
    expect(applied.problems).toEqual([]);
    expect(mapped.errors).toEqual([]);
    expect(body).toEqual(staff.body);
  });

  it("leaves out the person the file marks with a 1, and names the file's own row numbers", () => {
    const { applied } = bodyOf(staff.file, staff.description, "teachers");
    expect(applied.held).toEqual(held);
    expect([...staff.body.rowNumbers]).toEqual(rowNumbers);
    expect(staff.body.rows.map((row) => row.firstName)).not.toContain("Maria");
  });

  it("carries no personnummer, no TF number, no signature and no column the importer does not read", () => {
    const text = JSON.stringify(staff.body);
    expect(hasPersonalNumber(text)).toBe(false);
    expect(text).not.toMatch(/TF\d\d|ASP|MFI|EEX|Testskolan|Avd/);
    for (const row of staff.body.rows) expect(Object.keys(row).sort()).toEqual(["email", "firstName", "lastName"]);
  });
});
