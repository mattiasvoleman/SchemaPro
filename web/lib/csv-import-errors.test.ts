/**
 * What the import dialog says about a file it will not send, and how it reads
 * the bytes a school's file arrives in.
 *
 * Each message names the row as Excel numbers it (the header is row 1), the
 * column as the file spells it, the cell, and what the column takes. The
 * cells here are the ones the gateway's ValidationPipe refuses — an e-mail
 * without a domain, a colour that is no hex colour, a name longer than its
 * column — which used to reach it and come back as one English 400 for the
 * whole file, with no row in it.
 */
import { describe, expect, it } from "vitest";
import {
  decodeCsvBytes,
  fileProblems,
  mapClassRows,
  mapMembershipRows,
  mapRequirementRows,
  mapRoomRows,
  mapRoomTypeRows,
  mapStudentRows,
  mapSubjectRows,
  mapTeacherDutyRows,
  mapTeacherQualificationRows,
  mapTeacherRows,
  parseCsv,
} from "@/lib/csv";
import { mapTimplanRows } from "@/lib/timplan-csv";

const file = (...lines: string[]) => parseCsv(`﻿${lines.join("\r\n")}\r\n`);
const LONG_61 = "x".repeat(61);

describe("cells the gateway would refuse are refused here, by row and column", () => {
  it.each([
    [
      "an e-mail address without a domain (elever)",
      () => mapStudentRows(file("fornamn;efternamn;epost;klass", "Alma;Berg;alma.berg@;7A")),
      'Rad 2: epost "alma.berg@" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a class name longer than the column (elever)",
      () => mapStudentRows(file("fornamn;efternamn;epost;klass", `Alma;Berg;alma@skola.se;${LONG_61}`)),
      "Rad 2: klass är 61 tecken lång, men får vara högst 60.",
    ],
    [
      "a first name longer than the column (lärare)",
      () => mapTeacherRows(file("fornamn;efternamn;epost", `${"Å".repeat(121)};Ek;karin@skola.se`)),
      "Rad 2: fornamn är 121 tecken lång, men får vara högst 120.",
    ],
    [
      "a space in an e-mail address (lärare)",
      () => mapTeacherRows(file("fornamn;efternamn;epost", "Karin;Ek;karin ek@skola.se")),
      'Rad 2: epost "karin ek@skola.se" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a colour that is no hex colour (ämnen)",
      () => mapSubjectRows(file("namn;kod;farg", "Bild;BL;blå")),
      'Rad 2: farg "blå" är ingen färgkod. Skriv den som #4f46e5, eller lämna cellen tom.',
    ],
    [
      "a code longer than the column (ämnen)",
      () => mapSubjectRows(file("namn;kod", `Bild;${"B".repeat(21)}`)),
      "Rad 2: kod är 21 tecken lång, men får vara högst 20.",
    ],
    [
      "a salstyp name longer than the column (salstyper)",
      () => mapRoomTypeRows(file("namn", LONG_61)),
      "Rad 2: namn är 61 tecken lång, men får vara högst 60.",
    ],
    [
      "a pupil written as a name instead of an address (undervisningsgrupper)",
      () => mapMembershipRows(file("grupp;epost", "Ma71;Alma Berg")),
      'Rad 2: epost "Alma Berg" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a co-teacher without a top-level domain (timplansposter)",
      () =>
        mapRequirementRows(
          file("grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare;medlarare", "7A;MA;3;60;karin@skola.se;bo@skola"),
        ),
      'Rad 2: medlarare "bo@skola" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a teacher address with two @ (behörigheter)",
      () =>
        mapTeacherQualificationRows(
          file("larare_epost;amne;fran_arskurs;till_arskurs;behorighet", "karin@ek@skola.se;MA;7;9;legitimation"),
        ),
      'Rad 2: larare_epost "karin@ek@skola.se" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a group name longer than the column (uppdrag)",
      () =>
        mapTeacherDutyRows(
          file("larare_epost;typ;benamning;minuter_per_vecka;grupp", `karin@skola.se;mentor;Mentor;60;${LONG_61}`),
        ),
      "Rad 2: grupp är 61 tecken lång, men får vara högst 60.",
    ],
    [
      "a subject longer than the column (lokal timplan)",
      () => mapTimplanRows(file("amne;arskurs;minuter_per_vecka", `${"M".repeat(121)};7;120`)),
      "Rad 2: amne är 121 tecken lång, men får vara högst 120.",
    ],
  ])("%s", (_case, map, message) => {
    const { rows, errors } = map();
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 2, message }]);
  });

  it("names the row the problem is on, and keeps the rows around it", () => {
    const { rows, errors } = mapStudentRows(
      file("fornamn;efternamn;epost;klass", "Alma;Berg;alma@skola.se;7A", "Bo;Ek;bo@skola;7A", "Ida;Ek;ida@skola.se;"),
    );
    expect(errors).toEqual([
      { row: 3, message: 'Rad 3: epost "bo@skola" är inte en e-postadress. Skriv den som namn@skolan.se.' },
    ]);
    expect(rows.map((row) => row.firstName)).toEqual(["Alma", "Ida"]);
  });

  it("lets through the addresses the gateway takes: å, ä and ö before the @, a plus, an apostrophe", () => {
    const { errors } = mapStudentRows(
      file("fornamn;efternamn;epost;klass", "Noah;Sjö;noah.sjö.7b@skola.se;7B", "Liv;Ek;liv+7a@skola.se;7A", "Sean;O'Brien;o'brien@skola.se;7A"),
    );
    expect(errors).toEqual([]);
  });
});

