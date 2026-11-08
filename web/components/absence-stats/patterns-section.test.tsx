import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PatternsView } from "@/lib/absence-stats";
import { PATTERNS, SUPPRESSED } from "./__fixtures__/views";
import { plain, renderStats } from "./__fixtures__/render";
import { PatternsSection } from "./patterns-section";

/**
 * When absence falls: weekday, pass and subject. A class too small to count
 * has no pattern and the page says why instead of drawing one; a share of
 * nothing recorded is a dash, never 0 %.
 */

const section = (patterns: PatternsView, pupil = false) => (
  <PatternsSection id="patterns" title="Mönster" patterns={patterns} minGroup={5} pupil={pupil} />
);

describe("the patterns", () => {
  it("names the weekdays, the passes by their start time and the subjects as the gateway ordered them", () => {
    renderStats(section(PATTERNS));
    const weekdays = screen.getByRole("table", { name: "Frånvaro per veckodag" });
    expect(within(weekdays).getAllByRole("row").slice(1).map((row) => plain(within(row).getAllByRole("cell")[0]).split(" ")[0])).toEqual([
      "Måndag",
      "Fredag",
    ]);
    const slots = screen.getByRole("table", { name: "Frånvaro per pass" });
    expect(plain(within(slots).getAllByRole("row")[1]!)).toContain("08:10");
    const subjects = screen.getByRole("table", { name: "Frånvaro per ämne" });
    expect(within(subjects).getAllByRole("row").slice(1).map((row) => plain(within(row).getAllByRole("cell")[0]).split(" ")[0])).toEqual([
      "Idrott",
      "Matematik",
    ]);
  });

  it("writes the shares and the minutes they rest on", () => {
    renderStats(section(PATTERNS));
    const monday = within(screen.getByRole("table", { name: "Frånvaro per veckodag" })).getAllByRole("row")[1]!;
    expect(plain(within(monday).getAllByRole("cell")[0])).toBe("Måndag 2 000 min registrerade");
    expect(plain(within(monday).getAllByRole("cell")[1])).toBe("4,0 %");
    expect(plain(within(monday).getAllByRole("cell")[2])).toBe("3,0 %");
    expect(plain(within(monday).getAllByRole("cell")[3])).toBe("7,0 %");
  });

  it("writes a dash for a pass with nothing recorded, not 0 %", () => {
    renderStats(section(PATTERNS));
    const pass = within(screen.getByRole("table", { name: "Frånvaro per pass" })).getAllByRole("row")[2]!;
    expect(plain(within(pass).getAllByRole("cell")[1])).toBe("—");
    expect(plain(within(pass).getAllByRole("cell")[3])).toBe("—");
  });

  it("says how many pupils a class pattern rests on, and says nothing of a count for a pupil", () => {
    renderStats(section(PATTERNS));
    expect(screen.getByText("Mönstret bygger på 22 elever med markeringar.")).toBeInTheDocument();
  });

  it("does not count pupils behind a pupil's own pattern", () => {
    renderStats(section({ ...PATTERNS, groupSize: 1 }, true));
    expect(screen.queryByText(/Mönstret bygger på/)).not.toBeInTheDocument();
  });

  it("gives no pattern for a class under five pupils, and says why", () => {
    renderStats(section(SUPPRESSED));
    expect(screen.getByText("Mönster visas inte")).toBeInTheDocument();
    expect(screen.getByText(/Färre än 5 elever har markeringar under perioden/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says when the period holds no mark at all", () => {
    renderStats(section({ groupSize: 0, suppressed: false, weekdays: [], slots: [], subjects: [] }));
    expect(screen.getByText("Inga markeringar under perioden.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("is a section named by its heading", () => {
    renderStats(section(PATTERNS));
    expect(screen.getByRole("region", { name: "Mönster" })).toBeInTheDocument();
  });
});
