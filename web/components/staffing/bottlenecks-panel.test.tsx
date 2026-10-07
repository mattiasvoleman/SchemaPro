import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SubjectBottleneck } from "@/lib/teacher-load";
import { BottlenecksPanel } from "./bottlenecks-panel";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const bottleneck = (overrides: Partial<SubjectBottleneck>): SubjectBottleneck => ({
  subjectId: "s-ma",
  subjectName: "Matematik",
  unstaffedCount: 2,
  demandedMinutesPerWeek: 360,
  qualifiedRemainingMinutesPerWeek: 120,
  qualifiedTeacherCount: 2,
  qualifiedNoTargetCount: 0,
  short: true,
  ...overrides,
});

describe("BottlenecksPanel", () => {
  it("shows demand against the qualified teachers' room, short first as the report orders it", () => {
    render(
      <BottlenecksPanel
        report={{
          bottlenecksComputed: true,
          subjectBottlenecks: [
            bottleneck({}),
            bottleneck({
              subjectId: "s-no",
              subjectName: "NO",
              unstaffedCount: 1,
              demandedMinutesPerWeek: 90,
              qualifiedRemainingMinutesPerWeek: 400,
              qualifiedNoTargetCount: 1,
              short: false,
            }),
          ],
        }}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
      "MatematikbottleneckRows(2)",
      "NObottleneckRows(1)",
    ]);
    const ma = within(rows[0]!).getAllByRole("cell").map((cell) => cell.textContent);
    expect(ma).toEqual(["360", "120", "2", "bottleneckShort(240)"]);
    const no = within(rows[1]!).getAllByRole("cell").map((cell) => cell.textContent);
    // A teacher without a target is counted beside the figure, not in it.
    expect(no).toEqual(["90", "400", "bottleneckTeachersNoTarget(2|1)", "bottleneckEnough"]);
  });

  it("says the capacity is unknown, rather than painting every subject short, without behörigheter", () => {
    render(
      <BottlenecksPanel
        report={{ bottlenecksComputed: false, subjectBottlenecks: [] }}
      />,
    );
    expect(screen.getByText("bottlenecksNotComputed")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says there is no demand when nothing is unstaffed", () => {
    render(<BottlenecksPanel report={{ bottlenecksComputed: true, subjectBottlenecks: [] }} />);
    expect(screen.getByText("bottlenecksEmpty")).toBeInTheDocument();
  });
});
