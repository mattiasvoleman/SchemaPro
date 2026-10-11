import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilterBar, FilterField } from "./filter-bar";

describe("FilterBar", () => {
  it("lays its fields out bottom-aligned and wrapping", () => {
    render(
      <FilterBar role="group" aria-label="Filter">
        <span>field</span>
      </FilterBar>,
    );
    const bar = screen.getByRole("group", { name: "Filter" });
    expect(bar).toHaveClass("flex", "flex-wrap", "items-end", "gap-3");
  });

  it("merges a className", () => {
    render(<FilterBar data-testid="bar" className="print:hidden" />);
    expect(screen.getByTestId("bar")).toHaveClass("flex", "print:hidden");
  });
});

describe("FilterField", () => {
  it("names its control by a visible label", () => {
    render(
      <FilterBar>
        <FilterField id="report-from" label="Från">
          <input id="report-from" type="date" className="w-40" />
        </FilterField>
      </FilterBar>,
    );

    const input = screen.getByLabelText("Från");
    expect(input).toHaveAttribute("id", "report-from");
    expect(input.parentElement).toHaveClass("space-y-1.5");
    expect(screen.getByText("Från")).toBeVisible();
  });

  it("names a button-like control (a SelectTrigger) the same way", () => {
    render(
      <FilterField id="report-group" label="Klass">
        <button id="report-group" type="button" role="combobox" aria-expanded="false">
          7A
        </button>
      </FilterField>,
    );
    expect(screen.getByRole("combobox", { name: "Klass" })).toBeInTheDocument();
  });
});
