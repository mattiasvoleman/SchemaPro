/**
 * Every file the app exports, read back by the importer that takes it.
 *
 * One school's data, written by the export each page offers, saved the ways a
 * school saves a CSV — untouched, and opened and saved again in Excel as
 * "CSV (semikolonavgränsad)" (Windows-1252), as Excel for Mac's CSV (Mac
 * Roman), as "CSV UTF-8" and as an English-locale Excel's comma file — and
 * then read by the dialog's own path: bytes, decodeCsvBytes, parseCsv, the
 * kind's mapper. What comes out must be the rows the gateway's DTO takes,
 * carrying everything the export put in, with no error.
 *
 * There is no Excel on the machine that wrote this; asExcelSaved writes what
 * Excel's CSV formats write: the code page, CRLF, the delimiter of the
 * locale, quotes only around a cell that needs them, no BOM except in CSV
 * UTF-8, and a "?" for a character the code page lacks.
 */
import { describe, expect, it } from "vitest";
import {
  classesToCsv,
  decodeCsvBytes,
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
  membershipsToCsv,
  parseCsv,
  requirementsToCsv,
  roomTypesToCsv,
  roomsToCsv,
  studentsToCsv,
  subjectsToCsv,
  teacherQualificationsToCsv,
  teachersToCsv,
  type ParsedCsv,
} from "@/lib/csv";
import { teacherDutiesToCsv } from "@/lib/duties-csv-export";
import { mapTimplanRows, timplanToCsv } from "@/lib/timplan-csv";

// ---------------------------------------------------------------------------
// How a file is saved
// ---------------------------------------------------------------------------

type Save = "untouched" | "excel-windows" | "excel-mac" | "excel-utf8" | "excel-english";

const SAVES: Save[] = ["untouched", "excel-windows", "excel-mac", "excel-utf8", "excel-english"];

/** A single-byte code page as an encoder, built from the platform's own decoder. */
function codePage(label: string): (text: string) => Uint8Array {
  const decoder = new TextDecoder(label);
  const byChar = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    const char = decoder.decode(new Uint8Array([byte]));
    if (!byChar.has(char)) byChar.set(char, byte);
  }
  return (text) => Uint8Array.from([...text].map((char) => byChar.get(char) ?? 0x3f));
}

const windows1252 = codePage("windows-1252");
const macRoman = codePage("macintosh");

