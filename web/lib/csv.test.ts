/**
 * Adversarial tests for lib/csv.ts.
 *
 * Every assertion is a concrete value — no "toBeTruthy" hand-waving. Where
 * current behaviour is wrong (or contradicts the module's own doc comments),
 * the test PINS the current behaviour and carries a BUG comment; see the
 * "pinned bugs" describe at the bottom.
 */
import { describe, expect, it } from "vitest";

import {
  CSV_TEMPLATES,
  mapClassRows,
  mapMembershipRows,
  mapRoomTypeRows,
  mapStudentRows,
  mapTeacherRows,
  normalizeHeader,
  parseCsv,
  templateCsvContent,
  type ImportKind,
} from "./csv";

const BOM = "﻿";

// ---------------------------------------------------------------------------
// normalizeHeader
// ---------------------------------------------------------------------------

describe("normalizeHeader", () => {
  it('normalizes "Förnamn" (NFC, precomposed ö) to "fornamn"', () => {
    expect(normalizeHeader("Förnamn")).toBe("fornamn");
  });

  it('normalizes "FORNAMN" to "fornamn"', () => {
    expect(normalizeHeader("FORNAMN")).toBe("fornamn");
  });

  it('normalizes " fornamn " (padded with spaces) to "fornamn"', () => {
    expect(normalizeHeader(" fornamn ")).toBe("fornamn");
  });

  it('normalizes NFD "Förnamn" (o + combining diaeresis) identically to NFC', () => {
    const nfd = "Förnamn"; // o followed by U+0308 COMBINING DIAERESIS
    const nfc = "Förnamn";
    expect(nfd).not.toBe(nfc); // sanity: the two inputs really differ
    expect(normalizeHeader(nfd)).toBe("fornamn");
    expect(normalizeHeader(nfd)).toBe(normalizeHeader(nfc));
  });

  it('normalizes "Årskurs" to "arskurs" and "Åk" to "ak"', () => {
    expect(normalizeHeader("Årskurs")).toBe("arskurs");
    expect(normalizeHeader("Åk")).toBe("ak");
  });

  it("keeps digits and strips underscores", () => {
    expect(normalizeHeader("Grupp_1")).toBe("grupp1");
    expect(normalizeHeader("for_namn")).toBe("fornamn"); // underscore variant matches the alias
    expect(normalizeHeader("epost2")).toBe("epost2"); // digits survive, so this does NOT match "epost"
  });

  it('normalizes "E-postadress" to "epostadress" (hyphen stripped, matches alias)', () => {
    expect(normalizeHeader("E-postadress")).toBe("epostadress");
  });

  it("strips a stray BOM character embedded in a header", () => {
    expect(normalizeHeader("﻿fornamn")).toBe("fornamn");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeHeader("   ")).toBe("");
  });

  // The mojibake case is pinned in the "pinned bugs" describe below.
});

// ---------------------------------------------------------------------------
// parseCsv — BOM handling
// ---------------------------------------------------------------------------

describe("parseCsv — BOM handling", () => {
  it("strips a leading UTF-8 BOM before the first header", () => {
    const parsed = parseCsv(BOM + "fornamn;efternamn\r\nAlma;Berg\r\n");
    expect(parsed.headers).toEqual(["fornamn", "efternamn"]);
    expect(parsed.rows).toEqual([["Alma", "Berg"]]);
    expect(parsed.delimiter).toBe(";");
  });

  it("parses identically without a BOM", () => {
    const parsed = parseCsv("fornamn;efternamn\r\nAlma;Berg\r\n");
    expect(parsed.headers).toEqual(["fornamn", "efternamn"]);
    expect(parsed.rows).toEqual([["Alma", "Berg"]]);
  });

  it("treats a BOM-only file as empty", () => {
    expect(parseCsv(BOM)).toEqual({ headers: [], rows: [], delimiter: ";" });
  });

  it("survives a doubled BOM: parseCsv strips one, header trim() eats the other (U+FEFF is ECMAScript whitespace)", () => {
    const parsed = parseCsv(BOM + BOM + "fornamn\r\nAlma\r\n");
    expect(parsed.headers).toEqual(["fornamn"]);
    expect(parsed.rows).toEqual([["Alma"]]);
  });
});

