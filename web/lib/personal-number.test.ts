import { describe, expect, it } from "vitest";
import fixture from "../../src/schedule-exchange/__fixtures__/personal-number-cases.json";
import { findPersonalNumbers, hasPersonalNumber, isPersonalNumberHeader, redactPersonalNumbers, REDACTED } from "@/lib/personal-number";
import { normalizeHeader } from "@/lib/csv-export";

/** The text with every found part replaced by REDACTED: what redactPersonalNumbers must equal. */
function redactByMatches(text: string): string {
  let out = "";
  let from = 0;
  for (const found of findPersonalNumbers(text)) {
    out += text.slice(from, found.start) + REDACTED;
    from = found.end;
  }
  return out + text.slice(from);
}

describe("findPersonalNumbers agrees with the shape the rest of the module holds", () => {
  it.each(fixture.cases.map((c) => [c.text, c.has, c.redacted] as const))("%j: found %s, and replacing the parts gives %j", (text, has, redacted) => {
    expect(findPersonalNumbers(text).length > 0).toBe(has);
    expect(redactByMatches(text)).toBe(redacted);
  });

  it("names the digits, however the number was written", () => {
    const text = "A 800101-1234, B 19800101 1234, C 8001011234, D 800101+1234 och E １９８００１０１－１２３４.";
    const digits = findPersonalNumbers(text).map((found) => found.digits);
    expect(digits).toEqual(["8001011234", "198001011234", "8001011234", "8001011234", "198001011234"]);
  });

  it("locates a number in the text it was found in, also after a fold that changed spellings", () => {
    const text = "Anna １９８００１０１－１２３４ ringde.";
    const [found] = findPersonalNumbers(text);
    expect(text.slice(found!.start, found!.end)).toBe("１９８００１０１－１２３４");
    expect(found!.folded).toBe("19800101-1234");
  });

  it("finds nothing in a short text, null-ish text or a text without a number", () => {
    expect(findPersonalNumbers("")).toEqual([]);
    expect(findPersonalNumbers("123")).toEqual([]);
    expect(findPersonalNumbers("Klass 7A, sal 12")).toEqual([]);
  });
});

/**
 * The browser's copy of the personnummer shape, held to the gateway's by one list of cases
 * (src/schedule-exchange/__fixtures__/personal-number-cases.json, which the gateway's spec replays too).
 */
describe("the personnummer shape equals the gateway's", () => {
  it("has cases on both sides, and a redaction that changes exactly the texts that are numbers", () => {
    expect(fixture.cases.filter((c) => c.has).length).toBeGreaterThan(30);
    expect(fixture.cases.filter((c) => !c.has).length).toBeGreaterThan(30);
  });

  it.each(fixture.cases.map((c) => [c.text, c.has, c.redacted] as const))("%j: is a number %s, redacted %j", (text, has, redacted) => {
    expect(hasPersonalNumber(text)).toBe(has);
    expect(redactPersonalNumbers(text)).toBe(redacted);
  });

  it("is not a number for null, undefined and a short text", () => {
    expect(hasPersonalNumber(null)).toBe(false);
    expect(hasPersonalNumber(undefined)).toBe(false);
    expect(hasPersonalNumber("123")).toBe(false);
  });

  it("redacts every number of a text and nothing else, in the spelling it was written", () => {
    expect(redactPersonalNumbers("Anna 800101-1234 och Bo 19900202 4321.")).toBe(`Anna ${REDACTED} och Bo ${REDACTED}.`);
    expect(redactPersonalNumbers("Klass 7A")).toBe("Klass 7A");
  });
});

/**
 * What kind of number a part is, and which value (X3, 2026-11-22; the contract the pseudonymiser, X1, builds on). A personnummer and a samordningsnummer: the ten
 * last digits are the key, so ÅÅMMDD-NNNN and ÅÅÅÅMMDDNNNN are one person. A TF number (ÅÅÅÅMMDDTFnn, Skola24's): the ten digits it holds, and its key spells it
 * in upper case, so every spelling of one TF number is one key.
 */
