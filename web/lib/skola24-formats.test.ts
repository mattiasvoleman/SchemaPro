import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldOf } from "@/lib/column-fields";
import { readTable } from "@/lib/column-table";
import { normalizeHeader } from "@/lib/csv-export";
import { readFixture } from "@/lib/__fixtures__/skola24-read";
import { readFormat, unfillableFields } from "@/lib/skola24-format";
import { SKOLA24_FORMATS, formatById } from "@/lib/skola24-formats";
import type { Fact, FormatDescriptor } from "@/lib/skola24-format-types";

/**
 * The descriptions held to what they claim (Formatbeskrivare, X3): every fact has a source, every column is accounted for, every
 * field is a field of the format's kind (so, through web/lib/column-fields.test.ts, one of the gateway's), and every described
 * format has a fixture that its own reader reads without a column it cannot place.
 */

/** Every fact of a description, with where it stands. */
function factsOf(format: FormatDescriptor): { where: string; fact: Fact<unknown> }[] {
  const found: { where: string; fact: Fact<unknown> }[] = [];
  const add = (where: string, fact: Fact<unknown> | null | undefined) => {
    if (fact) found.push({ where: `${format.id} ${where}`, fact });
  };
  add("separator", format.separator);
  add("encoding", format.encoding);
  add("headerRow", format.headerRow);
  add("order", format.order);
  format.facts.forEach((fact, at) => add(`facts[${at}]`, fact));
  for (const column of format.columns ?? []) {
    add(`${column.id}.label`, column.label);
    add(`${column.id}.required`, column.required);
    add(`${column.id}.width`, column.width);
  }
  return found;
}

