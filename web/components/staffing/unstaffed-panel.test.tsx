import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnstaffedRequirement } from "@/lib/teacher-load";
import { UNSTAFFED_ANCHOR, UnstaffedPanel } from "./unstaffed-panel";

const assign = vi.hoisted(() => vi.fn());
const asked = vi.hoisted(() => ({ ids: [] as unknown[] }));

vi.mock("@/lib/staffing-queries", () => ({
  useSuggestTeachers: (requirementId: unknown) => {
    asked.ids.push(requirementId);
    return {
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
            currentlyAssigned: false,
            remainingMinutesPerWeek: 120,
            wouldExceed: false,
            status: "UNDER",
          },
        ],
      },
    };
  },
  useAssignTeacher: () => ({ mutateAsync: assign, isPending: false }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => true;
    return t;
  },
}));

const row = (overrides: Partial<UnstaffedRequirement>): UnstaffedRequirement => ({
  requirementId: "r-7a-ma",
  subjectId: "s-ma",
  subjectName: "Matematik",
  studentGroupId: "g-7a",
  groupName: "7A",
  minutesPerWeek: 180,
  teacherMinutesPerWeek: 180,
  gradeSpan: null,
  ...overrides,
});

describe("UnstaffedPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asked.ids = [];
  });

  it("lists the rows with the minutes they charge a teacher, under the anchor the generate page links to", () => {
    const { container } = render(
      <UnstaffedPanel
        rows={[row({}), row({ requirementId: "r-7b-no", subjectName: "NO", groupName: "7B", teacherMinutesPerWeek: 90 })]}
        teacherName={(id) => id}
        onAssigned={vi.fn()}
      />,
    );
    expect(container.querySelector(`#${UNSTAFFED_ANCHOR}`)).not.toBeNull();
    expect(screen.getByText("unstaffedRow(7A|Matematik|180)")).toBeInTheDocument();
    expect(screen.getByText("unstaffedRow(7B|NO|90)")).toBeInTheDocument();
    // Nothing is ranked until a row asks: forty rows must not cost forty calls.
    expect(asked.ids).toEqual([]);
  });

  it("opens one row's suggestions, assigns in one click, and passes WARN's findings up", async () => {
    const user = userEvent.setup();
    const onAssigned = vi.fn();
    const warning = {
      code: "STAFF_TEACHER_NOT_QUALIFIED",
      params: { role: "TEACHER", subject: "Matematik", grades: "7" },
    };
    assign.mockResolvedValue({ id: "r-7a-ma", warnings: [warning] });
    render(
      <UnstaffedPanel
        rows={[row({}), row({ requirementId: "r-7b-no", groupName: "7B" })]}
        teacherName={(id) => (id === "t-anna" ? "Anna Ek" : id)}
        onAssigned={onAssigned}
      />,
    );
    const first = screen.getByText("unstaffedRow(7A|Matematik|180)").closest("li")!;
    const toggle = within(first).getByRole("button", { name: "suggestTeachers" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(asked.ids).toContain("r-7a-ma");
    expect(asked.ids).not.toContain("r-7b-no");

    await user.click(within(first).getByRole("button", { name: "suggestAssignNamed(Anna Ek)" }));
    expect(assign).toHaveBeenCalledWith({ requirementId: "r-7a-ma", teacherId: "t-anna" });
    expect(onAssigned).toHaveBeenCalledWith([warning]);
    // The list closes; the row itself leaves when the report refetches.
    expect(within(first).queryByRole("list")).toBeNull();
  });

  it("says when every row has a teacher", () => {
    render(<UnstaffedPanel rows={[]} teacherName={(id) => id} onAssigned={vi.fn()} />);
    expect(screen.getByText("unstaffedEmpty")).toBeInTheDocument();
  });
});
