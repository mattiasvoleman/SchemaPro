import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StageWeekMatrix, stagesOf } from "./stage-week-matrix";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const row = (minGradeLevel: number, maxGradeLevel: number) => ({ minGradeLevel, maxGradeLevel });

describe("stagesOf", () => {
  it("gives each stage the rows mention once, in year order", () => {
    // The order the rows arrived in, twice over for 4–6, and a single year
    // between two spans: the school decides what a stage is.
    expect(stagesOf([row(7, 9), row(4, 6), row(4, 6), row(0, 3), row(4, 4)])).toEqual([
      { min: 0, max: 3 },
      { min: 4, max: 4 },
      { min: 4, max: 6 },
      { min: 7, max: 9 },
    ]);
  });

  it("has no stages before the rows have arrived", () => {
    expect(stagesOf(undefined)).toEqual([]);
  });
});

describe("StageWeekMatrix", () => {
  it("is a region named by its heading, one row per stage and a column per weekday", () => {
    render(
      <StageWeekMatrix
        id="vecka"
        title="Så här blir veckan"
        description="Uträknat ur raderna ovan"
        stageLabel="Årskurser"
        spans={[{ min: 4, max: 6 }, { min: 5, max: 5 }]}
        renderCell={(span, day) => `${span.min}:${day}`}
      />,
    );

    const region = screen.getByRole("region", { name: "Så här blir veckan" });
    expect(region.id).toBe("vecka");
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe("Så här blir veckan");
    // Named for a reader whose table navigation lands inside it.
    expect(within(region).getByRole("table", { name: "Så här blir veckan" })).toBeTruthy();
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Årskurser", "1", "2", "3", "4", "5"]);
    const rows = within(region).getAllByRole("row").slice(1);
    expect([...rows[0]!.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "grade(4)–grade(6)",
      "4:1",
      "4:2",
      "4:3",
      "4:4",
      "4:5",
    ]);
    // A single year reads as one year, not as a range of one.
    expect(rows[1]!.querySelector("td")?.textContent).toBe("grade(5)");
  });
});
