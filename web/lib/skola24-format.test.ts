import { describe, expect, it } from "vitest";
import { applyMapping, chooseHeaderRow, personalNumberColumns } from "@/lib/column-mapping";
import { readTable, writeMappedTable } from "@/lib/column-table";
import { mapTeacherRows } from "@/lib/csv";
import { hasPersonalNumber } from "@/lib/personal-number";
import { readFixture } from "@/lib/__fixtures__/skola24-read";
import { blockWithoutHeader, detectFormats, readFormat, type Verdict } from "@/lib/skola24-format";
import { SKOLA24_FORMATS, formatById } from "@/lib/skola24-formats";
import type { FormatDescriptor } from "@/lib/skola24-format-types";

const format = (id: string): FormatDescriptor => formatById(id)!;
const table = (name: string) => readTable(readFixture(name));
const statuses = (verdicts: { verdict: Verdict }[]) => verdicts.map((column) => column.verdict.status);

describe("a file with no header row, as X2 reads it today", () => {
  it("makes the first row the header, so one guardian is lost and his cells are named as columns", () => {
    // This is why blockWithoutHeader exists: chooseHeaderRow takes a header row of any file, and the parents' file has none.
    const asHeader = chooseHeaderRow(table("foraldrar.csv"), null)!;
    expect(asHeader.body).toHaveLength(3);
    expect(asHeader.headers[2]).toBe("Åsa");
  });

  it("is a block of its own with every row kept, the file's row numbers, and the description's labels as headers", () => {
    const labels = format("skola24-foraldrar-csv").columns!.map((column) => column.label.value);
    const block = blockWithoutHeader(table("foraldrar.csv"), labels)!;
    expect(block.headerRowNumber).toBe(0);
    expect(block.body).toHaveLength(4);
    expect(block.rowNumbers).toEqual([1, 2, 3, 4]);
    expect(block.headers).toEqual(labels);
    // A short row (the third ends after four values) is as wide as the header.
    expect(block.body[2]).toEqual(["19000101-0005", "19000102-0006", "Cia", "Fiktiv", "", ""]);
  });

  it("names a column the file has beyond the description's, by position: an empty header", () => {
    const block = blockWithoutHeader(readTable("a;b;c\n1;2;3;4;5\n"), ["x", "y"])!;
    expect(block.headers).toEqual(["x", "y", "", "", ""]);
    expect(block.keys.slice(2)).toEqual(["kolumn3", "kolumn4", "kolumn5"]);
    expect(blockWithoutHeader(readTable(""), ["x"])).toBeNull();
  });
});

describe("Föräldrar CSV", () => {
  const parents = format("skola24-foraldrar-csv");

  it("is read on position, since the page gives no header row and one fixed order", () => {
    const reading = readFormat(table("foraldrar.csv"), parents)!;
    expect(reading.by).toBe("position");
    expect(statuses(reading.columns)).toEqual(["personalNumber", "personalNumber", "placed", "placed", "placed", "placed"]);
    expect(reading.assignment).toEqual([null, null, "firstName", "lastName", "email", "phone"]);
    expect(reading.missing).toEqual([]);
    expect(reading.exact).toBe(false);
  });

  it("does not drop the mobile column as personnummer: ten bare digits that read as a date are a telephone number HERE", () => {
    const reading = readFormat(table("foraldrar.csv"), parents)!;
    expect(reading.block.telephone).toEqual([5]);
    expect(personalNumberColumns(reading.block).has(5)).toBe(false);
    // Without the description's say, the same block drops it: X2 knows a telephone column only by its header.
    const bare = blockWithoutHeader(table("foraldrar.csv"), parents.columns!.map((column) => column.label.value))!;
    expect(personalNumberColumns(bare).has(5)).toBe(true);
  });

  it("names the columns a file lacks when every row ends early", () => {
    const reading = readFormat(readTable("19000101-0001;19000102-0002;Åsa;Testsson\n19000101-0003;19000102-0004;Bo;Provsson\n"), parents)!;
    expect(reading.columns).toHaveLength(4);
    expect(reading.missing.map((column) => column.id)).toEqual(["email", "mobile"]);
    expect(reading.missing.every((column) => column.required?.value === false)).toBe(true);
  });

  it("cannot be imported as it stands: the page links a guardian by the pupil's personnummer, and Rastra wants the pupil's e-mail", () => {
    const reading = readFormat(table("foraldrar.csv"), parents)!;
    const applied = applyMapping(reading.block, "guardians", reading.assignment);
    expect(applied.problems).toEqual([{ code: "MISSING_REQUIRED", field: "studentEmail" }]);
    expect(applied.rows).toEqual([]);
  });
});

