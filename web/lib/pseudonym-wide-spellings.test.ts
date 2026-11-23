import { describe, expect, it } from "vitest";
import { findPersonalData, normaliseTelephone } from "@/lib/pseudonym-detect";

/*
 * THE SPELLINGS THE PSEUDONYMISER TAKES AND THE DOOR DOES NOT (the review of #398, and L-1, L-3 and L-8 of the reviews of #377 and #396).
 *
 * lib/personal-number.ts and the gateway's file-safety.ts are the door, and they are held equal by one list of cases; this search looks wider, because for a door a missed number is a cell read
 * as text and for the pseudonymiser it is a number left in a file that is sent on. Each family has what is taken, what is NOT (the page and the manual say so: report.limit2 and limit3), and the key,
 * so that two spellings of one value are one marker. lib/pseudonym-leak-oracle.test.ts is the other half: a reader that knows no shape.
 */

const found = (text: string) => findPersonalData(text).map((finding) => ({ kind: finding.kind, text: text.slice(finding.start, finding.end), key: finding.key, spelling: finding.spelling }));
const kindsOf = (text: string): string[] => findPersonalData(text).map((finding) => finding.kind);

describe("a personnummer with a colon, a comma or an apostrophe between the date and the last four", () => {
  it.each([
    ["a colon", "800101:1234", "ÅÅMMDD:NNNN"],
    ["a comma", "800101,1234", "ÅÅMMDD,NNNN"],
    ["an apostrophe", "800101'1234", "ÅÅMMDD'NNNN"],
    ["a typographic apostrophe", "800101\u20191234", "ÅÅMMDD'NNNN"],
    ["a left single quotation mark", "800101\u20181234", "ÅÅMMDD'NNNN"],
    ["an acute accent", "800101\u00b41234", "ÅÅMMDD'NNNN"],
    ["a grave accent", "800101`1234", "ÅÅMMDD'NNNN"],
    ["a modifier letter apostrophe", "800101\u02bc1234", "ÅÅMMDD'NNNN"],
    ["a prime", "800101\u20321234", "ÅÅMMDD'NNNN"],
    ["a next-line character", "800101\u00851234", "ÅÅMMDD NNNN"],
    ["a century", "19800101:1234", "ÅÅÅÅMMDD:NNNN"],
    ["a date written with hyphens", "1980-01-01,1234", "ÅÅÅÅ-MM-DD,NNNN"],
    ["a two-digit year written with hyphens", "80-01-01'1234", "ÅÅ-MM-DD'NNNN"],
    ["a blank inside the date, as the shape takes one", "8001 01:1234", "ÅÅMMDD:NNNN (med blanksteg i siffrorna)"],
    ["full-width digits", "８００１０１:1234", "ÅÅMMDD:NNNN"],
  ])("%s", (_name, text, spelling) => {
    expect(found(`Elev ${text} flyttad`)).toEqual([{ kind: "pnr", text, key: "8001011234", spelling }]);
  });

  it("is a samordningsnummer when the day says so, and has the key the same number has with a hyphen", () => {
    expect(found("800161:1234")).toEqual([{ kind: "sam", text: "800161:1234", key: "8001611234", spelling: "ÅÅMMDD:NNNN" }]);
    expect(findPersonalData("800101:1234")[0]!.key).toBe(findPersonalData("800101-1234")[0]!.key);
    expect(findPersonalData("19800101,1234")[0]!.key).toBe(findPersonalData("800101+1234")[0]!.key);
  });

  it("is told apart from what is not one: not four digits after it, no date before it, no mark elsewhere (report.limit3)", () => {
    for (const text of [
      "800101:123", // three digits
      "800101:12345", // five
      "10:12:15 1234", // a time with seconds
      "1234567,8901", // a decimal number: the six digits have a digit before them
      "Betyg 5,0",
      "80:01:01-1234", // the marks inside the date are not folded
      "8001:01-1234",
      "2026-11-21 08:10",
      "mailto:anna@skola.se",
    ]) {
      expect(kindsOf(text).filter((kind) => kind === "pnr" || kind === "sam"), text).toEqual([]);
    }
  });

  it("is the price said in the manual: a date and four digits with a colon or a comma between them is a personnummer, as it is with a blank", () => {
    expect(kindsOf("2026-11-21:0810")).toEqual(["pnr"]);
    expect(kindsOf("20261121 0810")).toEqual(["pnr"]);
  });
});

