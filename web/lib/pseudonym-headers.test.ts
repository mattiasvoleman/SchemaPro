import { describe, expect, it } from "vitest";
import { columnStats, DATE_OLD_DAYS, DATE_SPAN_ASKED, datesAsked, foldHeader, headerGroup, headerLooksLikeData, KEEP, mark, proposalFor, shapeOf, type HeaderGroup } from "@/lib/pseudonym-headers";

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

describe("a column of dates", () => {
  /** The day the tests are written on, so that "three years ago" is the same in every year they are run. */
  const TODAY = Date.UTC(2026, 10, 26);

  it("has a span in days when it holds two dates or more, written YYYY-MM-DD or D/M/YYYY", () => {
    expect(columnStats(["2026-08-17", "2026-12-18", ""]).dateSpanDays).toBe(123);
    expect(columnStats(["2026-08-17 08:10", "2026-08-18"]).dateSpanDays).toBe(1);
    expect(columnStats(["2026-08-17"]).dateSpanDays).toBeNull();
    // The way a spreadsheet in Swedish or British settings, and a file from Skola24's Tabell, write a date (X1b).
    expect(columnStats(["17/08/2026", "18/08/2026"]).dateSpanDays).toBe(1);
    expect(columnStats(["17.8.2026", "18-12-2026"]).dateSpanDays).toBe(123);
    expect(columnStats(["2026-13-40", "2026-02-30x"]).dateSpanDays).toBeNull();
    // A year of two digits is not read: 14.02.13 may as well be a time.
    expect(columnStats(["14.02.13", "15.02.13"]).dateSpanDays).toBeNull();
    expect(columnStats(["2026-08-17", "17/08/2026"]).firstDay).toBe(Date.UTC(2026, 7, 17));
  });

  it("is kept without a question when it spans a term, and asked about when it spans more than a year: lesson dates and birth dates look alike", () => {
    expect(proposalFor("Gäller", columnStats(["2026-08-17", "2026-12-18", "2027-06-10"]), TODAY)).toEqual({ treatment: KEEP, reason: "values", detail: "numbers" });
    expect(DATE_SPAN_ASKED).toBe(366);
    const births = columnStats(["2010-03-04", "2011-11-30", "2012-07-01", "2013-01-22"]);
    expect(births.dateSpanDays!).toBeGreaterThan(DATE_SPAN_ASKED);
    expect(proposalFor("F-datum", births, TODAY)).toBeNull();
    expect(datesAsked(births, TODAY)).toBe("span");
    // A header the lists know still goes first.
    expect(proposalFor("Födelsedatum", births, TODAY)?.treatment).toEqual(mark("text"));
  });

  it("is asked about when a date in it is older than three years, even when they are all from one year: a class is born in one (X1b, the review of #377 L-5 and #398 L-5)", () => {
    // Six birth dates of one class span a few months, and were kept under a header the lists do not know.
    const aClass = columnStats(["2013-02-14", "2013-05-03", "2013-09-30", "2013-11-11", "2013-12-20", "2013-01-05"]);
    expect(aClass.dateSpanDays!).toBeLessThan(DATE_SPAN_ASKED);
    expect(proposalFor("F-datum", aClass, TODAY)).toBeNull();
    expect(datesAsked(aClass, TODAY)).toBe("old");
    // In every way the page reads a date.
    expect(proposalFor("Datum", columnStats(["14/02/2013", "03/05/2013", "30/09/2013"]), TODAY)).toBeNull();
    expect(proposalFor("Datum", columnStats(["14.02.2013", "03.05.2013"]), TODAY)).toBeNull();
    expect(proposalFor("Datum", columnStats(["14-02-2013", "03-05-2013"]), TODAY)).toBeNull();
    // One date is enough: there is no span of one.
    expect(proposalFor("Datum", columnStats(["2013-02-14"]), TODAY)).toBeNull();
    // The lesson dates of this school year, and of the last, are lesson dates.
    expect(proposalFor("Datum", columnStats(["2026-11-02", "2026-11-09", "2026-11-16"]), TODAY)).toEqual({ treatment: KEEP, reason: "values", detail: "numbers" });
    expect(proposalFor("Datum", columnStats(["2024-02-14", "2024-05-03"]), TODAY)).toEqual({ treatment: KEEP, reason: "values", detail: "numbers" });
    expect(proposalFor("Datum", columnStats(["2023-02-14", "2023-05-03"]), TODAY)).toBeNull();
  });

  it("counts three years of 366 days from the day it is given, and nothing from a clock of its own", () => {
    // 1098 days before 2026-11-26 is 2023-11-24 (2024 is a leap year): a date older than that is old, that day itself is not.
    expect(datesAsked(columnStats(["2023-11-23", "2023-12-24"]), Date.UTC(2026, 10, 26))).toBe("old");
    expect(datesAsked(columnStats(["2023-11-24", "2023-12-24"]), Date.UTC(2026, 10, 26))).toBeNull();
    expect(datesAsked(columnStats(["2023-11-23", "2023-12-24"]), Date.UTC(2026, 10, 25))).toBeNull();
    expect(DATE_OLD_DAYS).toBe(1098);
  });

  it("is asked about when most of its cells are a date written as six or eight digits, which a spreadsheet keeps as a number (X1b)", () => {
    const compact = columnStats(["130214", "130503", "130930", "131111"]);
    expect(compact.compactDates).toBe(4);
    expect(compact.shapes.number).toBe(4);
    expect(proposalFor("F", compact, TODAY)).toBeNull();
    expect(datesAsked(compact, TODAY)).toBe("compact");
    expect(datesAsked(columnStats(["20130214", "20130503"]), TODAY)).toBe("compact");
    // Four in five, not all: a blank or a stray cell does not hide the column.
    expect(datesAsked(columnStats(["130214", "130503", "130930", "131111", "99"]), TODAY)).toBe("compact");
    // A code that happens to read as a date once in a while is not a column of dates, and a month of 13 or a day of 32 is not a date.
    expect(datesAsked(columnStats(["130214", "999999", "123456", "654321"]), TODAY)).toBeNull();
    expect(columnStats(["131314", "130232", "130200"]).compactDates).toBe(0);
    // Numbers that are not six or eight digits are not looked at, and nine or more are asked about already.
    expect(columnStats(["1302141", "13021400"]).compactDates).toBe(0);
    expect(proposalFor("Ring", columnStats(["701234567", "701234568"]), TODAY)).toBeNull();
  });
});

describe("headerLooksLikeData", () => {
  it("is true for a row with a number, a time or a date, which a header does not have, and false for words and codes", () => {
    expect(headerLooksLikeData(["Mån", "08:10", "Anna Exempel", "7A"])).toBe(true);
    expect(headerLooksLikeData(["Klass", "2026-08-17"])).toBe(true);
    expect(headerLooksLikeData(["Vecka", "34"])).toBe(true);
    expect(headerLooksLikeData(["Lärare", "Ämne", "Klass", "Notis"])).toBe(false);
    expect(headerLooksLikeData(["Sal", "", "7A"])).toBe(false);
    expect(headerLooksLikeData([])).toBe(false);
  });
});
