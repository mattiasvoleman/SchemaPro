import { describe, expect, it } from "vitest";
import { FIELDS } from "@/lib/column-fields";
import {
  aliasAssignment,
  applyMapping,
  chooseHeaderRow,
  describeColumns,
  headerRowCandidates,
  keysOf,
  matchTemplates,
  personalNumberColumns,
  placementsOf,
  recognise,
  templateAssignment,
  type Assignment,
  type MappingTemplate,
} from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { mapRequirementRows, mapStudentRows } from "@/lib/csv";
import { hasPersonalNumber } from "@/lib/personal-number";

/*
 * The fixtures below have INVENTED headers (Kurs, Ped, Rum, Tid, ...). They claim nothing about what any other program calls
 * its columns: the mapping never knows that, and these only show that a column the user points out is read as pointed out.
 */

const block = (text: string, headerRow: number | null = null) => chooseHeaderRow(readTable(text), headerRow)!;
const assign = (...fields: (string | null | undefined)[]): Assignment => fields;

const WIDE = ["Schema hösten 2026", "", "Kurs\tFack\tPed\tRum\tDag\tTid\tVecka\tAnteckning", "7A\tMatematik\tABC\tA1\tMån\t08:10-09:00\tA\tse mall", "7B\tSvenska\tDEF, GHI\tB2\tTis\t09:20 – 10:10\t\t", ""].join("\n");

describe("the header row", () => {
  it("is the first row with content, or the row the user names, a title above it skipped", () => {
    const table = readTable(WIDE);
    expect(chooseHeaderRow(table, null)!.headers).toEqual(["Schema hösten 2026"]);
    const chosen = chooseHeaderRow(table, 3)!;
    expect(chosen.headerRowNumber).toBe(3);
    expect(chosen.headers).toEqual(["Kurs", "Fack", "Ped", "Rum", "Dag", "Tid", "Vecka", "Anteckning"]);
    expect(chosen.rowNumbers).toEqual([4, 5]);
    expect(chosen.body[1]).toEqual(["7B", "Svenska", "DEF, GHI", "B2", "Tis", "09:20 – 10:10", "", ""]);
  });

  it("is none for a table with no rows or a row that is not there, and lists the first rows as candidates", () => {
    expect(chooseHeaderRow(readTable(""), null)).toBeNull();
    expect(chooseHeaderRow(readTable(WIDE), 2)).toBeNull();
    expect(chooseHeaderRow(readTable(WIDE), 99)).toBeNull();
    expect(headerRowCandidates(readTable(WIDE))).toEqual([1, 3, 4, 5]);
    expect(headerRowCandidates(readTable("a\nb\nc\nd"), 2)).toEqual([1, 2]);
  });

  it("pads a short row, cuts a cell right of the last header, and lists the row that had one", () => {
    const b = block("A;B\n1\n2;3;4\n5;6;");
    expect(b.body).toEqual([["1", ""], ["2", "3"], ["5", "6"]]);
    expect(b.overflowRows).toEqual([3]);
  });

  it("keys a header by its normalised spelling, `#2` for one that stands twice, `kolumn<n>` for one that is nothing", () => {
    expect(keysOf(["Lärare e-post", "LARARE E POST", "Namn", "namn", "namn", "#", ""])).toEqual(["larareepost", "larareepost#2", "namn", "namn#2", "namn#3", "kolumn6", "kolumn7"]);
  });

  it("never keys a header that has the shape of a number by that number", () => {
    const keys = keysOf(["19800101-1234", "Elev 8001011234", "Klass"]);
    expect(keys).toEqual(["kolumn1", "kolumn2", "klass"]);
    for (const key of keys) expect(hasPersonalNumber(key)).toBe(false);
  });
});

