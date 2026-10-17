import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import type { PeriodLoad, TeacherAssignment, TeacherLoad } from "@/lib/teacher-load";
import type { TeacherReconciliation } from "@/lib/staffing-reconciliation";
import { csvDecimal, samverkanCsv, SAMVERKAN_HEADERS } from "./staffing-exports";

const BOM = "﻿";

const assignment = (overrides: Partial<TeacherAssignment>): TeacherAssignment => ({
  requirementId: "r",
  role: "TEACHER",
  subjectId: "s-ma",
  subjectName: "Matematik",
  studentGroupId: "g-7a",
  groupName: "7A",
  gradeSpan: { min: 7, max: 7 },
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  lessonMinutesPerWeek: 240,
  timeMinutesPerWeek: 240,
  minutesPerWeek: 240,
  hoursPerYear: 152,
  ...overrides,
});

const teacher = (userId: string, overrides: Partial<TeacherLoad> = {}): TeacherLoad => ({
  userId,
  employment: {
    userId,
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: "FERIE",
    teachingTargetMinutesPerWeek: null,
    signature: userId.toUpperCase(),
  },
  targetMinutesPerWeek: 1080,
  assignedMinutesPerWeek: 1200,
  peakMinutesPerWeek: 1260,
  dutyMinutesPerWeek: 90,
  countedDutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 1200,
  balanceMinutesPerWeek: -120,
  percentOfTarget: 111.1,
  status: "OVER",
  requirementCount: 3,
  dutyCount: 1,
  subjects: [
    { subjectId: "s-no", subjectName: "NO", minutesPerWeek: 300, shareOfTeaching: 0.25, percentOfEmployment: 25, percentOfFullTime: null },
    { subjectId: "s-ma", subjectName: "Matematik", minutesPerWeek: 900, shareOfTeaching: 0.75, percentOfEmployment: 75, percentOfFullTime: null },
  ],
  assignments: [assignment({})],
  annual: {
    assignedHoursPerYear: 760.5,
    regulatedHoursPerYear: 1360,
    workDaysPerYear: 194,
    contractKind: "FERIE",
    annualHours: 1767,
    unregulatedHoursPerYear: 407,
    semesterHoursPerWeek: null,
    dutyHoursPerYear: 57,
    teachingWeeksPerYear: 38,
    percentOfRegulated: 55.9,
  },
  ...overrides,
});

const people: Record<string, { firstName: string; lastName: string }> = {
  "t-anna": { firstName: "Anna", lastName: "Öberg" },
  "t-bo": { firstName: "Bo", lastName: "Alm" },
  "t-vik": { firstName: "Vera", lastName: "Vikarie" },
};
const personOf = (id: string) => people[id] ?? null;

const reconciliation = (userId: string, overrides: Partial<TeacherReconciliation> = {}): TeacherReconciliation => ({
  userId,
  planned: 4800,
  scheduled: 4700,
  delivered: 4210,
  substituteMinutes: 0,
  coveredByOthersMinutes: 120,
  aheadMinutes: 0,
  lost: {
    cancelledTeacherUnavailable: 60,
    cancelledRoomUnavailable: 0,
    cancelledManual: 0,
    cancelledUnknown: 0,
    otherStatus: 0,
  },
  lostMinutes: 60,
  deliveredLessons: 70,
  displacedLessons: 0,
  lines: [],
  ...overrides,
});

const linesOf = (csv: string) => csv.slice(1).split("\r\n").filter((line) => line !== "");

describe("csvDecimal", () => {
  it("writes a decimal comma, an ASCII minus and no grouping; integers plain", () => {
    expect(csvDecimal(-12.5, 1)).toBe("-12,5");
    expect(csvDecimal(1234567.25, 2)).toBe("1234567,25");
    expect(csvDecimal(66.667, 3)).toBe("66,667");
    expect(csvDecimal(80, 3)).toBe("80");
    expect(csvDecimal(-0.04, 1)).toBe("0");
    expect(csvDecimal(null, 1)).toBe("");
    expect(csvDecimal(Number.NaN, 1)).toBe("");
    // Never U+2212, which Excel reads as text.
    expect(csvDecimal(-3.25, 2)).not.toContain("−");
  });
});