describe("klasser.csv's typ, halvklass_av and ersatter_amne", () => {
  const groups = (...lines: string[]) => mapClassRows(file("namn;arskurs;typ;halvklass_av;ersatter_amne", ...lines));

  it.each([
    [
      "a typ it does not know",
      "Ma71;;nivågrupp;;",
      'Rad 2: typ "nivågrupp" känns inte igen. Skriv "klass" eller "undervisningsgrupp", eller lämna cellen tom för en klass.',
    ],
    [
      "a half said to be a class",
      "7A:1;7;klass;7A;",
      'Rad 2: en halvklass är en undervisningsgrupp, men typ säger "klass". Skriv "undervisningsgrupp", eller lämna halvklass_av tom.',
    ],
    [
      "a class that replaces a subject",
      "7A;7;;;SV",
      'Rad 2: bara en undervisningsgrupp kan ersätta ett ämne, men typ säger "klass". Skriv "undervisningsgrupp" i typ, eller lämna ersatter_amne tom.',
    ],
    [
      "a half that replaces a subject",
      "7A:1;7;undervisningsgrupp;7A;SV",
      "Rad 2: en halvklass är en del av klassen och ersätter inget ämne. Lämna ersatter_amne tom.",
    ],
    ["a name longer than the column", `${LONG_61};7;;;`, "Rad 2: namn är 61 tecken lång, men får vara högst 60."],
  ])("refuses %s", (_case, line, message) => {
    expect(groups(line)).toEqual({ rows: [], errors: [{ row: 2, message }], rowNumbers: [] });
  });

  it("reads a half with typ left empty as the teaching group a half is", () => {
    expect(groups("7A:1;7;;7A;").rows).toEqual([{ name: "7A:1", gradeLevel: 7, kind: "TEACHING_GROUP", halfOf: "7A" }]);
  });

  it("reads the typ as a person writes it", () => {
    expect(groups("A;;Klass;;", "B;;Undervisningsgrupp;;", "C;;GRUPP;;").rows.map((row) => row.kind)).toEqual([
      "CLASS",
      "TEACHING_GROUP",
      "TEACHING_GROUP",
    ]);
  });

  it("posts a class list of namn and arskurs exactly as it always did", () => {
    expect(mapClassRows(file("namn;arskurs", "7A;7", "7B;")).rows).toStrictEqual([
      { name: "7A", gradeLevel: 7 },
      { name: "7B" },
    ]);
  });
});