describe("Personal CSV", () => {
  const staff = format("skola24-personal-csv");

  it("is read on position when its first row is data, and says why each unplaced column is not read", () => {
    const reading = readFormat(table("personal.csv"), staff)!;
    expect(reading.by).toBe("position");
    expect(reading.columns.map((column) => column.verdict)).toEqual([
      { status: "unread", column: "school", reason: "school" },
      { status: "unread", column: "department", reason: "department" },
      { status: "personalNumber", column: "personalNumber" },
      { status: "placed", column: "firstName", field: "firstName" },
      { status: "placed", column: "lastName", field: "lastName" },
      { status: "unread", column: "signature", reason: "needsPost" },
      { status: "placed", column: "email", field: "email" },
      { status: "unread", column: "confidentialMark", reason: "confidentialMark" },
    ]);
    expect(reading.assignment).toEqual([null, null, null, "firstName", "lastName", null, "email", null]);
  });

  it("holds back the row marked 1, by its row number", () => {
    expect(readFormat(table("personal.csv"), staff)!.heldRows).toEqual([3]);
    // The mark is "the number 1": nothing else is guessed to mean it, and a mark with spaces round it is still that.
    const text = "S;A;19000103-0001;A;B;C;;0\nS;A;19000103-0002;A;B;C;;x\nS;A;19000103-0003;A;B;C;; 1 \nS;A;19000103-0004;A;B;C;;11\n";
    expect(readFormat(readTable(text), staff)!.heldRows).toEqual([3]);
  });

  it("goes through X2 and the teachers' importer as a file of Rastra's own would", () => {
    const reading = readFormat(table("personal.csv"), staff)!;
    const applied = applyMapping(reading.block, "teachers", reading.assignment);
    expect(applied.problems).toEqual([]);
    expect(applied.headers).toEqual(["fornamn", "efternamn", "epost"]);
    expect(applied.dropped.map((column) => column.index)).toEqual([2]);
    const mapped = mapTeacherRows(applied.parsed);
    expect(mapped.rows.map((row) => row.firstName)).toEqual(["Åsa", "Maria"]);
    // The importer's own rule, not the description's: the second row has no e-mail.
    expect(mapped.errors.map((error) => error.row)).toEqual([2]);
  });

  it("does not place the signature by default: the importer would refuse every row that has one, as the user finds out by placing it", () => {
    const reading = readFormat(table("personal.csv"), staff)!;
    const assignment = [...reading.assignment];
    assignment[5] = "signature";
    const applied = applyMapping(reading.block, "teachers", assignment);
    expect(mapTeacherRows(applied.parsed).rows.map((row) => row.firstName)).toEqual(["Maria"]);
    expect(mapTeacherRows(applied.parsed).errors.map((error) => error.message).join(" ")).toContain("signatur utan tjanst_procent");
  });

  it("is read on headers when the file has them", () => {
    const headers = "skolans namn;avdelning;personnummer;förnamn;efternamn;signatur;e-postadress;sekretessmarkering\n";
    const reading = readFormat(readTable(`${headers}S;A;19000103-0001;Åsa;Provsson;ASP;a@example.invalid;\n`), staff)!;
    expect(reading.by).toBe("header");
    expect(reading.exact).toBe(true);
    expect(reading.block.headerRowNumber).toBe(1);
    expect(reading.assignment).toEqual([null, null, null, "firstName", "lastName", null, "email", null]);
  });
});