describe("Tjänstefördelning för samverkan", () => {
  const base = {
    loadModel: "MINUTES" as const,
    from: "2026-08-17",
    to: "2026-10-09",
    year: { startDate: "2026-08-17", endDate: "2027-06-11" },
    personOf,
    subjectName: (id: string) => (id === "s-ma" ? "Matematik" : "NO"),
    qualifications: null,
  };

  it("is BOM, semicolons and CRLF, one row per teacher by family name, every reconciled teacher included", () => {
    const csv = samverkanCsv({
      ...base,
      load: [teacher("t-anna"), teacher("t-bo", { employment: null })],
      // The vikarie has no post and no plan, but held lessons: not dropped.
      reconciliation: [reconciliation("t-anna"), reconciliation("t-vik", { planned: 0, substituteMinutes: 600, delivered: 600 })],
    });
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const parsed = parseCsv(csv);
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toHaveLength(29);
    expect(parsed.rows.map((row) => row[0])).toEqual(["Alm", "Vikarie", "Öberg"]);
    const anna = parsed.rows[2]!;
    expect(anna.slice(0, 6)).toEqual(["Öberg", "Anna", "T-ANNA", "100", "0", "Ferietjänst"]);
    // A negative saldo and a decimal stay numbers in Excel: no apostrophe, no U+2212.
    expect(anna[11]).toBe("-120");
    expect(anna[12]).toBe("111,1");
    expect(anna[13]).toBe("760,5");
    expect(anna[18]).toBe("Matematik 900; NO 300");
    expect(csv).toContain('"Matematik 900; NO 300"');
    expect(anna.slice(19, 28)).toEqual(["4800", "4700", "4210", "0", "120", "60", "2026-08-17", "2026-10-09", "Minuter"]);
    const vik = parsed.rows[1]!;
    expect(vik[3]).toBe("");
    expect(vik[21]).toBe("600");
    expect(csv).not.toContain("−");
    expect(csv).not.toContain("Behörigheter");
  });

  it("under FACTOR calls the charged figures räknad tid and writes the lesson time beside them; MINUTES is unchanged", () => {
    // Ma at factor 1,5: three 60-minute lessons are 180 minutes taught, 270 charged.
    const factor = teacher("t-anna", {
      assignedMinutesPerWeek: 270,
      peakMinutesPerWeek: 270,
      countedMinutesPerWeek: 270,
      subjects: [{ subjectId: "s-ma", subjectName: "Matematik", minutesPerWeek: 270, shareOfTeaching: 1, percentOfEmployment: 25, percentOfFullTime: null }],
      assignments: [assignment({ lessonMinutesPerWeek: 180, timeMinutesPerWeek: 180, minutesPerWeek: 270, hoursPerYear: 171 })],
      annual: { ...teacher("t-anna").annual, assignedHoursPerYear: 171 },
    });
    const parsed = parseCsv(samverkanCsv({ ...base, loadModel: "FACTOR", load: [factor], reconciliation: [reconciliation("t-anna")] }));
    const cell = (header: string) => parsed.rows[0]![parsed.headers.indexOf(header)];
    expect(parsed.headers).toHaveLength(30);
    expect(parsed.headers).not.toContain("Undervisning min/v (standardvecka)");
    expect(parsed.headers).not.toContain("Undervisning h/år");
    expect(cell("Räknad undervisning min/v (standardvecka, faktor)")).toBe("270");
    expect(cell("Undervisningstid min/v (standardvecka, utan faktor)")).toBe("180");
    expect(cell("Räknad undervisning h/år (faktor)")).toBe("171");
    expect(cell("Ämnen räknad tid min/v (faktor)")).toBe("Matematik 270");
    expect(cell("Genomfört i perioden min (räknad tid, faktor, avrundat per rad)")).toBe("4210");
    expect(cell("Beräkningsmodell")).toBe("Faktor");
    // MINUTES: the file of before, header for header.
    const minutes = parseCsv(samverkanCsv({ ...base, load: [teacher("t-anna")], reconciliation: [] }));
    expect(minutes.headers).toEqual([...SAMVERKAN_HEADERS]);
  });

  it("writes a post that changes during the year as on the läsår's first day, and each stretch with its own verdict", () => {
    const stretch = (overrides: Partial<PeriodLoad>): PeriodLoad => ({
      from: "2026-08-17",
      to: "2027-01-10",
      kind: "BASE",
      effectiveFrom: "2026-08-17",
      effectiveTo: "2027-01-10",
      employmentPercent: 100,
      reductionPercent: 0,
      ownTargetMinutesPerWeek: null,
      targetMinutesPerWeek: 600,
      teachingWeeks: 20,
      countedMinutesPerWeek: 600,
      balanceMinutesPerWeek: 0,
      percentOfTarget: 100,
      status: "OK",
      ...overrides,
    });
    const changing = teacher("t-anna", {
      // A period from the first day: the row's grad is the period's, not the base row's.
      employment: {
        ...teacher("t-anna").employment!,
        periods: [
          { validFrom: "2026-08-17", validTo: "2026-08-23", employmentPercent: 90, reductionPercent: 0, teachingTargetMinutesPerWeek: null },
          { validFrom: "2026-12-21", validTo: "2027-01-10", employmentPercent: 100, reductionPercent: 0, teachingTargetMinutesPerWeek: null },
          { validFrom: "2027-01-11", validTo: null, employmentPercent: 50, reductionPercent: 10, teachingTargetMinutesPerWeek: null },
        ],
      },
      periods: [
        stretch({ to: "2026-08-23", kind: "PERIOD", employmentPercent: 90, effectiveTo: "2026-08-23", teachingWeeks: 1, targetMinutesPerWeek: 540, countedMinutesPerWeek: 600, status: "OVER" }),
        stretch({ from: "2026-08-24", to: "2026-12-20", effectiveFrom: "2026-08-24", effectiveTo: "2026-12-20" }),
        stretch({ from: "2026-12-21", to: "2027-01-10", kind: "PERIOD", effectiveFrom: "2026-12-21", teachingWeeks: 0, countedMinutesPerWeek: 0, status: "UNDER" }),
        stretch({ from: "2027-01-11", to: "2027-06-11", kind: "PERIOD", employmentPercent: 50, reductionPercent: 10, effectiveFrom: "2027-01-11", teachingWeeks: 22, targetMinutesPerWeek: 240, countedMinutesPerWeek: 300, status: "OVER" }),
      ],
    });
    const parsed = parseCsv(samverkanCsv({ ...base, load: [changing], reconciliation: [] }));
    const cell = (header: string) => parsed.rows[0]![parsed.headers.indexOf(header)];
    // The grad is the first day's, and the header says so beside the weighted figures.
    expect(parsed.headers).not.toContain("Tjänstgöringsgrad %");
    expect(cell("Tjänstgöringsgrad % vid läsårets start")).toBe("90");
    expect(cell("Nedsättning % vid läsårets start")).toBe("0");
    expect(cell("Tjänstens perioder")).toBe(
      [
        "2026-08-17–2026-08-23: 90 %, riktmärke 540 min/v, räknat 600 min/v, över mål",
        "2026-08-24–2026-12-20: 100 %, riktmärke 600 min/v, räknat 600 min/v, i nivå",
        "2026-12-21–2027-01-10: 100 %, ingen undervisningsvecka",
        "2027-01-11–2027-06-11: 50 %, nedsättning 10 %, riktmärke 240 min/v, räknat 300 min/v, över mål",
      ].join("; "),
    );
    // A post the same all year: the column is empty, the row is the row it was.
    const steady = parseCsv(samverkanCsv({ ...base, load: [teacher("t-anna")], reconciliation: [] }));
    expect(steady.rows[0]![steady.headers.indexOf("Tjänstens perioder")]).toBe("");
    expect(steady.rows[0]![steady.headers.indexOf("Tjänstgöringsgrad %")]).toBe("100");
  });

  it("carries behörigheter only when the admin ticked them, legitimation named as a kind", () => {
    const csv = samverkanCsv({
      ...base,
      load: [teacher("t-anna")],
      reconciliation: [],
      qualifications: [
        { id: "q1", userId: "t-anna", subjectId: "s-ma", minGradeLevel: 7, maxGradeLevel: 9, kind: "LEGITIMATION", validFrom: null, validTo: null, note: null },
        { id: "q2", userId: "t-bo", subjectId: "s-ma", minGradeLevel: 4, maxGradeLevel: 4, kind: "BEHORIG", validFrom: null, validTo: null, note: null },
      ],
    });
    const lines = linesOf(csv);
    expect(lines[0]!.endsWith(";Behörigheter")).toBe(true);
    expect(lines[1]!.endsWith(";Matematik åk 7–9 (legitimation)")).toBe(true);
    expect(csv).not.toContain("åk 4");
  });

  it("writes restid between the school's sites last, only at a school with a travel figure, 0 for a teacher who walks nowhere", () => {
    const without = parseCsv(samverkanCsv({ ...base, load: [teacher("t-anna")], reconciliation: [] }));
    expect(without.headers).toHaveLength(29);
    expect(without.headers.join(";")).not.toContain("Restid");
    const csv = samverkanCsv({
      ...base,
      load: [teacher("t-anna"), teacher("t-bo")],
      reconciliation: [],
      travel: [{ userId: "t-anna", minutesPerWeek: 30, hoursPerYear: 19.5 }],
    });
    const parsed = parseCsv(csv);
    expect(parsed.headers.slice(-2)).toEqual(["Restid mellan skolområden min/v (standardvecka)", "Restid mellan skolområden h/år"]);
    const byName = new Map(parsed.rows.map((row) => [row[0], row]));
    expect(byName.get("Öberg")!.slice(-2)).toEqual(["30", "19,5"]);
    expect(byName.get("Alm")!.slice(-2)).toEqual(["0", "0"]);
  });

  it("lists only behörigheter valid at some point of the läsår", () => {
    const csv = samverkanCsv({
      ...base,
      load: [teacher("t-anna")],
      reconciliation: [],
      qualifications: [
        // A tillåten that lapsed before the läsår: not this year's.
        { id: "q1", userId: "t-anna", subjectId: "s-ma", minGradeLevel: 7, maxGradeLevel: 9, kind: "TILLATEN", validFrom: null, validTo: "2025-06-30", note: null },
        // One that begins during it: listed.
        { id: "q2", userId: "t-anna", subjectId: "s-no", minGradeLevel: 4, maxGradeLevel: 6, kind: "BEHORIG", validFrom: "2027-01-01", validTo: null, note: null },
        // One that begins after it: not.
        { id: "q3", userId: "t-anna", subjectId: "s-ma", minGradeLevel: 1, maxGradeLevel: 3, kind: "BEHORIG", validFrom: "2027-08-01", validTo: null, note: null },
      ],
    });
    expect(linesOf(csv)[1]!.endsWith(";NO åk 4–6 (behörig)")).toBe(true);
    expect(csv).not.toContain("tillåten");
    expect(csv).not.toContain("åk 1–3");
  });
});
