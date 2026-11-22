import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELDS } from "@/lib/column-fields";
import { mapGuardianRows, mapTeacherRows, parseCsv } from "@/lib/csv";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";

/*
 * P1 Pilotkit: what 3.8's Skola24 table says about a file is what a school meets when it reads one.
 *
 * lib/skola24-format.ts `unfillableFields` says which field a file can NEVER give (a pupils' file has no e-mail), and the table
 * says it. It cannot say that a file which has the column may still leave a cell in it empty, and Skola24's pages let two of them:
 * the guardians' file and the staff file mark the e-mail address as optional ("required: false" in lib/skola24-formats.ts),
 * while Rastra's importers need it on every row. A school that completes a guardians' file with the pupil's address, as the table
 * says, still has every row without the guardian's own refused ("Rad 2: kolumnen epost är tom"). The table says so.
 */

const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8");
const decode = (text: string): string => text.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const flat = (markup: string): string => decode(markup.replace(/<[^>]+>/g, " "));

/** The cells of one row of the Skola24 table, by the description's id. */
function cellsOf(id: string): string[] {
  const row = new RegExp(`<tr data-source="${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(MANUAL);
  return row === null ? [] : [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => flat(cell[1]!));
}

/** What the guide must say for a field the page lets be empty and the importer does not. */
const WORDS: Readonly<Record<string, RegExp>> = { email: /rad utan .*e-postadress.* läses inte/i };

describe("the Skola24 table says what an empty cell does", () => {
  const optionalButRequired = SKOLA24_FORMATS.flatMap((format) =>
    format.kind === null || format.columns === null
      ? []
      : format.columns
          .filter((column) => column.field !== undefined && column.required?.value === false && FIELDS[format.kind!].some((field) => field.id === column.field && field.required))
          .map((column) => ({ id: format.id, field: column.field! })),
  );

  it("finds the two descriptions whose page lets the e-mail address be empty", () => {
    expect(optionalButRequired).toEqual([
      { id: "skola24-foraldrar-csv", field: "email" },
      { id: "skola24-personal-csv", field: "email" },
    ]);
  });

  it("is what the importers do: a row with the cell empty is refused, whoever else is in the file", () => {
    const teachers = mapTeacherRows(parseCsv("fornamn;efternamn;epost\nBo;Ek;\nAnna;Berg;anna@skolan.example\n"));
    expect(teachers.rows).toHaveLength(1);
    expect(teachers.errors).toHaveLength(1);
    const guardians = mapGuardianRows(parseCsv("fornamn;efternamn;epost;elev_epost\nBo;Ek;;elev@skolan.example\nAnna;Berg;anna@skolan.example;elev@skolan.example\n"));
    expect(guardians.rows).toHaveLength(1);
    expect(guardians.errors).toHaveLength(1);
  });

  it.each(optionalButRequired)("says so in the row of $id", ({ id, field }) => {
    const words = WORDS[field];
    expect(words, `this test has no words for the field "${field}"`).toBeDefined();
    expect(cellsOf(id)[1]).toMatch(words!);
  });

  it("tells a school with a pupils' file to add the column, since the file has none to point out", () => {
    const [, how, what] = cellsOf("skola24-elever-klass");
    expect(how).toContain("ingen e-postadress");
    expect(what).toContain("Lägg till en kolumn");
  });

  it("gives the reason the group file is not read that the description gives: two layouts keyed on personnummer", () => {
    const description = SKOLA24_FORMATS.find((format) => format.id === "skola24-grupp-elev")!;
    // The page DOES give the order, twice: an answer of "no page gives it" is the other file's.
    expect(description.facts.map((fact) => fact.value).join(" ")).toContain("Två lägen");
    const [, how] = cellsOf("skola24-grupp-elev");
    expect(how).toContain("två lägen");
    expect(how).not.toContain("ingen offentlig sida");
  });
});
