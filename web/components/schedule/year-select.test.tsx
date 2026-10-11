import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AcademicYear } from "@/lib/types";
import { YearSelect, useYearScope } from "./year-select";

const yearsState = vi.hoisted(() => ({
  data: undefined as AcademicYear[] | undefined,
  isLoading: false,
  isError: false,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => yearsState,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => (key === "year" ? "Läsår" : key),
}));

const year = (id: string, name: string, isActive = false): AcademicYear =>
  ({
    id,
    name,
    startDate: "2026-08-17",
    endDate: "2027-06-11",
    isActive,
    predecessorId: null,
    graduatingGradeLevel: null,
  }) as AcademicYear;

const YEARS = [year("y1", "2025/2026"), year("y2", "2026/2027", true), year("y3", "2027/2028")];

beforeEach(() => {
  yearsState.data = YEARS;
  yearsState.isLoading = false;
  yearsState.isError = false;
});

describe("YearSelect", () => {
  it("is a w-44 combobox named Läsår, showing the chosen year", () => {
    render(<YearSelect value="y2" onValueChange={() => undefined} />);
    const trigger = screen.getByRole("combobox", { name: "Läsår" });
    expect(trigger).toHaveClass("w-44");
    expect(trigger).toHaveTextContent("2026/2027");
  });

  it("offers every year and reports the choice", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<YearSelect value="y2" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "2025/2026",
      "2026/2027",
      "2027/2028",
    ]);
    await user.click(screen.getByRole("option", { name: "2027/2028" }));
    expect(onValueChange).toHaveBeenCalledWith("y3");
  });

  it("takes its name from a visible label when given an id", () => {
    render(
      <>
        <label htmlFor="report-year">Rapportens läsår</label>
        <YearSelect id="report-year" value="y1" onValueChange={() => undefined} label="ignored" />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Rapportens läsår" })).toHaveAttribute("id", "report-year");
  });

  it("holds the header's place with a skeleton while the years load", () => {
    yearsState.data = undefined;
    yearsState.isLoading = true;
    const { container } = render(<YearSelect value={null} onValueChange={() => undefined} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("animate-pulse", "h-9", "w-44");
  });

  it("renders nothing for a school without years", () => {
    yearsState.data = [];
    const { container } = render(<YearSelect value={null} onValueChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers only the years it is given", async () => {
    const user = userEvent.setup();
    render(<YearSelect value="y3" years={[YEARS[2]!]} onValueChange={() => undefined} />);
    await user.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
});

describe("useYearScope", () => {
  it("defaults to the active year, follows a choice and ignores an unknown id", () => {
    const { result } = renderHook(() => useYearScope());
    expect(result.current.yearId).toBe("y2");

    act(() => result.current.setYearId("y1"));
    expect(result.current.year?.name).toBe("2025/2026");

    act(() => result.current.setYearId("gone"));
    expect(result.current.yearId).toBe("y2");
  });

  it("starts from a linked year, and falls back to the first when none is active", () => {
    expect(renderHook(() => useYearScope("y3")).result.current.yearId).toBe("y3");
    yearsState.data = [year("a", "2024/2025"), year("b", "2025/2026")];
    expect(renderHook(() => useYearScope()).result.current.yearId).toBe("a");
  });

  it("is null while loading or without years, and passes the query's state on", () => {
    yearsState.data = undefined;
    yearsState.isLoading = true;
    const { result } = renderHook(() => useYearScope());
    expect(result.current.year).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.years).toEqual([]);
  });
});
