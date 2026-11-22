import { describe, expect, it } from "vitest";
import { readTable } from "@/lib/column-table";
import { templateCsvContent } from "@/lib/csv";
import { detectFormats, formatsOfKind } from "@/lib/skola24-format";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";

/**
 * A school's own list is not offered as a file of Skola24's. Rastra's own pupils' template (fornamn, efternamn, epost, telefon, klass) has three
 * of the four headers of Skola24's pupils' file (efternamn, förnamn, klass), and every export of ours is read back with the same headers: the
 * offer "this looks like Skola24's file" came up on the most ordinary import there is. Skola24's files are keyed on a personnummer.
 */
describe("a school's own list against Skola24's descriptions", () => {
  it.each(["students", "guardians", "teachers"] as const)("is not offered Rastra's own %s template, with or without Skola24's descriptions of other kinds", (kind) => {
    const table = readTable(templateCsvContent(kind));
    expect(detectFormats(table, formatsOfKind(kind))).toEqual([]);
    expect(detectFormats(table, SKOLA24_FORMATS)).toEqual([]);
  });

  it("is still offered a pupils' file with a personnummer column and only two more of its headers", () => {
    const fits = detectFormats(readTable("Personnummer\tEfternamn\tFörnamn\n19000105-0001\tTestsson\tÅsa\n"), formatsOfKind("students"));
    expect(fits.map((fit) => [fit.format, fit.by, fit.exact])).toEqual([["skola24-elever-klass", "header", false]]);
  });

  it("is not offered the pupils' description for the same three headers without the personnummer", () => {
    expect(detectFormats(readTable("Efternamn\tFörnamn\tKlass\nTestsson\tÅsa\t7A\n"), formatsOfKind("students"))).toEqual([]);
  });
});