describe("decodeCsvBytes", () => {
  /** Bytes from hex, so no code page of the platform's own builds the files the decoder is tested on. */
  const hex = (text: string) => Uint8Array.from(text.match(/[0-9a-f]{2}/gi)!.map((byte) => parseInt(byte, 16)));
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

  it("reads UTF-8, with or without a BOM, and says so", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("namn\r\nSlöjd\r\n"))).toEqual({
      text: "namn\r\nSlöjd\r\n",
      encoding: "utf-8",
      problem: null,
    });
    expect(parseCsv(decodeCsvBytes(new TextEncoder().encode("\uFEFFnamn\r\nSlöjd\r\n")).text).rows).toEqual([["Slöjd"]]);
  });

  it("reads what Excel saves as CSV (semikolonavgränsad): Windows-1252", () => {
    // Read as UTF-8 — File.text(), before — this was "Textilsl\uFFFDjd".
    // "Textilslöjd;Åk 7 – Kök": ö F6, Å C5, – 96.
    const bytes = hex(`${ascii("Textilsl")}f6${ascii("jd;")}c5${ascii("k 7 ")}96${ascii(" K")}f6${ascii("k")}`);
    expect(new TextDecoder().decode(bytes)).toContain("\uFFFD");
    expect(decodeCsvBytes(bytes)).toMatchObject({ text: "Textilslöjd;Åk 7 – Kök", encoding: "windows-1252" });
  });

  it("reads what Excel for Mac saved as CSV: Mac Roman", () => {
    // "Bäck;Åsa\r\nStröm;Öst" in Mac Roman: ä 8A, Å 81, ö 9A, Ö 85.
    expect(decodeCsvBytes(hex(`${ascii("B")}8a${ascii("ck;")}81${ascii("sa")}0d0a${ascii("Str")}9a${ascii("m;")}85${ascii("st")}`))).toMatchObject({
      text: "Bäck;Åsa\r\nStröm;Öst",
      encoding: "macintosh",
    });
  });

  // The reviewer's cases (granskning-260, M3): a notes column of dashes and
  // curly quotes outnumbering the names' å, ä and ö tipped a byte count.
  const NOTE_1252 = `c5${ascii("k 7")}96${ascii("9 ")}96${ascii(" ")}94${ascii("klar")}94`;
  const NOTE_MAC = `81${ascii("k 7")}d0${ascii("9 ")}d0${ascii(" ")}d3${ascii("klar")}d3`;
  const notes = (note: string, name: string, rows: number) =>
    hex([ascii("namn;anteckning"), ...Array.from({ length: rows }, () => `${ascii("E;")}${note}`), `${name}${ascii(";ok")}`].join("0d0a"));

  it.each([2, 5, 20])("reads Windows-1252 with %i rows of “Åk 7–9 – ”klar”” notes as Windows-1252", (rows) => {
    const decoded = decodeCsvBytes(notes(NOTE_1252, `c5${ascii("ke")}`, rows));
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.text.endsWith("Åke;ok")).toBe(true);
    expect(decoded.text).toContain("Åk 7–9 – ”klar”");
  });

  it.each([2, 5, 20])("reads Mac Roman with %i rows of the same notes as Mac Roman", (rows) => {
    const decoded = decodeCsvBytes(notes(NOTE_MAC, `81${ascii("ke")}`, rows));
    expect(decoded.encoding).toBe("macintosh");
    expect(decoded.text.endsWith("Åke;ok")).toBe(true);
    expect(decoded.text).toContain("Åk 7–9 – ”klar”");
  });

  it("reads a Mac Roman file whose only letters beyond ASCII are Æ and Ø", () => {
    // "Ærø;Øberg": Æ AE, ø BF, Ø AF — a range the byte count never looked at.
    expect(decodeCsvBytes(hex(`ae${ascii("r")}bf${ascii(";")}af${ascii("berg")}`))).toMatchObject({
      text: "Ærø;Øberg",
      encoding: "macintosh",
    });
  });

  it("refuses UTF-16 (Excel's Unicode-text) with what to save it as instead", () => {
    const utf16 = hex(`fffe${ascii("namn").split(/(..)/).filter(Boolean).map((byte) => `${byte}00`).join("")}`);
    expect(decodeCsvBytes(utf16)).toMatchObject({ text: "", encoding: "utf-16", problem: expect.stringContaining("CSV UTF-8") });
  });

  it("refuses Excel's CSV (MS-DOS), code page 850, rather than reading its å, ä and ö wrong", () => {
    // "Åsa;Öberg\r\nMärta;Ström" in code page 850: Å 8F, Ö 99, ä 84, ö 94.
    const bytes = hex(`8f${ascii("sa;")}99${ascii("berg")}0d0a${ascii("M")}84${ascii("rta;Str")}94${ascii("m")}`);
    expect(decodeCsvBytes(bytes)).toMatchObject({ text: "", encoding: "cp850", problem: expect.stringContaining("MS-DOS") });
  });

  it("keeps a UTF-8 file with a stray byte UTF-8, losing that byte and not every å", () => {
    const utf8 = new TextEncoder().encode("namn\r\nSlöjd\r\nÅsa\r\nÄmne\r\n");
    const damaged = new Uint8Array([...utf8, 0xff, 0x0d, 0x0a]);
    expect(decodeCsvBytes(damaged)).toMatchObject({ text: "namn\r\nSlöjd\r\nÅsa\r\nÄmne\r\n\uFFFD\r\n", encoding: "utf-8" });
  });
});

describe("row numbers as Excel shows them", () => {
  it("count the header as row 1, an empty line as a row, and a cell with a line break as one row", () => {
    const parsed = parseCsv('fornamn;efternamn;epost;klass\r\nAlma;Berg;alma@skola.se;7A\r\n\r\n"Bo\r\nBertil";Ek;bo@skola;7A\r\nIda;Ek;ida@skola.se;\r\n');
    expect(parsed.rowNumbers).toEqual([2, 4, 5]);
    expect(mapStudentRows(parsed)).toMatchObject({
      errors: [{ row: 4, message: 'Rad 4: epost "bo@skola" är inte en e-postadress. Skriv den som namn@skolan.se.' }],
      rowNumbers: [2, 5],
    });
  });
});

