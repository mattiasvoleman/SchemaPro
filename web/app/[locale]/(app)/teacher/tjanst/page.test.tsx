import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MyStaffingPage from "./page";

/**
 * Min tjänst is read-only and about one person. What can go wrong is what it
 * STATES: a colleague's row shown as one's own (an admin who teaches gets the
 * whole school's report), a failed read drawn as "no teaching", and an empty
 * post read as 0 % of a tjänst that has no denominator. Each has a test.
 */

const ME = "t-me";

const state = vi.hoisted(() => ({
  year: { id: "y-1", name: "2026/27", isActive: true } as unknown,
  years: [] as unknown[],
  yearLoading: false,
  /** The predecessor y-0's report (staffing Fas 5). */
  lastLoad: { data: undefined as unknown, isLoading: false, isError: false },
  load: { data: undefined as unknown, isLoading: false, isError: false },
  duties: { data: undefined as unknown, isLoading: false, isError: false },
  loadYear: [] as (string | null)[],
  dutyArgs: [] as unknown[][],
}));

vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "t-me", role: "TEACHER" } }),
}));
vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ data: state.years, activeYear: state.year, isLoading: state.yearLoading }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik" }] }),
  useGroups: () => ({ data: [{ id: "g-7b", name: "7B" }] }),
}));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: (yearId: string | null) => {
    state.loadYear.push(yearId);
    return yearId === "y-0" ? state.lastLoad : state.load;
  },
  useTeacherDuties: (...args: unknown[]) => {
    state.dutyArgs.push(args);
    return state.duties;
  },
}));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const row = (overrides: Record<string, unknown> = {}) => ({
  userId: ME,
  employment: {
    userId: ME,
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: "FERIE",
    teachingTargetMinutesPerWeek: null,
    signature: null,
  },
  targetMinutesPerWeek: 1080,
  assignedMinutesPerWeek: 900,
  peakMinutesPerWeek: 960,
  dutyMinutesPerWeek: 120,
  countedDutyMinutesPerWeek: 60,
  countedMinutesPerWeek: 960,
  balanceMinutesPerWeek: 120,
  percentOfTarget: 88.9,
  status: "UNDER",
  requirementCount: 3,
  dutyCount: 2,
  subjects: [
    {
      subjectId: "s-ma",
      subjectName: "Matematik",
      minutesPerWeek: 600,
      shareOfTeaching: 0.6667,
      percentOfEmployment: 66.7,
      percentOfFullTime: null,
    },
    {
      subjectId: "s-no",
      subjectName: "NO",
      minutesPerWeek: 300,
      shareOfTeaching: 0.3333,
      percentOfEmployment: 33.3,
      percentOfFullTime: null,
    },
  ],
  annual: { assignedHoursPerYear: 573.5, regulatedHoursPerYear: 1360, workDaysPerYear: 194 },
  ...overrides,
});

const duty = (overrides: Record<string, unknown> = {}) => ({
  id: "d-1",
  userId: ME,
  academicYearId: "y-1",
  kind: "MENTORSKAP",
  label: "Mentor 7B",
  minutesPerWeek: 60,
  countsAsTeaching: false,
  subjectId: null,
  studentGroupId: "g-7b",
  blockedConstraintId: "c-1",
  blockedSlot: { dayOfWeek: 2, startTime: "08:00:00", endTime: "08:30:00" },
  note: null,
  ...overrides,
});

beforeEach(() => {
  state.year = { id: "y-1", name: "2026/27", isActive: true, predecessorId: null };
  state.years = [state.year];
  state.lastLoad = { data: undefined, isLoading: false, isError: false };
  state.yearLoading = false;
  state.load = { data: { teachers: [row()] }, isLoading: false, isError: false };
  state.duties = { data: [duty()], isLoading: false, isError: false };
  state.loadYear = [];
  state.dutyArgs = [];
});

