import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEY_SORT,
  ariaSortOf,
  costBasisCsv,
  costBasisFilename,
  gradeText,
  hoursOf,
  nextKeySort,
  percentOfShare,
  sortTeachers,
  spanLabel,
} from "@/lib/analysis";
import type { CostBasis, SchoolPart, TeacherKeyFigures } from "@/lib/analysis-types";

const teacher = (userId: string, over: Partial<TeacherKeyFigures> = {}): TeacherKeyFigures => ({
  userId,
  teachingMinutesPerWeek: 600,
  dutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 600,
  targetMinutesPerWeek: 1080,
  percentOfTarget: 56,
  status: "UNDER",
  scheduledMinutesPerWeek: null,
  teachingHoursPerYear: 400,
  employmentPercent: 100,
  groups: 3,
  pupils: 60,
  qualifiedShare: 1,
  ...over,
});

const NAMES: Record<string, string> = { a: "Ek, Bo", b: "Åkesson, Anna", c: "Berg, Cy", d: "Lind, Dan" };
const nameOf = (id: string) => NAMES[id] ?? "";

describe("hoursOf, percentOfShare, spanLabel and gradeText", () => {
  it("states minutes as hours to two decimals, a share as a percent to one, and a span the way a person writes it", () => {
    expect(hoursOf(90)).toBe(1.5);
    expect(hoursOf(100)).toBe(1.67);
    expect(hoursOf(0)).toBe(0);
    expect(percentOfShare(0.8725)).toBe(87.3);
    expect(percentOfShare(1)).toBe(100);
    expect(spanLabel({ gradeFrom: 0, gradeTo: 3 })).toBe("F–3");
    expect(spanLabel({ gradeFrom: 7, gradeTo: 9 })).toBe("7–9");
    expect(spanLabel({ gradeFrom: 9, gradeTo: 9 })).toBe("9");
    expect(spanLabel({ gradeFrom: 0, gradeTo: 0 })).toBe("F");
    expect(gradeText(0, "–")).toBe("F");
    expect(gradeText(7, "–")).toBe("7");
    expect(gradeText(null, "utan årskurs")).toBe("utan årskurs");
  });
});

describe("sorting the teachers", () => {
  const rows = [
    teacher("a", { pupils: 30, percentOfTarget: 90, qualifiedShare: 0.5, employmentPercent: 50 }),
    teacher("b", { pupils: 80, percentOfTarget: null, qualifiedShare: null, employmentPercent: null }),
    teacher("c", { pupils: 80, percentOfTarget: 40, qualifiedShare: 1, scheduledMinutesPerWeek: 300, employmentPercent: 100 }),
    teacher("d", { pupils: 10, percentOfTarget: 120, qualifiedShare: 0, scheduledMinutesPerWeek: 700, employmentPercent: 80 }),
  ];
  const order = (key: Parameters<typeof nextKeySort>[1], direction: "asc" | "desc") =>
    sortTeachers(rows, { key, direction }, nameOf).map((row) => row.userId);

  it("opens by name in Swedish order, Å after Z and A–Ö apart from the surname's case", () => {
    expect(order(DEFAULT_KEY_SORT.key, DEFAULT_KEY_SORT.direction)).toEqual(["c", "a", "d", "b"]);
    expect(order("teacher", "desc")).toEqual(["b", "d", "a", "c"]);
  });

  it("sorts numbers both ways and breaks a tie by name", () => {
    expect(order("pupils", "desc")).toEqual(["c", "b", "a", "d"]);
    expect(order("pupils", "asc")).toEqual(["d", "a", "c", "b"]);
  });

  it("puts a teacher without the figure last whichever way it sorts", () => {
    expect(order("load", "asc")).toEqual(["c", "a", "d", "b"]);
    expect(order("load", "desc")).toEqual(["d", "a", "c", "b"]);
    expect(order("qualified", "desc")).toEqual(["c", "a", "d", "b"]);
    expect(order("employment", "asc")).toEqual(["a", "d", "c", "b"]);
    expect(order("scheduled", "asc")).toEqual(["c", "d", "a", "b"]);
    expect(order("teaching", "asc")).toEqual(["c", "a", "d", "b"]);
  });

  it("does not touch the rows it is given", () => {
    const before = rows.map((row) => row.userId);
    sortTeachers(rows, { key: "pupils", direction: "desc" }, nameOf);
    expect(rows.map((row) => row.userId)).toEqual(before);
  });

  it("opens a column on the order that makes sense for it and turns it on a second press", () => {
    expect(nextKeySort(DEFAULT_KEY_SORT, "pupils")).toEqual({ key: "pupils", direction: "desc" });
    expect(nextKeySort({ key: "pupils", direction: "desc" }, "pupils")).toEqual({ key: "pupils", direction: "asc" });
    expect(nextKeySort({ key: "pupils", direction: "desc" }, "teacher")).toEqual({ key: "teacher", direction: "asc" });
    expect(ariaSortOf({ key: "pupils", direction: "desc" }, "pupils")).toBe("descending");
    expect(ariaSortOf({ key: "pupils", direction: "asc" }, "pupils")).toBe("ascending");
    expect(ariaSortOf({ key: "pupils", direction: "asc" }, "teacher")).toBe("none");
  });
});

