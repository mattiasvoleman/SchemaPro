import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pointsOfSeries } from "@/lib/absence-stats";
import { SCHOOL_SERIES, figures, month, reporting } from "./__fixtures__/views";
import { plain, renderStats } from "./__fixtures__/render";
import { MonthChart } from "./month-chart";
import { SeriesSection } from "./series-section";

/**
 * A school's or a class's months: the chart, and the table that says every
 * number the chart draws. The figures are the gateway's; what is checked here
 * is that they are written, not recounted, and that a month with no figure
 * and a month that is going on are said so and never read as 0.
 */

const section = (series = SCHOOL_SERIES) => (
  <SeriesSection
    id="series"
    title="Skolan månad för månad"
    caption="Skolans frånvaro per månad"
    series={series}
    minGroup={5}
  />
);

const rowOf = (name: RegExp) => screen.getByRole("row", { name });

describe("the months table", () => {
  it("is newest first under its läsår, with the pupils each figure rests on", () => {
    renderStats(section());
    const table = screen.getByRole("table", { name: "Skolans frånvaro per månad" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => plain(within(row).getAllByRole("cell")[0]))).toEqual([
      "Läsår 2026/27",
      "nov. 2026 Hittills, till och med 6 nov. 2026",
      "okt. 2026",
      "sep. 2026",
      "Läsår 2025/26",
      "okt. 2025",
    ]);
    const october = within(rowOf(/^okt\. 2026/)).getAllByRole("cell");
    expect(plain(october[1])).toBe("24 av 24");
  });

  it("writes the minutes and the share the gateway sent, and last year's share under each", () => {
    renderStats(section());
    const cells = within(rowOf(/^okt\. 2026/)).getAllByRole("cell");
    // Giltig, ogiltig, sena ankomster, rapporteringsgrad.
    expect(plain(cells[2])).toBe("480 min · 4,0 % Förra året: 2,5 %");
    expect(plain(cells[3])).toBe("270 min · 2,3 % Förra året: 1,5 %");
    expect(plain(cells[4])).toBe("6 Förra året: 0");
    expect(plain(cells[5])).toBe("95,0 % 399 av 420 lektioner Förra året: 90,0 %");
  });

  it("leaves out last year's line for a month the series has no year before for", () => {
    renderStats(section());
    const cells = within(rowOf(/^okt\. 2025/)).getAllByRole("cell");
    expect(plain(cells[2])).toBe("250 min · 2,5 %");
    expect(plain(cells[5])).toBe("90,0 % 360 av 400 lektioner");
  });

  it("marks the month that is going on 'hittills' with the day it reaches", () => {
    renderStats(section());
    const first = within(rowOf(/^nov\. 2026/)).getAllByRole("cell")[0]!;
    expect(plain(first)).toBe("nov. 2026 Hittills, till och med 6 nov. 2026");
    expect(within(rowOf(/^okt\. 2026/)).queryByText(/Hittills/)).not.toBeInTheDocument();
  });

  it("says that a month has no figure, in words, and never writes it as a zero", () => {
    renderStats(section());
    const row = rowOf(/^sep\. 2026/);
    expect(within(row).getByText("Ingen siffra: färre än 5 elever har markeringar")).toBeInTheDocument();
    // Three pupils had a mark of 24: the count the missing figure explains.
    expect(plain(within(row).getAllByRole("cell")[1])).toBe("3 av 24");
    expect(within(row).queryByText(/min ·/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/^0,0 %$/)).not.toBeInTheDocument();
  });

  it("says that last year had no figure when this month has one", () => {
    renderStats(section());
    // November last year has no figure at all (and no held lesson to report): said, not compared with a nothing.
    const cells = within(rowOf(/^nov\. 2026/)).getAllByRole("cell");
    expect(plain(cells[2])).toBe("40 min · 2,0 % Förra året: ingen siffra");
    expect(plain(cells[5])).toBe("50,0 % 30 av 60 lektioner Förra året: ingen siffra");
  });

  it("writes a dash for a share of nothing held, and says no lesson was held", () => {
    renderStats(section([month("2026-10-01", { reporting: reporting(0, 0) })]));
    expect(plain(within(rowOf(/^okt\. 2026/)).getAllByRole("cell")[5])).toBe("— Inga hållna lektioner");
  });

  it("names the classes of a month when a class and its predecessor share it", () => {
    renderStats(section([month("2026-08-01", { classNames: ["6C", "7C"] }), month("2026-09-01", { classNames: ["7C"] })]));
    expect(screen.getByText("Klass: 6C, 7C")).toBeInTheDocument();
    expect(screen.queryByText("Klass: 7C")).not.toBeInTheDocument();
  });

  it("says so when no month has been counted yet, with no chart and no table", () => {
    renderStats(section([]));
    expect(screen.getByText(/Ingen månad har räknats än/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("has the same words in English", () => {
    renderStats(section(), "en");
    expect(screen.getByRole("columnheader", { name: "Excused absence" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Reporting rate" })).toBeInTheDocument();
    expect(screen.getByText("No figure: fewer than 5 pupils have marks")).toBeInTheDocument();
    expect(screen.getByText("School year 2026/27")).toBeInTheDocument();
  });
});

describe("the chart", () => {
  it("is one image named after what it shows, and sends the reader to the table", () => {
    renderStats(section());
    const chart = screen.getByRole("img", { name: /Diagram över giltig och ogiltig frånvaro per månad/ });
    expect(chart).toHaveAccessibleName(/Samma siffror står i tabellen under/);
    // The table is there beside it: the chart is never the only reading.
    expect(screen.getByRole("table", { name: "Skolans frånvaro per månad" })).toBeInTheDocument();
  });

  it("draws a bar for a month with a figure and a dotted line, never a bar, for one without", () => {
    const { container } = renderStats(<MonthChart points={pointsOfSeries(SCHOOL_SERIES)} />);
    const group = (month: string) => container.querySelector(`g[data-month="${month}"]`)!;
    expect(group("2026-10-01").querySelectorAll("rect")).toHaveLength(2);
    expect(group("2026-09-01").querySelectorAll("rect")).toHaveLength(0);
    expect(group("2026-09-01").querySelectorAll("line")).toHaveLength(1);
    // October has last year's tick as well as its line; November, whose year before has no figure, has none.
    expect(group("2026-10-01").querySelectorAll("line")).toHaveLength(1);
    expect(group("2026-11-01").querySelectorAll("line")).toHaveLength(0);
  });

  it("hatches the invalid bar of a month that is going on", () => {
    const { container } = renderStats(<MonthChart points={pointsOfSeries(SCHOOL_SERIES)} />);
    const going = container.querySelector('g[data-month="2026-11-01"] rect')!;
    expect(going.getAttribute("fill")).toMatch(/^url\(#/);
    const over = container.querySelector('g[data-month="2026-10-01"] rect')!;
    expect(over.getAttribute("fill")).toBeNull();
  });

  it("labels the axis in percent of the registered minutes and keys every mark it uses", () => {
    renderStats(<MonthChart points={pointsOfSeries(SCHOOL_SERIES)} />);
    expect(screen.getByText("Andel av de registrerade minuterna")).toBeInTheDocument();
    for (const key of ["Ogiltig frånvaro", "Giltig frånvaro", "Samma månad året före", "Månad som pågår", "Ingen siffra"]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
  });

  it("scales its axis to the tallest bar", () => {
    const { container } = renderStats(
      <MonthChart points={pointsOfSeries([month("2026-10-01", { figures: figures(1000, 300, 300) })])} />,
    );
    // 60 % of the recorded minutes: the axis tops out at 100 %.
    expect([...container.querySelectorAll("text")].map((node) => plain(node.textContent))).toContain("100 %");
  });
});
