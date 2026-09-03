import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GeneratePage from "./page";

/**
 * The first test file this page has had. The warning it covers is the only
 * thing here that decides whether a school learns BEFORE a run that some of its
 * lessons will ignore the rasts — the grid afterwards shows the band and the
 * lesson on top of it, never why.
 */

const state = vi.hoisted(() => ({
  job: undefined as unknown,
  requirements: [] as unknown[],
  groups: [] as unknown[],
  memberships: [] as unknown[],
  people: [] as unknown[],
}));

const noMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ activeYear: { id: "y-1", name: "2026/27" } }),
  useRequirements: () => ({ data: state.requirements }),
  useRooms: () => ({ data: [{ id: "r-1" }] }),
  usePeople: () => ({ data: state.people }),
  useGroups: () => ({ data: state.groups }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useStartOptimization: () => noMutation,
  useOptimizationJob: () => ({ data: state.job }),
  useOptimizationHistory: () => ({ data: [] }),
  useLunchSettings: () => ({ data: null }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  // The page asks `tConflicts.has(category)` before translating, so the echo
  // carries a `has` too — every key is "known", which is what the label test
  // wants: an unknown category would fall back to the raw string.
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values
        ? `${namespace}.${key}(${Object.values(values).join("|")})`
        : `${namespace}.${key}`;
    return Object.assign(t, { has: () => true });
  },
}));

const requirement = (studentGroupId: string) => ({
  id: `req-${studentGroupId}`,
  subjectId: "s-1",
  studentGroupId,
  teacherId: "t-1",
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
});
const pupil = (id: string, studentGroupId: string) => ({
  id,
  role: "STUDENT",
  isActive: true,
  firstName: "E",
  lastName: "Lev",
  email: `${id}@x`,
  phone: null,
  invitedAt: null,
  studentGroupId,
});

beforeEach(() => {
  cleanup();
  state.job = undefined;
  state.groups = [
    { id: "g-41", academicYearId: "y-1", name: "4.1", kind: "CLASS", gradeLevel: 4 },
    { id: "g-sl1", academicYearId: "y-1", name: "4sl1", kind: "TEACHING_GROUP", gradeLevel: null },
    { id: "g-ma1", academicYearId: "y-1", name: "4ma1", kind: "TEACHING_GROUP", gradeLevel: null },
  ];
  state.people = [pupil("p-1", "g-41")];
  // 4ma1 has a member whose home class is year four; 4sl1 has nobody.
  state.memberships = [{ studentId: "p-1", studentGroupId: "g-ma1" }];
  state.requirements = [requirement("g-sl1"), requirement("g-ma1"), requirement("g-41")];
});

describe("groups the timplan names but whose year cannot be derived", () => {
  it("names them before the run", () => {
    render(<GeneratePage />);
    const status = screen.getByRole("status");
    // 4sl1 alone: 4ma1 gets year four from its member, 4.1 from itself.
    expect(status.textContent).toContain("generate.noYearTitle(1)");
    expect(status.textContent).toContain("4sl1");
    expect(status.textContent).not.toContain("4ma1");
    expect(screen.getByRole("link", { name: "generate.noYearLink" })).toHaveAttribute(
      "href",
      "/admin/groups",
    );
  });

  it("says nothing when every named group has a year", () => {
    state.memberships.push({ studentId: "p-1", studentGroupId: "g-sl1" });
    render(<GeneratePage />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores a yearless group the timplan does not name", () => {
    // Nothing will be scheduled for it, so nothing can land across a rast.
    state.requirements = [requirement("g-41")];
    render(<GeneratePage />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a run that hit the time limit", () => {
  it("shows what the probe measured, with its own label", () => {
    // A TIMEOUT used to be a bare status. The engine now switches one rule off
    // at a time and reports which relaxation let the week solve; that reaches
    // the page as an ordinary conflict, under a category that says it is a
    // measurement and not a proof.
    state.job = {
      id: "job-1",
      status: "SUCCEEDED",
      solverStatus: "TIMEOUT",
      conflictSummary: "No timetable within 60 s. With one rule relaxed, the same week solved.",
      conflicts: [
        {
          category: "TIMEOUT_PROBE",
          message: "With the corridor between lessons (changeoverMinutes) set to 0, a timetable was found in 4.1 s.",
        },
      ],
      createdAt: "2026-09-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("conflictCategories.TIMEOUT_PROBE")).toBeInTheDocument();
    expect(screen.getByText(/changeoverMinutes\) set to 0/)).toBeInTheDocument();
  });
});
