import { describe, expect, it } from "vitest";
import { findPersonalData, isMarkerAddress } from "@/lib/pseudonym-detect";
import { KEEP } from "@/lib/pseudonym-headers";
import { isMarker } from "@/lib/pseudonym-markers";
import { parseText } from "@/lib/pseudonym-input";
import { KnownNames } from "@/lib/pseudonym-names";
import { leftIn, pseudonymise } from "@/lib/pseudonym-run";

/*
 * WHAT IS A MARKER, AND WHAT ONLY LOOKS LIKE ONE (review of #377).
 *
 * A cell that is a marker already is left as it is (so that the tool run on its own output changes nothing), and the check takes the markers out
 * of a cell before it searches it. Both took `PNR-` or `TEL-` followed by ANY number of digits for a marker, so a personnummer or a telephone number
 * with a prefix ("PNR-198001011234", "TEL-0701234567") stayed in a column of personnummer, and the check passed over it. A marker is what the
 * book hands out: four to six digits. An address on @exempel.invalid is a marker only as the book writes it.
 */

describe("a marker is what the book writes", () => {
  it.each(["TEL-0701234567", "PNR-198001011234", "SAM-8001611234", "NAMN-1234567", "epost-0701234567@exempel.invalid"])("%s is no marker", (text) => {
    expect(isMarker(text)).toBe(false);
  });

  it.each(["PNR-0001", "TEL-0012", "NAMN-12345", "SIGN-123456", "epost-0007@Exempel.Invalid"])("%s is one", (text) => {
    expect(isMarker(text)).toBe(true);
  });

  it("takes an address of the marker domain for a marker only when it is written as the book writes it", () => {
    expect(isMarkerAddress("epost-0007@exempel.invalid")).toBe(true);
    expect(isMarkerAddress("anna.svensson@exempel.invalid")).toBe(false);
    expect(isMarkerAddress("epost-12@exempel.invalid")).toBe(false);
    expect(findPersonalData("Mejla anna.svensson@exempel.invalid").map((found) => found.kind)).toEqual(["epost"]);
  });
});

describe("a number with a prefix is a number", () => {
  const input = (rows: string[]) => parseText(["Personnummer;Klass", ...rows.map((row) => `${row};7A`)].join("\n") + "\n", "file", "UTF-8", false)!;

  it("is replaced in a column of personnummer, and nothing of it is left", () => {
    const result = pseudonymise([input(["PNR-198001011234", "TEL-0701234567", "SAM-8001611234", "800101-1234"])], { files: [{}] });
    if (!result.ok) throw new Error("undecided");
    const text = result.files[0]!.text;
    expect(text).not.toContain("198001011234");
    expect(text).not.toContain("0701234567");
    expect(text).not.toContain("8001611234");
    expect(result.check.passed).toBe(true);
  });

  it("is replaced in a column the user kept", () => {
    const parsed = parseText("Klass;Övrigt\n7A;TEL-0701234567\n7B;anna.svensson@exempel.invalid\n", "file", "UTF-8", false)!;
    const result = pseudonymise([parsed], { files: [{ treatments: { 1: KEEP } }] });
    if (!result.ok) throw new Error("undecided");
    expect(result.files[0]!.text).not.toMatch(/0701234567|svensson/);
  });

  it("is found by the check, which takes only the book's own markers out of a cell", () => {
    const names = new KnownNames();
    expect(leftIn("TEL-0701234567", names)).toBe(1);
    expect(leftIn("PNR-198001011234", names)).toBe(1);
    expect(leftIn("anna.svensson@exempel.invalid", names)).toBe(1);
    expect(leftIn("TEL-0001 och epost-0002@exempel.invalid", names)).toBe(0);
  });
});
