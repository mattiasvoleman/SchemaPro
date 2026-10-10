import { describe, expect, it } from "vitest";
import type { Hours } from "@/lib/cover-types";
import {
  HOURS_LESSON_HEADERS,
  HOURS_SUMMARY_HEADERS,
  hoursFilename,
  hoursLessonsCsv,
  hoursSummaryCsv,
  type HoursNames,
} from "./cover-hours-export";

/**
 * Vikarietimmar for payroll: Swedish Excel's dialect (BOM, `;`, CRLF, decimal
 * comma), the columns in the order the spec names them, times on the
 * SCHOOL's clock — and no column for the replaced teacher, the absence or a
 * reason, so the file cannot become a sick-leave register.
 */

const HOURS: Hours = {
  from: "2026-10-01",
  to: "2026-10-31",
  rows: [
    {
      lessonId: "l-2",
      userId: "u-pool",
      kind: "POOL",
      date: "2026-10-13",
      startsAt: "2026-10-13T06:00:00.000Z",
      endsAt: "2026-10-13T06:50:00.000Z",
      minutes: 50,
      subjectId: "s-en",
      studentGroupId: "g-8b",
      roomId: null,
    },
    {
      lessonId: "l-1",
      userId: "u-staff",
      kind: "STAFF",
      date: "2026-10-12",
      startsAt: "2026-10-12T07:00:00.000Z",
      endsAt: "2026-10-12T08:00:00.000Z",
      minutes: 60,
      subjectId: "s-ma",
      studentGroupId: "g-7a",
      roomId: "r-12",
    },
  ],
  summary: [
    { userId: "u-staff", kind: "STAFF", lessons: 1, minutes: 60 },
    { userId: "u-pool", kind: "POOL", lessons: 1, minutes: 50 },
  ],
  planned: [{ userId: "u-pool", lessons: 3, minutes: 150 }],
  toCheck: [],
};

const NAMES: HoursNames = {
  person: (id) =>
    id === "u-staff"
      ? { name: "Örjan Berg", email: "orjan@skola.se" }
      : id === "u-pool"
        ? { name: "=Anna Ek", email: "anna@example.se" }
        : null,
  subject: (id) => ({ "s-ma": "Matematik", "s-en": "Engelska" })[id] ?? "",
  group: (id) => ({ "g-7a": "7A", "g-8b": "8B" })[id] ?? "",
  room: (id) => (id === "r-12" ? "Sal 12" : ""),
  timezone: "Europe/Stockholm",
};

const lines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);

describe("the lessons file", () => {
  it("is Swedish Excel's dialect with the spec's columns, and no replaced teacher", () => {
    const csv = hoursLessonsCsv(HOURS, NAMES);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines(csv)[0]).toBe("Vikarie;E-post;Typ;Datum;Start;Slut;Minuter;Ämne;Grupp;Sal");
    expect(HOURS_LESSON_HEADERS.join(" ")).not.toMatch(/Ersatt|Frånvar|Orsak|Lärare/);
  });

  it("writes one row per held cover, by person in Swedish order, on the school's clock", () => {
    const [, first, second] = lines(hoursLessonsCsv(HOURS, NAMES));
    // "=Anna Ek" is neutralised against formula injection and sorts first.
    expect(first).toBe("'=Anna Ek;anna@example.se;Vikariepool;2026-10-13;08:00;08:50;50;Engelska;8B;");
    expect(second).toBe("Örjan Berg;orjan@skola.se;Personal;2026-10-12;09:00;10:00;60;Matematik;7A;Sal 12");
  });

  it("never exports a booked cover that has not been held", () => {
    expect(lines(hoursLessonsCsv(HOURS, NAMES))).toHaveLength(1 + HOURS.rows.length);
  });
});

describe("the summary file", () => {
  it("sums per person with hours in decimal comma", () => {
    const csv = hoursSummaryCsv(HOURS, NAMES);
    expect(lines(csv)).toEqual([
      HOURS_SUMMARY_HEADERS.join(";"),
      "'=Anna Ek;anna@example.se;Vikariepool;1;50;0,83",
      "Örjan Berg;orjan@skola.se;Personal;1;60;1",
    ]);
  });

  it("names the files by kind and period", () => {
    expect(hoursFilename("summering", "2026-10-01", "2026-10-31")).toBe("vikarietimmar-summering-2026-10-01-2026-10-31.csv");
  });
});
