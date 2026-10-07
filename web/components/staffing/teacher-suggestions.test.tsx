import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { TeacherCandidate, TeacherSuggestions as Suggestions } from "@/lib/types";
import { TeacherSuggestions, remainingOf } from "./teacher-suggestions";

const assign = vi.hoisted(() => vi.fn());
const suggestions = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
}));

vi.mock("@/lib/staffing-queries", () => ({
  useSuggestTeachers: () => suggestions,
  useAssignTeacher: () => ({ mutateAsync: assign, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${namespace === "engineMessages" ? "engine:" : ""}${key}${
        values ? `(${Object.values(values).join("|")})` : ""
      }`;
    // The engine catalogue knows the two staffing codes and nothing else.
    t.has = (key: string) => key.startsWith("STAFF_");
    return t;
  },
}));

const candidate = (overrides: Partial<TeacherCandidate>): TeacherCandidate => ({
  userId: "t-x",
  qualificationKind: null,
  teachesSubjectAlready: false,
  teachesGroupAlready: false,
  currentlyAssigned: false,
  remainingMinutesPerWeek: null,
  wouldExceed: false,
  status: "NO_TARGET",
  ...overrides,
});

/** As the gateway ranks them: behörighet, then the group, then room left. */
const ranked: Suggestions = {
  requirementId: "r-7a-ma",
  subjectId: "s-ma",
  studentGroupId: "g-7a",
  gradeSpan: { min: 7, max: 7 },
  teacherMinutesPerWeek: 180,
  qualificationsRecorded: true,
  candidates: [
    candidate({
      userId: "t-anna",
      qualificationKind: "LEGITIMATION",
      teachesGroupAlready: true,
      remainingMinutesPerWeek: 120,
      status: "UNDER",
    }),
    candidate({
      userId: "t-bo",
      qualificationKind: "BEHORIG",
      remainingMinutesPerWeek: -150,
      wouldExceed: true,
      status: "OVER",
    }),
    candidate({ userId: "t-cilla" }),
  ],
};

const names: Record<string, string> = { "t-anna": "Anna Ek", "t-bo": "Bo Alm", "t-cilla": "Cilla Öst" };

const renderList = (props: Partial<React.ComponentProps<typeof TeacherSuggestions>> = {}) => {
  const onAssigned = vi.fn();
  render(
    <TeacherSuggestions
      requirementId="r-7a-ma"
      currentTeacherId={null}
      teacherName={(id) => names[id] ?? id}
      onAssigned={onAssigned}
      {...props}
    />,
  );
  return { onAssigned };
};

const item = (name: string) => screen.getByText(name).closest("li")!;

describe("TeacherSuggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suggestions.data = ranked;
    suggestions.isLoading = false;
    suggestions.isError = false;
  });

  it("keeps the gateway's ranking and paints what each candidate brings", () => {
    renderList();
    const list = screen.getByRole("list", { name: "suggestListLabel" });
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-candidate"))).toEqual([
      "t-anna",
      "t-bo",
      "t-cilla",
    ]);
    expect(screen.getByText("suggestCharge(180)")).toBeInTheDocument();

    expect(within(item("Anna Ek")).getByText("kindLEGITIMATION")).toBeInTheDocument();
    expect(within(item("Anna Ek")).getByText("suggestTeachesGroup")).toBeInTheDocument();
    expect(within(item("Anna Ek")).getByText("candidateRemaining(120)")).toBeInTheDocument();

    expect(within(item("Bo Alm")).getByText("candidateOver(150)")).toBeInTheDocument();
    expect(within(item("Bo Alm")).getByText("suggestWouldExceed")).toBeInTheDocument();

    // No behörighet at all is said in words, never by colour alone.
    expect(within(item("Cilla Öst")).getByText("candidateUnqualified")).toBeInTheDocument();
    expect(within(item("Cilla Öst")).getByText("candidateNoTarget")).toBeInTheDocument();
  });

  it("assigns in one click, and hands WARN's sentence up with the saved row", async () => {
    const user = userEvent.setup();
    const warning = {
      code: "STAFF_TEACHER_OVER_TARGET",
      params: { role: "TEACHER", minutes: 1230, target: 1080, limit: 1188, tolerance: 10 },
    };
    assign.mockResolvedValue({ id: "r-7a-ma", teacherId: "t-bo", warnings: [warning] });
    const { onAssigned } = renderList();

    await user.click(screen.getByRole("button", { name: "suggestAssignNamed(Bo Alm)" }));

    expect(assign).toHaveBeenCalledWith({ requirementId: "r-7a-ma", teacherId: "t-bo" });
    expect(onAssigned).toHaveBeenCalledWith({ teacherId: "t-bo", warnings: [warning] });
  });

  it("shows REFUSE's 409 as the catalogue sentence under the list, and keeps the list open", async () => {
    const user = userEvent.setup();
    assign.mockRejectedValue(
      new ApiError(409, "Läraren saknar behörighet i Matematik för åk 7.", "STAFF_TEACHER_NOT_QUALIFIED", {
        role: "TEACHER",
        subject: "Matematik",
        grades: "7",
      }),
    );
    const { onAssigned } = renderList();

    await user.click(screen.getByRole("button", { name: "suggestAssignNamed(Cilla Öst)" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("refusedTitle");
    expect(alert).toHaveTextContent("engine:STAFF_TEACHER_NOT_QUALIFIED(TEACHER|Matematik|7)");
    // Never the person: the sentence is the subject and the grades.
    expect(alert).not.toHaveTextContent("Cilla");
    expect(onAssigned).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "suggestListLabel" })).toBeInTheDocument();
  });

  it("marks the current lead instead of offering them, and can take the row off them", async () => {
    const user = userEvent.setup();
    suggestions.data = {
      ...ranked,
      candidates: [candidate({ userId: "t-anna", currentlyAssigned: true }), ...ranked.candidates.slice(1)],
    };
    assign.mockResolvedValue({ id: "r-7a-ma", teacherId: null, warnings: [] });
    const { onAssigned } = renderList({ currentTeacherId: "t-anna" });

    expect(within(item("Anna Ek")).getByText("suggestCurrent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "suggestAssignNamed(Anna Ek)" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "suggestUnassign" }));
    expect(assign).toHaveBeenCalledWith({ requirementId: "r-7a-ma", teacherId: null });
    expect(onAssigned).toHaveBeenCalledWith({ teacherId: null, warnings: [] });
  });

  it("shows the first six and the rest on request", async () => {
    const user = userEvent.setup();
    suggestions.data = {
      ...ranked,
      candidates: Array.from({ length: 8 }, (_, index) => candidate({ userId: `t-${index}` })),
    };
    renderList();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "suggestShowAll(8)" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
  });

  it("says when the school has no behörigheter, so the ranking's basis is visible", () => {
    suggestions.data = { ...ranked, qualificationsRecorded: false };
    renderList();
    expect(screen.getByText(/suggestNoQualifications/)).toBeInTheDocument();
    // And no candidate is painted unqualified for it.
    expect(screen.queryByText("candidateUnqualified")).toBeNull();
  });
});

describe("remainingOf", () => {
  it("reads null as no target, a negative balance as over", () => {
    expect(remainingOf({ remainingMinutesPerWeek: null })).toEqual({ status: "NO_TARGET" });
    expect(remainingOf({ remainingMinutesPerWeek: 0 })).toEqual({ status: "REMAINING", minutes: 0 });
    expect(remainingOf({ remainingMinutesPerWeek: -40 })).toEqual({ status: "OVER", minutes: 40 });
  });
});
