import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELDS } from "@/lib/column-fields";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";

/*
 * P1 Pilotkit: sentences of 3.7 and 3.8 that said a little more or less than what they stand beside.
 *
 * Each one is held to the other place that says the truth: the checklist's own numbering, 3.6's table of what an import does to a row
 * that exists, the descriptions of Skola24's files, the importer's fields.
 */

const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8");
const GENERATE_PAGE = readFileSync(join(__dirname, "..", "app", "[locale]", "(app)", "admin", "generate", "page.tsx"), "utf8");
const decode = (text: string): string => text.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const flat = (markup: string): string => decode(markup.replace(/<[^>]+>/g, " "));

const between = (from: string, to: string): string => {
  const start = MANUAL.indexOf(from);
  const end = MANUAL.indexOf(to, start);
  return start < 0 || end < 0 ? "" : MANUAL.slice(start, end);
};
const S36 = flat(between('<h3 id="s36"', '<h3 id="s37"'));
const S37 = between('<h3 id="s37"', '<h3 id="s38"');
const S38 = between('<h3 id="s38"', "</section>");

/** The steps of 3.7's table: number and what the step is called. */
const STEPS = [...S37.matchAll(/<tr><td class="k">(\d+)<\/td><td>([^<]*)<\/td>/g)].map((match) => ({ step: Number(match[1]), name: match[2]! }));

describe("3.7 and 3.8 say no more and no less than the places they stand beside", () => {
  it("has the steps it is read against", () => {
    expect(STEPS.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("warns before the step that presses Generera, by its number", () => {
    const generate = STEPS.find((step) => step.name === "Generera")!.step;
    expect(flat(S37)).toContain(`Läs det här före steg ${generate}`);
  });

  it("sends a moving school to the steps that CHECK something, and not to the one that plans", () => {
    const checks = STEPS.filter((step) => step.name.startsWith("Kontrollera")).map((step) => step.step);
    expect(checks).toEqual([6, 8]);
    expect(flat(S38)).toContain(`Kontrollera som i steg ${checks[0]} och ${checks[1]} i 3.7`);
  });

  it("says a rerun of a corrected file leaves rows alone except the two things the manual says it updates", () => {
    // 2.6 says the teachers' file updates a post that differs (ImportService does: postIsUnchanged, then update), 3.6 says the duties' file does.
    expect(flat(MANUAL)).toContain("En tjänst som står annorlunda i filen än i registret uppdateras");
    expect(S36).toContain("uppdaterar uppdraget i stället för att dubblera det");
    expect(flat(S37)).toMatch(/hoppas över, utom en lärares tjänst och ett uppdrag[^:]*uppdateras/);
  });

  it("does not say that none of Skola24's schedule files has a column list, when one has", () => {
    expect(SKOLA24_FORMATS.some((format) => format.product === "Skola24 Schema" && format.columns !== null)).toBe(true);
    expect(flat(S38)).not.toContain("för något av schemats filer");
    expect(flat(S38)).toContain("för de flesta av schemats filer inte ens kolumnerna");
  });

  it("names the quicker way to get a signature in, which is the teachers' file, and the post a signature needs", () => {
    // The importer has both fields, and the file's own columns say so.
    const teacherFields = FIELDS.teachers.map((field) => field.id);
    expect(teacherFields).toEqual(expect.arrayContaining(["employmentPercent", "signature"]));
    const text = flat(S38);
    expect(text).toContain("larare.csv");
    expect(text).toContain("tjanst_procent");
    expect(text).toContain("En signatur sparas på lärarens tjänst");
  });

  it("names every row of Generera's Förutsättningar, and the page has no more rows than the guide names", () => {
    // The page's list is `const prerequisites = [...]`: a row is an object with an `ok`. The guide names year, requirements, teachers, rooms, and the staffed row.
    const start = GENERATE_PAGE.indexOf("const prerequisites:");
    const end = GENERATE_PAGE.indexOf("\n  ];", start);
    expect(start).toBeGreaterThan(0);
    const list = GENERATE_PAGE.slice(GENERATE_PAGE.indexOf("}[] = [", start), end);
    const rows = (list.match(/\bok:/g) ?? []).length;
    expect(rows).toBe(5);
    const step7 = flat(S37.slice(S37.indexOf('<td class="k">7</td>'), S37.indexOf('<td class="k">8</td>')));
    for (const named of ["läsår", "timplansposter", "lärare", "salar", "Alla timplansposter har lärare"]) expect(step7).toContain(named);
  });

  it("says that the size limit is the schedule file's, since the lists' CSV import has none to keep track of", () => {
    expect(S36).toContain("Det finns ingen storleksgräns du behöver hålla reda på");
    expect(flat(S38)).toContain("En schemafil som läses in får vara högst 700 kB");
  });
});
