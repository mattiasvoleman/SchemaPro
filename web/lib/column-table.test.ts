import { describe, expect, it } from "vitest";
import { guardFormula, readTable, unguardFormula, writeMappedTable } from "@/lib/column-table";

describe("readTable", () => {
  it("reads a ';' file, a ',' file and a tab-separated table pasted out of a page", () => {
    expect(readTable("a;b\n1;2").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(readTable("a,b\n1,2").delimiter).toBe(",");
    const pasted = readTable("Kurs\tPed\tRum\nMa7\tABC\tA1\n");
    expect(pasted.delimiter).toBe("\t");
    expect(pasted.rows).toEqual([["Kurs", "Ped", "Rum"], ["Ma7", "ABC", "A1"]]);
  });

  it("chooses the delimiter over the first ten records, so a title with a comma does not tip it", () => {
    const text = "Schema hösten 2026, Lillskolan\nKlass;Ämne;Dag\n7A;Ma;Mån\n";
    expect(readTable(text).delimiter).toBe(";");
  });

  it("settles a tie for ';' then ',' and takes a file with no delimiter as ';'", () => {
    expect(readTable("a;b,c\n").delimiter).toBe(";");
    expect(readTable("abc\n").delimiter).toBe(";");
    expect(readTable("").rows).toEqual([]);
  });

  it("keeps a title above the header, and numbers every row as Excel does, blank lines counted", () => {
    const table = readTable("Schema hösten\n\nKlass;Ämne\n7A;Ma\n\n7B;Sv\n");
    expect(table.rows.map((row) => row[0])).toEqual(["Schema hösten", "Klass", "7A", "7B"]);
    expect(table.rowNumbers).toEqual([1, 3, 4, 6]);
  });

  it("reads quoted fields with the delimiter, doubled quotes and line breaks inside, and a record ends at LF, CRLF or CR", () => {
    expect(readTable('a;b\r\n"x;y";"he said ""hi"""\r\n"two\nlines";z\rlast;row').rows).toEqual([
      ["a", "b"],
      ["x;y", 'he said "hi"'],
      ["two\nlines", "z"],
      ["last", "row"],
    ]);
  });

  it("takes off a BOM, and reports a quote that never closes", () => {
    expect(readTable("﻿a;b\n1;2").rows[0]).toEqual(["a", "b"]);
    const open = readTable('a;b\n1;"never closed\n2;3');
    expect(open.unterminated).toBe(true);
    expect(open.rows.at(-1)![1]).toContain("never closed");
    expect(readTable("a;b\n1;2").unterminated).toBe(false);
  });

  it("takes the formula guard off a cell, one apostrophe", () => {
    expect(readTable("a\n'=1+1\n''=1+1\n'Anna'\n").rows.map((row) => row[0])).toEqual(["a", "=1+1", "'=1+1", "'Anna'"]);
  });

  it("never throws, whatever the text", () => {
    for (const text of ['"', '""', ';;;;', '\n\n\n', '"a"b"c', "\r", "﻿", 'a;"b\n', "x".repeat(10000)]) {
      expect(() => readTable(text)).not.toThrow();
    }
  });
});

describe("the formula guard", () => {
  it.each([["=1+1", "'=1+1"], ["+a", "'+a"], ["+1", "+1"], ["-a", "'-a"], ["@x", "'@x"], [" =1", "' =1"], ["'=x", "''=x"], ["Anna", "Anna"], ["08:10", "08:10"], ["-5", "-5"], ["-12,5", "-12,5"], ["'-5", "''-5"]])(
    "guards %j as %j",
    (value, guarded) => {
      expect(guardFormula(value)).toBe(guarded);
      expect(unguardFormula(guarded)).toBe(value);
    },
  );
});

describe("writeMappedTable, a table of very many rows", () => {
  it("is written whatever the number of rows (a spread of the row numbers is a RangeError from about 125 000)", () => {
    const count = 300_000;
    const rows = Array.from({ length: count }, () => ["x"]);
    const text = writeMappedTable(1, ["h"], rows, rows.map((_, index) => index + 2));
    expect(text.length).toBe("h\r\n".length + count * "x\r\n".length);
  });
});

describe("writeMappedTable", () => {
  it("writes the header and each row on the row it came from, with empty lines between, and CRLF after every line", () => {
    expect(writeMappedTable(3, ["A", "B"], [["1", "2"], ["3", "4"]], [4, 6])).toBe("\r\n\r\nA;B\r\n1;2\r\n\r\n3;4\r\n");
  });

  it("quotes a cell with any delimiter, a quote or a line break, and guards a formula", () => {
    const text = writeMappedTable(1, ["A", "B", "C"], [["x,y", 'a "q"', "=SUM(1)"], ["l1\nl2", "t\tt", "ö"]], [2, 3]);
    expect(text).toBe('A;B;C\r\n"x,y";"a ""q""";\'=SUM(1)\r\n"l1\nl2";"t\tt";ö\r\n');
  });

  it("reads back as it was written: rows, row numbers and every cell, with guard and quoting undone", () => {
    const rows = [["x;y", '"q"', "'=a"], ["", "ö ä å", "  padded  "], ["a\r\nb", "-5", "+x"]];
    const text = writeMappedTable(2, ["H1", "H2", "H3"], rows, [4, 5, 9]);
    const back = readTable(text);
    expect(back.rowNumbers).toEqual([2, 4, 5, 9]);
    expect(back.rows).toEqual([["H1", "H2", "H3"], ...rows]);
  });

  it("writes only the header for a table with no rows", () => {
    expect(writeMappedTable(1, ["A"], [], [])).toBe("A\r\n");
  });
});

describe("readTable, a quote inside an unquoted field", () => {
  it("is part of the field: a nickname in quotes or an inch mark does not open a quoted field that swallows the rows below", () => {
    const table = readTable('namn;kod\nOla "Olle" Berg;x\n5" skruv;y\nEva;z\n');
    expect(table.rows).toEqual([["namn", "kod"], ['Ola "Olle" Berg', "x"], ['5" skruv', "y"], ["Eva", "z"]]);
    expect(table.unterminated).toBe(false);
  });
});
