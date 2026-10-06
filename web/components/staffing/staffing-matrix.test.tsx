import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TeacherLoad, TeacherLoadReport } from "@/lib/teacher-load";
import { StaffingMatrix } from "./staffing-matrix";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const teacher = (overrides: Partial<TeacherLoad>): TeacherLoad => ({
  userId: "t-anna",
  employment: {
    userId: "t-anna",
    employmentPercent: 80,
    reductionPercent: 0,
    contractKind: "FERIE",
    teachingTargetMinutesPerWeek: null,
    signature: "ANN",
  },
  targetMinutesPerWeek: 865,
  assignedMinutesPerWeek: 900,
  peakMinutesPerWeek: 960,
  dutyMinutesPerWeek: 0,
  countedDutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 900,
  balanceMinutesPerWeek: -35,
  percentOfTarget: 104,
  status: "OK",
  requirementCount: 2,
  dutyCount: 0,
  subjects: [
    {
      subjectId: "s-ma",
      subjectName: "Matematik",
      minutesPerWeek: 600,
      shareOfTeaching: 0.6667,
      percentOfEmployment: 53.3,
      percentOfFullTime: 55.6,
    },
    {
      subjectId: "s-no",
      subjectName: "Naturorientering",
      minutesPerWeek: 300,
      shareOfTeaching: 0.3333,
      percentOfEmployment: 26.7,
      percentOfFullTime: 27.8,
    },
  ],
  annual: { assignedHoursPerYear: 600, regulatedHoursPerYear: 1088, workDaysPerYear: 194 },
  ...overrides,
});

/** As the gateway sorts them: OVER first, then UNDER, OK, NO_TARGET. */
const report: TeacherLoadReport = {
  teachers: [
    teacher({
      userId: "t-bo",
      status: "OVER",
      assignedMinutesPerWeek: 1200,
      peakMinutesPerWeek: 1200,
      targetMinutesPerWeek: 1080,
      balanceMinutesPerWeek: -120,
      percentOfTarget: 111.1,
      subjects: [
        {
          subjectId: "s-no",
          subjectName: "Naturorientering",
          minutesPerWeek: 1200,
          shareOfTeaching: 1,
          percentOfEmployment: 100,
          percentOfFullTime: 111.1,
        },
      ],
    }),
    teacher({ userId: "t-anna" }),
    teacher({
      userId: "t-cilla",
      status: "NO_TARGET",
      employment: null,
      targetMinutesPerWeek: null,
      balanceMinutesPerWeek: null,
      percentOfTarget: null,
      assignedMinutesPerWeek: 180,
      peakMinutesPerWeek: 180,
      subjects: [
        {
          subjectId: "s-ma",
          subjectName: "Matematik",
          minutesPerWeek: 180,
          shareOfTeaching: 1,
          percentOfEmployment: null,
          percentOfFullTime: 16.7,
        },
      ],
    }),
  ],
  unstaffedRequirements: [],
  unqualifiedAssignments: [],
  qualificationsRecorded: false,
  subjectBottlenecks: [],
  bottlenecksComputed: false,
  totals: { teacherMinutesPerWeek: 2280, lessonMinutesPerWeek: 2280, dutyMinutesPerWeek: 0 },
};

const subjects = [
  { id: "s-no", name: "Naturorientering", code: "NO", color: null },
  { id: "s-ma", name: "Matematik", code: "MA", color: "#123456" },
  { id: "s-sv", name: "Svenska", code: "SV", color: null },
];

const requirements = [
  { subjectId: "s-ma", studentGroupId: "g-7a", teacherId: "t-anna", coTeacherId: null },
  { subjectId: "s-ma", studentGroupId: "g-7b", teacherId: "t-anna", coTeacherId: null },
  { subjectId: "s-no", studentGroupId: "g-7a", teacherId: "t-bo", coTeacherId: "t-anna" },
];

const names: Record<string, string> = { "t-anna": "Anna Ek", "t-bo": "Bo Alm", "t-cilla": "Cilla Öst" };
const groups: Record<string, string> = { "g-7a": "7A", "g-7b": "7B" };