/** One cell as Excel writes it: quoted only when it holds the delimiter, a quote or a line break. */
function excelCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** An exported file as it reaches the dialog after a save. */
function saved(csv: string, save: Save): Uint8Array {
  if (save === "untouched") return new TextEncoder().encode(csv);
  const { headers, rows } = parseCsv(csv);
  const delimiter = save === "excel-english" ? "," : ";";
  const text = [headers, ...rows].map((row) => row.map((cell) => excelCell(cell, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
  switch (save) {
    case "excel-windows":
      return windows1252(text);
    case "excel-mac":
      return macRoman(text);
    case "excel-utf8":
      return new TextEncoder().encode(`﻿${text}`);
    default:
      // An English Excel saves its plain CSV in 1252 too.
      return windows1252(text);
  }
}

/** The dialog's path from a chosen file's bytes to rows: decode, parse, map. */
function readBack(
  bytes: Uint8Array,
  mapper: (parsed: ParsedCsv) => { rows: unknown[]; errors: unknown[] },
): { rows: unknown[]; errors: unknown[] } {
  const decoded = decodeCsvBytes(bytes);
  expect(decoded.problem).toBeNull();
  return mapper(parseCsv(decoded.text));
}

// ---------------------------------------------------------------------------
// One school
// ---------------------------------------------------------------------------

const roomTypes = [
  { id: "rt-tm", name: "Trä- och metallslöjd" },
  { id: "rt-lab", name: "Laborationssal" },
];
const subjects = [
  { id: "s-ma", name: "Matematik", code: "MA", color: "#2563eb", requiredRoomTypeId: null, nationalCode: "MA", countsTowardTimplan: true },
  { id: "s-sl", name: "Slöjd", code: "SL", color: "#65a30d", requiredRoomTypeId: "rt-tm", nationalCode: "SL", countsTowardTimplan: true },
  { id: "s-sv", name: "Svenska", code: "SV", color: "#dc2626", requiredRoomTypeId: null, nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "s-hkk", name: 'Hem- och konsumentkunskap "HKK"; teori', code: "HKK", color: "#0f766e", requiredRoomTypeId: null, nationalCode: null, countsTowardTimplan: true },
  { id: "s-mt", name: "Mentorstid", code: "MT", color: null, requiredRoomTypeId: null, nationalCode: null, countsTowardTimplan: false },
  { id: "s-sh", name: "Studiehandledning", code: null, color: null, requiredRoomTypeId: null, nationalCode: null, countsTowardTimplan: true },
  { id: "s-ke", name: "Kemi", code: null, color: null, requiredRoomTypeId: "rt-lab", nationalCode: "KE", countsTowardTimplan: true },
];
const groups = [
  { id: "g-7a", name: "7A", kind: "CLASS", gradeLevel: 7, halfOfId: null, replacesSubjectId: null },
  { id: "g-7b", name: "7B", kind: "CLASS", gradeLevel: 7, halfOfId: null, replacesSubjectId: null },
  { id: "g-7b1", name: "7B grupp 1", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7b", replacesSubjectId: null },
  { id: "g-7b2", name: "7B grupp 2", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7b", replacesSubjectId: null },
  { id: "g-ma71", name: "Ma71", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null, replacesSubjectId: null },
  { id: "g-stod", name: "Sv-stöd 7", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: null, replacesSubjectId: null },
  { id: "g-sva", name: "SvA 7", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: null, replacesSubjectId: "s-sv" },
];
const people = [
  { id: "t-karin", role: "TEACHER", firstName: "Karin", lastName: "Andersson", email: "karin.andersson@skola.se", phone: "+46 70 123 45 67", studentGroupId: null },
  { id: "t-asa", role: "TEACHER", firstName: "Åsa", lastName: "Öberg-Ek", email: "asa.oberg@skola.se", studentGroupId: null },
  { id: "t-erik", role: "TEACHER", firstName: "Erik", lastName: "Johansson", email: "erik.johansson@skola.se", studentGroupId: null },
  { id: "p-noah", role: "STUDENT", firstName: "Noah", lastName: "Sjö", email: "noah.sjö.7b@skola.se", phone: "070-123 45 67", studentGroupId: "g-7b" },
  { id: "p-elsa", role: "STUDENT", firstName: "Elsa", lastName: "Berg", email: "elsa.berg.7a@skola.se", studentGroupId: "g-7a" },
  { id: "p-osten", role: "STUDENT", firstName: "Östen", lastName: "Åberg-Ärlig", email: "osten.aberg@skola.se", studentGroupId: null },
  { id: "p-dash", role: "STUDENT", firstName: "-Lisa", lastName: "=Lund", email: "lisa.lund@skola.se", studentGroupId: "g-7a" },
];
const employments = new Map([
  ["t-karin", { employmentPercent: 100, reductionPercent: 0, contractKind: "FERIE" as const, signature: "KAN" }],
  ["t-asa", { employmentPercent: 66.667, reductionPercent: 12.5, contractKind: "SEMESTER" as const, signature: "ÅSÖ" }],
  ["t-erik", { employmentPercent: 80, reductionPercent: 0, contractKind: "FERIE" as const, signature: null }],
]);
const memberships = [
  { studentGroupId: "g-7b1", studentId: "p-noah" },
  { studentGroupId: "g-ma71", studentId: "p-elsa" },
  { studentGroupId: "g-ma71", studentId: "p-noah" },
];
const qualifications = [
  { userId: "t-karin", subjectId: "s-ma", minGradeLevel: 7, maxGradeLevel: 9, kind: "LEGITIMATION" as const },
  { userId: "t-asa", subjectId: "s-sv", minGradeLevel: 4, maxGradeLevel: 6, kind: "BEHORIG" as const },
  { userId: "t-erik", subjectId: "s-sl", minGradeLevel: 1, maxGradeLevel: 9, kind: "TILLATEN" as const },
];
const duties = [
  { userId: "t-karin", kind: "MENTORSKAP" as const, label: "Mentor 7A", minutesPerWeek: 90, countsAsTeaching: false, subjectId: null, studentGroupId: "g-7a", validFrom: "2026-08-17", validTo: "2026-12-18", note: null },
  { userId: "t-asa", kind: "APT_KONFERENS" as const, label: "APT", minutesPerWeek: 120, countsAsTeaching: false, subjectId: null, studentGroupId: null, validFrom: null, validTo: null, note: "Möte; varannan vecka\nRum B1" },
  { userId: "t-erik", kind: "AMNESANSVAR" as const, label: "Ämnesansvar slöjd", minutesPerWeek: 60, countsAsTeaching: true, subjectId: "s-sl", studentGroupId: null, validFrom: null, validTo: null, note: null },
  { userId: "t-erik", kind: "PEDAGOGISK_LUNCH" as const, label: "Lunch", minutesPerWeek: 100, countsAsTeaching: false, subjectId: null, studentGroupId: null, validFrom: null, validTo: null, note: null },
  { userId: "t-erik", kind: "VFU_HANDLEDNING" as const, label: "VFU", minutesPerWeek: 30, countsAsTeaching: false, subjectId: null, studentGroupId: null, validFrom: null, validTo: null, note: null },
  { userId: "t-asa", kind: "FORSTELARARE" as const, label: "Förstelärare", minutesPerWeek: 240, countsAsTeaching: true, subjectId: null, studentGroupId: null, validFrom: null, validTo: null, note: null },
];
const requirement = (fields: Partial<Requirement>): Requirement => ({
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  teacherId: "t-karin",
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  minutesBefore: 0,
  minutesAfter: 0,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  ...fields,
});
type Requirement = Parameters<typeof requirementsToCsv>[0][number];
const requirements = [
  requirement({}),
  requirement({ studentGroupId: "g-7b1", subjectId: "s-sl", teacherId: "t-erik", coTeacherId: "t-asa", coTeacherLoadPercent: 50, lessonsPerWeek: 1, minutesPerLesson: 120, recurrence: "ODD_WEEKS" }),
  requirement({ studentGroupId: "g-stod", subjectId: "s-sv", teacherId: "t-asa", lessonsPerWeek: 2, minutesPerLesson: 45, startDate: "2026-08-17", endDate: "2026-09-24" }),
  requirement({ subjectId: "s-hkk", teacherId: null, lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }),
  requirement({ subjectId: "s-sh", teacherId: "t-asa", minutesBefore: 10, minutesAfter: 20, recurrence: "EVEN_WEEKS" }),
];

// ---------------------------------------------------------------------------
// Per kind: the export as the page builds it, and what must come back
// ---------------------------------------------------------------------------

const rooms = [
  { name: "Sal A1", code: "A1", capacity: 30, roomTypeId: null, minGradeLevel: 7, maxGradeLevel: 9, building: "Hus A", floor: 1 },
  { name: "Slöjdsal; trä", code: "SL1", capacity: 16, roomTypeId: "rt-tm", minGradeLevel: null, maxGradeLevel: null, building: "Hus B", floor: -1 },
  { name: "Labbet", code: null, capacity: null, roomTypeId: "rt-lab", minGradeLevel: 4, maxGradeLevel: 9, building: null, floor: null },
];

const KINDS = {
  rooms: {
    csv: () => roomsToCsv(rooms, roomTypes),
    read: mapRoomRows,
    expected: [
      { name: "Sal A1", code: "A1", roomType: null, capacity: 30, minGradeLevel: 7, maxGradeLevel: 9, building: "Hus A", floor: 1 },
      { name: "Slöjdsal; trä", code: "SL1", roomType: "Trä- och metallslöjd", capacity: 16, minGradeLevel: null, maxGradeLevel: null, building: "Hus B", floor: -1 },
      { name: "Labbet", code: null, roomType: "Laborationssal", capacity: null, minGradeLevel: 4, maxGradeLevel: 9, building: null, floor: null },
    ],
  },
  roomTypes: {
    csv: () => roomTypesToCsv(roomTypes),
    read: mapRoomTypeRows,
    expected: [{ name: "Trä- och metallslöjd" }, { name: "Laborationssal" }],
  },
  subjects: {
    csv: () => subjectsToCsv(subjects, (id) => roomTypes.find((type) => type.id === id)?.name ?? ""),
    read: mapSubjectRows,
    // Code, colour and room type are null where the subject has none: an empty
    // string was a 400 for the whole file.
    expected: [
      { name: "Matematik", code: "MA", color: "#2563eb", roomType: null, nationalCode: "MA", countsTowardTimplan: true },
      { name: "Slöjd", code: "SL", color: "#65a30d", roomType: "Trä- och metallslöjd", nationalCode: "SL", countsTowardTimplan: true },
      { name: "Svenska", code: "SV", color: "#dc2626", roomType: null, nationalCode: "SV_SVA", countsTowardTimplan: true },
      { name: 'Hem- och konsumentkunskap "HKK"; teori', code: "HKK", color: "#0f766e", roomType: null, nationalCode: null, countsTowardTimplan: true },
      { name: "Mentorstid", code: "MT", color: null, roomType: null, nationalCode: null, countsTowardTimplan: false },
      { name: "Studiehandledning", code: null, color: null, roomType: null, nationalCode: null, countsTowardTimplan: true },
      { name: "Kemi", code: null, color: null, roomType: "Laborationssal", nationalCode: "KE", countsTowardTimplan: true },
    ],
  },
  classes: {
    csv: () => classesToCsv(groups, subjects),
    read: mapClassRows,
    expected: [
      { name: "7A", gradeLevel: 7, kind: "CLASS" },
      { name: "7B", gradeLevel: 7, kind: "CLASS" },
      { name: "Ma71", kind: "TEACHING_GROUP" },
      { name: "Sv-stöd 7", gradeLevel: 7, kind: "TEACHING_GROUP" },
      { name: "SvA 7", gradeLevel: 7, kind: "TEACHING_GROUP", replacesSubject: "SV" },
      // The halves last, after every class, so a batch cut never leaves a
      // half before its class; each keeps its row number.
      { name: "7B grupp 1", gradeLevel: 7, kind: "TEACHING_GROUP", halfOf: "7B" },
      { name: "7B grupp 2", gradeLevel: 7, kind: "TEACHING_GROUP", halfOf: "7B" },
    ],
  },
  teachers: {
    csv: () => teachersToCsv(people, (id) => employments.get(id)),
    read: mapTeacherRows,
    expected: [
      { firstName: "Karin", lastName: "Andersson", email: "karin.andersson@skola.se", phone: "+46 70 123 45 67", employmentPercent: 100, contractKind: "FERIE", signature: "KAN" },
      { firstName: "Åsa", lastName: "Öberg-Ek", email: "asa.oberg@skola.se", employmentPercent: 66.667, reductionPercent: 12.5, contractKind: "SEMESTER", signature: "ÅSÖ" },
      { firstName: "Erik", lastName: "Johansson", email: "erik.johansson@skola.se", employmentPercent: 80, contractKind: "FERIE" },
    ],
  },
  students: {
    csv: () => studentsToCsv(people, (id) => groups.find((group) => group.id === id)?.name ?? ""),
    read: mapStudentRows,
    expected: [
      { firstName: "Noah", lastName: "Sjö", email: "noah.sjö.7b@skola.se", phone: "070-123 45 67", className: "7B" },
      { firstName: "Elsa", lastName: "Berg", email: "elsa.berg.7a@skola.se", phone: null, className: "7A" },
      { firstName: "Östen", lastName: "Åberg-Ärlig", email: "osten.aberg@skola.se", phone: null, className: null },
      // The formula guard's apostrophe is written out and read away again.
      { firstName: "-Lisa", lastName: "=Lund", email: "lisa.lund@skola.se", phone: null, className: "7A" },
    ],
  },
  teachingGroups: {
    csv: () => membershipsToCsv(groups, people, memberships),
    read: mapMembershipRows,
    expected: [
      { groupName: "7B grupp 1", email: "noah.sjö.7b@skola.se" },
      { groupName: "Ma71", email: "elsa.berg.7a@skola.se" },
      { groupName: "Ma71", email: "noah.sjö.7b@skola.se" },
    ],
  },
  teacherQualifications: {
    csv: () => teacherQualificationsToCsv(qualifications, people, subjects),
    read: mapTeacherQualificationRows,
    expected: [
      { teacherEmail: "karin.andersson@skola.se", subject: "MA", minGrade: 7, maxGrade: 9, kind: "LEGITIMATION" },
      { teacherEmail: "asa.oberg@skola.se", subject: "SV", minGrade: 4, maxGrade: 6, kind: "BEHORIG" },
      { teacherEmail: "erik.johansson@skola.se", subject: "SL", minGrade: 1, maxGrade: 9, kind: "TILLATEN" },
    ],
  },
  teacherDuties: {
    csv: () => teacherDutiesToCsv(duties, people, subjects, groups),
    read: mapTeacherDutyRows,
    expected: [
      { teacherEmail: "karin.andersson@skola.se", kind: "MENTORSKAP", label: "Mentor 7A", minutesPerWeek: 90, countsAsTeaching: false, subject: null, groupName: "7A", validFrom: "2026-08-17", validTo: "2026-12-18", note: null },
      { teacherEmail: "asa.oberg@skola.se", kind: "APT_KONFERENS", label: "APT", minutesPerWeek: 120, countsAsTeaching: false, subject: null, groupName: null, validFrom: null, validTo: null, note: "Möte; varannan vecka\nRum B1" },
      { teacherEmail: "erik.johansson@skola.se", kind: "AMNESANSVAR", label: "Ämnesansvar slöjd", minutesPerWeek: 60, countsAsTeaching: true, subject: "SL", groupName: null, validFrom: null, validTo: null, note: null },
      { teacherEmail: "erik.johansson@skola.se", kind: "PEDAGOGISK_LUNCH", label: "Lunch", minutesPerWeek: 100, countsAsTeaching: false, subject: null, groupName: null, validFrom: null, validTo: null, note: null },
      { teacherEmail: "erik.johansson@skola.se", kind: "VFU_HANDLEDNING", label: "VFU", minutesPerWeek: 30, countsAsTeaching: false, subject: null, groupName: null, validFrom: null, validTo: null, note: null },
      { teacherEmail: "asa.oberg@skola.se", kind: "FORSTELARARE", label: "Förstelärare", minutesPerWeek: 240, countsAsTeaching: true, subject: null, groupName: null, validFrom: null, validTo: null, note: null },
    ],
  },
  requirements: {
    csv: () => requirementsToCsv(requirements, groups, subjects, people),
    read: mapRequirementRows,
    expected: [
      { groupName: "7A", subject: "MA", lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [], minutesBefore: 0, minutesAfter: 0, teacherEmail: "karin.andersson@skola.se", coTeacherEmail: null, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: "ALL_WEEKS", startDate: null, endDate: null },
      { groupName: "7B grupp 1", subject: "SL", lessonsPerWeek: 1, minutesPerLesson: 120, lessonLengths: [], minutesBefore: 0, minutesAfter: 0, teacherEmail: "erik.johansson@skola.se", coTeacherEmail: "asa.oberg@skola.se", teacherLoadPercent: 100, coTeacherLoadPercent: 50, recurrence: "ODD_WEEKS", startDate: null, endDate: null },
      { groupName: "Sv-stöd 7", subject: "SV", lessonsPerWeek: 2, minutesPerLesson: 45, lessonLengths: [], minutesBefore: 0, minutesAfter: 0, teacherEmail: "asa.oberg@skola.se", coTeacherEmail: null, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: "ALL_WEEKS", startDate: "2026-08-17", endDate: "2026-09-24" },
      { groupName: "7A", subject: "HKK", lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40], minutesBefore: 0, minutesAfter: 0, teacherEmail: null, coTeacherEmail: null, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: "ALL_WEEKS", startDate: null, endDate: null },
      { groupName: "7A", subject: "Studiehandledning", lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [], minutesBefore: 10, minutesAfter: 20, teacherEmail: "asa.oberg@skola.se", coTeacherEmail: null, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: "EVEN_WEEKS", startDate: null, endDate: null },
    ],
  },
  localTimplan: {
    csv: () =>
      timplanToCsv(
        [
          { subjectId: "s-ma", gradeLevel: 0, minutesPerWeek: 120, note: null },
          { subjectId: "s-ma", gradeLevel: 1, minutesPerWeek: 236, note: "Lågstadiet; första året" },
          { subjectId: "s-sh", gradeLevel: 8, minutesPerWeek: 40, note: "Skolans val" },
        ],
        subjects,
      ),
    read: mapTimplanRows,
    expected: [
      { subject: "MA", gradeLevel: 0, minutesPerWeek: 120, note: "" },
      { subject: "MA", gradeLevel: 1, minutesPerWeek: 236, note: "Lågstadiet; första året" },
      { subject: "Studiehandledning", gradeLevel: 8, minutesPerWeek: 40, note: "Skolans val" },
    ],
  },
} satisfies Record<string, { csv: () => string; read: (parsed: ParsedCsv) => { rows: unknown[]; errors: unknown[] }; expected: unknown[] }>;

describe.each(Object.entries(KINDS))("%s: export, save, import", (_kind, { csv, read, expected }) => {
  it.each(SAVES)("comes back whole and without an error when the file is %s", (save) => {
    const { rows, errors } = readBack(saved(csv(), save), read);

    expect(errors).toEqual([]);
    expect(rows).toStrictEqual(expected);
  });
});

describe("the files themselves", () => {
  it("are what Swedish Excel opens: a BOM, semicolons, CRLF", () => {
    for (const { csv } of Object.values(KINDS)) {
      const file = csv();
      expect(file.startsWith("﻿")).toBe(true);
      expect(file.endsWith("\r\n")).toBe(true);
      expect(file.split("\r\n")[0]).not.toContain("\n");
      expect(parseCsv(file).delimiter).toBe(";");
    }
  });

  it("write a post's percentages with a decimal comma, as Swedish Excel reads and saves a number", () => {
    // 12.5 is a date (12 May) to a Swedish Excel; 12,5 is the number.
    const line = KINDS.teachers.csv().split("\r\n").find((row) => row.startsWith("Åsa"));
    expect(line).toBe("Åsa;Öberg-Ek;asa.oberg@skola.se;;66,667;12,5;semester;ÅSÖ");
  });

  it("write the timplan's ombyte columns in Swedish like their neighbours", () => {
    expect(parseCsv(KINDS.requirements.csv()).headers).toEqual([
      "grupp",
      "amne",
      "lektioner_per_vecka",
      "minuter_per_lektion",
      "minuter_fore",
      "minuter_efter",
      "larare",
      "medlarare",
      "veckor",
      "fran",
      "till",
      "larare_procent",
      "medlarare_procent",
      "lektionslangder",
    ]);
  });

  it("read back an uppdrag kind the export writes for every kind there is", () => {
    const kinds = [
      "MENTORSKAP",
      "AMNESANSVAR",
      "FORSTELARARE",
      "RASTVAKT",
      "PEDAGOGISK_LUNCH",
      "APT_KONFERENS",
      "VFU_HANDLEDNING",
      "APL",
      "ANNAT",
    ] as const;
    const file = teacherDutiesToCsv(
      kinds.map((kind, index) => ({ ...duties[1]!, kind, label: `Uppdrag ${index}` })),
      people,
      subjects,
      groups,
    );
    expect(mapTeacherDutyRows(parseCsv(file)).rows.map((row) => row.kind)).toEqual([...kinds]);
  });

  it("leave out an uppdrag whose teacher, subject or group the lists cannot name, rather than write it blank", () => {
    const file = teacherDutiesToCsv(
      [
        { ...duties[0]!, userId: "t-gone" },
        { ...duties[0]!, studentGroupId: "g-other-year" },
        { ...duties[2]!, subjectId: "s-gone" },
      ],
      people,
      subjects,
      groups,
    );
    expect(parseCsv(file).rows).toEqual([]);
  });

  it("leave out a deactivated person and what hangs on them, which the import would refuse or make active", () => {
    // The import creates active people and resolves rows only to active ones:
    // a deactivated pupil's membership came back as "Ingen aktiv elev …".
    const gone = [
      { id: "t-gone", role: "TEACHER", firstName: "Gun", lastName: "Gone", email: "gun@skola.se", studentGroupId: null, isActive: false },
      { id: "p-gone", role: "STUDENT", firstName: "Per", lastName: "Gone", email: "per@skola.se", studentGroupId: "g-7a", isActive: false },
    ];
    const everyone = [...people, ...gone];
    const names = (csv: string) => parseCsv(csv).rows.map((row) => row.join(";"));

    expect(names(teachersToCsv(everyone, (id) => employments.get(id))).join()).not.toContain("gun@skola.se");
    expect(names(studentsToCsv(everyone, () => "7A")).join()).not.toContain("per@skola.se");
    expect(names(membershipsToCsv(groups, everyone, [...memberships, { studentGroupId: "g-ma71", studentId: "p-gone" }]))).toEqual(
      names(KINDS.teachingGroups.csv()),
    );
    expect(
      names(teacherQualificationsToCsv([...qualifications, { ...qualifications[0]!, userId: "t-gone" }], everyone, subjects)),
    ).toEqual(names(KINDS.teacherQualifications.csv()));
    expect(names(teacherDutiesToCsv([...duties, { ...duties[0]!, userId: "t-gone" }], everyone, subjects, groups))).toEqual(
      names(KINDS.teacherDuties.csv()),
    );
  });

  it("write no post for a reader the percentages are hidden from, rather than half a post the import refuses", () => {
    // Without HR-läs the post arrives with its percentages null and its avtal
    // and signatur shown; written so ("…;;;ferie;KAN") the import answered
    // "avtal eller signatur utan tjanst_procent".
    const hidden = (id: string) =>
      id === "t-karin" ? { employmentPercent: null, reductionPercent: null, contractKind: "FERIE" as const, signature: "KAN" } : undefined;
    const file = teachersToCsv(people, hidden);

    expect(file.split("\r\n").find((row) => row.startsWith("Karin"))).toBe(
      "Karin;Andersson;karin.andersson@skola.se;'+46 70 123 45 67;;;;",
    );
    const { rows, errors } = mapTeacherRows(parseCsv(file));
    expect(errors).toEqual([]);
    expect(rows[0]).toStrictEqual({
      firstName: "Karin",
      lastName: "Andersson",
      email: "karin.andersson@skola.se",
      phone: "+46 70 123 45 67",
    });
  });

  it("leave out a timplanspost whose teacher is deactivated, which the import would refuse", () => {
    const gone = { id: "t-gone", role: "TEACHER", firstName: "Gun", lastName: "Gone", email: "gun@skola.se", isActive: false };
    const file = requirementsToCsv(
      [...requirements, requirement({ subjectId: "s-sv", teacherId: "t-gone" }), requirement({ subjectId: "s-mt", coTeacherId: "t-gone" })],
      groups,
      subjects,
      [...people, gone],
    );

    expect(file).not.toContain("gun@skola.se");
    expect(mapRequirementRows(parseCsv(file)).rows).toStrictEqual(KINDS.requirements.expected);
  });

  it("write a class whose other half was deleted with the one half left, which the import takes (granskning-260-r2, N2)", () => {
    // The gateway's half of this round trip is import.service.spec.ts's
    // "takes the one half an export writes", with exactly these rows.
    const file = classesToCsv(
      [
        { id: "g-7b", name: "7B", kind: "CLASS", gradeLevel: 7, halfOfId: null, replacesSubjectId: null },
        { id: "g-7b2", name: "7B:2", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7b", replacesSubjectId: null },
      ],
      subjects,
    );

    const { rows, errors, rowNumbers } = mapClassRows(parseCsv(decodeCsvBytes(saved(file, "excel-windows")).text));
    expect(errors).toEqual([]);
    expect(rows).toStrictEqual([
      { name: "7B", gradeLevel: 7, kind: "CLASS" },
      { name: "7B:2", gradeLevel: 7, kind: "TEACHING_GROUP", halfOf: "7B" },
    ]);
    expect(rowNumbers).toEqual([2, 3]);
  });

  it("write uppdrag dates as days even when the gateway answers a timestamp", () => {
    const file = teacherDutiesToCsv(
      [{ ...duties[0]!, validFrom: "2026-08-17T00:00:00.000Z", validTo: "2026-12-18T00:00:00.000Z" }],
      people,
      subjects,
      groups,
    );
    expect(mapTeacherDutyRows(parseCsv(file)).rows[0]).toMatchObject({
      validFrom: "2026-08-17",
      validTo: "2026-12-18",
    });
  });
});
