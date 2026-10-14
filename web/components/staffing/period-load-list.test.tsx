import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PeriodLoad } from "@/lib/teacher-load";
import { PeriodLoadList } from "./period-load-list";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const stretch = (overrides: Partial<PeriodLoad>): PeriodLoad => ({
  from: "2026-08-17",
  to: "2027-01-10",
  kind: "BASE",
  effectiveFrom: "2026-08-17",
  effectiveTo: "2027-01-10",
  employmentPercent: 100,
  reductionPercent: 0,
  ownTargetMinutesPerWeek: null,
  targetMinutesPerWeek: 600,
  teachingWeeks: 20,
  countedMinutesPerWeek: 480,
  balanceMinutesPerWeek: 120,
  percentOfTarget: 80,
  status: "UNDER",
  ...overrides,
});

describe("PeriodLoadList", () => {
  it("says, without hovering, which stretch is over: each with its dates, figures and own verdict", () => {
    render(
      <PeriodLoadList
        periods={[
          stretch({}),
          stretch({
            from: "2027-01-11",
            to: "2027-06-11",
            kind: "PERIOD",
            employmentPercent: 50,
            reductionPercent: 10,
            effectiveFrom: "2027-01-11",
            targetMinutesPerWeek: 240,
            countedMinutesPerWeek: 480,
            status: "OVER",
          }),
        ]}
      />,
    );
    const [autumn, spring] = screen.getAllByRole("listitem");
    expect(autumn).toHaveTextContent("periodDates(2026-08-17|2027-01-10) · periodFigures(100)");
    expect(autumn).toHaveTextContent("periodTargetCounted(600|480)");
    expect(autumn).toHaveTextContent("statusUNDER");
    expect(spring).toHaveTextContent("periodFiguresReduction(50|10)");
    expect(spring).toHaveTextContent("periodTargetCounted(240|480)");
    expect(spring).toHaveTextContent("statusOVER");
  });

  it("gives a stretch with no taught week no verdict, and one without a target its counted minutes", () => {
    render(
      <PeriodLoadList
        periods={[
          stretch({ targetMinutesPerWeek: null, status: "NO_TARGET" }),
          stretch({ from: "2026-12-21", kind: "PERIOD", effectiveFrom: "2026-12-21", teachingWeeks: 0 }),
          stretch({ from: "2027-01-12", to: "2027-01-15", kind: "PERIOD", effectiveFrom: null, effectiveTo: null, teachingWeeks: 0 }),
        ]}
      />,
    );
    const [untargeted, lov, noMonday] = screen.getAllByRole("listitem");
    expect(untargeted).toHaveTextContent("periodCountedOnly(480)");
    expect(lov).toHaveTextContent("periodNoTeachingWeek");
    expect(lov).not.toHaveTextContent("status");
    expect(noMonday).toHaveTextContent("periodNoWeek");
  });
});