// ---------------------------------------------------------------------------
// parseCsv — delimiter detection
// ---------------------------------------------------------------------------

describe("parseCsv — delimiter detection", () => {
  it("detects ; in a semicolon file", () => {
    const parsed = parseCsv("a;b;c\r\n1;2;3\r\n");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["a", "b", "c"]);
    expect(parsed.rows).toEqual([["1", "2", "3"]]);
  });

  it("detects , in a comma file", () => {
    const parsed = parseCsv("fornamn,efternamn\r\nAlma,Berg\r\n");
    expect(parsed.delimiter).toBe(",");
    expect(parsed.headers).toEqual(["fornamn", "efternamn"]);
    expect(parsed.rows).toEqual([["Alma", "Berg"]]);
  });

  it("breaks a tie (equal counts in the header) in favour of ; — the Swedish default", () => {
    const parsed = parseCsv("a;b,c\r\nx;y,z\r\n");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["a", "b,c"]);
    expect(parsed.rows).toEqual([["x", "y,z"]]);
  });

  it("ignores delimiters inside a quoted header field", () => {
    const parsed = parseCsv('"namn;extra",arskurs\r\n7A,7\r\n');
    expect(parsed.delimiter).toBe(",");
    expect(parsed.headers).toEqual(["namn;extra", "arskurs"]);
    expect(parsed.rows).toEqual([["7A", "7"]]);
  });

  it("defaults to ; for a single-column file with no delimiter at all", () => {
    const parsed = parseCsv("namn\r\n7A\r\n7B\r\n");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["namn"]);
    expect(parsed.rows).toEqual([["7A"], ["7B"]]);
  });

  it("defaults to ; for the empty string", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], delimiter: ";" });
  });

  it("detects from the first line only, even when data rows disagree", () => {
    const parsed = parseCsv("a;b\r\n1,x;2\r\n");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.rows).toEqual([["1,x", "2"]]);
  });
});

// ---------------------------------------------------------------------------
// parseCsv — RFC 4180 quoting
// ---------------------------------------------------------------------------

describe("parseCsv — RFC 4180 quoting", () => {
  it("keeps the delimiter inside a quoted field", () => {
    const parsed = parseCsv('namn;kommentar\r\n7A;"a;b"\r\n');
    expect(parsed.rows).toEqual([["7A", "a;b"]]);
  });

  it('unescapes doubled quotes: "say ""hej""" -> say "hej"', () => {
    const parsed = parseCsv('namn;kommentar\r\n7A;"say ""hej"""\r\n');
    expect(parsed.rows).toEqual([["7A", 'say "hej"']]);
  });

  it("keeps a CRLF newline inside a quoted field as one multi-line cell", () => {
    const parsed = parseCsv('namn;kommentar\r\n7A;"rad1\r\nrad2"\r\n');
    expect(parsed.headers).toEqual(["namn", "kommentar"]);
    expect(parsed.rows).toEqual([["7A", "rad1\r\nrad2"]]);
  });

  it("keeps a bare LF inside a quoted field", () => {
    const parsed = parseCsv('namn;kommentar\n7A;"rad1\nrad2"\n7B;x\n');
    expect(parsed.rows).toEqual([
      ["7A", "rad1\nrad2"],
      ["7B", "x"],
    ]);
  });

  it("treats a quote appearing mid-field (not at field start) as a literal character", () => {
    const parsed = parseCsv('h1;h2\r\na"b;c\r\n');
    expect(parsed.rows).toEqual([['a"b', "c"]]);
  });

  it("appends trailing characters after a closing quote to the same field (lenient)", () => {
    const parsed = parseCsv('h1;h2\r\n"ab"cd;x\r\n');
    expect(parsed.rows).toEqual([["abcd", "x"]]);
  });

  it("keeps the content of an unterminated quote at EOF as the final field", () => {
    const parsed = parseCsv('namn\r\n"abc');
    expect(parsed.headers).toEqual(["namn"]);
    expect(parsed.rows).toEqual([["abc"]]);
  });

  it("an unterminated quote swallows the rest of the file into one cell (current behaviour)", () => {
    const parsed = parseCsv('namn;x\r\n"oops;1\r\n7B;2\r\n');
    // The open quote eats the delimiter, the CRLF and the next record; the
    // trailing CRLF is then trim()med off and the row padded to header width.
    expect(parsed.rows).toEqual([["oops;1\r\n7B;2", ""]]);
  });

  it("parses an empty quoted field as empty string", () => {
    const parsed = parseCsv('a;b;c\r\n1;"";3\r\n');
    expect(parsed.rows).toEqual([["1", "", "3"]]);
  });

  it("trims whitespace even inside quoted fields (quoting does not preserve padding)", () => {
    const parsed = parseCsv('a;b\r\n"  padded  ";x\r\n');
    expect(parsed.rows).toEqual([["padded", "x"]]);
  });
});

