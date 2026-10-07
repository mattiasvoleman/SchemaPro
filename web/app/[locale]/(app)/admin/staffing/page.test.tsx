import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
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
/** Last year, and this year as rolled from it (staffing Fas 5). */
const lastYear = { id: "y0", name: "2025/2026", isActive: false, startDate: "2025-08-18", endDate: "2026-06-12", predecessorId: null };
const rolledYear = { ...year, predecessorId: "y0" };

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
  reportLoading: false,
  years: null as unknown as unknown[],
  /** Per year id: the load report, or an Error the read failed with. */
  reports: {} as Record<string, unknown>,
  employments: {} as Record<string, unknown[]>,
  assign: null as unknown as (body: unknown) => Promise<unknown>,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: state.years, isLoading: false, isError: false }),
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
  useStaffingLoad: (yearId: string | null) => {
    const other = yearId !== null && yearId !== "y1" ? state.reports[yearId] : undefined;
    if (other instanceof Error) return { data: undefined, isLoading: false, isError: true, error: other };
    if (other !== undefined) return { data: other, isLoading: false, isError: false };
    return {
      data: state.reportLoading ? undefined : state.report,
      isLoading: state.reportLoading,
      isError: false,
    };
  },
  useStaffingPolicy: () => ({ data: state.policy, isSuccess: true }),
  useSaveStaffingPolicy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTeacherEmployments: (yearId: string | null) => ({
    data: yearId === null ? undefined : (state.employments[yearId] ?? []),
  }),
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
    state.reportLoading = false;
    state.years = [year];
    state.reports = {};
    state.employments = {};
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

  it("scrolls to the panel a link named in its hash once the report has drawn it", () => {
    /*
     * /admin/generate links to /admin/staffing#unstaffed. The page first draws
     * a skeleton, so the target does not exist when Next handles the hash —
     * and Next gives the hash up for good ("a missing hash target is still a
     * handled scroll intent"). The admin landed at the top, the panel below
     * the whole matrix.
     */
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled(this.id);
    };
    window.history.replaceState(null, "", "#unstaffed");
    try {
      state.reportLoading = true;
      const { rerender } = render(<StaffingPage />);
      expect(document.getElementById("unstaffed")).toBeNull();
      state.reportLoading = false;
      rerender(<StaffingPage />);
      expect(scrolled).toHaveBeenCalledWith("unstaffed");
      expect(document.activeElement).toBe(document.getElementById("unstaffed"));
    } finally {
      Element.prototype.scrollIntoView = original;
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("staffs an unstaffed row from the panel and shows WARN's sentence in the panel, naming the row", async () => {
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
    const banner = sentence.closest("[aria-live]")!;
    expect(banner).toHaveTextContent("warnedTitle 7A · NO");
    // In the panel the click was made in, which sits below the matrix — not
    // above the matrix, off-screen from the admin after the click.
    expect(document.getElementById("unstaffed")!.contains(banner)).toBe(true);
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
  describe("last year (staffing Fas 5)", () => {
    const lastReport = {
      ...report,
      academicYearId: "y0",
      teachers: [
        { ...report.teachers[0]!, countedMinutesPerWeek: 960, employment: { ...report.teachers[0]!.employment!, employmentPercent: 80 } },
        { ...report.teachers[0]!, userId: "t-gone", employment: null, countedMinutesPerWeek: 600 },
      ],
    };

    it("offers no comparison and no carry for a year that was not rolled from another", () => {
      state.employments = { y0: [{ id: "e0", userId: "t-bo" }] };
      render(<StaffingPage />);
      expect(screen.queryByRole("tab", { name: "compare.withLastYear" })).toBeNull();
      expect(screen.queryByText(/carry.noticeTitle/)).toBeNull();
    });

    it("compares per teacher with the predecessor, naming who left, and filters to the changed", async () => {
      const user = userEvent.setup();
      const same = { ...report.teachers[0]!, userId: "t-same" };
      state.years = [rolledYear, lastYear];
      state.report = { ...report, teachers: [...report.teachers, same] };
      state.reports = { y0: { ...lastReport, teachers: [...lastReport.teachers, same] } };
      render(<StaffingPage />);
      await user.click(screen.getByRole("tab", { name: "compare.withLastYear" }));

      const row = (await screen.findByText("Bo Alm")).closest("tr")!;
      expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
        "80 %",
        "100 %(+20 %)",
        "960",
        "1200",
        "+240",
      ]);
      // A teacher with no row this year is a row, said in words.
      const gone = screen.getByText("t-gone").closest("tr")!;
      expect(gone).toHaveTextContent("changeLEFT");
      expect(within(gone).getAllByRole("cell")[3]?.textContent).toBe("—");
      expect(screen.getByText("footnote")).toBeInTheDocument();
      // The matrix's own toggles do not apply here.
      expect(screen.queryByRole("tab", { name: "weekPeak" })).toBeNull();

      expect(screen.getByText("t-same")).toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: "changedOnly" }));
      expect(screen.getByText("Bo Alm")).toBeInTheDocument();
      expect(screen.getByText("t-gone")).toBeInTheDocument();
      expect(screen.queryByText("t-same")).toBeNull();
    });

    it("says why there is no comparison instead of drawing last year as zeros", async () => {
      const user = userEvent.setup();
      state.years = [rolledYear, lastYear];
      state.reports = {
        y0: new ApiError(409, "…", "ROLLOVER_NOT_ACTIVATED"),
      };
      render(<StaffingPage />);
      await user.click(screen.getByRole("tab", { name: "compare.withLastYear" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("notActivated(2025/2026)");
      expect(screen.queryByRole("table")).toBeNull();
    });

    it("offers to carry last year's tjänster only while this year has none and last year has some", () => {
      state.years = [rolledYear, lastYear];
      state.employments = { y0: [{ id: "e0", userId: "t-bo" }] };
      const { unmount } = render(<StaffingPage />);
      expect(screen.getByText("carry.noticeTitle(2025/2026)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "carry.noticeAction" })).toBeInTheDocument();
      unmount();

      // Started by hand: no nag.
      state.employments = { y0: [{ id: "e0", userId: "t-bo" }], y1: [{ id: "e1", userId: "t-bo" }] };
      const second = render(<StaffingPage />);
      expect(screen.queryByText(/carry.noticeTitle/)).toBeNull();
      second.unmount();

      // Never had any: nothing to offer.
      state.employments = {};
      render(<StaffingPage />);
      expect(screen.queryByText(/carry.noticeTitle/)).toBeNull();
    });
  });
});
