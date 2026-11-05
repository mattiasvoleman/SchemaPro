import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import {
  formatTimplanGrade,
  mapTimplanRows,
  parseTimplanGrade,
  rowsOutsideSpan,
  TIMPLAN_CSV_TEMPLATE,
  timplanTemplateCsv,
  timplanToCsv,
} from "@/lib/timplan-csv";

const file = (...lines: string[]) => parseCsv(lines.join("\r\n"));

describe("mapTimplanRows: a lokal timplan file to ImportTimplanRowDto rows", () => {
  it("reads F as förskoleklass and keeps the file's column set for the import", () => {
    const { rows, errors, columns } = mapTimplanRows(
      file("ämne;årskurs;minuter per vecka;notering", "MA;F;120;", "Matematik;3;235;Skolans val"),
    );
    expect(errors).toEqual([]);
    expect(columns).toEqual(["subject", "gradeLevel", "minutesPerWeek", "note"]);
    expect(rows).toEqual([
      { subject: "MA", gradeLevel: 0, minutesPerWeek: 120, note: "" },
      { subject: "Matematik", gradeLevel: 3, minutesPerWeek: 235, note: "Skolans val" },
    ]);
  });

  it("without a notering column sends no note at all, so stored notes are left alone", () => {
    const { rows, columns } = mapTimplanRows(file("amne;arskurs;minuter_per_vecka", "BL;4;50"));
    expect(columns).toEqual(["subject", "gradeLevel", "minutesPerWeek"]);
    expect(rows[0]).not.toHaveProperty("note");
  });

  it("names a missing column by the template's spelling and reads no rows", () => {
    const { rows, errors } = mapTimplanRows(file("amne;minuter_per_vecka", "MA;60"));
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 0, message: expect.stringContaining("arskurs") }]);
  });

  it("refuses a requirements file (timplansposter.csv) for want of an årskurs", () => {
    const { errors } = mapTimplanRows(
      file("grupp;amne;lektioner_per_vecka;minuter_per_lektion", "7A;MA;3;60"),
    );
    expect(errors[0]!.message).toContain("arskurs");
  });

  it("gives one error per bad row, numbered as Excel numbers rows, and maps the rest", () => {
    const { rows, errors } = mapTimplanRows(
      file(
        "amne;arskurs;minuter_per_vecka",
        "MA;1;60",
        ";2;60",
        "MA;12;60",
        "MA;G;60",
        "MA;3;1201",
        "MA;4;12,5",
        "MA;5;",
        "MA;6;0",
      ),
    );
    expect(rows.map((row) => [row.gradeLevel, row.minutesPerWeek])).toEqual([
      [1, 60],
      [6, 0],
    ]);
    expect(errors.map((error) => error.row)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(errors[1]!.message).toContain('"12"');
  });

  it("refuses a file larger than one plan can hold, before anything is sent", () => {
    const lines = ["amne;arskurs;minuter_per_vecka"];
    for (let i = 0; i < 401; i++) lines.push(`S${i};1;60`);
    const { rows, errors } = mapTimplanRows(file(...lines));
    expect(rows).toEqual([]);
    expect(errors[0]!.message).toContain("400");
  });
});

describe("rowsOutsideSpan: rows the plan's årskurs span does not hold", () => {
  const rows = [1, 2, 2, 4, 9, 0].map((gradeLevel) => ({ gradeLevel }));

  it("counts them and names the årskurser once each, in order, so the dialog can say before the file is sent", () => {
    expect(rowsOutsideSpan(rows, { gradeFrom: 4, gradeTo: 9 })).toEqual({ count: 4, grades: [0, 1, 2] });
  });

  it("is nothing for a plan with no span, where every årskurs is the plan's", () => {
    expect(rowsOutsideSpan(rows, null)).toEqual({ count: 0, grades: [] });
  });

  it("is nothing when the span holds every row, förskoleklass included when it starts at F", () => {
    expect(rowsOutsideSpan(rows, { gradeFrom: 0, gradeTo: 9 })).toEqual({ count: 0, grades: [] });
  });

  it("does not make such a row an error: the mapper keeps it, as it keeps an åk 10 in a nine-year plan", () => {
    const { rows: mapped, errors } = mapTimplanRows(file("amne;arskurs;minuter_per_vecka", "MA;1;236", "MA;5;200"));
    expect(errors).toEqual([]);
    expect(mapped.map((row) => row.gradeLevel)).toEqual([1, 5]);
    expect(rowsOutsideSpan(mapped, { gradeFrom: 4, gradeTo: 9 })).toEqual({ count: 1, grades: [1] });
  });
});

describe("timplanToCsv: the plan as the file its import reads", () => {
  const subjects = [
    { id: "s-bl", name: "Bild", code: "BL" },
    { id: "s-ma", name: "Matematik", code: "MA" },
    { id: "s-prog", name: "Programmering", code: null },
  ];

  it("writes codes where there are codes, F for förskoleklass, and the grid's order", () => {
    const csv = timplanToCsv(
      [
        { subjectId: "s-ma", gradeLevel: 1, minutesPerWeek: 236, note: null },
        { subjectId: "s-prog", gradeLevel: 8, minutesPerWeek: 40, note: "Skolans val" },
        { subjectId: "s-ma", gradeLevel: 0, minutesPerWeek: 120, note: null },
        { subjectId: "s-bl", gradeLevel: 2, minutesPerWeek: 30, note: null },
      ],
      subjects,
    );
    expect(csv.startsWith("﻿amne;arskurs;minuter_per_vecka;notering\r\n")).toBe(true);
    expect(csv.split("\r\n").slice(1, -1)).toEqual([
      "BL;2;30;",
      "MA;F;120;",
      "MA;1;236;",
      "Programmering;8;40;Skolans val",
    ]);
  });

  it("round-trips: an exported plan imports back to the same cells", () => {
    const entries = [
      { subjectId: "s-ma", gradeLevel: 0, minutesPerWeek: 120, note: null },
      { subjectId: "s-prog", gradeLevel: 8, minutesPerWeek: 40, note: "Skolans val; åk 8" },
    ];
    const { rows, errors } = mapTimplanRows(parseCsv(timplanToCsv(entries, subjects)));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { subject: "MA", gradeLevel: 0, minutesPerWeek: 120, note: "" },
      { subject: "Programmering", gradeLevel: 8, minutesPerWeek: 40, note: "Skolans val; åk 8" },
    ]);
  });

  it("ships a template that imports cleanly under its own name", () => {
    expect(TIMPLAN_CSV_TEMPLATE.filename).toBe("lokal_timplan.csv");
    const { rows, errors } = mapTimplanRows(parseCsv(timplanTemplateCsv()));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(TIMPLAN_CSV_TEMPLATE.exampleRows.length);
  });
});

describe("årskurs spelling", () => {
  it("reads F/f and 0–11, refuses the rest, and writes 0 back as F", () => {
    expect(["F", "f", "0", "10", "11", "07"].map(parseTimplanGrade)).toEqual([0, 0, 0, 10, 11, 7]);
    expect(["12", "Fk", "-1", "", "1.5"].map(parseTimplanGrade)).toEqual([null, null, null, null, null]);
    expect([0, 9].map(formatTimplanGrade)).toEqual(["F", "9"]);
  });
});
