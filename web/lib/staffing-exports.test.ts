import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { parseCsv } from "@/lib/csv";
import type { TeacherAssignment, TeacherLoad } from "@/lib/teacher-load";
import type { TeacherReconciliation } from "@/lib/staffing-reconciliation";
import type { SchoolForm } from "@/lib/types";
import {
  csvDecimal,
  largestRemainder,
  samverkanCsv,
  scbColumnApplies,
  scbColumnOf,
  scbUnderlag,
  SAMVERKAN_HEADERS,
  SCB_PEDPERS_2026,
  SCB_SYSTEM_VERSION,
  type ScbInput,
} from "./staffing-exports";

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

describe("largestRemainder", () => {
  it("sums to the total, proportional to the weights", () => {
    expect(largestRemainder([1, 1, 1], 100)).toEqual([34, 33, 33]);
    expect(largestRemainder([600, 300], 80)).toEqual([53, 27]);
    expect(largestRemainder([0, 0], 100)).toEqual([0, 0]);
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
    expect(parsed.headers).toHaveLength(28);
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
    expect(parsed.headers).toHaveLength(29);
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

describe("the SCB column table", () => {
  it("holds SCB's 80 variables in SCB's order, as the 2026-05-07 datafilsbeskrivning lists them", () => {
    const names = SCB_PEDPERS_2026.columns.map(([name]) => name);
    expect(names).toHaveLength(80);
    expect(new Set(names).size).toBe(80);
    expect(names.slice(0, 9)).toEqual([
      "System", "Datum", "Version", "SkolenhetsKod", "PersonNr", "PersonNamn", "Verksamhetstyp", "SkolenhetNamn", "AnstForm",
    ]);
    expect(names[20]).toBe("OmfLarare");
    expect(names[27]).toBe("Undervisning");
    expect(names[79]).toBe("OmfSprakochk");
    expect(SCB_PEDPERS_2026.specVersionDate).toBe("2026-05-07");
  });

  it("applies SCB's matrix: Estetisk and the ämnesområden only on anpassad grundskola, no subjects on förskoleklass", () => {
    expect(scbColumnApplies("OmfEstetisk", "6")).toBe(false);
    expect(scbColumnApplies("OmfEstetisk", "11")).toBe(true);
    expect(scbColumnApplies("OmfKommunikation", "4")).toBe(false);
    expect(scbColumnApplies("OmfSamiska", "5")).toBe(true);
    expect(scbColumnApplies("OmfSamiska", "11")).toBe(false);
    expect(scbColumnApplies("OmfMatematik", "1")).toBe(false);
    expect(scbColumnApplies("Undervisning", "1")).toBe(false);
    expect(scbColumnApplies("OmfLarare", "1")).toBe(true);
  });

  it("states SchemaPro's own release in column 3", () => {
    expect(SCB_SYSTEM_VERSION).toBe(pkg.version);
    expect(SCB_SYSTEM_VERSION.length).toBeLessThanOrEqual(15);
  });

  it("maps national codes to SCB columns, Svenska/SvA and moderna språk by the school's subject", () => {
    expect(scbColumnOf({ nationalCode: "MA", code: "MA", name: "Matematik" })).toBe("OmfMatematik");
    expect(scbColumnOf({ nationalCode: "SV_SVA", code: "SV", name: "Svenska" })).toBe("OmfSvenska");
    expect(scbColumnOf({ nationalCode: "SV_SVA", code: "SVA", name: "Svenska 2" })).toBe("OmfSVA");
    expect(scbColumnOf({ nationalCode: "SV_SVA", code: null, name: "Svenska som andraspråk" })).toBe("OmfSVA");
    expect(scbColumnOf({ nationalCode: "M2", code: "M2SP", name: "Spanska" })).toBe("OmfSpanska");
    expect(scbColumnOf({ nationalCode: "M2", code: "M2", name: "Kinesiska" })).toBe("OmfOvrigtSprak");
    expect(scbColumnOf({ nationalCode: "NO", code: "NO", name: "NO" })).toBeNull();
    expect(scbColumnOf({ nationalCode: null, code: "MT", name: "Mentorstid" })).toBeNull();
  });
});

describe("SCB Pedagogisk personal, underlag", () => {
  const subjects = [
    { id: "s-ma", nationalCode: "MA", code: "MA", name: "Matematik" },
    { id: "s-en", nationalCode: "EN", code: "EN", name: "Engelska" },
    { id: "s-no", nationalCode: "NO", code: "NO", name: "NO" },
    { id: "s-est", nationalCode: "EST", code: "EST", name: "Estetisk verksamhet" },
    { id: "s-sl", nationalCode: "SL", code: "SL", name: "Slöjd" },
  ];
  const grundskola = new Map<number, SchoolForm>(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((grade) => [grade, "GRUNDSKOLA"]),
  );
  const input = (overrides: Partial<ScbInput>): ScbInput => ({
    exportDate: "2026-10-09",
    yearStartDate: "2026-08-17",
    schoolName: "Norra skolan",
    load: [],
    duties: [],
    subjects,
    schoolFormByGrade: grundskola,
    personOf,
    adminIds: new Set(),
    ...overrides,
  });
  const col = (name: string) => SCB_PEDPERS_2026.columns.findIndex(([column]) => column === name);
  const rowsOf = (csv: string) => linesOf(csv).slice(1).map((line) => line.split(";"));

  it("writes SCB's variable names as the header and fills what SchemaPro knows, never PersonNr or SkolenhetsKod", () => {
    const { csv, notices } = scbUnderlag(
      input({
        load: [
          teacher("t-anna", {
            employment: { ...teacher("t-anna").employment!, employmentPercent: 80 },
            assignments: [
              assignment({ subjectId: "s-ma", timeMinutesPerWeek: 600 }),
              assignment({ subjectId: "s-en", subjectName: "Engelska", timeMinutesPerWeek: 300 }),
            ],
          }),
        ],
      }),
    );
    expect(csv.startsWith(BOM)).toBe(true);
    expect(linesOf(csv)[0]).toBe(SCB_PEDPERS_2026.columns.map(([name]) => name).join(";"));
    const [row] = rowsOf(csv);
    expect(row).toHaveLength(80);
    expect(row![col("System")]).toBe("SchemaPro");
    expect(row![col("Datum")]).toBe("2026-10-09");
    expect(row![col("SkolenhetsKod")]).toBe("");
    expect(row![col("PersonNr")]).toBe("");
    expect(row![col("AnstForm")]).toBe("");
    expect(row![col("PersonNamn")]).toBe("Anna Öberg");
    expect(row![col("Verksamhetstyp")]).toBe("6");
    expect(row![col("OmfLarare")]).toBe("80");
    expect(row![col("Undervisning")]).toBe("J");
    expect(row![col("OmfMatematik")]).toBe("67");
    expect(row![col("OmfEngelska")]).toBe("33");
    expect(notices).toEqual([]);
    // Nothing about legitimation reaches the file.
    expect(csv.toLowerCase()).not.toContain("legitim");
  });

  it("names a post with no planned teaching: SCB wants a verksamhetstyp and subjects for OmfLarare > 0", () => {
    // A speciallärare, or a teacher whose timplansposter are not staffed yet.
    const { csv, notices } = scbUnderlag(input({ load: [teacher("t-anna", { assignments: [] })] }));
    const [row] = rowsOf(csv);
    expect(row![col("OmfLarare")]).toBe("100");
    expect(row![col("Verksamhetstyp")]).toBe("");
    expect(notices).toContainEqual({ code: "NO_TEACHING", params: { name: "Anna Öberg" } });
  });

  it("splits a group across stages by its grades, and the post by largest remainder summing to the whole", () => {
    const { csv } = scbUnderlag(
      input({
        load: [
          teacher("t-anna", {
            employment: { ...teacher("t-anna").employment!, employmentPercent: 75 },
            assignments: [assignment({ subjectId: "s-ma", gradeSpan: { min: 6, max: 7 }, timeMinutesPerWeek: 600 })],
          }),
        ],
      }),
    );
    const rows = rowsOf(csv);
    expect(rows.map((row) => row[col("Verksamhetstyp")])).toEqual(["5", "6"]);
    expect(rows.map((row) => row[col("OmfLarare")])).toEqual(["38", "37"]);
    expect(rows.map((row) => row[col("OmfMatematik")])).toEqual(["100", "100"]);
  });

  it("leaves out and names NO and a column SCB does not collect for the row's verksamhetstyp, rescaling the rest", () => {
    const { csv, notices } = scbUnderlag(
      input({
        load: [
          teacher("t-anna", {
            assignments: [
              assignment({ subjectId: "s-ma", timeMinutesPerWeek: 300 }),
              assignment({ subjectId: "s-no", subjectName: "NO", timeMinutesPerWeek: 300 }),
              assignment({ subjectId: "s-est", subjectName: "Estetisk verksamhet", timeMinutesPerWeek: 300 }),
            ],
          }),
        ],
      }),
    );
    const [row] = rowsOf(csv);
    expect(row![col("OmfMatematik")]).toBe("100");
    expect(row![col("OmfEstetisk")]).toBe("");
    expect(notices).toEqual([
      { code: "LEFT_OUT", params: { name: "Anna Öberg", line: "NO 7A" } },
      { code: "LEFT_OUT", params: { name: "Anna Öberg", line: "Estetisk verksamhet 7A" } },
    ]);
  });

  it("codes an anpassad grundskola row 10–12 from the year's timplan, where Estetisk verksamhet is collected", () => {
    const { csv } = scbUnderlag(
      input({
        schoolFormByGrade: new Map<number, SchoolForm>([[5, "ANPASSAD_GRUNDSKOLA_AMNEN"]]),
        load: [
          teacher("t-anna", {
            assignments: [
              assignment({ subjectId: "s-est", subjectName: "Estetisk verksamhet", gradeSpan: { min: 5, max: 5 }, timeMinutesPerWeek: 200 }),
              assignment({ subjectId: "s-sl", subjectName: "Slöjd", gradeSpan: { min: 5, max: 5 }, timeMinutesPerWeek: 200 }),
            ],
          }),
        ],
      }),
    );
    const [row] = rowsOf(csv);
    expect(row![col("Verksamhetstyp")]).toBe("11");
    expect(row![col("OmfEstetisk")]).toBe("50");
    expect(row![col("OmfSlojd")]).toBe("50");
  });

  it("gives förskoleklass no subjects and no Undervisning, merges a row whose share rounds to 0", () => {
    const { csv } = scbUnderlag(
      input({
        load: [
          teacher("t-anna", {
            employment: { ...teacher("t-anna").employment!, employmentPercent: 50 },
            assignments: [
              assignment({ subjectId: "s-ma", gradeSpan: { min: 0, max: 0 }, groupName: "FK", timeMinutesPerWeek: 1000 }),
              // 4 of 1004 minutes: 0 % of a 50 % post — merged into the FK row.
              assignment({ subjectId: "s-ma", gradeSpan: { min: 7, max: 7 }, timeMinutesPerWeek: 4 }),
            ],
          }),
        ],
      }),
    );
    const rows = rowsOf(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]![col("Verksamhetstyp")]).toBe("1");
    expect(rows[0]![col("OmfLarare")]).toBe("50");
    expect(rows[0]![col("Undervisning")]).toBe("");
    expect(rows[0]![col("OmfMatematik")]).toBe("");
  });

  it("reports a wholly reduced post as the post held, without subjects, and says how SCB wants it", () => {
    const { csv, notices } = scbUnderlag(
      input({
        load: [teacher("t-anna", { employment: { ...teacher("t-anna").employment!, reductionPercent: 100 } })],
      }),
    );
    const [row] = rowsOf(csv);
    expect(row![col("OmfLarare")]).toBe("100");
    expect(row![col("OmfMatematik")]).toBe("");
    expect(notices).toContainEqual({ code: "FULL_LEAVE", params: { name: "Anna Öberg" } });
  });

  it("uses undervisningstid and not räknad tid, names a reduction, a förstelärare, an admin, a missing post", () => {
    const { csv, notices } = scbUnderlag(
      input({
        load: [
          teacher("t-anna", {
            employment: { ...teacher("t-anna").employment!, reductionPercent: 20 },
            assignments: [
              // FACTOR 0.5 on slöjd: charged 100, but 200 minutes taught.
              assignment({ subjectId: "s-sl", subjectName: "Slöjd", timeMinutesPerWeek: 200, minutesPerWeek: 100 }),
              assignment({ subjectId: "s-ma", timeMinutesPerWeek: 200, minutesPerWeek: 200 }),
            ],
          }),
          teacher("t-bo", { employment: null }),
        ],
        duties: [{ userId: "t-anna", kind: "FORSTELARARE" }],
        adminIds: new Set(["t-anna"]),
      }),
    );
    const rows = rowsOf(csv);
    const anna = rows.find((row) => row[col("PersonNamn")] === "Anna Öberg")!;
    expect(anna[col("OmfLarare")]).toBe("80");
    expect(anna[col("OmfSlojd")]).toBe("50");
    expect(anna[col("OmfMatematik")]).toBe("50");
    const bo = rows.find((row) => row[col("PersonNamn")] === "Bo Alm")!;
    expect(bo[col("OmfLarare")]).toBe("");
    expect(bo.join(";")).not.toContain("NaN");
    // Bo Alm sorts first: his notice comes first.
    expect(notices.map((entry) => entry.code)).toEqual(["NO_POST", "REDUCTION", "FORSTELARARE", "ADMIN"]);
  });

  it("leaves specialskola uncoded and a grade without a timplan as grundskola, with notices; flags a year that is not HT 2026", () => {
    const { csv, notices } = scbUnderlag(
      input({
        yearStartDate: "2027-08-16",
        schoolFormByGrade: new Map<number, SchoolForm>([[8, "SPECIALSKOLA"]]),
        load: [
          teacher("t-anna", {
            assignments: [
              assignment({ gradeSpan: { min: 8, max: 8 }, timeMinutesPerWeek: 100 }),
              assignment({ gradeSpan: { min: 4, max: 4 }, timeMinutesPerWeek: 100 }),
            ],
          }),
        ],
      }),
    );
    expect(rowsOf(csv).map((row) => row[col("Verksamhetstyp")])).toEqual(["5", ""]);
    expect(notices.map((entry) => entry.code)).toEqual(["NOT_HT2026", "FORM_WITHOUT_CODE", "GRADE_WITHOUT_TIMPLAN"]);
  });
});