describe("a file that has a header row its page does not show", () => {
  it("is read on its headers, since the page's 'no header row' is our reading and the first row says otherwise", () => {
    const parents = format("skola24-foraldrar-csv");
    const labels = parents.columns!.map((column) => column.label.value).join(";");
    const reading = readFormat(readTable(`${labels}\n19000101-0001;19000102-0002;Åsa;Testsson;asa@example.invalid;\n`), parents)!;
    expect(reading.by).toBe("header");
    expect(reading.exact).toBe(true);
    expect(reading.block.body).toHaveLength(1);
    expect(reading.assignment).toEqual([null, null, "firstName", "lastName", "email", "phone"]);
    const extens = readFormat(readTable("EnhetsID;Personnummer;Summerat antal timmar oanmäld frånvaro för perioden\n12345;000106-0001;2.5\n"), format("skola24-extens-franvaro"))!;
    expect(extens.by).toBe("header");
    expect(extens.exact).toBe(true);
  });

  it("and is still read on position when the user says it has none, whatever its first row looks like", () => {
    const text = "Förnamn;x;y;z\nÅsa;1;2;3\n";
    expect(readFormat(readTable(text), format("skola24-foraldrar-csv"), { header: "absent" })!.by).toBe("position");
  });
});

describe("Barn CSV and the Extens file: described, read, and Rastra reads nothing from them", () => {
  it("names every column of the children's file and holds the row with the mark", () => {
    const reading = readFormat(table("barn.csv"), format("skola24-barn-csv"))!;
    expect(statuses(reading.columns)).toEqual(["unread", "unread", "personalNumber", "unread", "unread", "unread"]);
    expect(reading.assignment.every((entry) => entry === null)).toBe(true);
    expect(reading.heldRows).toEqual([2]);
  });

  it("reads the Extens file on position and drops its personnummer column", () => {
    const reading = readFormat(table("extens-franvaro.txt"), format("skola24-extens-franvaro"))!;
    expect(reading.by).toBe("position");
    expect(reading.columns.map((column) => column.verdict)).toEqual([
      { status: "unread", column: "unitId", reason: "noImport" },
      { status: "personalNumber", column: "personalNumber" },
      { status: "unread", column: "hours", reason: "noImport" },
    ]);
  });
});

describe("Elever, Klass – Elev", () => {
  const pupils = format("skola24-elever-klass");

  it("is read on its headers, exactly, and never on position (the page gives the order twice, differently)", () => {
    const reading = readFormat(table("elever-klass.tsv"), pupils)!;
    expect(reading.by).toBe("header");
    expect(reading.exact).toBe(true);
    expect(reading.assignment).toEqual([null, "lastName", "firstName", "className"]);
    expect(readFormat(table("elever-klass.tsv"), pupils, { header: "absent" })).toBeNull();
  });

  it("cannot be imported as it stands: Skola24's file has no e-mail and Rastra's importer wants one", () => {
    const reading = readFormat(table("elever-klass.tsv"), pupils)!;
    expect(applyMapping(reading.block, "students", reading.assignment).problems).toEqual([{ code: "MISSING_REQUIRED", field: "email" }]);
  });

  it("is not exact when it has a column of its own, and names that column: a single name column is no column the page lists", () => {
    const reading = readFormat(readTable("Personnummer\tNamn\tKlass\n19000105-0001\tTestsson, Åsa\t7A\n"), pupils)!;
    expect(reading.exact).toBe(false);
    expect(reading.columns.map((column) => [column.label, column.verdict.status])).toEqual([
      ["Personnummer", "personalNumber"],
      ["Namn", "unknown"],
      ["Klass", "placed"],
    ]);
    expect(reading.assignment).toEqual([null, undefined, "className"]);
    expect(reading.missing.map((column) => column.id)).toEqual(["lastName", "firstName"]);
  });

  it("is not exact when a header stands twice, and X2 is left to say that two columns claim one field", () => {
    const text = "Personnummer\tEfternamn\tFörnamn\tKlass\tKlass\n19000105-0001\tT\tÅ\t7A\t7B\n";
    const reading = readFormat(readTable(text), pupils)!;
    expect(reading.exact).toBe(false);
    expect(detectFormats(readTable(text))[0]).toMatchObject({ format: "skola24-elever-klass", exact: false });
    expect(reading.assignment).toEqual([null, "lastName", "firstName", "className", "className"]);
    expect(applyMapping(reading.block, "students", reading.assignment).problems.map((problem) => problem.code)).toContain("DUPLICATE_TARGET");
  });

  it("finds the headers under a title, when the user says where they stand", () => {
    const reading = readFormat(readTable("Elever hösten 2026\nPersonnummer\tEfternamn\tFörnamn\tKlass\n19000105-0001\tT\tÅ\t7A\n"), pupils, { headerRow: 2 })!;
    expect(reading.block.headerRowNumber).toBe(2);
    expect(reading.exact).toBe(true);
  });
});

