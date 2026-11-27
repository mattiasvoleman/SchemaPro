import { describe, expect, it } from "vitest";
import { MAX_CALENDAR_ROWS, parseDateCell, readCalendarFile } from "@/lib/school-calendar-file";

const ics = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kommunen//Läsårstider//SV", ...events, "END:VCALENDAR", ""].join("\r\n");
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("an ICS file", () => {
  it("reads a whole-day event as ending the day BEFORE its DTEND, as RFC 5545 says", () => {
    const file = readCalendarFile(ics(event("DTSTART;VALUE=DATE:20261026", "DTEND;VALUE=DATE:20261031", "SUMMARY:Höstlov")), "lov.ics");
    expect(file.format).toBe("ICS");
    expect(file.problems).toEqual([]);
    expect(file.entries).toEqual([
      expect.objectContaining({ source: "FILE", name: "Höstlov", kind: "HOLIDAY", startDate: "2026-10-26", endDate: "2026-10-30", minGradeLevel: null, maxGradeLevel: null, origin: "event:1" }),
    ]);
  });

  it("reads an event with no DTEND as one day, and a one-day event whose DTEND is the next day as one day", () => {
    const file = readCalendarFile(
      ics(
        event("DTSTART;VALUE=DATE:20270106", "SUMMARY:Trettondedag jul"),
        event("DTSTART;VALUE=DATE:20270107", "DTEND;VALUE=DATE:20270108", "SUMMARY:Klämdag"),
      ),
      "x.ics",
    );
    expect(file.entries.map((entry) => [entry.name, entry.startDate, entry.endDate])).toEqual([
      ["Trettondedag jul", "2027-01-06", "2027-01-06"],
      ["Klämdag", "2027-01-07", "2027-01-07"],
    ]);
  });

  it("reads a timed event on its own days, and a midnight end as exclusive", () => {
    const file = readCalendarFile(
      ics(
        event("DTSTART:20270301T080000Z", "DTEND:20270301T160000Z", "SUMMARY:Studiedag"),
        event("DTSTART:20270302T000000", "DTEND:20270305T000000", "SUMMARY:Prao"),
      ),
      "x.ics",
    );
    expect(file.entries.map((entry) => [entry.name, entry.startDate, entry.endDate, entry.kind])).toEqual([
      ["Studiedag", "2027-03-01", "2027-03-01", "STAFF_DAY"],
      ["Prao", "2027-03-02", "2027-03-04", "HOLIDAY"],
    ]);
  });

  it("reads a time in UTC on the school's day: a whole day written as Stockholm's midnight in UTC is that day, not the one before", () => {
    const file = readCalendarFile(
      ics(
        // Midnight 26 October to midnight 31 October in Stockholm (CET, UTC+1): höstlov 26-30 October.
        event("DTSTART:20261025T230000Z", "DTEND:20261030T230000Z", "SUMMARY:Höstlov"),
        // One day, 26 March 2027 (CET): Thursday 25 March is a school day and must not be in it.
        event("DTSTART:20270325T230000Z", "DTEND:20270326T230000Z", "SUMMARY:Lov fredag"),
        // One day in summer time (CEST, UTC+2): midnight 26 August is 22:00Z on the 25th.
        event("DTSTART:20260825T220000Z", "DTEND:20260826T220000Z", "SUMMARY:Studiedag"),
        // The night the clock goes forward (28 March 2027): 29 March starts at 22:00Z on the 28th.
        event("DTSTART:20270328T220000Z", "DTEND:20270329T220000Z", "SUMMARY:Annandag påsk"),
        // A time in the evening of the day before in UTC is still the day it says in Stockholm only when it is.
        event("DTSTART:20270301T080000Z", "DTEND:20270301T160000Z", "SUMMARY:Utvecklingsdag"),
      ),
      "x.ics",
    );
    expect(file.entries.map((entry) => [entry.name, entry.startDate, entry.endDate])).toEqual([
      ["Höstlov", "2026-10-26", "2026-10-30"],
      ["Lov fredag", "2027-03-26", "2027-03-26"],
      ["Studiedag", "2026-08-26", "2026-08-26"],
      ["Annandag påsk", "2027-03-29", "2027-03-29"],
      ["Utvecklingsdag", "2027-03-01", "2027-03-01"],
    ]);
  });

  it("unfolds long lines and unescapes the text of a summary", () => {
    const file = readCalendarFile(ics(event("DTSTART;VALUE=DATE:20261224", "SUMMARY:Jullov\\, jul-\r\n afton\; stängt", "DTEND;VALUE=DATE:20261225")), "x.ics");
    expect(file.entries[0]!.name).toBe("Jullov, jul-afton; stängt");
  });

  it("reads LF files and a file whose first line has a byte-order mark", () => {
    const text = `﻿BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261026\nSUMMARY:Höstlov\nEND:VEVENT\nEND:VCALENDAR\n`;
    expect(readCalendarFile(text, "x.ics").entries).toHaveLength(1);
  });

  it("says what it left out: a recurring event, a cancelled one, one with no name and one with a date it cannot read", () => {
    const file = readCalendarFile(
      ics(
        event("DTSTART;VALUE=DATE:20261026", "RRULE:FREQ=YEARLY", "SUMMARY:Höstlov"),
        event("DTSTART;VALUE=DATE:20261102", "STATUS:CANCELLED", "SUMMARY:Studiedag"),
        event("DTSTART;VALUE=DATE:20261103"),
        event("DTSTART;VALUE=DATE:20270230", "SUMMARY:Omöjlig"),
        event("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261105", "SUMMARY:Baklänges"),
        event("DTSTART;VALUE=DATE:20261201", "SUMMARY:Kvar"),
      ),
      "x.ics",
    );
    expect(file.entries.map((entry) => entry.name)).toEqual(["Kvar"]);
    expect(file.problems).toEqual([
      { code: "RECURRING", place: 1, value: "Höstlov" },
      { code: "CANCELLED", place: 2, value: "Studiedag" },
      { code: "NO_NAME", place: 3 },
      { code: "BAD_DATE", place: 4, value: "20270230" },
      { code: "END_BEFORE_START", place: 5, value: "Baklänges" },
    ]);
  });

  it("keeps a term date, unticked-by-default, and a staff day as one", () => {
    const file = readCalendarFile(ics(event("DTSTART;VALUE=DATE:20260817", "SUMMARY:Terminsstart hösttermin"), event("DTSTART;VALUE=DATE:20261013", "SUMMARY:Kompetensdag")), "x.ics");
    expect(file.entries.map((entry) => [entry.looksLikeTermDate ?? false, entry.kind])).toEqual([[true, "HOLIDAY"], [false, "STAFF_DAY"]]);
  });

  it("is told by its name when it has no VCALENDAR, and says so; a text with no events says that", () => {
    expect(readCalendarFile("hej", "lov.ics").problems).toEqual([{ code: "NOT_A_CALENDAR", place: 0 }]);
    expect(readCalendarFile(ics(), "x.ics").problems).toEqual([{ code: "NO_EVENTS", place: 0 }]);
  });

  it("reads at most what the gateway takes in one write, and says how many there were", () => {
    const events = Array.from({ length: MAX_CALENDAR_ROWS + 5 }, (_, n) => event(`DTSTART;VALUE=DATE:2026${String(Math.floor(n / 28) + 1).padStart(2, "0")}${String((n % 28) + 1).padStart(2, "0")}`, `SUMMARY:Lov ${n}`));
    const file = readCalendarFile(ics(...events), "x.ics");
    expect(file.entries).toHaveLength(MAX_CALENDAR_ROWS);
    expect(file.problems).toEqual([{ code: "TOO_MANY", place: 0, value: String(MAX_CALENDAR_ROWS + 5) }]);
  });
});

