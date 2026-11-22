import { describe, expect, it } from "vitest";
import { workbookParts, zip } from "@/lib/__fixtures__/xlsx-builder";
import { parseSource } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";
import { plainNumber, readWorkbook } from "@/lib/pseudonym-xlsx";

/*
 * A number cell as another writer prints it (the review of #398). Excel and LibreOffice store the personnummer 8001011234 as <v>8001011234</v>; a writer that prints
 * a double the way Java does (Apache POI) stores <v>8.001011234E9</v>, and the reader handed that on as it stood, so a personnummer got through in a cell that no
 * search for a personnummer reads, with no word on the page about it.
 */

const encoder = new TextEncoder();

/** A workbook with one column, Id, whose number cells hold exactly the given <v> text. */
async function bookWith(values: string[]): Promise<Uint8Array> {
  const parts = workbookParts({ sheets: [{ name: "Elever", rows: [["Id", "Klass"], ...values.map((_, i) => [900_000 + i, "7A"])] }] });
  let xml = parts["xl/worksheets/sheet1.xml"]!;
  values.forEach((value, i) => {
    xml = xml.replace(`<v>${900_000 + i}</v>`, `<v>${value}</v>`);
  });
  parts["xl/worksheets/sheet1.xml"] = xml;
  return zip(Object.entries(parts).map(([name, text]) => ({ name, data: encoder.encode(text) })));
}

describe("plainNumber", () => {
  it.each([
    ["8.001011234E9", "8001011234"],
    ["1.98001011234E11", "198001011234"],
    ["1.98001011234E+11", "198001011234"],
    ["8.001011234e9", "8001011234"],
    ["8001011234E0", "8001011234"],
    ["1.5E3", "1500"],
    ["-2.5E2", "-250"],
    // Not whole numbers, or not numbers: as stored.
    ["1.5E-3", "1.5E-3"],
    ["2.5E0", "2.5E0"],
    ["1E400", "1E400"],
    ["8001011234", "8001011234"],
    ["8001011234.0", "8001011234.0"],
    ["", ""],
    ["E9", "E9"],
  ])("%s is %s", (raw, expected) => {
    expect(plainNumber(raw)).toBe(expected);
  });
});

describe("a workbook with numbers written in scientific notation", () => {
  it("reads a whole number as its digits", async () => {
    const book = await readWorkbook(await bookWith(["8.001011234E9", "1.98001011234E11", "7001011234"]));
    expect(book.sheets[0]!.rows.map((row) => row[0])).toEqual(["Id", "8001011234", "198001011234", "7001011234"]);
  });

  it("takes the personnummer out of it, as it does one that Excel wrote", async () => {
    const bytes = await bookWith(["8.001011234E9", "1.98001011234E11"]);
    const parsed = await parseSource({ file: new File([bytes as unknown as BlobPart], "elever.xlsx") });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const input = parsed.inputs[0]!;
    const plan = planFile(input);
    const result = pseudonymise([input], { files: [{ treatments: Object.fromEntries(plan.columns.filter((c) => c.proposal === null).map((c) => [c.index, { kind: "keep" as const }])) }] });
    if (!result.ok) throw new Error(JSON.stringify(result.undecided));
    const text = result.files[0]!.text;
    expect(text).not.toMatch(/001011234|E9|E\+?11/);
    expect(text).toContain("PNR-0001");
    // The same person in two spellings is one marker.
    expect(text.match(/PNR-0001/g)).toHaveLength(2);
  });
});
