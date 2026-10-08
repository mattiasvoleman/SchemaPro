import { describe, expect, it } from "vitest";
import {
  creditBody,
  creditForm,
  creditFormProblems,
  EMPTY_CREDIT_FORM,
  insideAnyBreak,
  type CreditForm,
} from "@/lib/timplan-credit-form";
import { creditsInside } from "@/lib/timplan-credit-queries";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const valid: CreditForm = { ...EMPTY_CREDIT_FORM, name: "Friluftsdag", date: "2026-09-25", minutes: "300" };

describe("creditFormProblems mirrors the DTO and the table's CHECKs", () => {
  it.each([
    ["a valid friluftsdag", {}, []],
    ["a blank name", { name: "   " }, ["nameBlank"]],
    ["a tab-only name", { name: "\t" }, ["nameBlank"]],
    ["a no-break-space name", { name: "  " }, ["nameBlank"]],
    ["an 80-character name", { name: "x".repeat(80) }, []],
    ["an 81-character name", { name: "x".repeat(81) }, ["nameLong"]],
    ["80 code points that are 160 UTF-16 units", { name: "🌲".repeat(80) }, []],
    ["no date", { date: "" }, ["dateMissing"]],
    ["the year's first day", { date: "2026-08-17" }, []],
    ["the day after the year", { date: "2027-06-12" }, ["dateOutsideYear"]],
    ["0 minutes", { minutes: "0" }, ["minutes"]],
    ["1 minute", { minutes: "1" }, []],
    ["600 minutes", { minutes: "600" }, []],
    ["601 minutes", { minutes: "601" }, ["minutes"]],
    ["minutes with a decimal", { minutes: "30.5" }, ["minutes"]],
    ["minutes left empty", { minutes: "" }, ["minutes"]],
    ["a span upside down", { scope: "grades", minGradeLevel: 8, maxGradeLevel: 7 }, ["span"]],
    ["a group scope with no group", { scope: "group", studentGroupId: "" }, ["group"]],
    ["a 500-character note", { note: "n".repeat(500) }, []],
    ["a 501-character note", { note: "n".repeat(501) }, ["noteLong"]],
  ] as const)("%s", (_name, patch, problems) => {
    expect(creditFormProblems({ ...valid, ...patch } as CreditForm, YEAR)).toEqual(problems);
  });
});

describe("creditBody", () => {
  it("sends one scope and nulls for the other two, a trimmed name and no blank note", () => {
    expect(creditBody({ ...valid, name: " Friluftsdag ", note: " \t", scope: "grades" }, "y1")).toEqual({
      academicYearId: "y1",
      name: "Friluftsdag",
      date: "2026-09-25",
      minutes: 300,
      subjectId: null,
      studentGroupId: null,
      minGradeLevel: 7,
      maxGradeLevel: 9,
      note: null,
    });
    expect(creditBody({ ...valid, scope: "group", studentGroupId: "g", subjectId: "s" }, "y1")).toMatchObject({
      subjectId: "s",
      studentGroupId: "g",
      minGradeLevel: null,
      maxGradeLevel: null,
    });
  });

  it("reads a stored credit back into the scope it has", () => {
    const stored = {
      id: "c",
      academicYearId: "y1",
      date: "2026-09-25",
      minutes: 300,
      subjectId: null,
      studentGroupId: "g-7a",
      minGradeLevel: null,
      maxGradeLevel: null,
      name: "Temadag",
      note: null,
    };
    expect(creditForm(stored)).toMatchObject({ scope: "group", studentGroupId: "g-7a", subjectId: "", minutes: "300", note: "" });
    expect(creditForm({ ...stored, studentGroupId: null }).scope).toBe("school");
    expect(creditForm({ ...stored, studentGroupId: null, minGradeLevel: 4, maxGradeLevel: 6 })).toMatchObject({
      scope: "grades",
      minGradeLevel: 4,
      maxGradeLevel: 6,
    });
  });
});

describe("credits and the lov they belong to", () => {
  const credits = [
    { id: "b", date: "2026-10-30" },
    { id: "a", date: "2026-10-26" },
    { id: "c", date: "2026-11-02" },
  ];
  it("puts a credit under the lov its date lies in, first and last day included", () => {
    expect(creditsInside(credits, { startDate: "2026-10-26", endDate: "2026-10-30" }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(insideAnyBreak("2026-10-30", [{ startDate: "2026-10-26", endDate: "2026-10-30" }])).toBe(true);
    expect(insideAnyBreak("2026-11-02", [{ startDate: "2026-10-26", endDate: "2026-10-30" }])).toBe(false);
  });
});
