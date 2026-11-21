import { describe, expect, it } from "vitest";
import { readTable } from "@/lib/column-table";
import { encodeText, encodingFromName, endsWithLineBreak, lineEndingOf, writeTable } from "@/lib/pseudonym-write";

describe("encodeText", () => {
  it("writes UTF-8 with the byte order mark only when asked for it", () => {
    expect(Array.from(encodeText("å", "UTF-8", false).bytes)).toEqual([0xc3, 0xa5]);
    expect(Array.from(encodeText("å", "UTF-8", true).bytes)).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa5]);
  });

  it("writes Windows-1252 so that TextDecoder reads the text back: å ä ö, the euro sign, dashes and curly quotes", () => {
    const text = "Åke Öst, Märta Ångström – “klar” för 5 €\r\n";
    const encoded = encodeText(text, "Windows-1252", true);
    expect(encoded.encoding).toBe("Windows-1252");
    expect(encoded.fellBack).toBe(false);
    expect(new TextDecoder("windows-1252").decode(encoded.bytes)).toBe(text);
    // å is the single byte E5, and a single-byte file has no byte order mark.
    expect(encoded.bytes[1]).toBe(0x6b);
    expect(encoded.bytes[0]).toBe(0xc5);
  });

  it("writes Mac Roman so that TextDecoder reads the text back", () => {
    const text = "Åke Öst – Märta";
    const encoded = encodeText(text, "Mac Roman", false);
    expect(encoded.encoding).toBe("Mac Roman");
    expect(new TextDecoder("macintosh").decode(encoded.bytes)).toBe(text);
  });

  it("falls back to UTF-8 for the whole file when the code page cannot hold a character, and says so", () => {
    const encoded = encodeText("Anna 日本", "Windows-1252", false);
    expect(encoded.fellBack).toBe(true);
    expect(encoded.encoding).toBe("UTF-8");
    expect(new TextDecoder().decode(encoded.bytes)).toBe("Anna 日本");
  });

  it("names the encodings readSource names", () => {
    expect(encodingFromName(null)).toBe("UTF-8");
    expect(encodingFromName("Windows-1252")).toBe("Windows-1252");
    expect(encodingFromName("Mac Roman")).toBe("Mac Roman");
  });
});

describe("lineEndingOf", () => {
  it.each([
    ["a\r\nb\r\nc", "\r\n"],
    ["a\nb\nc\n", "\n"],
    ["a\rb\rc", "\r"],
    ["a\r\nb\nc\nd\n", "\n"],
    ["no break at all", "\r\n"],
    ["", "\r\n"],
  ])("%j has the line ending %j", (text, eol) => {
    expect(lineEndingOf(text)).toBe(eol);
  });

  it("knows whether a text ends with a line break", () => {
    expect(endsWithLineBreak("a\n")).toBe(true);
    expect(endsWithLineBreak("a\r")).toBe(true);
    expect(endsWithLineBreak("a")).toBe(false);
  });
});

describe("writeTable", () => {
  it("writes each row on the line it came from, with an empty line for every number between, the delimiter and line ending it was given", () => {
    const written = writeTable([["a", "b"], ["c", "d"]], [1, 4], ";", "\r\n", true);
    expect(written.text).toBe("a;b\r\n\r\n\r\nc;d\r\n");
  });

  it("ends without a line break when the original did", () => {
    expect(writeTable([["a"], ["b"]], [1, 2], ",", "\n", false).text).toBe("a\nb");
    expect(writeTable([], [], ";", "\n", true).text).toBe("");
  });

  it("quotes a field with a quote, a line break or any delimiter the reader detects, and doubles its quotes", () => {
    const text = writeTable([['a;b', 'say "hi"', "x,y", "t\tt", "l1\nl2", "plain"]], [1], ";", "\r\n", false).text;
    expect(text).toBe('"a;b";"say ""hi""";"x,y";"t\tt";"l1\nl2";plain');
  });

  it("puts the formula guard on what a spreadsheet would run, leaves a plain number alone, and counts the cells it touched", () => {
    const written = writeTable([["=1+1", "-5", "+46", "@x", "plain", "'=old"]], [1], ";", "\r\n", false);
    expect(written.text).toBe("'=1+1;-5;+46;'@x;plain;''=old");
    expect(written.guarded).toBe(3);
  });

  it("is read back by the table reader as the rows it was given, for tables of nasty cells and any delimiter", () => {
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const cells = ["a", "Åke", "x;y", 'q"q', "t\tt", "1,5", "line\nbreak", "=1+1", " lead", "7A", "a b c", "'=x"];
    for (let round = 0; round < 200; round += 1) {
      const width = 1 + next(5);
      const rows = Array.from({ length: 1 + next(6) }, () => Array.from({ length: width }, () => cells[next(cells.length)]!));
      // The reader drops a record of nothing but empty cells, so the generator never makes one.
      const numbers = rows.map((_, i) => i + 1 + next(3) * (i + 1));
      const unique = [...new Set(numbers)].sort((a, b) => a - b);
      const kept = rows.slice(0, unique.length);
      for (const eol of ["\r\n", "\n"] as const) {
        const written = writeTable(kept, unique, ";", eol, true).text;
        const read = readTable(written);
        // A guarded cell is read back unguarded: guard and unguard are inverses.
        expect(read.rows, JSON.stringify(kept)).toEqual(kept);
        expect(read.rowNumbers).toEqual(unique);
      }
    }
  });
});
