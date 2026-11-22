import { describe, expect, it } from "vitest";
import { readTable } from "@/lib/column-table";
import { detectFormats, readFormat } from "@/lib/skola24-format";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";

/**
 * A format is applied by itself only on exact DOCUMENTED headers (the user's decision, X3 design §6.2). No page prints a header row for
 * the parents', personnel, children's or Extens file (and the course files Skola24 publishes have none), so a file with the page's own
 * words in its first row is read on them and only OFFERED: `exact` is for a format whose page shows a header row (Elever, Klass – Elev).
 */
const described = SKOLA24_FORMATS.filter((format) => format.columns !== null);

describe("exact", () => {
  it.each(described.map((format) => [format.id, format] as const))("%s: a first row of the page's own labels is read on headers, and is exact only where a page shows a header row", (_id, format) => {
    const separator = format.separator?.value ?? ";";
    const table = readTable(`${format.columns!.map((column) => column.label.value).join(separator)}\n${format.columns!.map(() => "x").join(separator)}\n`);
    const shown = format.headerRow?.value === "yes";
    const reading = readFormat(table, format, { header: "present" })!;
    expect(reading.by).toBe("header");
    expect(reading.missing).toEqual([]);
    expect(reading.exact).toBe(shown);
    expect(detectFormats(table).filter((fit) => fit.format === format.id).map((fit) => fit.exact)).toEqual([shown]);
  });

  it("is possible for exactly one of the five: the file whose page shows its header row", () => {
    expect(described.filter((format) => format.headerRow?.value === "yes").map((format) => format.id)).toEqual(["skola24-elever-klass"]);
  });
});
