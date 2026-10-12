import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiStrip, KpiTile } from "./kpi";

describe("KpiStrip", () => {
  it("is a description list of tiles, two across on a phone and four across by default", () => {
    const { container } = render(
      <KpiStrip>
        <KpiTile label="Obemannade" value={3} />
        <KpiTile label="Över mål" value={0} />
      </KpiStrip>,
    );

    const list = container.querySelector("dl");
    // grid-cols-2 from the base: one tile per row stacked the dashboard's
    // eight into a phone-length scroll. It also covers sm, so no sm:grid-cols-2.
    expect(list).toHaveClass("grid", "grid-cols-2", "gap-3", "lg:grid-cols-4");
    expect(screen.getAllByRole("term")).toHaveLength(2);
    expect(screen.getAllByRole("definition")).toHaveLength(2);
  });

  it("takes three or five columns, still two across on a phone", () => {
    const { container, rerender } = render(<KpiStrip columns={5} />);
    expect(container.querySelector("dl")).toHaveClass("grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-5");
    rerender(<KpiStrip columns={3} />);
    expect(container.querySelector("dl")).toHaveClass("grid-cols-2", "sm:grid-cols-3");
    expect(container.querySelector("dl")).not.toHaveClass("lg:grid-cols-4");
  });
});

describe("KpiTile", () => {
  it("draws the label as an eyebrow and the figure large and tabular", () => {
    render(
      <dl>
        <KpiTile label="Planerat" value="1 240 min" detail="20,7 h" />
      </dl>,
    );

    expect(screen.getByRole("term")).toHaveClass("text-xs", "font-medium", "uppercase", "tracking-wide", "text-muted-foreground");
    const [figure, detail] = screen.getAllByRole("definition");
    expect(figure).toHaveTextContent("1 240 min");
    // A step smaller below sm, so a figure fits half a phone's width.
    expect(figure).toHaveClass("mt-1", "text-xl", "sm:text-2xl", "font-semibold", "tabular-nums");
    expect(detail).toHaveTextContent("20,7 h");
    expect(detail).toHaveClass("text-sm", "text-muted-foreground");
    expect(screen.getByRole("term").parentElement).toHaveClass("rounded-lg", "border", "bg-card", "p-3", "sm:p-4");
  });

  it("wraps a long label inside its half of the row instead of truncating it or widening the column", () => {
    render(
      <dl>
        <KpiTile label="Passerade utan beslut" value={2} />
      </dl>,
    );
    const label = screen.getByRole("term");
    expect(label).toHaveClass("break-words");
    expect(label).not.toHaveClass("truncate");
    // A grid item's min-width is auto: without min-w-0 one unbroken compound
    // would push its column wider than half the strip.
    expect(label.parentElement).toHaveClass("min-w-0");
  });

  it("shows a zero as a figure, not as missing", () => {
    render(
      <dl>
        <KpiTile label="Över mål" value={0} />
      </dl>,
    );
    expect(screen.getByRole("definition")).toHaveTextContent("0");
  });

  it("shows a sentence for a figure that is not there, with its reason as a tooltip", () => {
    render(
      <dl>
        <KpiTile label="Obehöriga" value={null} fallback="Inte registrerat" title="Behörighet är inte inlagd" />
      </dl>,
    );
    const figure = screen.getByRole("definition");
    expect(figure).toHaveTextContent("Inte registrerat");
    expect(figure).toHaveClass("text-sm", "text-foreground");
    expect(figure).toHaveAttribute("title", "Behörighet är inte inlagd");
  });

  it("shows a muted dash when there is no figure and no fallback", () => {
    render(
      <dl>
        <KpiTile label="Närvaro" value={null} />
      </dl>,
    );
    const figure = screen.getByRole("definition");
    expect(figure).toHaveTextContent("—");
    expect(figure).toHaveClass("text-muted-foreground");
  });
});
