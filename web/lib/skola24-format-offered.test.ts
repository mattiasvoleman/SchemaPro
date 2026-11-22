import { describe, expect, it } from "vitest";
import { applyMapping } from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { detectFormats, offeredReading } from "@/lib/skola24-format";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";

/**
 * A file with no header row whose description is only OFFERED (X3 design §6.1 and §6.2): the first row is a person and a person with the
 * confidential mark is never read, but nothing is placed on a column. Synthetic files; the TF numbers are not anybody's (no such date).
 */

const STAFF_MARKED_FIRST =
  "Testskolan;Avd A;99999001TF01;Skyddad;Person;SP;skyddad.person@example.invalid;1\r\n" + "Testskolan;;99999001TF02;Erik;Exempel;;erik.exempel@example.invalid;\r\n" + "Testskolan;Avd B;99999001TF03;Åsa;Berg;;asa.berg@example.invalid;0\r\n";
const STAFF_MARKED_LAST =
  "Testskolan;Avd A;99999001TF01;Erik;Exempel;;erik.exempel@example.invalid;\r\n" + "Testskolan;Avd B;99999001TF02;Skyddad;Person;SP;skyddad.person@example.invalid;1\r\n";

const offeredOf = (text: string) => {
  const table = readTable(text);
  return offeredReading(table, detectFormats(table, SKOLA24_FORMATS), SKOLA24_FORMATS);
};

describe("the reading of a file whose description is only offered", () => {
  it("takes the first row for a person, leaves the marked person out and names the row, and places nothing", () => {
    const offered = offeredOf(STAFF_MARKED_FIRST)!;
    expect(offered.heldRows).toEqual([1]);
    expect(offered.block.headerRowNumber).toBe(0);
    expect(offered.block.rowNumbers).toEqual([2, 3]);
    expect(offered.block.body.map((row) => row[3])).toEqual(["Erik", "Åsa"]);
    expect(offered.assignment).toEqual(Array(8).fill(undefined));
  });

  it("has no cell of the marked person anywhere in the block, and no cell of a row as a header or a key", () => {
    for (const text of [STAFF_MARKED_FIRST, STAFF_MARKED_LAST]) {
      const { block } = offeredOf(text)!;
      expect(JSON.stringify(block)).not.toMatch(/Skyddad|skyddad\.person|SP/);
      // A header is blank, or the description's word for a personnummer column; a TF number is never one, nor a name or an address.
      expect(block.headers.filter((header) => header !== "")).toEqual(["personnummer"]);
      expect(JSON.stringify(block.keys)).not.toMatch(/tf0|erik|exempel|asa|berg|example/);
    }
  });

  it("maps nothing by itself: the mapping of an offered file has no row of the marked person even when the user places every column", () => {
    const offered = offeredOf(STAFF_MARKED_LAST)!;
    const placed = applyMapping(offered.block, "teachers", [null, null, null, "firstName", "lastName", null, "email", null]);
    expect(placed.rows).toEqual([["Erik", "Exempel", "erik.exempel@example.invalid"]]);
    expect(JSON.stringify(placed)).not.toMatch(/Skyddad|skyddad\.person/);
  });

  it("is there for a file with TF numbers in the id column, which X2's own door does not know", () => {
    const { block } = offeredOf(STAFF_MARKED_FIRST)!;
    expect(block.body).toHaveLength(2);
    expect(block.headers).not.toContain("99999001TF01");
  });

  it("is null when no file with no header row is offered: a file with headers, a school's own list, nothing", () => {
    expect(offeredOf("Personnummer\tEfternamn\tFörnamn\tKlass\n19000105-0001\tTestsson\tÅsa\t7A\n")).toBeNull();
    expect(offeredOf("förnamn;efternamn;epost\nÅsa;Berg;asa@example.invalid\n")).toBeNull();
    expect(offeredOf("")).toBeNull();
  });
});