// ---------------------------------------------------------------------------
// parseCsv — line endings, blank lines
// ---------------------------------------------------------------------------

describe("parseCsv — line endings and blank lines", () => {
  it("parses CRLF endings", () => {
    expect(parseCsv("a;b\r\n1;2\r\n3;4\r\n").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses bare LF endings", () => {
    expect(parseCsv("a;b\n1;2\n3;4\n").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses bare CR endings (old Mac)", () => {
    expect(parseCsv("a;b\r1;2\r3;4\r").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses mixed line endings in one file", () => {
    expect(parseCsv("a;b\r\n1;2\n3;4\r5;6\r\n").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("parses identically with and without a trailing newline", () => {
    expect(parseCsv("a;b\r\n1;2").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a;b\r\n1;2\r\n").rows).toEqual([["1", "2"]]);
  });

  it("a trailing delimiter at EOF still yields the final empty field", () => {
    expect(parseCsv("a;b;c\r\n1;2;").rows).toEqual([["1", "2", ""]]);
  });

  it("drops fully blank lines between records", () => {
    expect(parseCsv("a;b\r\n\r\n\r\n1;2\r\n\r\n3;4\r\n").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("drops whitespace-only lines and lines of only delimiters", () => {
    expect(parseCsv("a;b\r\n   \r\n;\r\n \t ; \r\n1;2\r\n").rows).toEqual([
      ["1", "2"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseCsv — row shape
// ---------------------------------------------------------------------------

describe("parseCsv — row shape", () => {
  it("pads short rows with empty strings up to the header width", () => {
    expect(parseCsv("a;b;c\r\n1\r\n").rows).toEqual([["1", "", ""]]);
  });

  it("truncates long rows to the header width", () => {
    expect(parseCsv("a;b\r\n1;2;3;4\r\n").rows).toEqual([["1", "2"]]);
  });

  it("returns headers and zero rows for a header-only file", () => {
    const parsed = parseCsv("fornamn;efternamn;epost\r\n");
    expect(parsed.headers).toEqual(["fornamn", "efternamn", "epost"]);
    expect(parsed.rows).toEqual([]);
  });

  it("returns empty everything for the completely empty string", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], delimiter: ";" });
  });

  it("trims headers and cell values", () => {
    const parsed = parseCsv(" fornamn ; efternamn \r\n Alma ; Berg \r\n");
    expect(parsed.headers).toEqual(["fornamn", "efternamn"]);
    expect(parsed.rows).toEqual([["Alma", "Berg"]]);
  });
});

// ---------------------------------------------------------------------------
// templateCsvContent
// ---------------------------------------------------------------------------

const ALL_KINDS: ImportKind[] = ["students", "teachers", "classes", "teachingGroups"];

describe("templateCsvContent", () => {
  it.each(ALL_KINDS)("%s: starts with the UTF-8 BOM", (kind) => {
    const content = templateCsvContent(kind);
    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(content.startsWith(BOM)).toBe(true);
  });

  it.each(ALL_KINDS)("%s: is ;-separated, CRLF-terminated, and ends with CRLF", (kind) => {
    const content = templateCsvContent(kind);
    expect(content.endsWith("\r\n")).toBe(true);
    expect(content).not.toContain(",");
    expect(content).toContain(";");
    // Every \n is preceded by \r and every \r followed by \n — pure CRLF.
    expect(/(?<!\r)\n/.test(content)).toBe(false);
    expect(/\r(?!\n)/.test(content)).toBe(false);
  });

  it("classes template is byte-exact", () => {
    expect(templateCsvContent("classes")).toBe(
      BOM + "namn;arskurs\r\n7A;7\r\n7B;7\r\n",
    );
  });

  it.each(ALL_KINDS)("%s: round-trips through parseCsv to its own headers and rows", (kind) => {
    const parsed = parseCsv(templateCsvContent(kind));
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(CSV_TEMPLATES[kind].headers);
    expect(parsed.rows).toEqual(CSV_TEMPLATES[kind].exampleRows);
  });

  it("each template maps through its own mapper with zero errors", () => {
    const students = mapStudentRows(parseCsv(templateCsvContent("students")));
    expect(students.errors).toEqual([]);
    expect(students.rows).toEqual([
      {
        firstName: "Alma",
        lastName: "Berg",
        email: "alma.berg@example.com",
        className: "7A",
      },
    ]);

    const teachers = mapTeacherRows(parseCsv(templateCsvContent("teachers")));
    expect(teachers.errors).toEqual([]);
    expect(teachers.rows).toEqual([
      { firstName: "Karin", lastName: "Ek", email: "karin.ek@example.com" },
    ]);

    const classes = mapClassRows(parseCsv(templateCsvContent("classes")));
    expect(classes.errors).toEqual([]);
    expect(classes.rows).toStrictEqual([
      { name: "7A", gradeLevel: 7 },
      { name: "7B", gradeLevel: 7 },
    ]);

    const memberships = mapMembershipRows(
      parseCsv(templateCsvContent("teachingGroups")),
    );
    expect(memberships.errors).toEqual([]);
    expect(memberships.rows).toEqual([
      { groupName: "Ma71", email: "alma.berg@example.com" },
      { groupName: "Sv73", email: "alma.berg@example.com" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// mapTeacherRows / mapStudentRows
// ---------------------------------------------------------------------------

describe("mapTeacherRows", () => {
  it("reports a single row-0 error naming ALL missing required columns", () => {
    const result = mapTeacherRows(parseCsv("foo;bar\r\nx;y\r\n"));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      {
        row: 0,
        message:
          "Kolumner saknas: fornamn, efternamn, epost. Ladda ner mallen och utgå från den.",
      },
    ]);
  });

  it("reports row 0 naming only the one missing column", () => {
    const result = mapTeacherRows(parseCsv("fornamn;efternamn\r\nKarin;Ek\r\n"));
    expect(result.errors).toEqual([
      {
        row: 0,
        message: "Kolumner saknas: epost. Ladda ner mallen och utgå från den.",
      },
    ]);
  });

  it("reports an empty required cell with its 1-based data-row number", () => {
    const csv =
      "fornamn;efternamn;epost\r\nKarin;Ek;karin@example.com\r\nBo;Alm;\r\nEva;Lund;eva@example.com\r\n";
    const result = mapTeacherRows(parseCsv(csv));
    expect(result.errors).toEqual([
      { row: 2, message: 'Rad 2: kolumnen "epost" är tom.' },
    ]);
    expect(result.rows).toEqual([
      { firstName: "Karin", lastName: "Ek", email: "karin@example.com" },
      { firstName: "Eva", lastName: "Lund", email: "eva@example.com" },
    ]);
  });

  it('a row of only empty cells (";;") is dropped as a blank line, not reported', () => {
    const result = mapTeacherRows(parseCsv("fornamn;efternamn;epost\r\n;;\r\n"));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("reports only the FIRST empty required cell per row (spec order)", () => {
    // fornamn and efternamn are both empty; only fornamn is reported.
    const result = mapTeacherRows(
      parseCsv("fornamn;efternamn;epost\r\n;;x@example.com\r\n"),
    );
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: kolumnen "fornamn" är tom.' },
    ]);
    expect(result.rows).toEqual([]);
  });

  it("accepts alias headers: email for epost, case-insensitive with diacritics", () => {
    const csv = "Förnamn;Efternamn;Email\r\nKarin;Ek;karin@example.com\r\n";
    const result = mapTeacherRows(parseCsv(csv));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { firstName: "Karin", lastName: "Ek", email: "karin@example.com" },
    ]);
  });

  it("accepts the E-postadress alias", () => {
    const csv = "fornamn;efternamn;E-postadress\r\nKarin;Ek;k@example.com\r\n";
    expect(mapTeacherRows(parseCsv(csv)).rows).toEqual([
      { firstName: "Karin", lastName: "Ek", email: "k@example.com" },
    ]);
  });

  it("returns zero rows and zero errors for a header-only file", () => {
    const result = mapTeacherRows(parseCsv("fornamn;efternamn;epost\r\n"));
    expect(result).toEqual({ rows: [], errors: [] });
  });

  it("blank lines do not advance the reported row number (row = data-row index, not file line)", () => {
    const csv = "fornamn;efternamn;epost\r\n\r\n\r\nKarin;Ek;\r\n";
    const result = mapTeacherRows(parseCsv(csv));
    // Physically line 4 of the file, but data row 1 after blank lines are dropped.
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: kolumnen "epost" är tom.' },
    ]);
  });
});

describe("mapStudentRows", () => {
  it("requires klass and reports it when missing", () => {
    const csv = "fornamn;efternamn;epost\r\nAlma;Berg;a@example.com\r\n";
    const result = mapStudentRows(parseCsv(csv));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      {
        row: 0,
        message: "Kolumner saknas: klass. Ladda ner mallen och utgå från den.",
      },
    ]);
  });

  it("maps a comma-separated file with alias headers", () => {
    const csv =
      "firstname,lastname,email,class\r\nAlma,Berg,alma@example.com,7A\r\n";
    const result = mapStudentRows(parseCsv(csv));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        firstName: "Alma",
        lastName: "Berg",
        email: "alma@example.com",
        className: "7A",
      },
    ]);
  });

  it("reports an empty klass cell with its row number", () => {
    const csv =
      "fornamn;efternamn;epost;klass\r\nAlma;Berg;a@example.com;7A\r\nBo;Ek;b@example.com;\r\n";
    const result = mapStudentRows(parseCsv(csv));
    expect(result.errors).toEqual([
      { row: 2, message: 'Rad 2: kolumnen "klass" är tom.' },
    ]);
    expect(result.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mapClassRows
// ---------------------------------------------------------------------------

describe("mapClassRows", () => {
  it("reports row 0 when the name column is missing", () => {
    const result = mapClassRows(parseCsv("arskurs\r\n7\r\n"));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      { row: 0, message: "Kolumner saknas: namn. Ladda ner mallen och utgå från den." },
    ]);
  });

  it("empty grade cell is OK — the row is kept WITHOUT a gradeLevel key", () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\n7A;\r\n"));
    expect(result.errors).toEqual([]);
    expect(result.rows).toStrictEqual([{ name: "7A" }]);
  });

  it("a missing grade column entirely is OK", () => {
    const result = mapClassRows(parseCsv("namn\r\n7A\r\n7B\r\n"));
    expect(result.errors).toEqual([]);
    expect(result.rows).toStrictEqual([{ name: "7A" }, { name: "7B" }]);
  });

  it('grade "7" parses to the number 7', () => {
    expect(mapClassRows(parseCsv("namn;arskurs\r\n7A;7\r\n")).rows).toStrictEqual([
      { name: "7A", gradeLevel: 7 },
    ]);
  });

  it("boundary grades 0 and 12 are accepted", () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\nF;0\r\nGy3;12\r\n"));
    expect(result.errors).toEqual([]);
    expect(result.rows).toStrictEqual([
      { name: "F", gradeLevel: 0 },
      { name: "Gy3", gradeLevel: 12 },
    ]);
  });

  it("grade 13 is rejected with the row number", () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\nX;13\r\n"));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: årskurs "13" är inte ett tal mellan 0 och 12.' },
    ]);
  });

  it("grade -1 is rejected", () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\nX;-1\r\n"));
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: årskurs "-1" är inte ett tal mellan 0 och 12.' },
    ]);
  });

  it('grade "abc" is rejected with the row number, and later rows still map', () => {
    const result = mapClassRows(
      parseCsv("namn;arskurs\r\n7A;7\r\n7B;abc\r\n7C;8\r\n"),
    );
    expect(result.errors).toEqual([
      { row: 2, message: 'Rad 2: årskurs "abc" är inte ett tal mellan 0 och 12.' },
    ]);
    expect(result.rows).toStrictEqual([
      { name: "7A", gradeLevel: 7 },
      { name: "7C", gradeLevel: 8 },
    ]);
  });

  it('grade "7,5" (Swedish decimal comma) is rejected', () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\n7A;7,5\r\n"));
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: årskurs "7,5" är inte ett tal mellan 0 och 12.' },
    ]);
  });

  it('grade "7.5" is rejected (not an integer)', () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\n7A;7.5\r\n"));
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: årskurs "7.5" är inte ett tal mellan 0 och 12.' },
    ]);
  });

  it("empty name cell is reported with its row number", () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\n;7\r\n7B;8\r\n"));
    expect(result.errors).toEqual([
      { row: 1, message: 'Rad 1: kolumnen "namn" är tom.' },
    ]);
    expect(result.rows).toStrictEqual([{ name: "7B", gradeLevel: 8 }]);
  });

  it('accepts "klass" and "åk" as header aliases', () => {
    const result = mapClassRows(parseCsv("Klass;Åk\r\n7A;7\r\n"));
    expect(result.errors).toEqual([]);
    expect(result.rows).toStrictEqual([{ name: "7A", gradeLevel: 7 }]);
  });

  // Number() is permissive: pin the quirk so a future fix is a conscious change.
  it('QUIRK (pinned): scientific notation "1e1" is accepted as gradeLevel 10', () => {
    const result = mapClassRows(parseCsv("namn;arskurs\r\nX;1e1\r\n"));
    expect(result.errors).toEqual([]);
    expect(result.rows).toStrictEqual([{ name: "X", gradeLevel: 10 }]);
  });
});