describe("every description", () => {
  it("is one of ten, with a distinct id", () => {
    expect(SKOLA24_FORMATS).toHaveLength(10);
    expect(new Set(SKOLA24_FORMATS.map((format) => format.id)).size).toBe(SKOLA24_FORMATS.length);
    expect(formatById("skola24-personal-csv")?.kind).toBe("teachers");
    expect(formatById("nope")).toBeUndefined();
  });

  it.each(SKOLA24_FORMATS.map((format) => [format.id, format] as const))("%s: every fact has a page, the day it was read, and the date the page carries", (_id, format) => {
    for (const { where, fact } of factsOf(format)) {
      // A support page, or a file Skola24 publishes under "Filer för kurser".
      expect(fact.source.url, where).toMatch(/^https:\/\/www\.skola24\.com\/(support|globalassets\/support)\//);
      // The pages were read on 2026-11-21 and the course files on 2026-11-22 (the commit that added them says so, and so does the header of skola24-formats.ts).
      expect(fact.source.read, where).toBe(fact.source.url.includes("/globalassets/support/kursdokument/") ? "2026-11-22" : "2026-11-21");
      expect(fact.source.updated === null || /^\d{4}-\d{2}-\d{2}$/.test(fact.source.updated), where).toBe(true);
      expect(["DOKUMENTERAT", "TOLKAT"], where).toContain(fact.source.status);
    }
  });

  it.each(SKOLA24_FORMATS.map((format) => [format.id, format] as const))("%s: a width is only ever DOKUMENTERAT, and an encoding is DOKUMENTERAT or seen in a file Skola24 publishes", (_id, format) => {
    for (const { where, fact } of factsOf(format)) {
      if (where.endsWith(".width")) expect(fact.source.status, where).toBe("DOKUMENTERAT");
      // No page says a code page; a published course file shows one, which is our reading of what an export holds, and says so.
      if (where.endsWith(" encoding") && fact.source.status === "TOLKAT") expect(fact.source.url, where).toMatch(/\/globalassets\/support\/kursdokument\/[\w-]+\.csv$/);
    }
  });

  it("states no width, and an encoding only for the three CSV files Skola24 publishes examples of: Windows-1252, from a file", () => {
    // If a width appears, a page now says one: add it WITH its page, and say so in the design note. Do not loosen the test.
    const stated = SKOLA24_FORMATS.flatMap(factsOf);
    expect(stated.filter(({ where }) => where.endsWith(".width"))).toEqual([]);
    const encodings = stated.filter(({ where }) => where.endsWith(" encoding"));
    expect(encodings.map(({ where }) => where.split(" ")[0])).toEqual(["skola24-foraldrar-csv", "skola24-personal-csv", "skola24-barn-csv"]);
    expect(encodings.every(({ fact }) => fact.value === "windows-1252" && fact.source.status === "TOLKAT")).toBe(true);
  });
});

describe("a description with columns", () => {
  const described = SKOLA24_FORMATS.filter((format) => format.columns !== null);

  it("is the five whose layout a public page gives", () => {
    expect(described.map((format) => format.id)).toEqual(["skola24-foraldrar-csv", "skola24-personal-csv", "skola24-barn-csv", "skola24-elever-klass", "skola24-extens-franvaro"]);
  });

  it.each(described.map((format) => [format.id, format] as const))("%s: the first spelling of a column is its label, and every spelling is normalised", (_id, format) => {
    for (const column of format.columns!) {
      expect(column.synonyms[0], column.id).toBe(normalizeHeader(column.label.value));
      for (const synonym of column.synonyms) expect(normalizeHeader(synonym), `${column.id} ${synonym}`).toBe(synonym);
    }
  });

  it.each(described.map((format) => [format.id, format] as const))("%s: no two columns share a spelling", (_id, format) => {
    const all = format.columns!.flatMap((column) => column.synonyms);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(described.map((format) => [format.id, format] as const))("%s: every column is a personnummer column, a Rastra field, or says why Rastra reads nothing from it", (_id, format) => {
    for (const column of format.columns!) {
      const accounted = Number(column.personalNumber === true) + Number(column.field !== undefined) + Number(column.unread !== undefined);
      // A confidential mark is a personnummer-free column with a reason; the three are otherwise exclusive.
      expect(accounted, column.id).toBe(1);
      if (column.confidentialMark === true) expect(column.unread, column.id).toBe("confidentialMark");
      if (column.field !== undefined) {
        expect(format.kind, `${column.id} has a field but the format has no kind`).not.toBeNull();
        expect(fieldOf(format.kind!, column.field), `${format.kind} has no field ${column.field}`).toBeDefined();
      }
      if (format.kind === null) expect(column.field, column.id).toBeUndefined();
    }
    const fields = format.columns!.flatMap((column) => (column.field === undefined ? [] : [column.field]));
    expect(new Set(fields).size, "two columns for one field").toBe(fields.length);
  });

  it.each(described.map((format) => [format.id, format] as const))("%s: a format with a fixed order says so once, with a page; one without never has its order guessed", (_id, format) => {
    if (format.order !== null) expect(format.order.value).toBe("fixed");
    // The pupils' page gives the order twice, differently: its description has none, and says why.
    if (format.id === "skola24-elever-klass") {
      expect(format.order).toBeNull();
      expect(format.facts.some((fact) => fact.value.includes("två gånger olika"))).toBe(true);
    }
  });

  it.each(described.map((format) => [format.id, format] as const))("%s: has a fixture on disk, which its own reader reads without a column it cannot place", (_id, format) => {
    expect(format.fixtures.length).toBeGreaterThan(0);
    for (const name of format.fixtures) {
      expect(existsSync(join(__dirname, "__fixtures__", "skola24", name)), name).toBe(true);
      const reading = readFormat(readTable(readFixture(name)), format);
      expect(reading, name).not.toBeNull();
      expect(
        reading!.columns.filter((column) => column.verdict.status === "unknown"),
        `${name} has a column the description does not know`,
      ).toEqual([]);
      // The columns the reader says are personnummer are exactly the description's.
      expect(reading!.columns.filter((column) => column.verdict.status === "personalNumber").map((column) => (column.verdict as { column: string | null }).column)).toEqual(
        format.columns!.filter((column) => column.personalNumber === true).map((column) => column.id),
      );
    }
  });
});

describe("a description without columns", () => {
  const awaiting = SKOLA24_FORMATS.filter((format) => format.columns === null);

  it("is awaiting an example file: no fixture, and no reader to read it", () => {
    expect(awaiting.map((format) => format.id)).toEqual([
      "skola24-grupp-elev",
      "skola24-textfil",
      "skola24-mdb-extens",
      "skola24-tabell-lektion",
      "skola24-tabell-tjanstefordelning",
    ]);
    for (const format of awaiting) {
      expect(format.fixtures, format.id).toEqual([]);
      expect(format.kind, format.id).toBeNull();
      expect(readFormat(readTable("a;b;c\n1;2;3\n"), format), format.id).toBeNull();
    }
  });

  it("says what the pages say of Textfil: its posts, its rename, and what Version 2 adds", () => {
    const text = formatById("skola24-textfil")!.facts.map((fact) => fact.value).join("\n");
    expect(text).toContain("salar, lärare, elever, grupper, kurser, ämnen");
    expect(text).toContain("Procapita");
    expect(text).toContain("Version 2");
  });
});

describe("what Skola24's own files cannot give Rastra's importers", () => {
  it("is named, once, in the description and not found out file by file", () => {
    // The staff file carries every field the teachers' import needs; the pupils' file has no e-mail, and the parents' file links the
    // guardian to the pupil by personnummer where Rastra's import wants the pupil's e-mail. If an importer changes, this says so.
    expect(unfillableFields(formatById("skola24-personal-csv")!)).toEqual([]);
    expect(unfillableFields(formatById("skola24-elever-klass")!)).toEqual(["email"]);
    expect(unfillableFields(formatById("skola24-foraldrar-csv")!)).toEqual(["studentEmail"]);
    expect(unfillableFields(formatById("skola24-barn-csv")!)).toEqual([]);
    expect(unfillableFields(formatById("skola24-textfil")!)).toEqual([]);
  });
});
