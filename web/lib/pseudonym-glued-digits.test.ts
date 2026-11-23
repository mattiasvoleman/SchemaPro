import { describe, expect, it } from "vitest";
import { findPersonalData, luhnHolds } from "@/lib/pseudonym-detect";
import { KEEP } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * A PERSONNUMMER WITH A DIGIT STUCK TO IT (the review of #403). The door's shape takes no number with a digit beside it, and the pseudonymiser took the same, so "80010112347A" (a number and the first digit of a
 * class, in a file of fixed width with no blank between its fields) was left standing and the check, which searches the same way, said nothing was left. The review of #396 (L-1) asked for the same of a TF number, and it was
 * done; a personnummer has no letters to tell it from a code by, so the rule here asks for a check digit that holds.
 */

/** A ten-digit number with a Luhn digit that holds, from nine digits. */
function withCheckDigit(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let digit = nine.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return nine + String((10 - (sum % 10)) % 10);
}

const TEN = withCheckDigit("800101123");
const SAM = withCheckDigit("800161123");
const found = (text: string) => findPersonalData(text).map((finding) => ({ kind: finding.kind, text: text.slice(finding.start, finding.end), key: finding.key }));

describe("a personnummer with digits stuck to it", () => {
  it("is found with one to three digits after it or before it, and the finding is the whole run of digits", () => {
    expect(luhnHolds(TEN)).toBe(true);
    for (const [text, taken] of [
      [`Elev ${TEN}7A i 7B`, `${TEN}7`],
      [`Elev ${TEN}1 i grupp`, `${TEN}1`],
      [`Elev ${TEN}123 i grupp`, `${TEN}123`],
      [`Elev 7${TEN} i grupp`, `7${TEN}`],
      [`Elev 123${TEN} i grupp`, `123${TEN}`],
      [`Elev 19${TEN}7A i grupp`, `19${TEN}7`],
    ] as const) {
      expect(found(text), text).toEqual([{ kind: "pnr", text: taken, key: TEN }]);
    }
    expect(found(`Elev ${SAM}7A`)).toEqual([{ kind: "sam", text: `${SAM}7`, key: SAM }]);
  });

  it("is not a code: a run of digits whose date is no date, whose check digit fails, a timestamp of fourteen, a number of ten and one of fourteen or more", () => {
    const wrong = TEN.slice(0, 9) + String((Number(TEN[9]) + 1) % 10);
    for (const text of [`Elev ${wrong}7A`, `Elev 7${wrong}`, "Elev 1763712000000 i grupp", "Id 20261121081500", `Id ${TEN}1234 i grupp`, "Id 99999999999", "Id 12345678901"]) {
      expect(found(text).filter((finding) => finding.kind !== "tel"), text).toEqual([]);
    }
  });

  it("takes the stuck digits with it, so that no marker stands beside the digits of another field, and gives the same person the same marker as the number written whole", () => {
    const input = parseText(["Elevlista för terminen", `Elev ${TEN}7A i sjuan`, `Elev ${TEN} igen`, "Tack för hjälpen", "Hälsningar", "Skolan", ""].join("\r\n"), "file", "UTF-8", false)!;
    const treatments = Object.fromEntries(planFile(input).columns.filter((column) => column.proposal === null).map((column) => [column.index, KEEP]));
    const result = pseudonymise([input], { files: [{ treatments }] });
    if (!result.ok) throw new Error("undecided");
    expect(result.files[0]!.text).toBe("Elevlista för terminen\r\nElev PNR-0001A i sjuan\r\nElev PNR-0001 igen\r\nTack för hjälpen\r\nHälsningar\r\nSkolan\r\n");
    expect(result.report.totals.pnr).toEqual({ occurrences: 2, distinct: 1 });
    expect(result.check.passed).toBe(true);
  });
});