describe("Min tjänst", () => {
  it("asks for the active year's load and the teacher's own duties", () => {
    render(<MyStaffingPage />);

    expect(state.loadYear).toContain("y-1");
    expect(state.dutyArgs).toContainEqual(["y-1", ME]);
  });

  it("states the post, the target, the counted minutes and the status", () => {
    render(<MyStaffingPage />);

    expect(screen.getByText("staffing.employmentSummary(100|staffing.contractFERIE)")).toBeInTheDocument();
    expect(screen.getByText(/myStaffing\.target\(1080\)/)).toBeInTheDocument();
    expect(screen.getByText(/myStaffing\.counted\(960\)/)).toBeInTheDocument();
    expect(screen.getByText("staffing.statusUNDER")).toBeInTheDocument();
    // The admin's own bar, drawn from the same row.
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getByText("myStaffing.annual(573,5)")).toBeInTheDocument();
  });

  it("lists each subject with its minutes and its share of the post", () => {
    render(<MyStaffingPage />);

    const table = screen.getByRole("table");
    const ma = within(table).getByRole("rowheader", { name: "Matematik" }).closest("tr")!;
    expect(within(ma).getByText("600")).toBeInTheDocument();
    expect(within(ma).getByText("66,7 %")).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "NO" })).toBeInTheDocument();
  });

  it("prints a dash, not 0 %, for a share with no post to be a share of", () => {
    state.load = {
      data: {
        teachers: [
          row({
            employment: null,
            targetMinutesPerWeek: null,
            status: "NO_TARGET",
            subjects: [
              {
                subjectId: "s-ma",
                subjectName: "Matematik",
                minutesPerWeek: 600,
                shareOfTeaching: 1,
                percentOfEmployment: null,
                percentOfFullTime: null,
              },
            ],
          }),
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<MyStaffingPage />);

    expect(screen.getByText("myStaffing.noEmployment")).toBeInTheDocument();
    expect(screen.getByText(/myStaffing\.noTarget/)).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0 %")).toBeNull();
  });

  it("lists the teacher's duties with the time each one blocks", () => {
    render(<MyStaffingPage />);

    expect(screen.getByText("Mentor 7B")).toBeInTheDocument();
    expect(screen.getByText("staffing.dutyKindMENTORSKAP")).toBeInTheDocument();
    expect(screen.getByText("staffing.dutyMinutes(60) · 7B")).toBeInTheDocument();
    expect(screen.getByText("staffing.dutyBlocks(days.2|08:00|08:30)")).toBeInTheDocument();
  });

  it("shows only the viewer's own row and duties when the report holds the whole school", () => {
    // A SCHOOL_ADMIN who teaches gets every teacher's row from the gateway.
    state.load = {
      data: {
        teachers: [
          row({ userId: "t-colleague", countedMinutesPerWeek: 1500, status: "OVER" }),
          row(),
        ],
      },
      isLoading: false,
      isError: false,
    };
    state.duties = {
      data: [duty(), duty({ id: "d-2", userId: "t-colleague", label: "Förstelärare NO" })],
      isLoading: false,
      isError: false,
    };
    render(<MyStaffingPage />);

    expect(screen.getByText(/myStaffing\.counted\(960\)/)).toBeInTheDocument();
    expect(screen.queryByText(/myStaffing\.counted\(1500\)/)).toBeNull();
    expect(screen.queryByText("staffing.statusOVER")).toBeNull();
    expect(screen.queryByText("Förstelärare NO")).toBeNull();
  });

  it("offers no control to change anything, and says who does", () => {
    render(<MyStaffingPage />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("myStaffing.readOnly")).toBeInTheDocument();
  });

  it("says a failed read is one, never an empty tjänst", () => {
    state.load = { data: undefined, isLoading: false, isError: true };
    render(<MyStaffingPage />);

    expect(screen.getByText("myStaffing.loadFailed")).toBeInTheDocument();
    expect(screen.queryByText("myStaffing.noTeaching")).toBeNull();
    expect(screen.queryByText(/notRegistered/)).toBeNull();
  });

  it("draws no figure while the report is in flight", () => {
    state.load = { data: undefined, isLoading: true, isError: false };
    render(<MyStaffingPage />);

    expect(screen.queryByText(/myStaffing\.counted/)).toBeNull();
    expect(screen.queryByText(/notRegistered/)).toBeNull();
  });

  it("says nothing is registered when the teacher has no row and no duties", () => {
    state.load = { data: { teachers: [] }, isLoading: false, isError: false };
    state.duties = { data: [], isLoading: false, isError: false };
    render(<MyStaffingPage />);

    expect(screen.getByText("myStaffing.notRegistered(2026/27)")).toBeInTheDocument();
  });

  it("says there is no active year rather than asking for nothing", () => {
    state.year = null;
    render(<MyStaffingPage />);

    expect(screen.getByText("myStaffing.noYear")).toBeInTheDocument();
    // This year's report and last year's: neither asked for.
    expect(state.loadYear.every((yearId) => yearId === null)).toBe(true);
  });

  describe("last year (staffing Fas 5)", () => {
    const rolled = () => {
      state.year = { id: "y-1", name: "2026/27", isActive: true, predecessorId: "y-0" };
      state.years = [state.year, { id: "y-0", name: "2025/26", isActive: false, predecessorId: null }];
    };

    it("states last year's post and counted minutes beside this year's, from the teacher's own row", () => {
      rolled();
      state.lastLoad = {
        data: {
          teachers: [
            row({ userId: "t-colleague", countedMinutesPerWeek: 1500 }),
            row({
              countedMinutesPerWeek: 840,
              employment: { ...row().employment, employmentPercent: 80 },
            }),
          ],
        },
        isLoading: false,
        isError: false,
      };
      render(<MyStaffingPage />);

      expect(state.loadYear).toContain("y-0");
      expect(screen.getByText("myStaffing.lastYear(2025/26|80|840)")).toBeInTheDocument();
      expect(screen.queryByText(/1500/)).toBeNull();
    });

    it("says last year had no post rather than 0 %", () => {
      rolled();
      state.lastLoad = {
        data: { teachers: [row({ employment: null, countedMinutesPerWeek: 300 })] },
        isLoading: false,
        isError: false,
      };
      render(<MyStaffingPage />);
      expect(screen.getByText("myStaffing.lastYearNoPost(2025/26|300)")).toBeInTheDocument();
    });

    it("has no line without a predecessor, without a row there, or when last year cannot be read", () => {
      const { unmount } = render(<MyStaffingPage />);
      expect(screen.queryByText(/myStaffing\.lastYear/)).toBeNull();
      unmount();

      rolled();
      state.lastLoad = { data: { teachers: [] }, isLoading: false, isError: false };
      const second = render(<MyStaffingPage />);
      expect(screen.queryByText(/myStaffing\.lastYear/)).toBeNull();
      second.unmount();

      state.lastLoad = { data: undefined, isLoading: false, isError: true };
      render(<MyStaffingPage />);
      expect(screen.queryByText(/myStaffing\.lastYear/)).toBeNull();
      // And this year's figures stand.
      expect(screen.getByText(/myStaffing\.counted\(960\)/)).toBeInTheDocument();
    });
  });
});