describe("a colon, a comma or an apostrophe with a blank beside it (the review of #403)", () => {
  it.each([
    ["a blank after a colon", "800101: 1234"],
    ["a blank after a comma", "800101, 1234"],
    ["a blank after an apostrophe", "800101' 1234"],
    ["a blank before a colon", "800101 :1234"],
    ["a blank on each side of a comma", "800101 , 1234"],
    ["two blanks after a colon", "800101:  1234"],
    ["a century, a blank after the colon", "19800101: 1234"],
    ["a blank inside the date", "8001 01: 1234"],
  ])("%s: %s", (_name, text) => {
    const [one] = findPersonalData(`Elev ${text} flyttad`);
    expect(`Elev ${text} flyttad`.slice(one!.start, one!.end), text).toBe(text);
    expect(one).toMatchObject({ kind: "pnr", key: "8001011234" });
  });

  it("does not take what is not a personnummer: more than two blanks, a time, a decimal, an amount with a blank in it, a blank inside the last four", () => {
    // The last one is what report.limit3 says: a mark and a blank inside the last four is not taken ('20261116, 1 250 kr' is a date and an amount).
    for (const text of ["800101:   1234", "10:12:15, 1234", "Betyg 5, 0", "1234567, 8901", "800101: 123", "800101: 12345", "80:01:01- 1234", "mailto: anna@skola.se", "20261116, 1 250 kr", "800101:12 34"]) {
      expect(kindsOf(text).filter((kind) => kind === "pnr" || kind === "sam"), text).toEqual([]);
    }
  });

  it("is the price said in the manual, with a blank as without one: a compact date, a comma and four digits is a personnummer (a date written with hyphens is one only with no blank, as the shape has it)", () => {
    expect(kindsOf("20261121, 0810")).toEqual(["pnr"]);
    expect(kindsOf("20261121,0810")).toEqual(["pnr"]);
    expect(kindsOf("2026-11-21,0810")).toEqual(["pnr"]);
    expect(kindsOf("2026-11-21, 0810")).toEqual([]);
  });
});

