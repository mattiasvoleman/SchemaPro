import { describe, expect, it } from "vitest";
import { findPersonalData, holdsPersonalData, isMarkerAddress, luhnHolds } from "@/lib/pseudonym-detect";

/** The check digit that makes nine digits a Luhn-valid ten. */
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

/** Invented numbers: a Luhn-valid one, and the same with its check digit made wrong. */
const VALID = withCheckDigit("800101123"); // 8001011234 or whatever the digit is
const WRONG = VALID.slice(0, 9) + String((Number(VALID[9]) + 1) % 10);
const SAMORDNING = withCheckDigit("800161123"); // day 61

const kinds = (text: string) => findPersonalData(text).map((f) => f.kind);
const keys = (text: string) => findPersonalData(text).map((f) => f.key);

describe("luhnHolds", () => {
  it("holds for the famous test number and for numbers with a made check digit, and fails for a wrong digit", () => {
    expect(luhnHolds("1212121212")).toBe(true);
    expect(luhnHolds(VALID)).toBe(true);
    expect(luhnHolds(WRONG)).toBe(false);
  });

  it.each(["", "123", "12345678901", "abcdefghij", "121212121a"])("does not hold for %j, which is not ten digits", (text) => {
    expect(luhnHolds(text)).toBe(false);
  });
});

describe("personnummer", () => {
  it("is found with or without century, with a hyphen, a plus, a blank or nothing, and the same person has one key", () => {
    const ten = VALID;
    const spellings = [`${ten.slice(0, 6)}-${ten.slice(6)}`, `19${ten.slice(0, 6)}-${ten.slice(6)}`, ten, `19${ten}`, `${ten.slice(0, 6)}+${ten.slice(6)}`, `${ten.slice(0, 6)} ${ten.slice(6)}`];
    for (const spelling of spellings) {
      const [found] = findPersonalData(`Elev ${spelling} i 7A`);
      expect(found?.kind, spelling).toBe("pnr");
      expect(found?.key, spelling).toBe(ten);
      expect(found?.checkDigit, spelling).toBe(true);
    }
  });

  it("is found where it stands in the text, and nowhere else", () => {
    const text = `Ring 0 eller ${VALID.slice(0, 6)}-${VALID.slice(6)}, tack`;
    const [found] = findPersonalData(text);
    expect(text.slice(found!.start, found!.end)).toBe(`${VALID.slice(0, 6)}-${VALID.slice(6)}`);
  });

  it("is a samordningsnummer when the day is 61 to 91", () => {
    expect(kinds(`${SAMORDNING.slice(0, 6)}-${SAMORDNING.slice(6)}`)).toEqual(["sam"]);
    expect(kinds(`19${SAMORDNING}`)).toEqual(["sam"]);
  });

  it("is still found when the check digit does not hold, and the finding says so: the number is replaced, only counted apart", () => {
    const [found] = findPersonalData(`${WRONG.slice(0, 6)}-${WRONG.slice(6)}`);
    expect(found?.kind).toBe("pnr");
    expect(found?.checkDigit).toBe(false);
  });

  it("is found in the full-width and the spaced spellings the shape folds", () => {
    expect(kinds("１９８００１０１－１２３４")).toEqual(["pnr"]);
    expect(kinds("19 80 01 01 - 12 34")).toEqual(["pnr"]);
  });

  it("says how it was written as a pattern with no digit of the value in it", () => {
    const spelling = (text: string) => findPersonalData(text)[0]?.spelling;
    expect(spelling(`19${VALID.slice(0, 6)}-${VALID.slice(6)}`)).toBe("ÅÅÅÅMMDD-NNNN");
    expect(spelling(`${VALID.slice(0, 6)}-${VALID.slice(6)}`)).toBe("ÅÅMMDD-NNNN");
    expect(spelling(VALID)).toBe("ÅÅMMDDNNNN");
    expect(spelling(`${VALID.slice(0, 6)}+${VALID.slice(6)}`)).toBe("ÅÅMMDD+NNNN");
    expect(spelling("1980-01-01-1234")).toBe("ÅÅÅÅ-MM-DD-NNNN");
    for (const found of findPersonalData(`${VALID} ${VALID.slice(0, 6)}-${VALID.slice(6)}`)) expect(found.spelling).not.toMatch(/\d/);
  });

  it("is not a date, a time, a period or a short number", () => {
    for (const text of ["2026-08-17", "08:10-09:00", "2026-08-17-2026-12-18", "Klass 7A", "12345", "1980"]) expect(findPersonalData(text), text).toEqual([]);
  });
});

