import { describe, expect, it } from "vitest";
import { readTable } from "@/lib/column-table";
import { detectFormats, readFormat } from "@/lib/skola24-format";
import type { FormatDescriptor } from "@/lib/skola24-format-types";
import { formatById } from "@/lib/skola24-formats";

/**
 * The edges of the reader that hand mutants of skola24-format.ts left alive (the review of PR 370): each case below fails on exactly the
 * mutant named, and passes on the code.
 */
const parents = formatById("skola24-foraldrar-csv")!;
const extens = formatById("skola24-extens-franvaro")!;
const fits = (text: string) => detectFormats(readTable(text)).map((fit) => fit.format);

describe("what a page SAYS about the header row decides, and only that", () => {
  // `stated` branch of headerModeOf: the five descriptions have a TOLKAT or no header-row fact, so no description exercises it.
  const documented = (value: "yes" | "no"): FormatDescriptor => ({ ...parents, headerRow: { value, source: { url: "https://www.skola24.com/support/x/", updated: null, read: "2026-11-21", status: "DOKUMENTERAT" } } });
  const dataFirst = "99999002TF01;99999003TF01;Åsa;Öberg;a@example.invalid\n99999002TF02;99999003TF02;Bo;Björk;\n";

  it("a documented 'yes' makes the first row the header, even over a row that looks like data", () => {
    expect(readFormat(readTable(dataFirst), documented("yes"))!.by).toBe("header");
  });

  it("a documented 'no' makes it data, even over a row that spells the page's columns", () => {
    const labels = parents.columns!.map((column) => column.label.value).join(";");
    expect(readFormat(readTable(`${labels}\n${dataFirst}`), documented("no"))!.by).toBe("position");
  });
});

describe("recognising a file by its headers", () => {
  it("needs three of the description's columns, however short the description is (Extens has three)", () => {
    expect(fits("EnhetsID;Personnummer;Foo\n12345;000106-0001;2.5\n")).toEqual([]);
    expect(fits("EnhetsID;Personnummer;Summerat antal timmar oanmäld frånvaro för perioden\n12345;000106-0001;2.5\n")).toEqual(["skola24-extens-franvaro"]);
  });
});

describe("recognising a file by position", () => {
  const row = (at: number) => `12345;000106-${String(1000 + at)};${at}`;

  it("looks at the first 25 rows: a file whose first three rows fit and the next twenty-two do not is not offered", () => {
    const text = [row(1), row(2), row(3), ...Array.from({ length: 30 }, () => "x;y;z")].join("\n");
    expect(fits(text)).toEqual([]);
  });

  it("needs four rows in five to fit: three in five is not offered, four is", () => {
    expect(fits([row(1), row(2), row(3), "a;b;c", "a;b;c"].join("\n"))).toEqual([]);
    expect(fits([row(1), row(2), row(3), row(4), "a;b;c"].join("\n"))).toEqual(["skola24-extens-franvaro"]);
  });

  it("needs a row to reach the description's last required column: guardians' rows of three cells are not offered", () => {
    expect(fits("99999002TF01;99999003TF01;Åsa\n99999002TF02;99999003TF02;Bo\n")).not.toContain("skola24-foraldrar-csv");
    expect(fits("99999002TF01;99999003TF01;Åsa;Öberg\n99999002TF02;99999003TF02;Bo;Björk\n")).toEqual(["skola24-foraldrar-csv"]);
  });

  it("takes the first row's id column to be data when only ONE of two id columns holds a number", () => {
    // `some`, not `every`: a guardian row whose pupil id is missing is still a row of data, and is not taken for a header.
    const reading = readFormat(readTable(";99999003TF01;Åsa;Öberg;a@example.invalid\n99999002TF02;99999003TF02;Bo;Björk;\n"), parents)!;
    expect(reading.by).toBe("position");
    expect(reading.block.body).toHaveLength(2);
  });
});

describe("the extens description, which has no kind", () => {
  it("is read on position and drops its id column without a Rastra field", () => {
    expect(readFormat(readTable("12345;000106-0001;2.5\n"), extens)!.assignment).toEqual([null, null, null]);
  });
});
