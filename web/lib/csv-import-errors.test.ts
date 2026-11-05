/**
 * What the import dialog says about a file it will not send, and how it reads
 * the bytes a school's file arrives in.
 *
 * Each message names the row (1 is the first row below the headers), the
 * column as the file spells it, the cell, and what the column takes. The
 * cells here are the ones the gateway's ValidationPipe refuses — an e-mail
 * without a domain, a colour that is no hex colour, a name longer than its
 * column — which used to reach it and come back as one English 400 for the
 * whole file, with no row in it.
 */
import { describe, expect, it } from "vitest";
import {
  decodeCsvBytes,
  mapClassRows,
  mapMembershipRows,
  mapRequirementRows,
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
      'Rad 1: epost "alma.berg@" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a class name longer than the column (elever)",
      () => mapStudentRows(file("fornamn;efternamn;epost;klass", `Alma;Berg;alma@skola.se;${LONG_61}`)),
      "Rad 1: klass är 61 tecken lång, men får vara högst 60.",
    ],
    [
      "a first name longer than the column (lärare)",
      () => mapTeacherRows(file("fornamn;efternamn;epost", `${"Å".repeat(121)};Ek;karin@skola.se`)),
      "Rad 1: fornamn är 121 tecken lång, men får vara högst 120.",
    ],
    [
      "a space in an e-mail address (lärare)",
      () => mapTeacherRows(file("fornamn;efternamn;epost", "Karin;Ek;karin ek@skola.se")),
      'Rad 1: epost "karin ek@skola.se" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a colour that is no hex colour (ämnen)",
      () => mapSubjectRows(file("namn;kod;farg", "Bild;BL;blå")),
      'Rad 1: farg "blå" är ingen färgkod. Skriv den som #4f46e5, eller lämna cellen tom.',
    ],
    [
      "a code longer than the column (ämnen)",
      () => mapSubjectRows(file("namn;kod", `Bild;${"B".repeat(21)}`)),
      "Rad 1: kod är 21 tecken lång, men får vara högst 20.",
    ],
    [
      "a salstyp name longer than the column (salstyper)",
      () => mapRoomTypeRows(file("namn", LONG_61)),
      "Rad 1: namn är 61 tecken lång, men får vara högst 60.",
    ],
    [
      "a pupil written as a name instead of an address (undervisningsgrupper)",
      () => mapMembershipRows(file("grupp;epost", "Ma71;Alma Berg")),
      'Rad 1: epost "Alma Berg" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a co-teacher without a top-level domain (timplansposter)",
      () =>
        mapRequirementRows(
          file("grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare;medlarare", "7A;MA;3;60;karin@skola.se;bo@skola"),
        ),
      'Rad 1: medlarare "bo@skola" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a teacher address with two @ (behörigheter)",
      () =>
        mapTeacherQualificationRows(
          file("larare_epost;amne;fran_arskurs;till_arskurs;behorighet", "karin@ek@skola.se;MA;7;9;legitimation"),
        ),
      'Rad 1: larare_epost "karin@ek@skola.se" är inte en e-postadress. Skriv den som namn@skolan.se.',
    ],
    [
      "a group name longer than the column (uppdrag)",
      () =>
        mapTeacherDutyRows(
          file("larare_epost;typ;benamning;minuter_per_vecka;grupp", `karin@skola.se;mentor;Mentor;60;${LONG_61}`),
        ),
      "Rad 1: grupp är 61 tecken lång, men får vara högst 60.",
    ],
    [
      "a subject longer than the column (lokal timplan)",
      () => mapTimplanRows(file("amne;arskurs;minuter_per_vecka", `${"M".repeat(121)};7;120`)),
      "Rad 1: amne är 121 tecken lång, men får vara högst 120.",
    ],
  ])("%s", (_case, map, message) => {
    const { rows, errors } = map();
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 1, message }]);
  });

  it("names the row the problem is on, and keeps the rows around it", () => {
    const { rows, errors } = mapStudentRows(
      file("fornamn;efternamn;epost;klass", "Alma;Berg;alma@skola.se;7A", "Bo;Ek;bo@skola;7A", "Ida;Ek;ida@skola.se;"),
    );
    expect(errors).toEqual([
      { row: 2, message: 'Rad 2: epost "bo@skola" är inte en e-postadress. Skriv den som namn@skolan.se.' },
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
      'Rad 1: typ "nivågrupp" känns inte igen. Skriv "klass" eller "undervisningsgrupp", eller lämna cellen tom för en klass.',
    ],
    [
      "a half said to be a class",
      "7A:1;7;klass;7A;",
      'Rad 1: en halvklass är en undervisningsgrupp, men typ säger "klass". Skriv "undervisningsgrupp", eller lämna halvklass_av tom.',
    ],
    [
      "a class that replaces a subject",
      "7A;7;;;SV",
      'Rad 1: bara en undervisningsgrupp kan ersätta ett ämne, men typ säger "klass". Skriv "undervisningsgrupp" i typ, eller lämna ersatter_amne tom.',
    ],
    [
      "a half that replaces a subject",
      "7A:1;7;undervisningsgrupp;7A;SV",
      "Rad 1: en halvklass är en del av klassen och ersätter inget ämne. Lämna ersatter_amne tom.",
    ],
    ["a name longer than the column", `${LONG_61};7;;;`, "Rad 1: namn är 61 tecken lång, men får vara högst 60."],
  ])("refuses %s", (_case, line, message) => {
    expect(groups(line)).toEqual({ rows: [], errors: [{ row: 1, message }] });
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
  const cp1252 = (text: string) => {
    const decoder = new TextDecoder("windows-1252");
    const byChar = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) byChar.set(decoder.decode(new Uint8Array([byte])), byte);
    return Uint8Array.from([...text].map((char) => byChar.get(char)!));
  };

  it("reads UTF-8, with or without a BOM", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("namn\r\nSlöjd\r\n"))).toBe("namn\r\nSlöjd\r\n");
    expect(parseCsv(decodeCsvBytes(new TextEncoder().encode("﻿namn\r\nSlöjd\r\n"))).rows).toEqual([["Slöjd"]]);
  });

  it("reads what Excel saves as CSV (semikolonavgränsad): Windows-1252", () => {
    // Read as UTF-8 — File.text(), before — this was "Textilsl�jd".
    const bytes = cp1252("namn;salstyp\r\nTextilslöjd;Textilslöjdsal\r\nÅk 7 – Hemkunskap;Kök\r\n");
    expect(new TextDecoder().decode(bytes)).toContain("Textilsl�jd");
    expect(parseCsv(decodeCsvBytes(bytes)).rows).toEqual([
      ["Textilslöjd", "Textilslöjdsal"],
      ["Åk 7 – Hemkunskap", "Kök"],
    ]);
  });

  it("reads what Excel for Mac saved as CSV: Mac Roman", () => {
    // å ä ö Å Ä Ö in Mac Roman.
    const bytes = new Uint8Array([0x8c, 0x3b, 0x8a, 0x3b, 0x9a, 0x0d, 0x0a, 0x81, 0x3b, 0x80, 0x3b, 0x85]);
    expect(decodeCsvBytes(bytes)).toBe("å;ä;ö\r\nÅ;Ä;Ö");
  });

  it("keeps a UTF-8 file with a stray byte UTF-8, losing that byte and not every å", () => {
    const utf8 = new TextEncoder().encode("namn\r\nSlöjd\r\nÅsa\r\nÄmne\r\n");
    const damaged = new Uint8Array([...utf8, 0xff, 0x0d, 0x0a]);
    expect(decodeCsvBytes(damaged)).toBe("namn\r\nSlöjd\r\nÅsa\r\nÄmne\r\n�\r\n");
  });
});
