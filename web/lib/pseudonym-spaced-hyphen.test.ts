import { describe, expect, it } from "vitest";
import { KEEP } from "@/lib/pseudonym-headers";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * A telephone number written with a hyphen and a blank on each side (the review of #398). "070 - 123 45 67" is how a person types a number into a free-text
 * column, and a word processor makes the same of "070–123 45 67" when it puts blanks round the dash. Two separators are what a sentence may put between two groups of
 * a number, and a spaced hyphen is three, so the groups were two numbers of three and seven digits and neither was one.
 */

const spans = (text: string): string[] => findPersonalData(text).map((f) => `${f.kind}:${text.slice(f.start, f.end)}`);

describe("a telephone number with a spaced hyphen", () => {
  it.each([
    ["Ring 070 - 123 45 67 efter fem", "tel:070 - 123 45 67"],
    ["Ring 070 – 123 45 67 efter fem", "tel:070 – 123 45 67"],
    ["Ring 08 - 123 456 78 efter fem", "tel:08 - 123 456 78"],
    ["Ring +46 70 - 123 45 67 efter fem", "tel:+46 70 - 123 45 67"],
    ["070 - 1234567", "tel:070 - 1234567"],
  ])("%s is found whole", (text, found) => {
    expect(spans(text)).toEqual([found]);
  });

  it("is the same number as the one written 070-123 45 67", () => {
    const key = (text: string) => findPersonalData(text)[0]?.key;
    expect(key("070 - 123 45 67")).toBe(key("070-123 45 67"));
  });

  it("does not take a time range written the same way for a number: lessons are 0800 - 0845", () => {
    for (const text of ["0800 - 0845", "Mån 0830 - 0915 och 0930 - 1015", "0800 - 0845 Anna", "kl 0800 - 1600"]) expect(spans(text), text).toEqual([]);
  });

  it("takes it out of a column the user kept, so that nothing of it is left", () => {
    const input = parseText("Klass;Notis\r\n7A;Ring 070 - 123 45 67 efter fem\r\n7B;Prov på fredag\r\n7C;Sjuk\r\n8A;Byt sal\r\n", "file", "UTF-8", false)!;
    const plan = planFile(input);
    const treatments = Object.fromEntries(plan.columns.filter((c) => c.proposal === null).map((c) => [c.index, KEEP]));
    const result = pseudonymise([input], { files: [{ treatments }] });
    if (!result.ok) throw new Error(JSON.stringify(result.undecided));
    expect(result.files[0]!.text).toBe("Klass;Notis\r\n7A;Ring TEL-0001 efter fem\r\n7B;Prov på fredag\r\n7C;Sjuk\r\n8A;Byt sal\r\n");
  });
});
