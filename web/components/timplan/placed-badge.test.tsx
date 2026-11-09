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
