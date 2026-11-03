import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcademicYear, Person, StudentGroup } from "@/lib/types";
import { STUDENT_BULK_KEYS, StudentsBulkDialogs, describeStudentRemoval } from "./students-bulk-dialogs";

// Echo the key and its values, so assertions read against stable text.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && Object.keys(values).length > 0 ? `${key}(${Object.values(values).join("|")})` : key,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const calls = vi.hoisted(() => ({
  base: "",
  keys: [] as unknown,
  remove: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/bulk-api", () => ({
  useBulkActions: (base: string, keys: unknown) => {
    calls.base = base;
    calls.keys = keys;
    return { remove: { mutateAsync: calls.remove }, update: { mutateAsync: calls.update } };
  },
}));

const YEARS = [
  { id: "year-1", name: "2026/2027", isActive: true },
  { id: "year-2", name: "2027/2028", isActive: false },
] as AcademicYear[];

const GROUPS = [
  { id: "g-7a", academicYearId: "year-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-7b", academicYearId: "year-1", name: "7B", kind: "CLASS", gradeLevel: 7 },
  { id: "g-ma71", academicYearId: "year-1", name: "Ma71", kind: "TEACHING_GROUP", gradeLevel: null },
  { id: "g-next-8a", academicYearId: "year-2", name: "8A", kind: "CLASS", gradeLevel: 8 },
] as StudentGroup[];

const pupil = (id: string, firstName: string, studentGroupId: string | null, isActive = true) =>
  ({ id, role: "STUDENT", firstName, lastName: "Berg", email: "", phone: null, isActive, invitedAt: null, studentGroupId }) as Person;

const PEOPLE = [pupil("st-1", "Alma", "g-7a"), pupil("st-2", "Nils", "g-7a"), pupil("st-3", "Ida", "g-7b", false)];

const open = (mode: "edit" | "delete", ids: string[]) => {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  render(
    <StudentsBulkDialogs
      mode={mode}
      ids={ids}
      people={PEOPLE}
      groups={GROUPS}
      years={YEARS}
      activeYearId="year-1"
      onClose={onClose}
      onDeleted={onDeleted}
    />,
  );
  return { onClose, onDeleted };
};

const choose = async (field: string, option: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
};

describe("describeStudentRemoval", () => {
  const t = (key: string, values?: Record<string, number>) => (values ? `${key}(${values.count})` : key);
  const none = {
    memberships: 0,
    enrolments: 0,
    guardianLinks: 0,
    absenceReports: 0,
    leaveRequests: 0,
    attendanceMarks: 0,
    logins: 0,
    fromSource: 0,
  };

  it("says what goes with the pupils, nothing for a count of 0, and that making them inactive keeps it", () => {
    expect(describeStudentRemoval(t, { ...none, enrolments: 2, absenceReports: 5, logins: 1, fromSource: 2 })).toEqual({
      goes: ["studentConsequences.enrolments(2)", "studentConsequences.absenceReports(5)", "studentConsequences.logins(1)"],
      loses: [],
      notes: ["fromSource(2)", "studentConsequences.deactivateInstead"],
    });
  });
});

describe("StudentsBulkDialogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes through the pupils' bulk routes and makes the register stale", () => {
    open("edit", ["st-1"]);
    expect(calls.base).toBe("/api/v1/users/students");
    expect(calls.keys).toBe(STUDENT_BULK_KEYS);
    expect(STUDENT_BULK_KEYS).toEqual(expect.arrayContaining([["people"], ["groupMemberships"], ["lessonRoster"]]));
  });

  it("moves the ticked pupils to a class of the active läsår, and leaves their status alone", async () => {
    calls.update.mockResolvedValue({ applied: true, dryRun: false, done: ["st-1", "st-2"], refused: [] });
    const { onClose } = open("edit", ["st-1", "st-2"]);
    const classes = screen.getByRole("combobox", { name: "studentFields.class" });
    expect(classes).toHaveTextContent("7A");
    await userEvent.setup().click(classes);
    // This year's classes, not next year's 8A or a teaching group.
    const offered = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(offered).toEqual(["studentFields.classNone", "7A", "7B"]);
    await userEvent.setup().click(screen.getByRole("option", { name: "7B" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(2)" }));
    expect(calls.update).toHaveBeenCalledWith({ ids: ["st-1", "st-2"], changes: { studentGroupId: "g-7b" } });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("saved(2)");
  });

  it("shows Olika värden for pupils in different classes and statuses, and makes them inactive", async () => {
    calls.update.mockResolvedValue({ applied: true, dryRun: false, done: ["st-1", "st-3"], refused: [] });
    open("edit", ["st-1", "st-3"]);
    expect(screen.getByRole("combobox", { name: "studentFields.class" })).toHaveTextContent("mixed");
    expect(screen.getByRole("combobox", { name: "studentFields.status" })).toHaveTextContent("mixed");
    await choose("studentFields.status", "studentFields.inactive");
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(2)" }));
    expect(calls.update).toHaveBeenCalledWith({ ids: ["st-1", "st-3"], changes: { isActive: false } });
  });

  it("takes the pupils out of every class with Ingen klass, sent as null", async () => {
    calls.update.mockResolvedValue({ applied: true, dryRun: false, done: ["st-1"], refused: [] });
    open("edit", ["st-1"]);
    await choose("studentFields.class", "studentFields.classNone");
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(1)" }));
    expect(calls.update).toHaveBeenCalledWith({ ids: ["st-1"], changes: { studentGroupId: null } });
  });

  it("asks the delete's dry run of the ticked pupils, names them, and says what goes with them", async () => {
    calls.remove.mockResolvedValueOnce({
      applied: false,
      dryRun: true,
      done: ["st-1", "st-2"],
      refused: [],
      consequences: { memberships: 1, enrolments: 2, guardianLinks: 3, absenceReports: 0, leaveRequests: 0, attendanceMarks: 40, logins: 0, fromSource: 0 },
    });
    open("delete", ["st-1", "st-2"]);
    expect(await screen.findByText("studentConsequences.attendanceMarks(40)")).toBeInTheDocument();
    expect(screen.getByText("studentConsequences.guardianLinks(3)")).toBeInTheDocument();
    expect(screen.getByText("studentConsequences.deactivateInstead")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "goesTitle(students|2)" })).toHaveTextContent("Alma BergNils Berg");
    expect(calls.remove).toHaveBeenCalledWith({ ids: ["st-1", "st-2"], dryRun: true });
  });
});
