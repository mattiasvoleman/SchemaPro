import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { LunchLocksNote, PeriodNote } from "./period-note";

/**
 * The two lines under a refusal, rendered from the real message files by the
 * real next-intl — not by a mock that shows the key and its arguments, which
 * is what the pages' own tests use and cannot see a sentence with.
 *
 * Each sentence is written out whole. The English one is also held to the
 * API's (src/optimization/catalogue-sentences.spec.ts); the Swedish one had
 * no test at all, and its placeholders swapped, "med flera" on the wrong
 * branch or another last word passed every suite (the review of #302).
 */
type Params = Record<string, string | number> | null | undefined;

function said(locale: "sv" | "en", note: React.ReactElement): string {
  const { container } = render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
      {note}
    </NextIntlClientProvider>,
  );
  return container.textContent ?? "";
}

describe("LunchLocksNote", () => {
  // Four days no two of which are alike, so a line with two of them swapped
  // is another line.
  const dated = {
    group: "7A",
    lockPeriods: "0;2",
    lockFrom: "2026-08-15",
    lockTo: "2026-12-20",
    otherLockFrom: "2027-01-11",
    otherLockTo: "2027-06-12",
    lockWeeksElsewhere: 0,
  };
  const lunch = (locale: "sv" | "en", params: Params) => said(locale, <LunchLocksNote params={params} />);

  it("says in Swedish which two parts of the läsår the locks are in, and that the meal is the year's", () => {
    expect(lunch("sv", dated)).toBe(
      "De låsta lektionerna som tillsammans stänger lunchfönstret ligger i olika delar av läsåret: " +
        "veckorna 15 augusti 2026 – 20 december 2026 och veckorna 11 januari 2027 – 12 juni 2027. " +
        "Klassens lunch är en och samma tid hela läsåret och måste därför gå fri från låsta lektioner i varje del av det.",
    );
  });

  it("adds “med flera” in Swedish only when the locks run in more stretches than the two written out", () => {
    expect(lunch("sv", { ...dated, lockWeeksElsewhere: 3 })).toBe(
      "De låsta lektionerna som tillsammans stänger lunchfönstret ligger i olika delar av läsåret: " +
        "veckorna 15 augusti 2026 – 20 december 2026 och veckorna 11 januari 2027 – 12 juni 2027 med flera. " +
        "Klassens lunch är en och samma tid hela läsåret och måste därför gå fri från låsta lektioner i varje del av det.",
    );
    expect(lunch("sv", dated)).not.toContain("med flera");
  });

  it("says the same in English, with and without the other stretches", () => {
    const sentence = (more: string) =>
      "The locked lessons that close the lunch window between them run in different parts of the school year: " +
      `the weeks from 15 August 2026 to 20 December 2026 and the weeks from 11 January 2027 to 12 June 2027${more}. ` +
      "A class's lunch is one time all year, so it has to keep clear of locked lessons in every part of the year.";
    expect(lunch("en", dated)).toBe(sentence(""));
    expect(lunch("en", { ...dated, lockWeeksElsewhere: 1 })).toBe(sentence(", among others"));
  });

  it("shows no line, and does not throw, for a day the calendar does not have", () => {
    for (const key of ["lockFrom", "lockTo", "otherLockFrom", "otherLockTo"] as const) {
      expect(lunch("sv", { ...dated, [key]: "2026-13-45" })).toBe("");
      expect(lunch("en", { ...dated, [key]: "2026-02-30" })).toBe("");
    }
    expect(lunch("sv", null)).toBe("");
    expect(lunch("sv", { group: "7A", lockPeriods: "0;2" })).toBe("");
  });
});

describe("PeriodNote", () => {
  const counted = { period: 0, periods: "0,1,2", periodFrom: "2026-08-15", periodTo: "2026-12-27", periodStretches: 1 };
  const note = (locale: "sv" | "en", params: Params) => said(locale, <PeriodNote params={params} />);

  it("says in Swedish the weeks a refusal was counted for", () => {
    expect(note("sv", counted)).toBe(
      "Räknat för veckorna 15 augusti 2026 – 27 december 2026: det är då de här posterna går samtidigt.",
    );
    expect(note("sv", { ...counted, periodStretches: 2, parity: "ODD_WEEKS" })).toBe(
      "Räknat för veckorna 15 augusti 2026 – 27 december 2026 och övriga veckor med samma poster (udda veckor): " +
        "det är då de här posterna går samtidigt.",
    );
  });

  it("shows no line, and does not throw, for a day the calendar does not have", () => {
    expect(note("sv", { ...counted, periodFrom: "2026-13-45" })).toBe("");
    expect(note("en", { ...counted, periodTo: "2026-02-30" })).toBe("");
  });
});