describe("e-mail addresses", () => {
  it("is found in running text without the full stop that ends the sentence, in lower case as its key", () => {
    const text = "Skriv till Anna.Svensson@Skola.SE.";
    const [found] = findPersonalData(text);
    expect(found?.kind).toBe("epost");
    expect(text.slice(found!.start, found!.end)).toBe("Anna.Svensson@Skola.SE");
    expect(found?.key).toBe("anna.svensson@skola.se");
  });

  it("is found as mailto:, in angle brackets and in a list, each address on its own", () => {
    expect(keys("mailto:a@b.se")).toEqual(["a@b.se"]);
    expect(keys("Anna <a@b.se>; Bo <bo@c.se>")).toEqual(["a@b.se", "bo@c.se"]);
    expect(keys("a@b.se,c@d.se")).toEqual(["a@b.se", "c@d.se"]);
  });

  it("is found with no top domain too: what was typed as an address is taken", () => {
    expect(kinds("anna@skola")).toEqual(["epost"]);
  });

  it("holds the digits of a personnummer written inside it, so that the address is one finding and not two", () => {
    const text = `elev.${VALID.slice(0, 6)}-${VALID.slice(6)}@skola.se`;
    expect(kinds(text)).toEqual(["epost"]);
  });

  it("is not a lone @, an @ with nothing on one side, or the markers the pseudonymiser writes", () => {
    for (const text of ["@", "@anna", "anna@", "Välkommen @ 08:10", "a @ b"]) expect(findPersonalData(text), text).toEqual([]);
    expect(findPersonalData("epost-0001@exempel.invalid")).toEqual([]);
    expect(isMarkerAddress("epost-0007@Exempel.Invalid")).toBe(true);
    expect(isMarkerAddress("anna@skola.se")).toBe(false);
  });

  it("costs one scan when there is no @ in a cell of a million characters, and a linear one when there are many", () => {
    const started = Date.now();
    findPersonalData("a".repeat(1_000_000));
    findPersonalData("a@".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("telephone numbers", () => {
  it.each([
    ["070-123 45 67", "0701234567"],
    ["070 123 45 67", "0701234567"],
    ["08-123 456 78", "0812345678"],
    ["031-12 34 56", "031123456"],
    ["+46 70 123 45 67", "0701234567"],
    ["+46701234567", "0701234567"],
    ["0046 70 123 45 67", "0701234567"],
    ["+47 22 33 44 55", "+4722334455"],
    ["(08) 123 456 78", "0812345678"],
  ])("%s is one number with the key %s", (text, key) => {
    const found = findPersonalData(`Tel: ${text}.`);
    expect(found.map((f) => f.kind)).toEqual(["tel"]);
    expect(found[0]!.key).toBe(key);
  });

  it("is one value however it is written: +46 and 0046 are 0", () => {
    expect(new Set(["070-123 45 67", "+46 70 123 45 67", "0046701234567", "0701234567"].map((t) => keys(t)[0])).size).toBe(1);
  });

  it("is not a date, a time, a decimal, a version or a number that does not begin with 0", () => {
    for (const text of ["2026-08-17", "17-08-2026", "17/08/2026", "07.08.2026", "0.1234567", "08:10", "1234567", "12.5", "v1.2.3.4.5.6.7", "Sal 12 och 13"]) {
      expect(kinds(text), text).not.toContain("tel");
    }
  });

  it("is found in a cell with text around it, and ten bare digits that begin with 0 and fail the check digit are a telephone number", () => {
    expect(kinds("Ring 0701234567 efter 17")).toEqual(["tel"]);
    // Ten bare digits whose check digit holds are a personnummer.
    const validBare = withCheckDigit("070123456");
    expect(kinds(validBare)).toEqual(["pnr"]);
  });

  it("finds the number inside a run of digit groups that is not one number: next to a personnummer, to a short number, and to another telephone number", () => {
    const next = `${VALID.slice(0, 6)}-${VALID.slice(6)}`;
    const found = (text: string) => findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)]);
    expect(found(`Pnr ${next} 077-1539679 imorgon`)).toEqual([["pnr", next], ["tel", "077-1539679"]]);
    expect(found("1234 077-1539679")).toEqual([["tel", "077-1539679"]]);
    expect(found("kommer 78-109 077-1539679")).toEqual([["tel", "077-1539679"]]);
    expect(found("070-123 45 67 08-123 456 78")).toEqual([["tel", "070-123 45 67"], ["tel", "08-123 456 78"]]);
    expect(found("070-123 45 67, 08-123 456 78")).toEqual([["tel", "070-123 45 67"], ["tel", "08-123 456 78"]]);
  });

  it("finds a telephone number next to a date, and none inside one: dates are not read as numbers, a range of dates is not one", () => {
    const found = (text: string) => findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)]);
    for (const text of ["2026-08-17 2026-12-18", "2026-08-17-2026-12-18", "17-08-2026 07-12-2027", "Gäller 07.08.2026 till 17.12.2026", "08:10-09:00 och 10:00-11:00"]) expect(found(text), text).toEqual([]);
    expect(found("Från 2026-08-17 ring 070-123 45 67")).toEqual([["tel", "070-123 45 67"]]);
    expect(found("08-123 456 78/070-123 45 67")).toEqual([["tel", "08-123 456 78"], ["tel", "070-123 45 67"]]);
    expect(found("070-123 45 67-18")).toEqual([["tel", "070-123 45 67"]]);
  });

  it("makes one span of findings that overlap, so that no digit of either is left: a personnummer's shape across two numbers", () => {
    // "86 0207014960" reads as a twelve-digit personnummer with the century 86, taking the end of the number before it.
    const text = "076-543 57 86 0207014960";
    expect(findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)])).toEqual([["pnr", text]]);
    // Twelve digits in the middle of two numbers read as a samordningsnummer; the whole of both is replaced.
    const two = "+46 78 430 19 16 074 114 72 54";
    const spans = findPersonalData(two);
    expect(spans).toHaveLength(1);
    expect(two.slice(spans[0]!.start, spans[0]!.end)).toBe(two);
  });

  it("keeps two numbers apart that would be one if the first were allowed to swallow the start of the second, and leaves nothing of either", () => {
    const found = (text: string) => findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)]);
    expect(found("0046755162714 075-5162714")).toEqual([["tel", "0046755162714"], ["tel", "075-5162714"]]);
    expect(found("+47 22 33 44 55 070-123 45 67")).toEqual([["tel", "+47 22 33 44 55"], ["tel", "070-123 45 67"]]);
    // A long number with nothing after it is one number.
    expect(found("+49 151 12345678")).toEqual([["tel", "+49 151 12345678"]]);
  });

  it("cuts a run of numbers where the most digits are covered, so that nothing of a number is left in front of the next", () => {
    const found = (text: string) => findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)]);
    // "0237 072" is seven digits that could be a number; the number that covers more is 072-7691023.
    expect(found("0237 072-7691023")).toEqual([["tel", "072-7691023"]]);
    // Two numbers one after the other: a samordningsnummer reads across both, and the whole of them is one span (nothing left on either side).
    const two = "074-330 56 63 072-7691023";
    expect(findPersonalData(two).map((f) => two.slice(f.start, f.end))).toEqual([two]);
    expect(found("070-123 45 67 08-123 456 78")).toEqual([["tel", "070-123 45 67"], ["tel", "08-123 456 78"]]);
  });

  it("reads a number next to a personnummer so that the digits it adds are the most: the number before one that begins with a century that is the end of it", () => {
    // "00 34 141211" would be a number of its own (country code 34), but then "079-148" stays; "079-148 00 34" adds the most, and the personnummer takes the rest.
    const text = "Svensson 079-148 00 34 141211+3829 till";
    const spans = findPersonalData(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("079-148 00 34 141211+3829");
  });

  it("is one value with the trunk 0 of +46 (0)70 counted once", () => {
    expect(new Set(["070-123 45 67", "+46 (0)70 123 45 67", "+46 70 123 45 67"].map((t) => findPersonalData(t)[0]?.key)).size).toBe(1);
  });

  it("takes the longest run of digit groups that is a telephone number, and leaves what is too long to be part of one", () => {
    const text = "0701234567 89";
    expect(findPersonalData(text).map((f) => [f.kind, text.slice(f.start, f.end)])).toEqual([["tel", "0701234567"]]);
    const [one] = findPersonalData("Ring 070 123 45 67.");
    expect("Ring 070 123 45 67.".slice(one!.start, one!.end)).toBe("070 123 45 67");
  });

  it("a personnummer wins over a telephone number that overlaps it", () => {
    expect(kinds(`${VALID.slice(0, 6)}-${VALID.slice(6)}`)).toEqual(["pnr"]);
  });
});