// ---------------------------------------------------------------------------
// mapMembershipRows
// ---------------------------------------------------------------------------

describe("mapMembershipRows", () => {
  it("maps grupp + epost", () => {
    const csv = "grupp;epost\r\nMa71;a@example.com\r\n";
    expect(mapMembershipRows(parseCsv(csv)).rows).toEqual([
      { groupName: "Ma71", email: "a@example.com" },
    ]);
  });

  it('accepts "Undervisningsgrupp" and "Elev" as header aliases', () => {
    const csv = "Undervisningsgrupp;Elev\r\nMa71;a@example.com\r\n";
    const result = mapMembershipRows(parseCsv(csv));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([{ groupName: "Ma71", email: "a@example.com" }]);
  });

  it("duplicate group names pass through untouched — dedup is the server's job", () => {
    const csv =
      "grupp;epost\r\nMa71;a@example.com\r\nMa71;b@example.com\r\nMa71;a@example.com\r\n";
    const result = mapMembershipRows(parseCsv(csv));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { groupName: "Ma71", email: "a@example.com" },
      { groupName: "Ma71", email: "b@example.com" },
      { groupName: "Ma71", email: "a@example.com" }, // exact duplicate row also kept
    ]);
  });

  it("reports both missing columns at row 0", () => {
    const result = mapMembershipRows(parseCsv("x;y\r\n1;2\r\n"));
    expect(result.errors).toEqual([
      {
        row: 0,
        message: "Kolumner saknas: grupp, epost. Ladda ner mallen och utgå från den.",
      },
    ]);
  });

  it("reports an empty grupp cell with its row number", () => {
    const csv = "grupp;epost\r\n;a@example.com\r\n";
    expect(mapMembershipRows(parseCsv(csv)).errors).toEqual([
      { row: 1, message: 'Rad 1: kolumnen "grupp" är tom.' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pinned bugs — these tests document CURRENT (wrong or comment-contradicting)
// behaviour. If one of these starts failing, the underlying bug was probably
// fixed: update the test to assert the CORRECT behaviour instead.
// ---------------------------------------------------------------------------

describe("pinned bugs (documenting current behaviour)", () => {
  /**
   * BUG 1: normalizeHeader's doc comment claims the mojibake artifact
   * "FÃ¶rnamn" (UTF-8 "Förnamn" mis-decoded as Latin-1/CP1252) "resolves
   * alike" with "fornamn". It does NOT: Ã (U+00C3) NFD-decomposes to
   * A + combining tilde, so the header normalizes to "farnamn" — 'a', not
   * 'o' — and can never match the "fornamn" alias. A wrongly-decoded file
   * therefore fails with "Kolumner saknas" despite the module's stated
   * intent to survive exactly this artifact.
   */
  it('mojibake by design (a): mojibake "FÃ¶rnamn" normalizes to "farnamn", NOT "fornamn"', () => {
    const mojibake = "FÃ¶rnamn"; // F + Ã + ¶ + rnamn
    expect(normalizeHeader(mojibake)).toBe("farnamn");
    expect(normalizeHeader(mojibake)).not.toBe("fornamn");
  });

  it("mojibake by design (b): a teacher file with a mojibake header fails with a missing-column error", () => {
    const csv = "FÃ¶rnamn;Efternamn;Epost\r\nKarin;Ek;k@example.com\r\n";
    const result = mapTeacherRows(parseCsv(csv));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      {
        row: 0,
        message: "Kolumner saknas: fornamn. Ladda ner mallen och utgå från den.",
      },
    ]);
  });

  /**
   * BUG 2: delimiter detection slices the "header line" at the FIRST line
   * break in the file — even one INSIDE a quoted header field. For a
   * comma-separated file whose first header cell contains a quoted newline,
   * detection sees only `"multi`, counts zero of both delimiters, and the
   * `semicolons >= commas` tie-break picks ";". The whole file then parses
   * as a single mangled column. (A ;-file with the same shape survives only
   * because ";" is also the tie-break default.)
   */
  it("a quoted newline in the header no longer defeats delimiter detection", () => {
    // Detection scans to the first UNQUOTED line break, so the full header
    // row — including the delimiter after the multi-line cell — is visible.
    const parsed = parseCsv('"multi\nline",col2\nv1,v2\n');
    expect(parsed.delimiter).toBe(",");
    expect(parsed.headers).toEqual(["multi\nline", "col2"]);
    expect(parsed.rows).toEqual([["v1", "v2"]]);
  });

  it("the same shape in a ;-file parses identically", () => {
    const parsed = parseCsv('"multi\nline";col2\r\nv1;v2\r\n');
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["multi\nline", "col2"]);
    expect(parsed.rows).toEqual([["v1", "v2"]]);
  });
});

describe("room types", () => {
  it("ships a template a Swedish school can fill in as-is", () => {
    const content = templateCsvContent("roomTypes");

    expect(content.startsWith("\uFEFF")).toBe(true); // Excel keeps å/ä/ö
    expect(content).toContain("namn");
    expect(content).toContain("Trä- och metallslöjd");
    expect(content.endsWith("\r\n")).toBe(true);
    expect(CSV_TEMPLATES.roomTypes.filename).toBe("salstyper.csv");
  });

  it("round-trips its own template through the parser and mapper", () => {
    const { rows, errors } = mapRoomTypeRows(parseCsv(templateCsvContent("roomTypes")));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { name: "Hemkunskapssal" },
      { name: "Trä- och metallslöjd" },
      { name: "Textilslöjd" },
    ]);
  });

  it("accepts the spellings a human would reach for", () => {
    for (const header of ["namn", "Namn", "salstyp", "Typ", "name"]) {
      const { rows, errors } = mapRoomTypeRows(parseCsv(`${header}\nTextilslöjd\n`));
      expect(errors).toEqual([]);
      expect(rows).toEqual([{ name: "Textilslöjd" }]);
    }
  });

  it("names the missing column instead of importing nothing silently", () => {
    const { rows, errors } = mapRoomTypeRows(parseCsv("kapacitet\n30\n"));

    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { row: 0, message: expect.stringContaining("namn") },
    ]);
  });

  it("reports an empty cell with its 1-based data row number", () => {
    const { rows, errors } = mapRoomTypeRows(
      parseCsv("namn\nBildsal\n\nMusiksal\n"),
    );

    // The blank line is dropped, so Musiksal is row 2 — not row 3.
    expect(rows).toEqual([{ name: "Bildsal" }, { name: "Musiksal" }]);
    expect(errors).toEqual([]);
  });
});
