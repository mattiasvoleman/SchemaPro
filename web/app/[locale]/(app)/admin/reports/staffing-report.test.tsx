import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uppdragLoad } from "@/lib/__fixtures__/staffing-fas3";
import type { StaffingReconciliationResponse } from "@/lib/staffing-reconciliation";
import { StaffingReport } from "./staffing-report";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const download = vi.hoisted(() => vi.fn());
const apiGet = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  rec: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown },
  recArgs: [] as unknown[][],
}));

vi.mock("@/lib/csv-export", async (original) => ({
  ...(await original<typeof import("@/lib/csv-export")>()),
  downloadCsv: download,
}));
vi.mock("@/lib/api", () => ({ api: { get: apiGet } }));
vi.mock("./use-staffing-reconciliation", () => ({
  useStaffingReconciliation: (...args: unknown[]) => {
    state.recArgs.push(args);
    return state.rec;
  },
}));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => ({
    data: { loadModel: "MINUTES", teachers: [uppdragLoad] },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [{ id: "y1", name: "2026/27", isActive: true, startDate: "2026-08-17", endDate: "2027-06-11" }],
  }),
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", firstName: "Anna", lastName: "Öberg" },
      { id: "t-bo", role: "TEACHER", firstName: "Bo", lastName: "Alm" },
    ],
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik", nationalCode: "MA", code: "MA" }] }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }, { id: "g-7b", name: "7B" }] }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-admin" }, school: { name: "Norra skolan", timezone: "Europe/Stockholm" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace === "timplanCoverage.delivered.cause" ? "cause." : ""}${key}${
      values ? `(${Object.values(values).join("|")})` : ""
    }`,
}));

const lost = { cancelledTeacherUnavailable: 0, cancelledRoomUnavailable: 0, cancelledManual: 0, cancelledUnknown: 0, otherStatus: 0 };
const response = (overrides: Partial<StaffingReconciliationResponse> = {}): StaffingReconciliationResponse => ({
  academicYearId: "y1",
  year: { startDate: "2026-08-17", endDate: "2027-06-11" },
  asOf: "2026-10-09T10:00:00.000Z",
  asOfDate: "2026-10-09",
  from: "2026-08-17",
  to: "2026-10-09",
  comparison: { from: "2026-08-24", to: "2026-10-09" },
  loadModel: "MINUTES",
  published: { from: "2026-08-24", through: "2026-12-18" },
  teachers: [
    {
      userId: "t-anna",
      planned: 2400,
      scheduled: 2380,
      delivered: 2200,
      substituteMinutes: 0,
      coveredByOthersMinutes: 120,
      aheadMinutes: 60,
      lost: { ...lost, cancelledManual: 80 },
      lostMinutes: 80,
      deliveredLessons: 40,
      displacedLessons: 0,
      lines: [
        { subjectId: "s-ma", studentGroupId: "g-7a", extraGroupIds: ["g-7b"], planned: 2400, scheduled: 2380, delivered: 2200, substituteMinutes: 0, lostMinutes: 80 },
      ],
    },
    {
      userId: "t-bo",
      planned: 0,
      scheduled: 0,
      delivered: 300,
      substituteMinutes: 300,
      coveredByOthersMinutes: 0,
      aheadMinutes: 0,
      lost,
      lostMinutes: 0,
      deliveredLessons: 5,
      displacedLessons: 0,
      lines: [],
    },
  ],
  groupLosses: [{ studentGroupId: "g-7a", subjectId: "s-ma", teacherless: 40, ...lost, cancelledManual: 80, lessons: 3 }],
  totals: { planned: 2400, scheduled: 2380, delivered: 2500, substituteMinutes: 300, coveredByOthersMinutes: 120, lostMinutes: 80, aheadMinutes: 60 },
  notices: [{ code: "STAFFING_RANGE_BEFORE_PUBLISHED", params: { publishedFrom: "2026-08-24" } }],
  ...overrides,
});

describe("Rapporter › Tjänstefördelning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.recArgs = [];
    state.rec = { data: response(), isLoading: false, isError: false, error: null };
  });

  it("asks for the active year with the gateway's default range, and states the range it used", () => {
    render(<StaffingReport />);
    expect(state.recArgs.at(-1)).toEqual(["y1", null, null]);
    expect(screen.getByText("comparison(2026-08-24|2026-10-09|model.MINUTES)")).toBeInTheDocument();
    expect(screen.getByText("notice.STAFFING_RANGE_BEFORE_PUBLISHED(2026-08-24)")).toBeInTheDocument();
  });

  it("shows the KPIs in minutes and hours, and one row per teacher by family name", () => {
    render(<StaffingReport />);
    expect(screen.getByText("minutes(2500)")).toBeInTheDocument();
    expect(screen.getByText("hours(41,7)")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /tableCaption/ });
    const names = within(table)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Bo Alm", "Anna Öberg"]);
    const anna = within(table).getByRole("button", { name: "showLines(Anna Öberg)" }).closest("tr")!;
    expect(within(anna).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Anna Öberg", "80 %", "2400", "2380", "2200", "-200", "0", "120", "80", "60",
    ]);
  });

  it("unfolds a teacher's lines per subject and group, naming the samläsning", async () => {
    const user = userEvent.setup();
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "showLines(Anna Öberg)" }));
    expect(screen.getByRole("button", { name: "hideLines(Anna Öberg)" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Matematik · 7A withGroups(7B)")).toBeInTheDocument();
  });

  it("lists the bortfall per group with P3's cause names, and the footnotes, Faktor only when it is on", () => {
    const { unmount } = render(<StaffingReport />);
    expect(screen.getByRole("columnheader", { name: "cause.teacherless" })).toBeInTheDocument();
    expect(screen.getByText("7A · Matematik").closest("tr")).toHaveTextContent("7A · Matematik400080003120");
    expect(screen.getByText("footCredit")).toBeInTheDocument();
    expect(screen.queryByText("footFactor")).not.toBeInTheDocument();
    unmount();
    state.rec = { data: response({ loadModel: "FACTOR" }), isLoading: false, isError: false, error: null };
    render(<StaffingReport />);
    expect(screen.getByText("footFactor")).toBeInTheDocument();
  });

  it("says the gateway's refusal rather than drawing an empty report", () => {
    state.rec = { data: undefined, isLoading: false, isError: true, error: new Error("Läsåret är inte aktiverat.") };
    render(<StaffingReport />);
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
    expect(screen.getByText("Läsåret är inte aktiverat.")).toBeInTheDocument();
  });

  it("downloads the samverkan file with the vikarie in it, and behörigheter only when ticked", async () => {
    const user = userEvent.setup();
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "exportSamverkan" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, csv] = download.mock.calls[0] as [string, string];
    expect(filename).toBe("tjanstefordelning-2026-27-2026-08-17-2026-10-09.csv");
    expect(csv).toContain("Alm;Bo;");
    expect(csv).not.toContain("Behörigheter");
    expect(apiGet).not.toHaveBeenCalled();

    apiGet.mockResolvedValueOnce([]);
    await user.click(screen.getByRole("checkbox", { name: "includeQualifications" }));
    await user.click(screen.getByRole("button", { name: "exportSamverkan" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenCalledWith("/api/v1/teacher-qualifications");
    expect(download.mock.calls[1]![1]).toContain("Behörigheter");
  });

  it("builds the SCB underlag from the year's plan and timplans, and lists what to check", async () => {
    const user = userEvent.setup();
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/teacher-duties")) return [{ userId: "t-anna", kind: "FORSTELARARE" }];
      if (path.endsWith("/timplans")) return [{ gradeLevel: 7, localTimplanId: "p1", planName: "G", planStatus: "DECIDED" }];
      if (path === "/api/v1/local-timplans") return [{ id: "p1", schoolForm: "GRUNDSKOLA" }];
      throw new Error(path);
    });
    render(<StaffingReport />);
    expect(screen.getByText("scbNotice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "exportScb" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(apiGet).toHaveBeenCalledWith("/api/v1/teacher-duties?academicYearId=y1");
    const [filename, csv] = download.mock.calls[0] as [string, string];
    expect(filename).toBe("scb-pedagogisk-personal-underlag-2026-27.csv");
    expect(csv.split("\r\n")[0]).toMatch(/^﻿System;Datum;Version;SkolenhetsKod;PersonNr;PersonNamn;/);
    // What SchemaPro cannot fill is listed beside the button, never silently.
    expect(await screen.findByText("scb.notice.FORSTELARARE(Anna Öberg)")).toBeInTheDocument();
    expect(screen.getByText(/^scbNoticesTitle\(/).textContent).toBe("scbNoticesTitle(3)");
    // Slöjd is not among the subjects this school maps: left out, and named.
    expect(screen.getByText("scb.notice.LEFT_OUT(Anna Öberg|Slöjd 7B)")).toBeInTheDocument();
    expect(screen.getByText("scb.notice.REDUCTION(Anna Öberg)")).toBeInTheDocument();
  });
});
