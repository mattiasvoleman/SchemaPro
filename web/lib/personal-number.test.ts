import { describe, expect, it } from "vitest";
import fixture from "../../src/schedule-exchange/__fixtures__/personal-number-cases.json";
import { hasPersonalNumber, isPersonalNumberHeader, redactPersonalNumbers, REDACTED } from "@/lib/personal-number";
import { normalizeHeader } from "@/lib/csv-export";

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

describe("a header that says personnummer", () => {
  it.each(["Personnummer", "Samordningsnummer", "personnr", "PNR", "SSN", "Elevens personnummer", "Personal number", "Civic number", "Social security number"])(
    "%s is one",
    (header) => {
      expect(isPersonalNumberHeader(normalizeHeader(header))).toBe(true);
    },
  );

  it.each(["Namn", "Klass", "Pnrx", "Session", "Lärare", "Nummer", "Ämnesnr"])("%s is not", (header) => {
    expect(isPersonalNumberHeader(normalizeHeader(header))).toBe(false);
  });
});