describe("the kind and key of what is found", () => {
  it("a personnummer: kind personnummer, the ten last digits as key, whether written with ten or twelve", () => {
    const found = findPersonalNumbers("A 800101-1234, B 19800101 1234, C 8001011234, D 800101+1234 och E １９８００１０１－１２３４.");
    expect(found.map((f) => f.kind)).toEqual(["personnummer", "personnummer", "personnummer", "personnummer", "personnummer"]);
    expect(found.map((f) => f.key)).toEqual(["8001011234", "8001011234", "8001011234", "8001011234", "8001011234"]);
  });

  it("a samordningsnummer: the day plus 60 (61-91), the same ten digits as key", () => {
    const found = findPersonalNumbers("800161-1234 och 19800191-1234 och 8001811234, men 800131-1234 är ett personnummer");
    expect(found.map((f) => [f.kind, f.key])).toEqual([
      ["samordning", "8001611234"],
      ["samordning", "8001911234"],
      ["samordning", "8001811234"],
      ["personnummer", "8001311234"],
    ]);
  });

  it("a TF number: kind tf, its ten digits, and one key for every spelling of it, in upper case", () => {
    const found = findPersonalNumbers("A 19000101TF01, B 19000101tf01, C 19000101-TF01, D 19000101 Tf01, E １９０００１０１TF０１ och F 19000101/tF01.");
    expect(found).toHaveLength(6);
    expect(found.map((f) => f.kind)).toEqual(Array(6).fill("tf"));
    expect(found.map((f) => f.digits)).toEqual(Array(6).fill("1900010101"));
    expect(found.map((f) => f.key)).toEqual(Array(6).fill("19000101TF01"));
    // Another number is another key.
    expect(findPersonalNumbers("19000101TF02 och 19000102TF01").map((f) => f.key)).toEqual(["19000101TF02", "19000102TF01"]);
  });

  it("locates a TF number in the text it was found in, also after a fold that changed spellings", () => {
    const text = "Anna １９０００１０１TF０１ ringde.";
    const [found] = findPersonalNumbers(text);
    expect(text.slice(found!.start, found!.end)).toBe("１９０００１０１TF０１");
    expect(found!.folded).toBe("19000101TF01");
  });

  it("comes in the order of the text and never overlaps, whatever kinds stand side by side", () => {
    const text = "19000101TF01 800101-1234 19000102TF02;800161-1234 19000103-TF03 x 8001011234 19000104tf04";
    const found = findPersonalNumbers(text);
    expect(found.map((f) => f.kind)).toEqual(["tf", "personnummer", "tf", "samordning", "tf", "personnummer", "tf"]);
    for (let i = 1; i < found.length; i += 1) expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
    expect(found.map((f) => f.start)).toEqual([...found.map((f) => f.start)].sort((a, b) => a - b));
  });

  it("agrees with redactPersonalNumbers about every TF text: the same parts, the same redaction", () => {
    for (const text of ["19000101TF01", "Elev 19000101TF01 flyttad", "19000101TF01 och 19000102TF02", "800101-1234 och 19000101TF01", "ID19000101TF01", "19000101 TF 01", "7ATF12"]) {
      expect(redactByMatches(text), text).toBe(redactPersonalNumbers(text));
    }
  });

  it("finds a TF number in no text that is not one: the forms no file has shown, and the codes of a school", () => {
    for (const text of ["TF01", "19000101TF", "19000101TF1", "19000101TF123", "1900010TF01", "190001011TF01", "800101TF01", "19000101 TF 01", "1900 0101TF01", "7ATF12", "Ma7 TF12", "TF2026", "Block TF-12"]) {
      expect(findPersonalNumbers(text), text).toEqual([]);
    }
  });
});

describe("a header that says personnummer", () => {
  it.each(["Personnummer", "Samordningsnummer", "personnr", "PNR", "SSN", "Elevens personnummer", "Personal number", "Civic number", "Social security number", "TF-nummer", "TFnummer", "Tfnr", "TF nr", "Elevens TF-nummer"])(
    "%s is one",
    (header) => {
      expect(isPersonalNumberHeader(normalizeHeader(header))).toBe(true);
    },
  );

  it.each(["Namn", "Klass", "Pnrx", "Session", "Lärare", "Nummer", "Ämnesnr", "TF", "Tfn", "Tfnrs", "Stfnr"])("%s is not", (header) => {
    expect(isPersonalNumberHeader(normalizeHeader(header))).toBe(false);
  });
});
