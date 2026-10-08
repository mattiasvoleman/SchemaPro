import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeacherRequirementsCard } from "./teacher-requirements-card";

const assign = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staffing-queries", () => ({
  useSuggestTeachers: (requirementId: string) => ({
    isLoading: false,
    isError: false,
    data: {
      requirementId,
      subjectId: "s-ma",
      studentGroupId: "g-7a",
      gradeSpan: null,
      teacherMinutesPerWeek: 180,
      qualificationsRecorded: true,
      candidates: [
        {
          userId: "t-anna",
          qualificationKind: "LEGITIMATION",
          teachesSubjectAlready: true,
          teachesGroupAlready: true,
          currentlyAssigned: true,
          remainingMinutesPerWeek: 300,
          wouldExceed: false,
          status: "UNDER",
        },
        {
          userId: "t-bo",
          qualificationKind: "BEHORIG",
          teachesSubjectAlready: false,
          teachesGroupAlready: false,
          currentlyAssigned: false,
          remainingMinutesPerWeek: -60,
          wouldExceed: true,
          status: "OVER",
        },
      ],
    },
  }),
  useAssignTeacher: () => ({ mutateAsync: assign, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${namespace === "engineMessages" ? "engine:" : ""}${key}${
        values ? `(${Object.values(values).join("|")})` : ""
      }`;
    t.has = () => true;
    return t;
  },
}));

const rows = [
  { id: "r1", subjectId: "s-ma", studentGroupId: "g-7a", teacherId: "t-anna", coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60 },
  { id: "r2", subjectId: "s-no", studentGroupId: "g-7a", teacherId: "t-bo", coTeacherId: "t-anna", lessonsPerWeek: 2, minutesPerLesson: 60 },
  { id: "r3", subjectId: "s-ma", studentGroupId: "g-7b", teacherId: "t-cilla", coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60 },
];
const subjects: Record<string, string> = { "s-ma": "Matematik", "s-no": "NO" };
const groups: Record<string, string> = { "g-7a": "7A", "g-7b": "7B" };
const names: Record<string, string> = { "t-anna": "Anna Ek", "t-bo": "Bo Alm" };

const renderCard = () =>
  render(
    <TeacherRequirementsCard
      teacherId="t-anna"
      rows={rows}
      subjectName={(id) => subjects[id]!}
      groupName={(id) => groups[id]!}
      teacherName={(id) => names[id] ?? id}
    />,
  );

describe("TeacherRequirementsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists the rows the teacher leads and co-teaches, and offers a handover only where they lead", () => {
    renderCard();
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("7A · Matematik"),
      expect.stringContaining("7A · NO"),
    ]);
    expect(within(items[0]!).getByRole("button", { name: "changeTeacherFor(7A · Matematik)" })).toBeInTheDocument();
    expect(within(items[1]!).getByText(/teacherRowCoTeacher/)).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
  });

  it("states a uniform row as it always did and a split row as its lengths", () => {
    render(
      <TeacherRequirementsCard
        teacherId="t-anna"
        rows={[
          rows[0]!,
          { ...rows[1]!, teacherId: "t-anna", coTeacherId: null, lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] },
        ]}
        subjectName={(id) => subjects[id]!}
        groupName={(id) => groups[id]!}
        teacherName={(id) => names[id] ?? id}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("teacherRowLessons(3 × 60)");
    expect(items[1]).toHaveTextContent("teacherRowLessons(1 × 80 + 1 × 40)");
  });

  it("hands a row on and keeps WARN's sentence on screen in the card", async () => {
    const user = userEvent.setup();
    const warning = {
      code: "STAFF_TEACHER_OVER_TARGET",
      params: { role: "TEACHER", minutes: 1260, target: 1080, limit: 1188, tolerance: 10 },
    };
    assign.mockResolvedValue({ id: "r1", teacherId: "t-bo", warnings: [warning] });
    renderCard();
    await user.click(screen.getByRole("button", { name: "changeTeacherFor(7A · Matematik)" }));
    // The current teacher is marked, not offered.
    expect(screen.getByText("suggestCurrent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "suggestAssignNamed(Bo Alm)" }));
    expect(assign).toHaveBeenCalledWith({ requirementId: "r1", teacherId: "t-bo" });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("warnedTitle");
    expect(status).toHaveTextContent("engine:STAFF_TEACHER_OVER_TARGET(TEACHER|1260|1080|1188|10)");
    await user.click(screen.getByRole("button", { name: "warnedDismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