describe("characters that show nothing are no gap in a number", () => {
  const ZWSP = "\u200b";
  const SHY = "\u00ad";
  const WJ = "\u2060";

  it("any number of them between the digits of a personnummer, a TF number and a telephone number, and the finding is the whole of it as it stood", () => {
    for (const text of [`8001${ZWSP}${SHY}${WJ}01-1234`, `800${ZWSP}${ZWSP}${ZWSP}101-12${SHY}${SHY}34`, `8${WJ}0${WJ}0${WJ}1${WJ}0${WJ}1${WJ}-${WJ}1${WJ}2${WJ}3${WJ}4`, `800101${SHY}${SHY}${SHY}1234`]) {
      expect(found(`Elev ${text} flyttad`), JSON.stringify(text)).toEqual([expect.objectContaining({ kind: "pnr", text, key: "8001011234" })]);
    }
    expect(found(`19000101T${ZWSP}${ZWSP}F01`)).toEqual([expect.objectContaining({ kind: "tf", key: "19000101TF01" })]);
    expect(found(`070${ZWSP}${SHY}-123${WJ}${WJ}45 67`)).toEqual([expect.objectContaining({ kind: "tel", key: "0701234567" })]);
  });

  it("every kind of them: marks of direction, selectors, the combining grapheme joiner, the Arabic letter mark, the Mongolian vowel separator, a tag character beyond the first plane", () => {
    for (const mark of ["\u200e", "\u200f", "\u202a", "\u202c", "\u202e", "\u2066", "\u2069", "\u061c", "\u034f", "\ufe0f", "\ufe00", "\u180e", "\ufeff", "\u3164", "\u2061", "\u{e0041}", "\u0600", "\u06dd"]) {
      expect(found(`800101${mark}${mark}1234`), JSON.stringify(mark)).toEqual([expect.objectContaining({ kind: "pnr", key: "8001011234", text: `800101${mark}${mark}1234` })]);
    }
  });

  it("is the same place in the text as it stood: the characters before and after a number are not in it", () => {
    const text = `${ZWSP}${ZWSP}800101-1234${SHY}`;
    const [one] = findPersonalData(text);
    expect(text.slice(one!.start, one!.end)).toBe("800101-1234");
  });

  it("still keeps two numbers two when a character that shows nothing is what stood between them", () => {
    expect(kindsOf(`0701234567${ZWSP}0812345678`)).toEqual(["tel", "tel"]);
    expect(kindsOf(`070-123 45 67${ZWSP}+46 8 123 456 78`)).toEqual(["tel", "tel"]);
  });

  it("finds an address with one inside it whole", () => {
    expect(found(`anna.svens${ZWSP}son@skola.se`)).toEqual([expect.objectContaining({ kind: "epost", text: `anna.svens${ZWSP}son@skola.se` })]);
  });

  it("is so for the next-line character too, which is listed with them: any number of them (a single one was a blank, which the shape takes; two were not)", () => {
    const NEL = "\u0085";
    for (const text of [`8001${NEL}${NEL}011234`, `800101${NEL}${NEL}${NEL}1234`, `800${NEL}${NEL}${NEL}1011234`]) {
      expect(found(`Elev ${text} flyttad`), JSON.stringify(text)).toEqual([expect.objectContaining({ kind: "pnr", text, key: "8001011234" })]);
    }
    expect(found(`19000101${NEL}${NEL}${NEL}TF01`)).toEqual([expect.objectContaining({ kind: "tf", key: "19000101TF01" })]);
    expect(found(`070${NEL}${NEL}123 45 67`)).toEqual([expect.objectContaining({ kind: "tel", key: "0701234567" })]);
    expect(found(`anna.sv${NEL}${NEL}ensson@skola.se`)).toEqual([expect.objectContaining({ kind: "epost", text: `anna.sv${NEL}${NEL}ensson@skola.se` })]);
    // And a next-line character between two numbers is still a gap between two numbers.
    expect(kindsOf(`0701234567${NEL}0812345678`)).toEqual(["tel", "tel"]);
  });
});

describe("what writing 46 with no plus costs (the review of #403, said in the manual)", () => {
  it.each([
    ["a week and a date written without hyphens", "Vecka 46 20261116", "46 20261116"],
    ["the same with the week stuck to a letter", "v46 20261123", "46 20261123"],
    ["a week and a date with blanks", "w46 2026 11 16", "46 2026 11 16"],
    ["an id of ten digits that begins with 46", "Id 4612345678", "4612345678"],
  ])("%s: %s is a telephone number", (_name, text, taken) => {
    expect(found(text)).toEqual([expect.objectContaining({ kind: "tel", text: taken })]);
  });

  it("but not a week and a date with hyphens, nor fewer than ten digits", () => {
    for (const text of ["Vecka 46 2026-11-16", "46 elever", "461234567", "Id 46123456", "Vecka 47 20261116"]) {
      expect(kindsOf(text).filter((kind) => kind === "tel"), text).toEqual([]);
    }
  });
});

describe("a date is masked before a telephone number is looked for only when it is a date: a month AND a day (the review of #403)", () => {
  it("a number written with hyphens that has a month and no day, or a day and no month, is a telephone number", () => {
    // 12 is a month and 69 is no day; 79 is no month and 12 is a day. Either alone must keep the span from being masked as a date.
    expect(found("0046-12-691-72-10")).toEqual([expect.objectContaining({ kind: "tel", text: "0046-12-691-72-10" })]);
    expect(found("0046-79-12-345-67")).toEqual([expect.objectContaining({ kind: "tel", text: "0046-79-12-345-67" })]);
    expect(found("0046-79-691-72-10")).toEqual([expect.objectContaining({ kind: "tel", text: "0046-79-691-72-10" })]);
  });

  it("and a date with a month and a day is still masked, so that two dates are not a number", () => {
    expect(kindsOf("2026-08-17-2026-12-18")).toEqual([]);
  });
});

