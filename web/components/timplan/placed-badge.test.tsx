import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import type { RequirementPlacement } from "@/lib/requirement-placements";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { PlacedBadge, placementLine, placementsSummary } from "./placed-badge";

/**
 * The mark "Förlagd", with the catalogues' real words: the page test echoes keys
 * and proves where the mark goes, not what it says.
 */

const row = (extra: Partial<RequirementPlacement> = {}): RequirementPlacement => ({
  id: "p1",
  requirementId: "r1",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "room-1",
  roomName: "Simhallen",
  recurrence: "ODD_WEEKS",
  teacherId: null,
  ...extra,
});

function inLocale(locale: "sv" | "en", ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("the mark on a post with lessons placed", () => {
  it("is a pin and the word, with the rows in the tooltip", () => {
    inLocale("sv", <PlacedBadge rows={[row()]} />);

    const word = screen.getByText("Förlagd");
    expect(word.parentElement).toHaveAttribute("title", "tis 10:00–11:00, Simhallen, udda veckor");
    // The pin is decoration: the word says it.
    expect(word.parentElement?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("says the rows beside the word where there is room for them", () => {
    inLocale("sv", <PlacedBadge rows={[row()]} withRows />);

    expect(screen.getByText("tis 10:00–11:00, Simhallen, udda veckor")).toBeInTheDocument();
  });

  it("says it in English", () => {
    inLocale("en", <PlacedBadge rows={[row({ recurrence: "ALL_WEEKS" })]} />);

    expect(screen.getByText("Placed").parentElement).toHaveAttribute("title", "tue 10:00–11:00, Simhallen");
  });

  it("is no wider than the recurrence badge beside it, which is 96 px", () => {
    inLocale("sv", <PlacedBadge rows={[row()]} />);

    expect(screen.getByText("Förlagd").parentElement?.className).toContain("max-w-24");
  });
});

describe("a post's rows in words", () => {
  const t = (key: string, values?: Record<string, string | number>) => `${key}:${Object.values(values ?? {}).join("|")}`;

  it("puts the week in order: the day, then the start", () => {
    const summary = placementsSummary(
      [row({ id: "b", dayOfWeek: 4 }), row({ id: "c", startTime: "13:00", endTime: "14:00" }), row()],
      t,
      (key) => key,
    );

    expect(summary.split("; ")).toEqual([
      "placements.row:tuesday|10:00|11:00|Simhallen|ODD_WEEKS",
      "placements.row:tuesday|13:00|14:00|Simhallen|ODD_WEEKS",
      "placements.row:thursday|10:00|11:00|Simhallen|ODD_WEEKS",
    ]);
  });

  it("does not trip over a day the school week has no name for", () => {
    expect(placementLine(row({ dayOfWeek: 6 }), t, (key) => key)).toMatch(/^placements\.row:6\|10:00/);
  });
});

// Review of #298, LÅG-4: a shared post's rows are different teachers' lessons, and a row said only when and where.
describe("a shared post's rows say whose lesson each is", () => {
  const NAMES: Record<string, string> = { "t-bo": "Bo Ek", "t-ce": "Cecilia Ås" };
  const nameOf = (id: string) => NAMES[id] ?? null;

  it("adds the teacher's name to the row, in the tooltip and beside the word, in both languages", () => {
    const rows = [row({ teacherId: "t-ce", recurrence: "ALL_WEEKS" }), row({ id: "p2", dayOfWeek: 4, startTime: "13:15", endTime: "13:55", teacherId: "t-bo" })];
    inLocale("sv", <PlacedBadge rows={rows} withRows teacherName={nameOf} />);
    expect(screen.getByText("Förlagd").parentElement).toHaveAttribute(
      "title",
      "tis 10:00–11:00, Simhallen (Cecilia Ås); tor 13:15–13:55, Simhallen, udda veckor (Bo Ek)",
    );
    expect(screen.getByText("tis 10:00–11:00, Simhallen (Cecilia Ås); tor 13:15–13:55, Simhallen, udda veckor (Bo Ek)")).toBeInTheDocument();
  });

  it("says it in English", () => {
    inLocale("en", <PlacedBadge rows={[row({ teacherId: "t-bo", recurrence: "ALL_WEEKS" })]} teacherName={nameOf} />);
    expect(screen.getByText("Placed").parentElement).toHaveAttribute("title", "tue 10:00–11:00, Simhallen (Bo Ek)");
  });

  it("leaves a row as it was when it has no teacher, or when the teacher cannot be named, or when no name is given", () => {
    inLocale("sv", <PlacedBadge rows={[row({ teacherId: null }), row({ id: "p2", dayOfWeek: 4, teacherId: "t-gone" })]} teacherName={nameOf} />);
    expect(screen.getByText("Förlagd").parentElement).toHaveAttribute("title", "tis 10:00–11:00, Simhallen, udda veckor; tor 10:00–11:00, Simhallen, udda veckor");
  });

  it("is the page's words for the cell's label when the summary is asked for with names", () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}:${Object.values(values ?? {}).join("|")}`;
    expect(placementLine(row({ teacherId: "t-bo" }), t, (key) => key, nameOf)).toBe("placements.rowOf:placements.row:tuesday|10:00|11:00|Simhallen|ODD_WEEKS|Bo Ek");
    expect(placementsSummary([row({ teacherId: "t-bo" })], t, (key) => key)).toBe("placements.row:tuesday|10:00|11:00|Simhallen|ODD_WEEKS");
  });
});