describe("a column that looks like a personnummer", () => {
  it("is a header that says so, or a column where half of the filled cells have the shape", () => {
    const b = block("Namn;Personnr;Anteckning;Id\nAnna;19800101-1234;ok;1\nBo;800101-1235;;2\nCarl;nej;;3");
    expect([...personalNumberColumns(b)]).toEqual([1]);
    const content = block("Namn;Kod\nAnna;8001011234\nBo;800101-1235\nCarl;x");
    expect([...personalNumberColumns(content)]).toEqual([1]);
    const few = block("Namn;Kod\nAnna;8001011234\nBo;a\nCarl;b\nDan;c");
    expect([...personalNumberColumns(few)]).toEqual([]);
  });

  it("is a column where exactly half of the filled cells have the shape, and not one where fewer do", () => {
    // One of two filled cells: half is enough, since a column that holds a number in every second row is a column of numbers.
    const half = block("Namn;Kod\nAnna;8001011234\nBo;x");
    expect([...personalNumberColumns(half)]).toEqual([1]);
    // One of three is a column with a stray cell: the row is held back (below), the column is read.
    const fewer = block("Namn;Kod\nAnna;8001011234\nBo;x\nCarl;y");
    expect([...personalNumberColumns(fewer)]).toEqual([]);
    // Empty cells are not counted: one number among two empty cells and one text is one of two filled.
    const sparse = block("Namn;Kod\nAnna;8001011234\nBo;\nCarl;x\nDan;");
    expect([...personalNumberColumns(sparse)]).toEqual([1]);
  });

  it("is dropped whatever is assigned to it, and is not named when its header is itself a number", () => {
    const b = block("Namn;19800101-1234;Klass\nAnna;a;7A\nBo;b;7B");
    const done = applyMapping(b, "students", assign("firstName", "lastName", "className"));
    expect(done.dropped).toEqual([{ index: 1, label: null }]);
    // The column is not read although a field was put on it: the field is then missing, and no row holds what the column had.
    expect(done.problems.map((problem) => [problem.code, problem.field])).toEqual([["MISSING_REQUIRED", "lastName"], ["MISSING_REQUIRED", "email"]]);
    expect(done.rows).toEqual([]);
    expect(JSON.stringify(done)).not.toMatch(/19800101/);
    // A field the kind does not need: the rows are written without it.
    const rooms = applyMapping(block("namn;kod;Id\nA;B;19800101-1234\nC;D;19900202-4321"), "rooms", assign("name", "code", "building"));
    expect(rooms.ok).toBe(true);
    expect(rooms.headers).toEqual(["namn", "kod"]);
    expect(rooms.rows).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("holds a row back when a column that is read has a cell with the shape, naming the row and the column, never the value", () => {
    const b = block("Namn;Byggnad;Anteckning\nA1;Hus A;ok\nA2;Anna Berg 19800101-1234;ok\nA3;Hus C;19800101-1234\nA4;Hus D;ok");
    const done = applyMapping(b, "rooms", assign("name", "building", null));
    expect(done.ok).toBe(false);
    expect(done.rowProblems).toHaveLength(1);
    expect(done.rowProblems[0]).toMatchObject({ row: 3, code: "PERSONAL_NUMBER_IN_CELL" });
    expect(done.rowProblems[0]!.message).toContain("Rad 3");
    expect(done.rowProblems[0]!.message).toContain("”Byggnad”");
    expect(JSON.stringify(done)).not.toMatch(/19800101|8001011234/);
    // The fourth row has one too, in a column that is not read, and is not held back for it.
    expect(done.rowNumbers).toEqual([2, 4, 5]);
  });
});

describe("two columns the user put on one field", () => {
  it("are shown as duplicates, each with the field, and neither is called placed", () => {
    const b = block("namn;kod;extra\nA;B;C\n");
    const states = describeColumns(b, "rooms", assign("name", "name", "code"));
    expect(states.map((state) => [state.status, state.field])).toEqual([["duplicate", "name"], ["duplicate", "name"], ["placed", "code"]]);
  });
});

describe("a personnummer where the mapping splits a cell in two", () => {
  const LESSONS = (cells: string[]) => block(`Kurs\tFack\tPed\tTid\tDag\n${cells.join("\n")}\n`);
  const FIELDS_OF = assign("group", "subject", "teacherList", "timeRange", "day");

  it("holds the row back for a personnummer in a teacher list or a time range, and writes nothing of the cell", () => {
    for (const [column, cell] of [["Ped", "ABC, 19800101-1234"], ["Ped", "19800101-1234"], ["Tid", "08:10-09:00 800101-1234"]] as const) {
      const rows = ["7A\tMat\tABC\t08:10-09:00\tMån", "7B\tSv\tDEF\t09:20-10:10\tTis", "7C\tEn\tGHI\t10:20-11:10\tOns"];
      rows[0] = column === "Ped" ? `7A\tMat\t${cell}\t08:10-09:00\tMån` : `7A\tMat\tABC\t${cell}\tMån`;
      const done = applyMapping(LESSONS(rows), "scheduleLessons", FIELDS_OF);
      expect(done.rowProblems.map((problem) => [problem.row, problem.code]), cell).toEqual([[2, "PERSONAL_NUMBER_IN_CELL"]]);
      expect(done.rowNumbers, cell).toEqual([3, 4]);
      expect(done.csv, cell).not.toMatch(/1980|800101/);
      expect(JSON.stringify(done), cell).not.toMatch(/1980|800101/);
    }
  });
});

describe("a header that has the shape of a number only after its punctuation is gone", () => {
  it("is known by its position, as a header that has the shape of one is", () => {
    for (const header of ["19800101-1234", "19800101(1234)", "(8001011234)", "1980 01 01 / 1234", "19800101_1234"]) {
      expect(keysOf(["Kurs", header]), header).toEqual(["kurs", "kolumn2"]);
    }
  });
});

describe("what a table pasted from another program writes between two times and two teachers", () => {
  const lesson = (tid: string, ped: string) => block(`Kurs;Fack;Ped;Tid;Dag\n7A;Mat;"${ped}";"${tid}";Mån\n`);
  const ASSIGN = assign("group", "subject", "teacherList", "timeRange", "day");

  it("takes a minus sign or a hyphen-like dash between the times, and a slash between the teachers", () => {
    for (const dash of ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"]) {
      const done = applyMapping(lesson(`08:10${dash}09:00`, "ABC/DEF"), "scheduleLessons", ASSIGN);
      expect(done.ok, dash.charCodeAt(0).toString(16)).toBe(true);
      expect(done.rows[0], dash.charCodeAt(0).toString(16)).toEqual(["7A", "Mat", "Mån", "08:10", "09:00", "ABC", "DEF"]);
    }
  });
});

describe("the columns of a table nobody has said anything about", () => {
  it("are placed by the importer's own spellings, and the others are unplaced and named", () => {
    const b = block("Fornamn;Efternamn;E-post;Okänd kolumn;Klass\nAnna;Berg;a@s.se;x;7A");
    const assignment = aliasAssignment(b, "students");
    expect(assignment).toEqual(["firstName", "lastName", "email", undefined, "className"]);
    const states = describeColumns(b, "students", assignment);
    expect(states.map((state) => state.status)).toEqual(["placed", "placed", "placed", "unplaced", "placed"]);
    expect(states[3]).toMatchObject({ label: "Okänd kolumn", field: null, sample: ["x"] });
    const done = applyMapping(b, "students", assignment);
    expect(done.unplaced).toEqual([{ index: 3, label: "Okänd kolumn" }]);
    expect(done.ok).toBe(true);
  });

  it("are never matched by likeness: a header that merely resembles a spelling is unplaced", () => {
    const b = block("Förnamnet;Eftern;Epostadressen;Klassen\nAnna;Berg;a@s.se;7A");
    expect(aliasAssignment(b, "students")).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("leave a field two columns claim to the user: both are duplicates, neither is placed", () => {
    const b = block("Namn;Namn;Årskurs\nAnna;Berg;7");
    const assignment = aliasAssignment(b, "classes");
    expect(assignment).toEqual([undefined, undefined, "gradeLevel"]);
    expect(describeColumns(b, "classes", assignment).map((state) => state.status)).toEqual(["duplicate", "duplicate", "placed"]);
    // Two different headers the importer reads as one field are the same.
    const two = block("Namn;Klass\nAnna;7A");
    expect(aliasAssignment(two, "classes")).toEqual([undefined, undefined]);
    expect(describeColumns(two, "classes", [undefined, undefined]).map((state) => state.status)).toEqual(["duplicate", "duplicate"]);
  });

  it("never place a header two fields claim", () => {
    // "typ" is the kind of a class and the type of a room's name in other kinds; within one kind a spelling names one field. In the requirements, "kod" is the subject's alone.
    const b = block("kod;grupp\nMA;7A");
    expect(aliasAssignment(b, "requirements")).toEqual(["subject", "groupName"]);
  });
});

describe("applying a mapping", () => {
  const b = block(WIDE, 3);

  it("writes each placed column under the field's header, in the catalogue's order, and the rest is named", () => {
    const done = applyMapping(b, "scheduleLessons", assign("group", "subject", "teacherList", "room", "day", "timeRange", "weeks", null));
    expect(done.problems).toEqual([]);
    expect(done.headers).toEqual(["Klass/grupp", "Ämne", "Sal", "Dag", "Veckomönster", "Start", "Slut", "Lärare", "Medlärare"]);
    expect(done.rows).toEqual([
      ["7A", "Matematik", "A1", "Mån", "A", "08:10", "09:00", "ABC", ""],
      ["7B", "Svenska", "B2", "Tis", "", "09:20", "10:10", "DEF", "GHI"],
    ]);
    expect(done.rowNumbers).toEqual([4, 5]);
    expect(done.skipped).toEqual([{ index: 7, label: "Anteckning" }]);
    expect(done.unplaced).toEqual([]);
  });

  it("writes the text the gateway reads: the header on its row, each row on its own, UTF-8", () => {
    const done = applyMapping(b, "scheduleLessons", assign("group", "subject", "teacher", "room", "day", "timeRange", "weeks"));
    expect(done.ok).toBe(true);
    const back = readTable(done.csv);
    expect(back.rowNumbers).toEqual([3, 4, 5]);
    expect(back.rows[0]).toEqual(done.headers);
    expect(back.rows.slice(1)).toEqual(done.rows);
  });

  it("hands the importers' mappers a table they read as their own", () => {
    const students = block("Given;Family;Mail;Grp;Telefon\nAnna;Berg;anna@skolan.se;7A;070-123 45 67\nBo;Lund;bo@skolan.se;;");
    const done = applyMapping(students, "students", assign("firstName", "lastName", "email", "className", "phone"));
    const mapped = mapStudentRows(done.parsed);
    expect(mapped.errors).toEqual([]);
    expect(mapped.rows).toEqual([
      { firstName: "Anna", lastName: "Berg", email: "anna@skolan.se", phone: "070-123 45 67", className: "7A" },
      { firstName: "Bo", lastName: "Lund", email: "bo@skolan.se", phone: null, className: null },
    ]);
    expect(mapped.rowNumbers).toEqual([2, 3]);
  });

  it("leaves the rules to the importer: a cell it refuses is its error, named with the file's row", () => {
    const reqs = block("Titel\nGrupp;Ämne;Antal;Min\n7A;MA;3;60\n7B;SV;99;60");
    const done = applyMapping(chooseHeaderRow(readTable("Titel\nGrupp;Ämne;Antal;Min\n7A;MA;3;60\n7B;SV;99;60"), 2)!, "requirements", assign("groupName", "subject", "lessonsPerWeek", "minutesPerLesson"));
    expect(reqs.headerRowNumber).toBe(1);
    const mapped = mapRequirementRows(done.parsed);
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.errors).toHaveLength(1);
    expect(mapped.errors[0]!.row).toBe(4);
  });

  it("refuses a mapping with a required field not placed, naming the field, and gives no rows", () => {
    const done = applyMapping(b, "scheduleLessons", assign("group", null, null, "room", "day", "timeRange"));
    expect(done.problems).toEqual([{ code: "MISSING_REQUIRED", field: "subject" }]);
    expect(done.rows).toEqual([]);
    expect(done.ok).toBe(false);
    const noTime = applyMapping(b, "scheduleLessons", assign("group", "subject", "teacher", null, "day"));
    expect(noTime.problems.map((p) => [p.code, p.field])).toEqual([["MISSING_REQUIRED", "start"], ["MISSING_REQUIRED", "end"]]);
  });

  it("accepts start and end from a cell that holds both, and needs them otherwise", () => {
    const text = "Kurs;Ämne;Dag;Från;Till\n7A;Ma;Mån;08:10;09:00";
    const plain = applyMapping(block(text), "scheduleLessons", assign("group", "subject", "day", "start", "end"));
    expect(plain.ok).toBe(true);
    expect(plain.headers).toEqual(["Klass/grupp", "Ämne", "Dag", "Start", "Slut"]);
  });

  it("refuses a field on two columns, naming both, and never takes the first", () => {
    const done = applyMapping(block("A;B\n1;2"), "classes", assign("name", "name"));
    expect(done.problems).toEqual([{ code: "DUPLICATE_TARGET", field: "name", columns: ["A", "B"] }]);
    expect(done.rows).toEqual([]);
  });

  it("refuses two fields that read the same cells, and a field that is not the kind's", () => {
    const conflict = applyMapping(b, "scheduleLessons", assign("group", "subject", "teacherList", "teacher", "day", "timeRange", "start"));
    expect(conflict.problems.map((p) => [p.code, p.field, p.other])).toEqual(expect.arrayContaining([["FIELDS_CONFLICT", "timeRange", "start"], ["FIELDS_CONFLICT", "teacherList", "teacher"]]));
    const unknown = applyMapping(block("A\n1"), "rooms", assign("groupName"));
    expect(unknown.problems).toEqual([{ code: "UNKNOWN_FIELD", field: "groupName" }, { code: "MISSING_REQUIRED", field: "name" }]);
  });

  it("holds a row back when a combined cell does not split, and says what to write", () => {
    const done = applyMapping(block("Kurs;Ped;Tid;Dag;Ämne\n7A;A;lunchtid;Mån;Ma\n7B;B, C, D;08:10-09:00;Tis;Sv\n7C;E;8.10 - 9.00;Ons;En"), "scheduleLessons", assign("group", "teacherList", "timeRange", "day", "subject"));
    expect(done.rowProblems.map((p) => [p.row, p.code])).toEqual([[2, "TIME_RANGE_UNREADABLE"], [3, "TOO_MANY_TEACHERS"]]);
    expect(done.rowProblems[0]!.message).toContain("08:10–09:00");
    expect(done.rowProblems[1]!.message).toContain("3 lärare");
    expect(done.rows).toEqual([["7C", "En", "Ons", "8.10", "9.00", "E", ""]]);
  });

  it("reads a cell that is empty as two empty cells, for the reader to name", () => {
    const done = applyMapping(block("K;Ped;Tid;D;Ä\n7A;;;Mån;Ma"), "scheduleLessons", assign("group", "teacherList", "timeRange", "day", "subject"));
    expect(done.rows[0]!.slice(-4)).toEqual(["", "", "", ""]);
    expect(done.ok).toBe(true);
  });

  it("reports an unterminated quote and cells right of the header as warnings, and a replacement character in a kept cell", () => {
    const warn = applyMapping(block('A;B\n1;"open\n2;3'), "classes", assign("name", null));
    expect(warn.warnings.map((w) => w.code)).toEqual(["UNTERMINATED_QUOTE"]);
    const wide = applyMapping(block("A\n1;x;y"), "classes", assign("name"));
    expect(wide.warnings).toEqual([{ code: "CELLS_RIGHT_OF_HEADER", rows: [2] }]);
    const broken = applyMapping(block("A\nAn�a"), "classes", assign("name"));
    expect(broken.warnings).toEqual([{ code: "REPLACEMENT_CHARACTER", rows: [2] }]);
  });

  it("caps the row problems it names and counts the rest", () => {
    // Fewer than half of the column's cells, so the column is read and the rows are held back one by one.
    const rows = [...Array.from({ length: 250 }, () => "Sal;19800101-1234"), ...Array.from({ length: 300 }, () => "Sal;Hus A")].join("\n");
    const done = applyMapping(block(`Namn;Byggnad\n${rows}`), "rooms", assign("name", "building"));
    expect(done.rowProblems).toHaveLength(200);
    expect(done.hiddenRowProblems).toBe(50);
  });
});

describe("a teacher list with a long run of spaces", () => {
  it("is split in time linear in its length, so that a pasted cell cannot freeze the page", () => {
    const cell = `ABC${" ".repeat(100_000)}DEF och GHI`;
    const t0 = performance.now();
    const done = applyMapping(block(`Kurs;Fack;Ped;Tid;Dag\n7A;Mat;"${cell}";08:10-09:00;Mån\n`), "scheduleLessons", assign("group", "subject", "teacherList", "timeRange", "day"));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(done.ok).toBe(true);
    expect(done.rows[0]!.slice(5)).toEqual([`ABC${" ".repeat(100_000)}DEF`, "GHI"]);
  });
});

describe("what a template may hold of a header", () => {
  it("keeps a key to the gateway's hundred characters, unique under a cut, and names no header that is a number once its punctuation is gone", () => {
    const long = "Schema för klass sjuA höstterminen tjugohundratjugosex ".repeat(4);
    const keys = keysOf([long, `${long}x`, "Kurs"]);
    expect(keys.map((key) => key.length)).toEqual([100, 100 + "#2".length, 4]);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]{1,100}(#[0-9]{1,3})?$/);
    expect(new Set(keys).size).toBe(3);
    const b = block("Kurs;19800101(1234)\nA;x\n");
    expect(placementsOf(b, "scheduleLessons", ["group", "block"]).map((post) => [post.key, post.label])).toEqual([["kurs", "Kurs"], ["kolumn2", ""]]);
  });
});

describe("a saved template", () => {
  const template = (over: Partial<MappingTemplate> & Pick<MappingTemplate, "placements">): MappingTemplate => ({
    id: "t1",
    kind: "scheduleLessons",
    name: "Höstens tabell",
    headerRow: null,
    ...over,
  });
  const post = (key: string, field: string | null) => ({ key, label: key, field });
  const table = readTable("Kurs;Ped;Rum;Dag;Tid\n7A;ABC;A1;Mån;08:10-09:00");
  const mall = template({ placements: [post("kurs", "group"), post("ped", "teacher"), post("rum", "room"), post("dag", "day"), post("tid", "timeRange")] });

  it("fits a file with exactly its columns, in any order, spelt in any case", () => {
    const shuffled = readTable("TID;rum;Kurs;PED;Dag\n08:10-09:00;A1;7A;ABC;Mån");
    const found = recognise(shuffled, "scheduleLessons", [mall])!;
    expect(found.template?.id).toBe("t1");
    expect(found.reason).toBe("exact");
    expect(found.assignment).toEqual(["timeRange", "room", "group", "teacher", "day"]);
  });

  it("fits a file with more columns, applies to those it knows and leaves the others unplaced", () => {
    const more = readTable("Kurs;Ped;Rum;Dag;Tid;Ny kolumn\n7A;ABC;A1;Mån;08:10-09:00;x");
    const found = recognise(more, "scheduleLessons", [mall])!;
    expect(found.reason).toBe("subset");
    expect(found.assignment).toEqual(["group", "teacher", "room", "day", "timeRange", undefined]);
    expect(applyMapping(found.block, "scheduleLessons", found.assignment).unplaced).toEqual([{ index: 5, label: "Ny kolumn" }]);
  });

  it("is only offered, not applied, when the file lacks a column it expects", () => {
    const less = readTable("Kurs;Ped;Rum;Dag\n7A;ABC;A1;Mån");
    const found = recognise(less, "scheduleLessons", [mall])!;
    expect(found.template).toBeNull();
    expect(found.offered.map((o) => [o.template.id, o.missing])).toEqual([["t1", ["tid"]]]);
    // Nothing is placed by it; the importer's own spellings still place what they know.
    expect(found.assignment).toEqual([undefined, undefined, undefined, "day"]);
  });

  it("is looked for on the row the user names, and on that row alone, whatever row a template was made for", () => {
    const titled = readTable("Schema hösten\n\nKurs;Ped;Rum;Dag;Tid\n7A;ABC;A1;Mån;08:10-09:00");
    const forThree = template({ headerRow: 3, placements: mall.placements });
    // The user says the headers stand on row 3: the template for row 3 fits.
    expect(recognise(titled, "scheduleLessons", [forThree], 3)!.template?.id).toBe("t1");
    // The user says row 1: the template for row 3 is not tried, and the importer's own spellings place what they know.
    const first = recognise(titled, "scheduleLessons", [forThree], 1)!;
    expect(first.block.headerRowNumber).toBe(1);
    expect(first.template).toBeNull();
    // A template for no particular row is for the first row with content, and for no other.
    expect(recognise(titled, "scheduleLessons", [mall], 3)!.template).toBeNull();
    expect(recognise(titled, "scheduleLessons", [template({ placements: [post("schemahosten", "group")] })], 1)!.template?.id).toBe("t1");
    expect(recognise(titled, "scheduleLessons", [forThree], 7)).toBeNull();
  });

  it("shows the row a template is offered on, when no template fits on any row", () => {
    const titled = readTable("Schema hösten\n\nKurs;Ped;Rum;Dag\n7A;ABC;A1;Mån");
    const partial = template({ headerRow: 3, placements: mall.placements });
    const found = recognise(titled, "scheduleLessons", [partial])!;
    expect(found.block.headerRowNumber).toBe(3);
    expect(found.template).toBeNull();
    expect(found.offered.map((o) => [o.template.id, o.missing])).toEqual([["t1", ["tid"]]]);
  });

  it("is not offered when the file has none of its columns", () => {
    expect(recognise(readTable("X;Y\n1;2"), "scheduleLessons", [mall])!.offered).toEqual([]);
  });

  it("takes the one that places most of the file's columns, and none when two tie", () => {
    const wider = template({ id: "t2", name: "Bredare", placements: [...mall.placements, post("anteckning", null)] });
    const file = readTable("Kurs;Ped;Rum;Dag;Tid;Anteckning\n7A;ABC;A1;Mån;08:10-09:00;x");
    expect(recognise(file, "scheduleLessons", [mall, wider])!.template?.id).toBe("t2");
    const twin = template({ id: "t3", name: "Tvilling", placements: mall.placements });
    const tie = recognise(table, "scheduleLessons", [mall, twin])!;
    expect(tie.template).toBeNull();
    expect(tie.ambiguous.map((entry) => entry.id).sort()).toEqual(["t1", "t3"]);
  });

  it("ignores a template of another kind, and one with no posts", () => {
    expect(recognise(table, "students", [mall])!.template).toBeNull();
    expect(recognise(table, "scheduleLessons", [template({ id: "t0", placements: [] })])!.template).toBeNull();
    expect(matchTemplates(block("A\n1"), [template({ placements: [] })])).toMatchObject({ template: null, ambiguous: [] });
  });

  it("finds its header row when a title lies above the headers", () => {
    const titled = readTable("Schema hösten\n\nKurs;Ped;Rum;Dag;Tid\n7A;ABC;A1;Mån;08:10-09:00");
    const found = recognise(titled, "scheduleLessons", [template({ headerRow: 3, placements: mall.placements })])!;
    expect(found.block.headerRowNumber).toBe(3);
    expect(found.template?.id).toBe("t1");
    // A template for the first row is not looked for on row 3, and one for row 3 is not applied to the first row.
    expect(recognise(titled, "scheduleLessons", [mall])!.template).toBeNull();
  });

  it("keeps a skipped column skipped, so that it is not named as new next time", () => {
    const skipping = template({ placements: [post("kurs", "group"), post("anteckning", null)] });
    const found = recognise(readTable("Kurs;Anteckning\n7A;x"), "scheduleLessons", [skipping])!;
    expect(found.assignment).toEqual(["group", null]);
    expect(describeColumns(found.block, "scheduleLessons", found.assignment).map((s) => s.status)).toEqual(["placed", "skipped"]);
  });

  it("is made from a mapping: a post for every column that was said something about, and none for the others", () => {
    const b = block("Kurs;Ped;Anteckning;Okänd\n7A;ABC;x;y");
    const posts = placementsOf(b, "scheduleLessons", assign("group", "teacher", null, undefined));
    expect(posts).toEqual([{ key: "kurs", label: "Kurs", field: "group" }, { key: "ped", label: "Ped", field: "teacher" }, { key: "anteckning", label: "Anteckning", field: null }]);
    expect(templateAssignment(b, template({ placements: posts }))).toEqual(["group", "teacher", null, undefined]);
  });

  it("never holds a header that has the shape of a number, nor reads anything from its column", () => {
    const b = block("Namn;19800101-1234;Pnr;Klass\nAnna;a;19800101-1234;7A");
    const posts = placementsOf(b, "students", assign("firstName", "lastName", "email", "className"));
    expect(JSON.stringify(posts)).not.toMatch(/19800101/);
    expect(posts.filter((p) => p.key === "kolumn2")).toEqual([{ key: "kolumn2", label: "", field: null }]);
    expect(posts.find((p) => p.key === "pnr")).toEqual({ key: "pnr", label: "Pnr", field: null });
  });
});

describe("what the user is shown", () => {
  it("is up to three filled cells of each column, and none of a personnummer column", () => {
    const b = block("Namn;Pnr\nAnna;19800101-1234\n;19800101-1235\nBo;x\nCarl;y\nDan;z");
    const states = describeColumns(b, "students", assign(undefined, undefined));
    expect(states[0]!.sample).toEqual(["Anna", "Bo", "Carl"]);
    expect(states[1]).toMatchObject({ status: "personalNumber", sample: [] });
  });

  it("has an entry for every field of the kind that a placed column fills", () => {
    const required = FIELDS.scheduleLessons.filter((f) => f.required).length;
    expect(required).toBe(5);
  });
});