describe("a file no description can read", () => {
  it("is null: no columns, no rows, or no header row for a description with no order", () => {
    expect(readFormat(readTable(""), format("skola24-foraldrar-csv"))).toBeNull();
    expect(readFormat(table("elever-klass.tsv"), format("skola24-textfil"))).toBeNull();
    expect(readFormat(table("elever-klass.tsv"), format("skola24-elever-klass"), { header: "absent" })).toBeNull();
  });
});

describe("recognising a file", () => {
  const first = (name: string) => detectFormats(table(name)).map((fit) => `${fit.format}/${fit.by}${fit.exact ? "/exact" : ""}`);

  it("offers the description of each fixture, and no other", () => {
    expect(first("foraldrar.csv")).toEqual(["skola24-foraldrar-csv/position"]);
    expect(first("personal.csv")).toEqual(["skola24-personal-csv/position"]);
    expect(first("elever-klass.tsv")).toEqual(["skola24-elever-klass/header/exact"]);
    expect(first("extens-franvaro.txt")).toEqual(["skola24-extens-franvaro/position"]);
  });

  it("offers BOTH when two descriptions fit equally, the more specific first: a six-column staff file and a children's file are alike", () => {
    expect(first("barn.csv")).toEqual(["skola24-barn-csv/position", "skola24-personal-csv/position"]);
  });

  it("offers nothing for a school's own list, however alike its headers are", () => {
    expect(detectFormats(readTable("Förnamn;Efternamn;E-post;Telefon;Signatur\nÅsa;Testsson;a@example.invalid;070;ASP\n"))).toEqual([]);
    expect(detectFormats(readTable(""))).toEqual([]);
    expect(detectFormats(readTable("a;b;c\n1;2;3\n"))).toEqual([]);
  });

  it("looks at no more than the first rows of a long file, and one stray row does not undo a fit", () => {
    const rows = Array.from({ length: 200 }, (_, at) => `1234${at};00010${(at % 8) + 1}-${String(1000 + at)};${at}`);
    expect(detectFormats(readTable(rows.join("\n"))).map((fit) => fit.format)).toEqual(["skola24-extens-franvaro"]);
    const stray = ["12345;000101-0001;1", "12345;000101-0002;2", "12345;000101-0003;3", "12345;000101-0004;4", "12345;;5"];
    expect(detectFormats(readTable(stray.join("\n"))).map((fit) => fit.format)).toEqual(["skola24-extens-franvaro"]);
  });
});

