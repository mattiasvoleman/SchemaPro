import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeacherLoadReport } from "@/lib/teacher-load";
import StaffingPage from "./page";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Mounts the real page over a mocked report, for the three things only the
 * page decides: the KPI strip, the empty-riktmärke notice, and that the two
 * toggles reach the matrix. The matrix's own rendering is covered in
 * components/staffing/staffing-matrix.test.tsx.
 */

const year = { id: "y1", name: "2026/2027", isActive: true, startDate: "2026-08-17", endDate: "2027-06-11" };

const report: TeacherLoadReport & { academicYearId: string; horizon: "planned"; year: typeof year } = {
  academicYearId: "y1",
  horizon: "planned",
  year,
  teachers: [
    {
      userId: "t-bo",
      employment: {
        userId: "t-bo",
        employmentPercent: 100,
        reductionPercent: 0,
        contractKind: "FERIE",
        teachingTargetMinutesPerWeek: null,
        signature: "BO",
      },
      targetMinutesPerWeek: 1080,
      assignedMinutesPerWeek: 1200,
      peakMinutesPerWeek: 1260,
      dutyMinutesPerWeek: 0,
      countedDutyMinutesPerWeek: 0,
      countedMinutesPerWeek: 1200,
      balanceMinutesPerWeek: -120,
      percentOfTarget: 111.1,
      status: "OVER",
      requirementCount: 1,
      dutyCount: 0,
      subjects: [
        {
          subjectId: "s-ma",
          subjectName: "Matematik",
          minutesPerWeek: 1200,
          shareOfTeaching: 1,
          percentOfEmployment: 100,
          percentOfFullTime: 111.1,
        },
      ],
      annual: { assignedHoursPerYear: 800, regulatedHoursPerYear: 1360, workDaysPerYear: 194 },
    },
  ],
  unstaffedRequirements: [
    {
      requirementId: "r-1",
      subjectId: "s-no",
      subjectName: "NO",
      studentGroupId: "g-7a",
      groupName: "7A",
      minutesPerWeek: 120,
      teacherMinutesPerWeek: 120,
      gradeSpan: { min: 7, max: 7 },
    },
  ],
  unqualifiedAssignments: [],
  qualificationsRecorded: false,
  subjectBottlenecks: [],
  bottlenecksComputed: false,
  totals: { teacherMinutesPerWeek: 1200, lessonMinutesPerWeek: 1320, dutyMinutesPerWeek: 0 },
};

const state = vi.hoisted(() => ({
  policy: null as unknown,
  report: null as unknown,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [year], isLoading: false, isError: false }),
  useSubjects: () => ({
    data: [{ id: "s-ma", name: "Matematik", code: "MA", color: null, requiredRoomTypeId: null }],
    isLoading: false,
    isError: false,
  }),
  usePeople: () => ({
    data: [
      { id: "t-bo", role: "TEACHER", firstName: "Bo", lastName: "Alm", email: "bo@s.se", phone: null, isActive: true, invitedAt: null, studentGroupId: null },
    ],
  }),
  useGroups: () => ({ data: [{ id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 }] }),
  useRequirements: () => ({ data: [] }),
}));

vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => ({ data: state.report, isLoading: false, isError: false }),
  useStaffingPolicy: () => ({ data: state.policy, isSuccess: true }),
  useSaveStaffingPolicy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTeacherEmployments: () => ({ data: [] }),
  useTeacherQualifications: () => ({ data: [] }),
  useTeacherEmploymentActions: () => ({
    save: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useReplaceTeacherQualifications: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

describe("StaffingPage", () => {
  beforeEach(() => {
    state.policy = null;
    state.report = report;
  });

  it("shows the KPI strip, reading an unchecked school as 'not recorded' rather than zero", () => {
    render(<StaffingPage />);
    const kpiUnstaffed = screen.getByText("kpiUnstaffed").parentElement!;
    expect(within(kpiUnstaffed).getByText("1")).toBeInTheDocument();
    expect(screen.getByText("kpiUnqualifiedNotRecorded")).toBeInTheDocument();
    const kpiOver = screen.getByText("kpiOverTarget").parentElement!;
    expect(within(kpiOver).getByText("1")).toBeInTheDocument();
  });

  it("says no riktmärke is set when the school has no policy, and opens the card on request", async () => {
    const user = userEvent.setup();
    render(<StaffingPage />);
    expect(screen.getByText("noTargetTitle")).toBeInTheDocument();
    expect(document.getElementById("staffing-policy")).toBeNull();
    await user.click(screen.getByRole("button", { name: "noTargetAction" }));
    expect(document.getElementById("staffing-policy")).not.toBeNull();
  });

  it("drops the notice once a riktmärke is saved", () => {
    state.policy = {
      id: "p1",
      fullTimeTeachingMinutesPerWeek: 1080,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: 40,
      qualificationMode: "WARN",
      overAllocationMode: "WARN",
      overAllocationTolerancePercent: 10,
      loadModel: "MINUTES",
    };
    render(<StaffingPage />);
    expect(screen.queryByText("noTargetTitle")).not.toBeInTheDocument();
  });

  it("switches the matrix between standardvecka and toppvecka, and minutes and percent", async () => {
    const user = userEvent.setup();
    render(<StaffingPage />);
    const row = screen.getByText("Bo Alm").closest("tr")!;
    expect(within(row).getAllByRole("cell")[0]?.textContent).toBe("1200");
    expect(screen.getByRole("columnheader", { name: "teachingHeader" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "weekPeak" }));
    expect(screen.getByRole("columnheader", { name: "teachingPeakHeader" })).toBeInTheDocument();
    expect(within(screen.getByText("Bo Alm").closest("tr")!).getAllByRole("cell")[3]?.textContent).toBe("1260");
    expect(screen.getByText("weekHintPeak")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "unitPercent" }));
    expect(within(screen.getByText("Bo Alm").closest("tr")!).getAllByRole("cell")[0]?.textContent).toBe("100 %");
  });

  it("lists the unstaffed rows with a link to the timplan", () => {
    render(<StaffingPage />);
    const link = screen.getByRole("link", { name: "unstaffedRow(7A|NO|120)" });
    expect(link).toHaveAttribute("href", "/admin/requirements");
  });

  it("opens the drawer for a teacher", async () => {
    const user = userEvent.setup();
    render(<StaffingPage />);
    await user.click(screen.getByRole("button", { name: "openDrawer(Bo Alm)" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("employmentTitle");
    expect(screen.getByRole("dialog")).toHaveTextContent("qualificationsTitle");
    expect(screen.getByRole("dialog")).toHaveTextContent("drawerSubtitle(111,1|1200|1080)");
  });
});