describe("what the file itself says is wrong", () => {
  it("reports a quote that never closes, on the row it opened on", () => {
    const parsed = parseCsv('namn\r\nAula\r\n"Slöjdsal\r\nMusiksal\r\n');
    expect(fileProblems(parsed)).toEqual([
      {
        row: 3,
        message:
          "Rad 3: ett citattecken öppnas men stängs aldrig, så resten av filen blev en enda cell. Lägg till det avslutande citattecknet, eller ta bort det inledande.",
      },
    ]);
  });

  it("reports cells right of the header, as an unquoted decimal comma in a comma file leaves them", () => {
    const parsed = parseCsv("fornamn,efternamn,epost,tjanst_procent\r\nAnna,Ek,anna@skola.se,66,667\r\n");
    expect(parsed.rows[0]![3]).toBe("66");
    expect(fileProblems(parsed)).toEqual([
      {
        row: 2,
        message:
          "Rad 2: raden har fler celler än rubrikraden har kolumner. Står ett tal med decimalkomma i en kommaavgränsad fil måste det stå inom citattecken, eller sparas filen med semikolon.",
      },
    ]);
  });

  it("reads a tab-separated table as one, copied out of a text editor or a spreadsheet", () => {
    const parsed = parseCsv("namn\tkod\r\nSal A1\tA1\r\n");
    expect(parsed).toMatchObject({ delimiter: "\t", headers: ["namn", "kod"], rows: [["Sal A1", "A1"]] });
  });
});

describe("numbers read the same in every column", () => {
  it.each([
    ["lektioner_per_vecka", "3,0", { lessonsPerWeek: 3 }],
    ["lektioner_per_vecka", "3.0", { lessonsPerWeek: 3 }],
    ["larare_procent", "50,0", { teacherLoadPercent: 50 }],
    ["larare_procent", "50 %", { teacherLoadPercent: 50 }],
  ])("reads %s %j", (column, value, expected) => {
    const csv = `grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare_procent\r\n7A;MA;${column === "lektioner_per_vecka" ? value : "3"};60;${column === "larare_procent" ? value : ""}\r\n`;
    const { rows, errors } = mapRequirementRows(parseCsv(csv));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject(expected);
  });

  it.each(["12,5 %", "12.5", "12,5"])("reads nedsattning_procent %j as 12.5", (value) => {
    const { rows, errors } = mapTeacherRows(
      parseCsv(`fornamn;efternamn;epost;tjanst_procent;nedsattning_procent\r\nKarin;Ek;karin@skola.se;100 %;${value}\r\n`),
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ employmentPercent: 100, reductionPercent: 12.5 });
  });

  it.each(["0x3", "1e0", "3,5", "-3", "1 000"])("refuses lektioner_per_vecka %j, which Number() would have read", (value) => {
    const { errors } = mapRequirementRows(parseCsv(`grupp;amne;lektioner_per_vecka;minuter_per_lektion\r\n7A;MA;${value};60\r\n`));
    expect(errors).toEqual([{ row: 2, message: `Rad 2: lektioner_per_vecka "${value}" är inte ett heltal mellan 1 och 40.` }]);
  });
});

describe("salar.csv", () => {
  const rooms = (...lines: string[]) =>
    mapRoomRows(file("namn;kod;salstyp;kapacitet;lagsta_arskurs;hogsta_arskurs;byggnad;vaning", ...lines));

  it.each([
    ["a capacity of none", "Sal;;;0;;;;", 'Rad 2: kapacitet "0" är inte ett heltal mellan 1 och 10000.'],
    ["a floor below the deepest", "Sal;;;;;;;-6", 'Rad 2: vaning "-6" är inte ett heltal mellan -5 och 50.'],
    ["a span that runs backwards", "Sal;;;;9;7;;", "Rad 2: lagsta_arskurs (9) är högre än hogsta_arskurs (7)."],
    ["a code longer than the column", `Sal;${"K".repeat(21)};;;;;;`, "Rad 2: kod är 21 tecken lång, men får vara högst 20."],
    ["a name missing", ";A1;;;;;;", 'Rad 2: kolumnen "namn" är tom.'],
  ])("refuses %s", (_case, line, message) => {
    expect(rooms(line)).toEqual({ rows: [], errors: [{ row: 2, message }], rowNumbers: [] });
  });

  it("reads a basement floor, written with Excel's minus too, and empty cells as nothing", () => {
    expect(rooms("Arkivet;;;;;;Hus C;\u22121", "Aula;;;;;;;").rows).toEqual([
      { name: "Arkivet", code: null, roomType: null, capacity: null, minGradeLevel: null, maxGradeLevel: null, building: "Hus C", floor: -1 },
      { name: "Aula", code: null, roomType: null, capacity: null, minGradeLevel: null, maxGradeLevel: null, building: null, floor: null },
    ]);
  });
});