describe("nothing is said twice or not at all", () => {
  /** mulberry32, as column-mapping.property.test.ts. */
  const rng = (seed: number) => {
    let a = seed >>> 0;
    return (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const ROUNDS = 150;
  const EXTRA = ["Anteckning", "Fri text", "Övrigt", "Kolumn X"];

  it.each(SKOLA24_FORMATS.filter((entry) => entry.columns !== null).map((entry) => [entry.id, entry] as const))(
    "%s: every column of a file with the description's headers in any order, and some of its own, gets exactly one verdict",
    (_id, descriptor) => {
      const next = rng(descriptor.id.length * 7919);
      for (let round = 0; round < ROUNDS; round += 1) {
        const labels = descriptor.columns!.map((column) => column.label.value).filter(() => next() < 0.8);
        const extras = EXTRA.filter(() => next() < 0.4);
        const headers = [...labels, ...extras].sort(() => next() - 0.5);
        const reading = readFormat(readTable(`${headers.join(";")}\n${headers.map(() => "x").join(";")}\n`), descriptor, { header: "present" })!;
        expect(reading.columns, `round ${round}`).toHaveLength(headers.length);
        expect(reading.assignment, `round ${round}`).toHaveLength(headers.length);
        expect(reading.columns.filter((column) => column.verdict.status === "unknown").length, `round ${round}`).toBe(extras.length);
        // A column is placed on one field, and a field has one column.
        const fields = reading.columns.flatMap((column) => (column.verdict.status === "placed" ? [column.verdict.field] : []));
        expect(new Set(fields).size, `round ${round}`).toBe(fields.length);
        // What the description has and the file lacks is named, and nothing else.
        expect(reading.missing.length, `round ${round}`).toBe(descriptor.columns!.length - labels.length);
        expect(reading.exact, `round ${round}`).toBe(extras.length === 0 && labels.length === descriptor.columns!.length);
      }
    },
  );
});

describe("no personnummer is shown, sent or kept in a result", () => {
  it.each(["foraldrar.csv", "personal.csv", "barn.csv", "elever-klass.tsv", "extens-franvaro.txt"])("%s: what the reading says of its columns holds none", (name) => {
    const descriptor = detectFormats(table(name)).map((fit) => format(fit.format))[0]!;
    const reading = readFormat(table(name), descriptor)!;
    // `block` is X2's own and keeps the table's cells, as X2's does; what is SAID about the columns does not.
    const said = JSON.stringify({ ...reading, block: undefined });
    expect(hasPersonalNumber(said), said).toBe(false);
    expect(said).not.toContain("19000");
    for (const column of reading.columns.filter((entry) => entry.verdict.status === "personalNumber")) {
      expect(reading.assignment[column.index]).toBeNull();
    }
  });

  it("holds none in what is sent for import either: the personnummer column is not in the mapped table", () => {
    const reading = readFormat(table("personal.csv"), format("skola24-personal-csv"))!;
    const applied = applyMapping(reading.block, "teachers", reading.assignment);
    expect(applied.csv).not.toContain("19000");
    expect(JSON.stringify(applied.rows)).not.toContain("19000");
  });

  it("does not name a header that is itself a personnummer, in a file that has headers", () => {
    const reading = readFormat(readTable("19000105-0001\tEfternamn\tFörnamn\tKlass\n19000105-0002\tT\tÅ\t7A\n"), format("skola24-elever-klass"), { header: "present" })!;
    expect(reading.columns[0]!.label).toBeNull();
    expect(reading.columns[0]!.verdict.status).toBe("personalNumber");
  });
});

describe("writing a table with no header row", () => {
  it("puts the header first, on a record of its own, and each row where it was one record later", () => {
    // headerRowNumber 0: lib/column-mapping.ts Block.headerRowNumber for a file with no header row.
    expect(writeMappedTable(0, ["a", "b"], [["1", "2"], ["3", "4"]], [1, 3])).toBe("a;b\r\n1;2\r\n\r\n3;4\r\n");
    // With one it is as before.
    expect(writeMappedTable(2, ["a", "b"], [["1", "2"]], [3])).toBe("\r\na;b\r\n1;2\r\n");
  });
});