const renderMatrix = (
  props: Partial<React.ComponentProps<typeof StaffingMatrix>> = {},
) => {
  const onOpenTeacher = vi.fn();
  render(
    <StaffingMatrix
      report={report}
      subjects={subjects}
      requirements={requirements}
      groupName={(id) => groups[id] ?? "—"}
      teacherName={(id) => names[id] ?? id}
      week="standard"
      unit="minutes"
      onOpenTeacher={onOpenTeacher}
      {...props}
    />,
  );
  return { onOpenTeacher };
};

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getByRole("rowheader").textContent);

describe("StaffingMatrix", () => {
  it("keeps the report's order — OVER first — and names each row's status", () => {
    renderMatrix();
    expect(rowNames()).toEqual(["Bo AlmstatusOVER", "Anna EkstatusOK", "Cilla ÖststatusNO_TARGET"]);
  });

  it("shows only taught subjects as columns, by code, and minutes in the cells", () => {
    renderMatrix();
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.slice(1, 3)).toEqual(["MA", "NO"]);
    expect(headers).not.toContain("SV");

    const anna = screen.getByText("Anna Ek").closest("tr")!;
    const cells = within(anna).getAllByRole("cell");
    expect(cells[0]?.textContent).toBe("600");
    expect(cells[1]?.textContent).toBe("300");
    // Tjänst, mål, undervisning, saldo
    expect(cells.slice(2, 6).map((cell) => cell.textContent)).toEqual(["80", "865", "900", "-35"]);
  });

  it("names the groups behind a cell in its tooltip", () => {
    renderMatrix();
    const anna = screen.getByText("Anna Ek").closest("tr")!;
    const ma = within(anna).getAllByRole("cell")[0]!;
    expect(ma).toHaveAttribute(
      "title",
      "cellLabel(Anna Ek|Matematik|600) · cellGroups(7A, 7B)",
    );
    // Co-teaching counts: Anna is co-teacher on 7A NO.
    expect(within(anna).getAllByRole("cell")[1]).toHaveAttribute(
      "title",
      "cellLabel(Anna Ek|Naturorientering|300) · cellGroups(7A)",
    );
  });

  it("switches the cells to percent of employment, and leaves a teacher without a post empty", () => {
    renderMatrix({ unit: "percent" });
    const anna = screen.getByText("Anna Ek").closest("tr")!;
    expect(within(anna).getAllByRole("cell")[0]?.textContent).toBe("53,3 %");
    const cilla = screen.getByText("Cilla Öst").closest("tr")!;
    expect(within(cilla).getAllByRole("cell")[0]?.textContent).toBe("—");
    expect(within(cilla).getAllByRole("cell")[2]?.textContent).toBe("noPost");
  });

  it("switches the teaching column to the peak week, header and figure alike", () => {
    renderMatrix({ week: "peak" });
    expect(screen.getByRole("columnheader", { name: "teachingPeakHeader" })).toBeInTheDocument();
    const anna = screen.getByText("Anna Ek").closest("tr")!;
    expect(within(anna).getAllByRole("cell")[4]?.textContent).toBe("960");
    // The bar follows the week too: 960 of 865 is over.
    expect(within(anna).getByText("barLabel(111)")).toBeInTheDocument();
  });

  it("labels every bar, including the one with no target", () => {
    renderMatrix();
    expect(screen.getByText("barLabel(111,1)")).toBeInTheDocument();
    expect(screen.getByText("barLabel(104)")).toBeInTheDocument();
    expect(screen.getByText("barNoTarget")).toBeInTheDocument();
  });

  it("opens the teacher on the row's name", async () => {
    const user = userEvent.setup();
    const { onOpenTeacher } = renderMatrix();
    await user.click(screen.getByRole("button", { name: "openDrawer(Bo Alm)" }));
    expect(onOpenTeacher).toHaveBeenCalledWith("t-bo");
  });
});
