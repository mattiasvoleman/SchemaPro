import { describe, expect, it } from "vitest";
import {
  coverageCase,
  EMPTY_PLAN,
  LANGUAGES,
  MIXED,
  UNATTACHED_AND_DRAFT,
} from "@/lib/__fixtures__/timplan-tackning";
import { buildCoverageMatrix, coverageTone, signedMinutes } from "./timplan-tackning";

const id = (n: number) => `00000000-0000-4000-8000-000000000${n}`;

describe("buildCoverageMatrix", () => {
  it("lays the gateway's document out as class rows and the school's subject order", () => {
    const { input, response } = coverageCase(LANGUAGES);
    // The school's list is in Swedish order and holds a subject no class uses.
    const subjects = [...input.subjects].sort((a, b) => a.name.localeCompare(b.name, "sv"));
    const matrix = buildCoverageMatrix(response, input.groups, subjects);

    expect(matrix.classes.map((row) => row.name)).toEqual(["8A"]);
    const names = matrix.subjects.map((subject) => subject.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "sv")));
    // Mentorstid does not count toward the timplan, so it has no cell.
    expect(names).not.toContain("Mentorstid");
    expect(names).toContain("Spanska");
  });

  it("gives each cell the line's tone: språkval carried by its groups is 'pupils'", () => {
    const { input, response } = coverageCase(LANGUAGES);
    const matrix = buildCoverageMatrix(response, input.groups, input.subjects);
    expect(matrix.cell(id(303), id(105))?.tone).toBe("pupils");
    expect(matrix.cell(id(303), id(101))?.tone).toBe("met");
    expect(matrix.cell(id(303), id(101))?.line.pupils).toEqual({ min: 180, median: 180, max: 240, below: 0 });
    expect(matrix.cell(id(307), id(101))).toBeNull();
  });

  it("files the listed pupils under their class, in surname order, unknown pupils last", () => {
    const { input, response } = coverageCase(LANGUAGES);
    const people = [
      { id: id(909), firstName: "Ada", lastName: "Öberg" },
      { id: id(906), firstName: "Bo", lastName: "Andersson" },
    ];
    const matrix = buildCoverageMatrix(response, input.groups, input.subjects, people);
    expect(matrix.classes[0]!.pupils.map((pupil) => pupil.pupilId)).toEqual([id(906), id(909), id(908)]);
  });

  it("names unattached årskurser and draft plans from the verdicts", () => {
    const { input, response } = coverageCase(UNATTACHED_AND_DRAFT);
    const matrix = buildCoverageMatrix(response, input.groups, input.subjects);
    expect(matrix.unattachedGrades).toEqual([6]);
    expect(matrix.draftPlans).toEqual([{ id: id(202), name: "Grundskolan 2027 (utkast)", gradeLevels: [9] }]);
  });

  it("names an årskurs attached to a plan that gives it no minutes, and never asks åk 11 for a plan", () => {
    const { input, response } = coverageCase(EMPTY_PLAN);
    const matrix = buildCoverageMatrix(response, input.groups, input.subjects);
    expect(matrix.emptyPlanGrades).toEqual([{ gradeLevel: 3, planName: "Högstadiet 2024" }]);
    expect(matrix.unattachedGrades).toEqual([]);
    expect(matrix.classes.map((row) => [row.name, row.summary.linesWithTarget])).toEqual([
      ["11A", 0],
      ["3A", 0],
      ["3B", 0],
    ]);
  });

  it("keeps a subject the school list no longer holds, named by its id", () => {
    const { input, response } = coverageCase(MIXED);
    const missing = response.cells[0]!.subjectId;
    const matrix = buildCoverageMatrix(
      response,
      input.groups,
      input.subjects.filter((subject) => subject.id !== missing),
    );
    expect(matrix.subjects.at(-1)).toEqual({ id: missing, name: missing });
    expect(matrix.subjects.length).toBe(new Set(response.cells.map((cell) => cell.subjectId)).size);
  });

  it("carries a teacher's group-only document with no pupils", () => {
    const { input, response } = coverageCase(LANGUAGES);
    const matrix = buildCoverageMatrix({ ...response, pupils: null, pupilLevel: false }, input.groups, input.subjects);
    expect(matrix.classes[0]!.pupils).toEqual([]);
  });
});

describe("coverageTone and signedMinutes", () => {
  it("maps every status", () => {
    expect(["UNPLANNED", "UNDER", "PUPILS", "MET", "OVER", "NO_TARGET"].map((s) => coverageTone(s as never))).toEqual(
      ["unplanned", "under", "pupils", "met", "over", "none"],
    );
  });

  it("writes a real minus sign", () => {
    expect([signedMinutes(5), signedMinutes(-20), signedMinutes(0)]).toEqual(["+5", "−20", "0"]);
  });
});
