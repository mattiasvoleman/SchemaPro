import { describe, expect, it } from "vitest";
import { KEEP, mark } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * A FILE WITH NO HEADER ROW (review of #377).
 *
 * The default header row is the first row that is nearly as full as the fullest of the first ten. In a file that is only records (a list of persons
 * from a system that writes no header) that is the first person: its cells became column names, were searched by shape only, and the person's name
 * was not collected as a known name. "Anna Svensson" in the first row stayed in the safe file, and so did "Anna" in the comment next to it.
 */

const HEADERLESS = ["Anna Svensson;800101-1234;Anna ringde idag;7A", "Bengt Berg;810202-2345;Bengt sjuk;7B", "Eva Eklund;820303-3456;Eva kommer sent;7C", ""].join("\n");
const parse = (text: string) => parseText(text, "file", "UTF-8", false)!;

describe("a file whose first row is a record", () => {
  it("has no header row by default: a row with a personnummer as a whole cell is a person, not a header", () => {
    const plan = planFile(parse(HEADERLESS));
    expect(plan.headerRow).toBeNull();
    expect(plan.titleRows).toBe(0);
    expect(plan.columns).toHaveLength(4);
  });

  it("replaces the first person as it replaces the others", () => {
    const result = pseudonymise([parse(HEADERLESS)], { files: [{ treatments: { 0: mark("namn"), 2: KEEP, 3: KEEP } }] });
    if (!result.ok) throw new Error(`undecided: ${JSON.stringify(result.undecided)}`);
    expect(result.files[0]!.text).not.toMatch(/Anna|Svensson|Bengt|Berg|Eva|Eklund|800101/);
    expect(result.check.passed).toBe(true);
  });

  it("still takes a real header row for one, and a title above it for a title", () => {
    expect(planFile(parse("Namn;Personnummer;Klass\nAnna;800101-1234;7A\n")).headerRow).toBe(1);
    expect(planFile(parse("Utskrift;sida 1\nNamn;Personnummer;Klass\nAnna;800101-1234;7A\n")).headerRow).toBe(2);
    expect(planFile(parse("Namn;Kontakt\nAnna;anna@skola.se\n")).headerRow).toBe(1);
  });

  it("lets the user say that the first row is the header all the same", () => {
    expect(planFile(parse(HEADERLESS), 1).headerRow).toBe(1);
  });
});
