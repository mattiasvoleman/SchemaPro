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
  assign: null as unknown as (body: unknown) => Promise<unknown>,
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
  useRequirements: () => ({
    data: [
      {
        id: "r-bo-ma",
        academicYearId: "y1",
        subjectId: "s-ma",
        studentGroupId: "g-7a",
        teacherId: "t-bo",
        coTeacherId: null,
        lessonsPerWeek: 4,
        minutesPerLesson: 60,
      },
    ],
  }),
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
  useTeacherDuties: () => ({ data: [], isLoading: false, isError: false }),
  useTeacherDutyActions: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useSuggestTeachers: (requirementId: string) => ({
    isLoading: false,
    isError: false,
    data: {
      requirementId,
      subjectId: "s-no",
      studentGroupId: "g-7a",
      gradeSpan: { min: 7, max: 7 },
      teacherMinutesPerWeek: 120,
      qualificationsRecorded: false,
      candidates: [
        {
          userId: "t-bo",
          qualificationKind: null,
          teachesSubjectAlready: false,
          teachesGroupAlready: true,
          currentlyAssigned: false,
          remainingMinutesPerWeek: -240,
          wouldExceed: true,
          status: "OVER",
        },
      ],
    },
  }),
  useAssignTeacher: () => ({ mutateAsync: (body: unknown) => state.assign(body), isPending: false }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${namespace === "engineMessages" ? "engine:" : ""}${key}${
        values ? `(${Object.values(values).join("|")})` : ""
      }`;
    t.has = () => true;
    return t;
  },
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
    const kpiUnqualified = screen.getByText("kpiUnqualified").parentElement!;
    expect(within(kpiUnqualified).getByText("kpiUnqualifiedNotRecorded")).toBeInTheDocument();
    const kpiOver = screen.getByText("kpiOverTarget").parentElement!;
    expect(within(kpiOver).getByText("1")).toBeInTheDocument();
    // Bottlenecks are unknowable without behörigheter: said, not zeroed.
    const kpiBottlenecks = screen.getByText("kpiBottlenecks").parentElement!;
    expect(within(kpiBottlenecks).getByText("kpiUnqualifiedNotRecorded")).toBeInTheDocument();
    expect(screen.getByText("bottlenecksNotComputed")).toBeInTheDocument();
  });

  it("counts the short subjects in the KPI strip once capacity is known", () => {
    state.report = {
      ...report,
      qualificationsRecorded: true,
      bottlenecksComputed: true,
      subjectBottlenecks: [
        {
          subjectId: "s-no",
          subjectName: "NO",
          unstaffedCount: 1,
          demandedMinutesPerWeek: 120,
          qualifiedRemainingMinutesPerWeek: 0,
          qualifiedTeacherCount: 1,
          qualifiedNoTargetCount: 0,
          short: true,
        },
      ],
    };
    render(<StaffingPage />);
    const kpiBottlenecks = screen.getByText("kpiBottlenecks").parentElement!;
    expect(within(kpiBottlenecks).getByText("1")).toBeInTheDocument();
    expect(screen.getByText("bottleneckShort(120)")).toBeInTheDocument();
  });

  it("staffs an unstaffed row from the panel and shows WARN's sentence over the matrix", async () => {
    const user = userEvent.setup();
    const assigned = vi.fn().mockResolvedValue({
      id: "r-1",
      teacherId: "t-bo",
      warnings: [
        {
          code: "STAFF_TEACHER_OVER_TARGET",
          params: { role: "TEACHER", minutes: 1320, target: 1080, limit: 1188, tolerance: 10 },
        },
      ],
    });
    state.assign = assigned;
    render(<StaffingPage />);
    await user.click(screen.getByRole("button", { name: "suggestTeachers" }));
    await user.click(screen.getByRole("button", { name: "suggestAssignNamed(Bo Alm)" }));
    expect(assigned).toHaveBeenCalledWith({ requirementId: "r-1", teacherId: "t-bo" });
    const sentence = await screen.findByText(
      "engine:STAFF_TEACHER_OVER_TARGET(TEACHER|1320|1080|1188|10)",
    );
    const banner = sentence.closest('[role="status"]')!;
    expect(banner).toHaveTextContent("warnedTitle");
    // Above the matrix, where the admin is looking after the click.
    expect(
      banner.compareDocumentPosition(screen.getByRole("table", { name: "tableCaption" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
      unstaffedGeneration: "ALLOW",
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
    const row = screen.getByText("unstaffedRow(7A|NO|120)").closest("li")!;
    expect(within(row).getByRole("link", { name: "openRequirements" })).toHaveAttribute(
      "href",
      "/admin/requirements",
    );
  });

  it("opens the drawer for a teacher", async () => {
    const user = userEvent.setup();
    render(<StaffingPage />);
    await user.click(screen.getByRole("button", { name: "openDrawer(Bo Alm)" }));
    // Lazy: the drawer's module is fetched on the first click.
    expect(await screen.findByRole("dialog")).toHaveTextContent("employmentTitle");
    expect(screen.getByRole("dialog")).toHaveTextContent("qualificationsTitle");
    expect(screen.getByRole("dialog")).toHaveTextContent("drawerSubtitle(111,1|1200|1080)");
    // Fas 2: the uppdrag and the rows the teacher carries, each one handable on.
    expect(screen.getByRole("dialog")).toHaveTextContent("dutiesTitle");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "changeTeacherFor(7A · Matematik)" }),
    ).toBeInTheDocument();
  });
});
