import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import { membershipsToCsv, studentsToCsv, teacherQualificationsToCsv } from "@/lib/csv-export";
import { teacherDutiesToCsv } from "@/lib/duties-csv-export";
import { markedAmong, readMarks, withoutMarked } from "@/lib/protected-people";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
const get = (api as unknown as { get: Mock }).get;

const person = (id: string, role: string, first: string, studentGroupId: string | null = null) => ({
  id,
  role,
  firstName: first,
  lastName: "Ek",
  email: `${first.toLowerCase()}@skola.se`,
  phone: null,
  isActive: true,
  studentGroupId,
});
const ALVA = person("p-alva", "STUDENT", "Alva", "g-7a");
const BO = person("p-bo", "STUDENT", "Bo", "g-7a");
const KARIN = person("t-karin", "TEACHER", "Karin");
const people = [ALVA, BO, KARIN];

describe("the marks of a protected identity, as the web's files read them", () => {
  // A block, not an arrow's value: vitest runs a function beforeEach returns
  // as the case's teardown, and the mock is one.
  beforeEach(() => {
    get.mockReset();
  });

  it("reads the school's marks from the gateway, at the call", async () => {
    get.mockResolvedValue([{ userId: "p-alva", source: "SS12000" }, { userId: "t-karin", source: "MANUAL" }]);
    await expect(readMarks()).resolves.toEqual(new Set(["p-alva", "t-karin"]));
    expect(get).toHaveBeenCalledWith("/api/v1/person-protections");
  });

  it("builds a file from the unmarked alone, and counts the marked of the file's role", async () => {
    get.mockResolvedValue([{ userId: "p-alva", source: "MANUAL" }, { userId: "t-karin", source: "MANUAL" }]);
    const file = await withoutMarked(people, "STUDENT", (kept) => studentsToCsv(kept, () => "7A"));
    expect(file.heldOut).toBe(1);
    expect(file.unit).toBe("people");
    expect(file.content).toContain("bo@skola.se");
    expect(file.content).not.toContain("alva@skola.se");
    expect(file.content).not.toContain("Alva");
  });

  it("counts by a test when the file's people are not one role", async () => {
    get.mockResolvedValue([{ userId: "p-alva", source: "MANUAL" }, { userId: "t-karin", source: "MANUAL" }]);
    const file = await withoutMarked(people, (p) => p.id === "t-karin", () => "x");
    expect(file.heldOut).toBe(1);
  });

  it("leaves every row naming a marked person out of a file keyed by e-mail: undervisningsgrupper, behörigheter, uppdrag", async () => {
    get.mockResolvedValue([{ userId: "p-alva", source: "SS12000" }, { userId: "t-karin", source: "MANUAL" }]);
    const groups = [{ id: "g-ma", name: "Ma7", kind: "TEACHING_GROUP", academicYearId: "y1" }];
    const memberships = [
      { studentGroupId: "g-ma", studentId: "p-alva" },
      { studentGroupId: "g-ma", studentId: "p-bo" },
    ];
    const members = await withoutMarked(people, "STUDENT", (kept) => membershipsToCsv(groups as never, kept, memberships));
    expect(members.content).toContain("bo@skola.se");
    expect(members.content).not.toContain("alva@skola.se");

    const subjects = [{ id: "s-ma", name: "Matematik", code: "MA" }];
    const qualifications = [{ userId: "t-karin", subjectId: "s-ma", gradeFrom: 7, gradeTo: 9, kind: "LEGITIMATION" }];
    const quals = await withoutMarked(people, "TEACHER", (kept) => teacherQualificationsToCsv(qualifications as never, kept, subjects));
    expect(quals.content).not.toContain("karin@skola.se");
    expect(quals.heldOut).toBe(1);

    const duties = [{ id: "d1", userId: "t-karin", kind: "OVRIGT", label: "Bibliotek", minutesPerWeek: 60, studentGroupId: null, academicYearId: "y1", validFrom: null, validTo: null, note: null }];
    const dutyFile = await withoutMarked(people, "TEACHER", (kept) => teacherDutiesToCsv(duties as never, kept, subjects, []));
    expect(dutyFile.content).not.toContain("karin@skola.se");
  });

  it("lets a failed read fail: the page downloads nothing rather than a file with them in it", async () => {
    get.mockRejectedValue(new Error("HTTP 500"));
    const build = vi.fn(() => "file");
    await expect(withoutMarked(people, "STUDENT", build)).rejects.toThrow("HTTP 500");
    expect(build).not.toHaveBeenCalled();
  });

  it("counts the marked among a kept file's people, each once", async () => {
    get.mockResolvedValue([{ userId: "t-karin", source: "MANUAL" }]);
    await expect(markedAmong(["t-karin", "t-karin", "p-bo"])).resolves.toBe(1);
  });
});