describe("costBasisCsv", () => {
  const figures = (over: Partial<CostBasis["total"]> = {}): CostBasis["total"] => ({
    pupils: 60,
    hours: { TEACHER: 1200.5, UNQUALIFIED_TEACHER: 80, SUBSTITUTE: 10.25 },
    hoursPerPupil: 21.5,
    cost: 520000,
    costPerPupil: 8666.67,
    ...over,
  });
  const high: SchoolPart = { id: "high", name: "Högstadiet", account: "4030", gradeFrom: 7, gradeTo: 9 };
  const basis: CostBasis = {
    academicYearId: "y",
    year: { startDate: "2026-08-17", endDate: "2027-06-11" },
    gradeNumbering: "NIOARIG",
    substitutes: null,
    rates: [],
    missingRates: [],
    parts: [
      { schoolPartId: "high", name: "Högstadiet", account: "4030", ...figures() },
      { schoolPartId: null, name: null, account: null, ...figures({ pupils: 0, hoursPerPupil: null, cost: null, costPerPupil: null }) },
    ],
    cells: [
      { schoolPartId: "high", gradeLevel: 7, ...figures() },
      { schoolPartId: null, gradeLevel: null, ...figures({ pupils: 0, hoursPerPupil: null, cost: null, costPerPupil: null }) },
    ],
    total: figures(),
    notices: [],
  };
  const lines = costBasisCsv(basis, [high], "Ingen skoldel", "utan årskurs", "Hela skolan")
    .replace(/^﻿/, "")
    .split("\r\n")
    .filter(Boolean);

  it("is Swedish Excel's: a BOM-led, semicolon-separated file with a decimal comma", () => {
    expect(costBasisCsv(basis, [high], "x", "y", "z").startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(
      "Skoldel;Konto;Årskurs;Elever;Behörig lärare (tim);Lärare utan behörighet (tim);Vikarie (tim);Lärartid per elev (tim);Kostnad (kr);Kostnad per elev (kr)",
    );
    expect(lines[1]).toBe("Högstadiet;4030;7;60;1200,50;80,00;10,25;21,50;520000,00;8666,67");
  });

  it("has a row per årskurs, then one per skoldel, then the school, and an unknown cost is empty", () => {
    expect(lines).toHaveLength(6);
    expect(lines[2]).toBe("Ingen skoldel;;utan årskurs;0;1200,50;80,00;10,25;;;");
    expect(lines[3]).toBe("Högstadiet;4030;;60;1200,50;80,00;10,25;21,50;520000,00;8666,67");
    expect(lines[4]).toBe("Ingen skoldel;;;0;1200,50;80,00;10,25;;;");
    expect(lines[5]).toBe("Hela skolan;;;60;1200,50;80,00;10,25;21,50;520000,00;8666,67");
  });

  it("names a file after the läsår, without characters a file name dislikes", () => {
    expect(costBasisFilename("2026/27")).toBe("kostnad-per-elev-2026-27.csv");
    expect(costBasisFilename("Läsåret 26–27")).toBe("kostnad-per-elev-Läsåret-26-27.csv");
  });
});