describe("a cell that is hostile in size", () => {
  // A school's file is a stranger's. These are the shapes that were quadratic once (58 s and 74 s for a megabyte on a loaded host, found by timing them): one scan of every
  // finding for every group of digits. Now they are a second or so; the bound is loose, because a CI host is not quiet, and far under what a quadratic scan costs.
  const SHAPES: [string, string][] = [
    ["a megabyte of 1 1 1 1, every ten of them a personnummer by the shape", "1 ".repeat(500_000)],
    ["a megabyte of personnummer, one after the other", "800101-1234 ".repeat(80_000)],
    ["a megabyte of people with a number, an address and a telephone number each", "Anna 800101-1234 a@b.se 070-123 45 67 ".repeat(25_000)],
    ["a megabyte of 0 0 0 0, each a start of something that is not a number", "0 ".repeat(500_000)],
  ];
  it.each(SHAPES)("is read in seconds: %s", (_name, text) => {
    const started = Date.now();
    findPersonalData(text);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("an address in brackets (anna@[10.0.0.1]) is looked for within reach of its @ and no further (the review of #403)", () => {
  it("takes the bracket when it closes within reach, and not when it is far off", () => {
    const at = (text: string) => findPersonalData(text).map((finding) => text.slice(finding.start, finding.end));
    expect(at("Skriv till anna@[10.0.0.1] i dag")).toEqual(["anna@[10.0.0.1]"]);
    // 44 characters to the bracket is within reach (48 from the @); 60 is not, and a "[" ends an address in running text, so nothing is taken (as before: the reach is the same, only the scan is bounded).
    expect(at(`x@[${"1".repeat(43)}] y`)).toEqual([`x@[${"1".repeat(43)}]`]);
    expect(at(`x@[${"1".repeat(60)}] y`)).toEqual([]);
  });

  it("reads a text of 1.6 million characters with an @[ in every three in about the time it takes to read it, and not in the time of a scan to the end for each (the cost was quadratic: 14 s, found by timing it)", () => {
    const text = "a@[".repeat(530_000);
    const started = Date.now();
    findPersonalData(text);
    expect(Date.now() - started).toBeLessThan(3_000);
    // And with the one closing bracket at the very end, which a scan to the next "]" had to run to from every @.
    const closed = "a@[".repeat(529_999) + "]";
    const startedAgain = Date.now();
    findPersonalData(closed);
    expect(Date.now() - startedAgain).toBeLessThan(3_000);
  }, 120_000);
});

describe("findPersonalData", () => {
  it("returns findings in order of position and not overlapping, for any text", () => {
    const parts = ["a@b.se", VALID, "070-123 45 67", "text", " ", "2026-08-17", "+46 8 123 456 78", "Anna", "19800101-1234"];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 500; round += 1) {
      const text = Array.from({ length: 1 + (next() % 8) }, () => parts[next() % parts.length]).join(next() % 2 === 0 ? " " : ";");
      const found = findPersonalData(text);
      for (let i = 0; i < found.length; i += 1) {
        expect(found[i]!.start).toBeLessThan(found[i]!.end);
        if (i > 0) expect(found[i]!.start, text).toBeGreaterThanOrEqual(found[i - 1]!.end);
      }
    }
  });

  it("finds nothing in an empty or short text, and holdsPersonalData says so", () => {
    expect(findPersonalData("")).toEqual([]);
    expect(findPersonalData("abc")).toEqual([]);
    expect(holdsPersonalData("Klass 7A, sal 12, 08:10")).toBe(false);
    expect(holdsPersonalData("anna@skola.se")).toBe(true);
  });
});