describe("a CSV file", () => {
  it("reads Swedish headers, a semicolon file and day-first dates, with a row's own place", () => {
    const file = readCalendarFile("Namn;Första dag;Sista dag;Typ\nHöstlov;26.10.2026;30.10.2026;Lov\nStudiedag;2026-11-09;;Studiedag\n", "lov.csv");
    expect(file.format).toBe("CSV");
    expect(file.problems).toEqual([]);
    expect(file.entries.map((entry) => [entry.name, entry.startDate, entry.endDate, entry.kind, entry.origin])).toEqual([
      ["Höstlov", "2026-10-26", "2026-10-30", "HOLIDAY", "row:2"],
      ["Studiedag", "2026-11-09", "2026-11-09", "STAFF_DAY", "row:3"],
    ]);
  });

  it("reads a comma file, a quoted name with a comma in it, and a file with a byte-order mark", () => {
    const file = readCalendarFile('﻿name,start,end\n"Jullov, 2026",2026-12-21,2027-01-06\n', "x.csv");
    expect(file.entries.map((entry) => [entry.name, entry.startDate, entry.endDate])).toEqual([["Jullov, 2026", "2026-12-21", "2027-01-06"]]);
  });

  it("reads the årskurser of a prao week, as a pair", () => {
    const file = readCalendarFile("namn;start;slut;från årskurs;till årskurs\nPrao;2027-02-08;2027-02-12;9;9\nÅk 7-9;2027-02-15;2027-02-15;åk 7;9\n", "x.csv");
    expect(file.entries.map((entry) => [entry.name, entry.minGradeLevel, entry.maxGradeLevel])).toEqual([["Prao", 9, 9], ["Åk 7-9", 7, 9]]);
  });

  it("names the row of every cell it cannot read, and leaves the row out", () => {
    const file = readCalendarFile(
      "namn;start;slut;från årskurs;till årskurs\n;2026-10-26;;;\nA;02/22/2027;;;\nB;2026-10-30;2026-10-26;;\nC;2026-11-02;2026-11-03;9;\nD;2026-11-04;2026-11-04;13;13\nE;2026-11-05;2026-11-05;;\n",
      "x.csv",
    );
    expect(file.entries.map((entry) => entry.name)).toEqual(["E"]);
    expect(file.problems).toEqual([
      { code: "NO_NAME", place: 2 },
      { code: "BAD_DATE", place: 3, value: "02/22/2027" },
      { code: "END_BEFORE_START", place: 4, value: "B" },
      { code: "BAD_GRADES", place: 5, value: "C" },
      { code: "BAD_GRADES", place: 6, value: "D" },
    ]);
  });

  it("says which headers it found when it finds no name or no start", () => {
    expect(readCalendarFile("foo;bar\n1;2\n", "x.csv").problems).toEqual([{ code: "NO_COLUMNS", place: 0, value: "foo, bar" }]);
    expect(readCalendarFile("", "x.csv").problems).toEqual([{ code: "NO_COLUMNS", place: 0, value: "" }]);
  });
});

describe("parseDateCell", () => {
  it.each([
    ["2027-02-22", "2027-02-22"],
    ["2027/2/2", "2027-02-02"],
    ["20270222", "2027-02-22"],
    ["22/2/2027", "2027-02-22"],
    ["22.02.2027", "2027-02-22"],
    ["22-2-2027", "2027-02-22"],
    [" 2027-02-22 ", "2027-02-22"],
    ["2028-02-29", "2028-02-29"],
  ])("reads %s as %s", (cell, day) => expect(parseDateCell(cell)).toBe(day));

  it.each(["2027-02-30", "2027-13-01", "2027-02-00", "02/22/2027", "2027-2", "idag", "", "2027-02-22T08:00"])("does not read %j: no day is rolled over to another", (cell) =>
    expect(parseDateCell(cell)).toBeNull(),
  );
});
