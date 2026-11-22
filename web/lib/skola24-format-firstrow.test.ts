import { describe, expect, it } from "vitest";
import { readTable } from "@/lib/column-table";
import { readFormat } from "@/lib/skola24-format";
import { formatById } from "@/lib/skola24-formats";

/**
 * The first row of a file whose page shows no header row is DATA unless it spells a column the page lists. A first row with no id (a person
 * whose id is not there yet, or mistyped) used to be taken for a header: the person was lost, and their name and e-mail were named as columns.
 */
const staff = formatById("skola24-personal-csv")!;
const parents = formatById("skola24-foraldrar-csv")!;

describe("a first row with no identity number", () => {
  it("is a row of the personnel file, not its header: nothing is lost and no cell becomes a label", () => {
    const text = "Testskolan;Avd Ä;;Åsa;Öberg;ÅÖ;asa@example.invalid;0\r\nTestskolan;;99999001TF02;Håkan;Ström;;hakan@example.invalid;\r\n";
    const reading = readFormat(readTable(text), staff)!;
    expect(reading.by).toBe("position");
    expect(reading.block.rowNumbers).toEqual([1, 2]);
    expect(reading.block.body[0]![3]).toBe("Åsa");
    const said = JSON.stringify(reading.columns.map((column) => column.label));
    expect(said).not.toMatch(/Åsa|Öberg|asa@example/);
  });

  it("is a row of the guardians' file too, whatever is wrong with its two ids", () => {
    const text = "ABC;;Åsa;Öberg;asa@example.invalid\r\n99999002TF02;99999003TF02;Bo;Björk;\r\n";
    const reading = readFormat(readTable(text), parents)!;
    expect(reading.by).toBe("position");
    expect(reading.block.rowNumbers).toEqual([1, 2]);
    expect(reading.columns.map((column) => column.label)).not.toContain("Åsa");
  });

  it("is still a header when it spells one column the page lists: a school's own header row is read on its headers", () => {
    const text = "Skola;Avd;TF-nummer;Fornamn;Efternamn;Sign;Epost;Sekr\r\nTestskolan;Avd Ä;99999001TF01;Åsa;Öberg;ÅÖ;asa@example.invalid;0\r\n";
    const reading = readFormat(readTable(text), staff)!;
    expect(reading.by).toBe("header");
    expect(reading.block.body).toHaveLength(1);
  });

  it("is a header in the file whose page shows one, whatever it says (Elever has no fixed order)", () => {
    const reading = readFormat(readTable("Pnr\tNamn\tKlass\n99999005TF01\tÖberg Åsa\t7A\n"), formatById("skola24-elever-klass")!)!;
    expect(reading.by).toBe("header");
    expect(reading.block.body).toHaveLength(1);
  });
});
