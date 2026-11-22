import { describe, expect, it } from "vitest";
import { readTable } from "@/lib/column-table";
import { detectFormats, readFormat } from "@/lib/skola24-format";
import { formatById } from "@/lib/skola24-formats";

/**
 * A sheet Excel has formatted past its data is saved with empty cells to the right (lib/column-mapping.ts chooseHeaderRow says so of a header
 * row). Skola24's own grundskolan_barn.csv is one: twenty columns, the fourteen last empty on every row. Those cells are padding: the file is
 * still the children's file, and detectFormats must offer it. A cell with something in it beyond the description's last column still counts.
 */
const pad = (cells: string[], to: number): string => `${[...cells, ...Array(Math.max(0, to - cells.length)).fill("")].join(";")}\r\n`;
const barn = (to: number) => readTable([pad(["Testskolan", "Avd Ä", "99999002TF01", "Lo", "Björk", ""], to), pad(["Testskolan", "Avd Ä", "99999002TF02", "Mio", "Källström", "0"], to), pad(["Testskolan", "Avd Ö", "99999002TF03", "Åke", "Mjölner", ""], to)].join(""));

describe("empty cells to the right of the data", () => {
  it("do not make the children's file too wide to be offered: six columns and fourteen empty ones", () => {
    const table = barn(20);
    expect(table.rows[0]).toHaveLength(20);
    const fits = detectFormats(table).map((fit) => `${fit.format}/${fit.by}`);
    expect(fits).toContain("skola24-barn-csv/position");
    const reading = readFormat(table, formatById("skola24-barn-csv")!)!;
    expect(reading.by).toBe("position");
    expect(reading.block.body).toHaveLength(3);
    expect(reading.columns).toHaveLength(6);
  });

  it("do not make the personnel file too wide either: eight columns and three empty ones", () => {
    const rows = [pad(["Testskolan", "Avd Ä", "99999001TF01", "Åsa", "Öberg", "ÅÖ", "asa@example.invalid", "0"], 11), pad(["Testskolan", "", "99999001TF02", "Håkan", "Ström", "", "h@example.invalid", ""], 11)];
    expect(detectFormats(readTable(rows.join(""))).map((fit) => fit.format)).toEqual(["skola24-personal-csv"]);
  });

  it("but a cell with something in it past the description's last column still does", () => {
    const rows = [pad(["Testskolan", "Avd Ä", "99999002TF01", "Lo", "Björk", "", "något"], 20), pad(["Testskolan", "Avd Ä", "99999002TF02", "Mio", "Källström", "0", "mer"], 20)];
    expect(detectFormats(readTable(rows.join(""))).map((fit) => fit.format)).not.toContain("skola24-barn-csv");
  });
});
