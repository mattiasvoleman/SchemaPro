import { describe, expect, it } from "vitest";
import { applyMapping, describeColumns } from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { readFixture } from "@/lib/__fixtures__/skola24-read";
import { readFormat } from "@/lib/skola24-format";
import { formatById } from "@/lib/skola24-formats";

/**
 * A person with the confidential mark is never read (the user's decision, X3 design §6.1): the row is named by its number in `heldRows`,
 * and no cell of it is in the block, a sample, a mapping or a CSV.
 */
const staff = formatById("skola24-personal-csv")!;
const text = "S;A;19000103-0001;Åsa;Provsson;ASP;asa@example.invalid;\nS;A;19000103-0002;Skyddad;Person;SP;skyddad@example.invalid;1\nS;A;19000103-0003;Erik;Exempel;EEX;erik@example.invalid;\n";

describe("a held row", () => {
  it("is named by its number and is no row of the block", () => {
    const reading = readFormat(readTable(text), staff)!;
    expect(reading.heldRows).toEqual([2]);
    expect(reading.block.rowNumbers).toEqual([1, 3]);
    expect(reading.block.body).toHaveLength(2);
    expect(JSON.stringify(reading.block)).not.toMatch(/Skyddad|skyddad/);
  });

  it("is in no sample the panel shows, no mapped row and no CSV", () => {
    const reading = readFormat(readTable(text), staff)!;
    expect(JSON.stringify(describeColumns(reading.block, "teachers", reading.assignment))).not.toMatch(/Skyddad|skyddad/);
    const applied = applyMapping(reading.block, "teachers", reading.assignment);
    expect(applied.rows).toEqual([
      ["Åsa", "Provsson", "asa@example.invalid"],
      ["Erik", "Exempel", "erik@example.invalid"],
    ]);
    expect(applied.rowNumbers).toEqual([1, 3]);
    expect(applied.csv).not.toMatch(/Skyddad|skyddad/);
  });

  it("is held in a file with headers too, and a held row's overflow cells are not named", () => {
    const headers = "skolans namn;avdelning;personnummer;förnamn;efternamn;signatur;e-postadress;sekretessmarkering\n";
    const reading = readFormat(readTable(`${headers}S;A;19000103-0001;Åsa;Provsson;ASP;a@example.invalid;\nS;A;19000103-0002;Skyddad;Person;SP;s@example.invalid;1;extra\n`), staff)!;
    expect(reading.by).toBe("header");
    expect(reading.heldRows).toEqual([3]);
    expect(reading.block.rowNumbers).toEqual([2]);
    expect(reading.block.overflowRows).toEqual([]);
  });

  it("is the children's file's row with the mark as well, and in a file of TF numbers too", () => {
    const reading = readFormat(readTable(readFixture("barn.csv")), formatById("skola24-barn-csv")!)!;
    expect(reading.heldRows).toEqual([2]);
    expect(JSON.stringify(reading.block)).not.toContain("Mio");
    expect(reading.block.rowNumbers).toEqual([1]);
    const marked = "Testskolan;Avd A;19000103TF01;Åsa;Provsson;ASP;asa@example.invalid;0\r\nTestskolan;Avd B;19000103TF02;Maria;Fiktiv;MFI;maria@example.invalid;1\r\n";
    const tf = readFormat(readTable(marked), staff)!;
    expect(tf.heldRows).toEqual([2]);
    expect(JSON.stringify(tf.block)).not.toContain("Maria");
  });

  it("changes nothing for a file with no mark", () => {
    const reading = readFormat(readTable(readFixture("foraldrar.csv")), formatById("skola24-foraldrar-csv")!)!;
    expect(reading.heldRows).toEqual([]);
    expect(reading.block.rowNumbers).toEqual([1, 2, 3, 4]);
  });
});