describe("a telephone number written with no plus, or with full stops", () => {
  it.each([
    ["46701234567", "0701234567"],
    ["46 70 123 45 67", "0701234567"],
    ["46-70-123-45-67", "0701234567"],
    ["46.70.123.45.67", "0701234567"],
    ["46 8 123 456 78", "0812345678"],
    ["46.8.559.129.40", "085591294" + "0"],
    ["070.123.45.67", "0701234567"],
    ["08.123.45.67", "0812345" + "67"],
    ["0046.70.123.45.67", "0701234567"],
    ["0046-79-691-72-10", "0796917210"],
    ["0046 70.795 40.57", "0707954057"],
  ])("%s", (text, key) => {
    expect(found(`Ring ${text} nu`)).toEqual([expect.objectContaining({ kind: "tel", text, key })]);
  });

  it("is the same number as the one written with a plus, a 00 and a 0", () => {
    const keys = ["46701234567", "+46701234567", "0046701234567", "070-123 45 67", "+46 (0)70 123 45 67", "070.123.45.67"].map((text) => findPersonalData(text)[0]!.key);
    expect(new Set(keys)).toEqual(new Set(["0701234567"]));
    expect(normaliseTelephone("46701234567")).toBe("0701234567");
    expect(normaliseTelephone("0701234567")).toBe("0701234567");
  });

  it("is told apart from what is not one: a 46 that is no country code, a decimal number, a date, a time, a version, an address", () => {
    for (const text of ["46 elever", "461234567", "46123", "4670", "Klass 46 70", "0.1234567", "07.08.2026", "17.8.2026", "08.10.09.10", "08.10-09.00", "10.0.0.1", "192.168.0.1", "v1.2.3.4", "1.234.567", "070.123.4567", "010.001.002.003x", "2026.11.21", "4612345678901", "0.1.2.3.4.5.6.7.8.9", "070.12.3 45.67"]) {
      expect(kindsOf(text).filter((kind) => kind === "tel"), text).toEqual([]);
    }
  });

  it("is no longer hidden by a date that is none: an ISO date has a month and a day", () => {
    expect(kindsOf("0046-79-691-72-10")).toEqual(["tel"]);
    // And a date still hides what is in it.
    expect(kindsOf("2026-08-17-2026-12-18")).toEqual([]);
  });
});

describe("an address with its local part in quotes, or its domain in brackets", () => {
  it.each([
    ['"anna.svensson"@skola.se', "anna.svensson@skola.se"],
    ['"anna svensson"@skola.se', "anna svensson@skola.se"],
    ["\u201canna.svensson\u201d@skola.se", "anna.svensson@skola.se"],
    ["\u201eanna.svensson\u201d@skola.se", "anna.svensson@skola.se"],
    ['"ANNA.Svensson"@Skola.se', "anna.svensson@skola.se"],
    ["\u201canna svensson\u201d@skola.se", "anna svensson@skola.se"],
    ["\u201eanna svensson\u201c@skola.se", "anna svensson@skola.se"],
    ["\u201danna svensson\u201d@skola.se", "anna svensson@skola.se"],
    ["anna.svensson@[10.0.0.1]", "anna.svensson@[10.0.0.1]"],
    ['"anna.svensson"@[10.0.0.1]', "anna.svensson@[10.0.0.1]"],
  ])("%s", (text, key) => {
    expect(found(`Skriv till ${text} tack`)).toEqual([{ kind: "epost", text, key, spelling: undefined }]);
  });

  it("is one address however it is written: the key has no quotes in it", () => {
    expect(findPersonalData('"anna.svensson"@skola.se')[0]!.key).toBe(findPersonalData("anna.svensson@skola.se")[0]!.key);
  });

  it("takes a display name's address in angle brackets from its opening quote, and mailto: with it", () => {
    expect(found('Anna <"anna.svensson"@skola.se>')).toEqual([expect.objectContaining({ text: '"anna.svensson"@skola.se' })]);
    expect(found('mailto:"anna"@skola.se')).toEqual([expect.objectContaining({ text: 'mailto:"anna"@skola.se', key: "anna@skola.se" })]);
  });

  it("is not made of a quotation that is no address", () => {
    for (const text of ['Han sa "hej" och gick', 'Citat "Hej" @ här', '""@skola.se', '"hej" @ skolan', "anna@", "@anna", 'a "b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n o p"@x.se']) {
      expect(kindsOf(text).includes("epost") && !text.includes("@x.se"), text).toBe(false);
    }
  });
});
