import { describe, expect, it } from "vitest";
import { columnStats, foldHeader, headerGroup, KEEP, mark, proposalFor, shapeOf, type HeaderGroup } from "@/lib/pseudonym-headers";

describe("headerGroup", () => {
  const cases: [string, HeaderGroup | null][] = [
    ["Personnummer", "pnr"],
    ["Samordningsnummer", "pnr"],
    ["PNR", "pnr"],
    ["Elevens personnummer", "pnr"],
    ["E-post", "epost"],
    ["E-postadress", "epost"],
    ["Mail", "epost"],
    ["Telefon", "tel"],
    ["Mobilnummer", "tel"],
    ["Tel", "tel"],
    ["Signatur", "sign"],
    ["Lärarsignatur", "sign"],
    ["Sign", "sign"],
    ["Förnamn", "fornamn"],
    ["Tilltalsnamn", "fornamn"],
    ["First name", "fornamn"],
    ["Efternamn", "efternamn"],
    ["Surname", "efternamn"],
    ["Namn", "namn"],
    ["Lärare", "namn"],
    ["Elevnamn", "namn"],
    ["Vårdnadshavare", "namn"],
    ["Kontaktperson", "namn"],
    ["Födelsedatum", "text"],
    ["Adress", "text"],
    ["Postnummer", "text"],
    ["Kommentar", "text"],
    ["Anteckningar", "text"],
    ["Ort", "text"],
    ["Ämnesnamn", "structure"],
    ["Klassnamn", "structure"],
    ["Gruppnamn", "structure"],
    ["Salnamn", "structure"],
    ["Dag", "structure"],
    ["Start", "structure"],
    ["Klass", "structure"],
    ["Ämne", "structure"],
    ["Sal", "structure"],
    ["Vecka", "structure"],
    ["", null],
    ["Okänd kolumn", null],
    ["Antal lärare", null],
    ["Kolumn 7", null],
  ];
  it.each(cases)("%j is in the group %s", (header, group) => {
    expect(headerGroup(header)).toBe(group);
  });

  it("tries what says person before what says structure: a header that is both is a person", () => {
    expect(headerGroup("Lärare")).toBe("namn");
    expect(headerGroup("Efternamn")).toBe("efternamn");
  });

  it("calls a header that has the shape of a personnummer a personnummer column, and folds headers as normalizeHeader does", () => {
    expect(headerGroup("19800101-1234")).toBe("pnr");
    expect(foldHeader("Förnamn (elev)")).toBe("fornamnelev");
    expect(foldHeader("  ÅÄÖ!? ")).toBe("aao");
  });
});

describe("shapeOf", () => {
  it.each([
    ["12", "number"],
    ["-3,5", "number"],
    ["08:10", "time"],
    ["8.10", "number"],
    ["2026-08-17", "date"],
    ["2026-08-17 08:10", "date"],
    ["17/08/2026", "date"],
    ["7A", "code"],
    ["ANSV", "code"],
    ["Sal12", "code"],
    ["Anna", "word"],
    ["Matematik", "word"],
    ["Anna Svensson", "text"],
    ["Svenska 7A och mer text", "text"],
    ["Verylongtokenwithoutspace1", "text"],
  ])("%j is a %s", (value, shape) => {
    expect(shapeOf(value)).toBe(shape);
  });
});

describe("columnStats", () => {
  it("counts the filled cells, the different values and the kinds of value, and keeps the first five different values to show", () => {
    const stats = columnStats(["a1", "", "a1", "b2", "  ", "Anna", "Anna Svensson", "c3", "d4", "e5"]);
    expect(stats.filled).toBe(8);
    expect(stats.distinct).toBe(7);
    // Cells are counted, not different values: a1 stands twice.
    expect(stats.shapes.code).toBe(6);
    expect(stats.shapes.word).toBe(1);
    expect(stats.shapes.text).toBe(1);
    expect(stats.samples).toEqual(["a1", "b2", "Anna", "Anna Svensson", "c3"]);
  });

  it("counts the cells that hold a personnummer, an address and a telephone number", () => {
    const stats = columnStats(["800101-1234", "a@b.se", "070-123 45 67", "x"]);
    expect([stats.withPersonalNumber, stats.withAddress, stats.withTelephone]).toEqual([1, 1, 1]);
  });

  it("cuts a long sample, and counts different values to a thousand and no further", () => {
    expect(columnStats(["x".repeat(100)]).samples[0]).toBe(`${"x".repeat(40)}…`);
    expect(columnStats(Array.from({ length: 3000 }, (_, i) => `v${i}`)).distinct).toBe(1000);
  });
});

describe("proposalFor", () => {
  it("proposes by the header, with the group as its reason, and the treatment the group means", () => {
    expect(proposalFor("Efternamn", columnStats(["Svensson"]))).toEqual({ treatment: mark("efternamn"), reason: "header", detail: "efternamn" });
    expect(proposalFor("Klass", columnStats(["7A", "7B"]))).toEqual({ treatment: KEEP, reason: "header", detail: "structure" });
    expect(proposalFor("Kommentar", columnStats(["hej"]))).toEqual({ treatment: mark("text"), reason: "header", detail: "text" });
  });

  it("lets the values of a column that is half personnummer, addresses or telephone numbers decide, before the header", () => {
    expect(proposalFor("Klass", columnStats(["800101-1234", "800102-1235", "x"]))).toEqual({ treatment: mark("pnr"), reason: "content", detail: "pnr" });
    expect(proposalFor("", columnStats(["a@b.se", "c@d.se"]))?.treatment).toEqual(mark("epost"));
    expect(proposalFor("", columnStats(["070-123 45 67", "08-123 456 78"]))?.treatment).toEqual(mark("tel"));
  });

  it("does not take a column for one on the strength of a single cell among many", () => {
    const stats = columnStats(["a1", "b2", "c3", "800101-1234"]);
    expect(proposalFor("", stats)).toBeNull();
  });

  it("keeps a column of nothing but numbers, times and dates, and an empty one, with the values as the reason", () => {
    expect(proposalFor("", columnStats(["1", "2", "08:10", "2026-08-17"]))).toEqual({ treatment: KEEP, reason: "values", detail: "numbers" });
    expect(proposalFor("", columnStats(["", " "]))).toEqual({ treatment: KEEP, reason: "values", detail: "empty" });
  });

  it("proposes nothing for a column no header and no values place: the user chooses", () => {
    expect(proposalFor("", columnStats(["Anna", "Bo", "Cia"]))).toBeNull();
    expect(proposalFor("Okänd", columnStats(["ANSV", "BOEK"]))).toBeNull();
    expect(proposalFor("Antal lärare", columnStats(["1", "x"]))).toBeNull();
  });
});
