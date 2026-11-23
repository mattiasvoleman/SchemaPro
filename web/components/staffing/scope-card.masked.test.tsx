import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

/*
 * What a reader without HR-läs gets of a level the rektor set: the gateway keeps the row and masks every field but the exception's kind
 * (hr-visibility.ts, hideScopeHr), so a level and no exception reaches the card as an assessment of nothing but nulls. The manual says
 * such a reader sees that a level is set and not which; this is where the card says it. Rendered with the real catalogues.
 */
const base: TeacherScope = {
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 645,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: null,
  ordinanceHighestHours: null,
  planningFloorHours: 645,
  remainingHours: null,
  planningFits: null,
};
const version = { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" };
const card = (teacher: Partial<TeacherScope>): ScopeCardData => ({ teacher: { ...base, ...teacher }, version, yearReason: null, interpretations: [] });
const masked = { levelHours: null, exceptionKind: null, ownInitiativeOn: null, note: null, decidedAt: null };

const rows = (locale: "sv" | "en", data: ScopeCardData) => {
  const messages = locale === "sv" ? sv : en;
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ScopeCard data={data} />
    </NextIntlClientProvider>,
  );
  return screen.getAllByRole("term").map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);
};

describe("ScopeCard: a level set that the reader may not read", () => {
  it.each([
    ["sv", "Rektorns nivå för läraren, vid heltid=satt, visas inte"],
    ["en", "The principal's level for the teacher, at full time=set, not shown"],
  ] as const)("says in %s that a level is set, and shows no figure", (locale, row) => {
    const list = rows(locale, card({ assessment: masked }));
    expect(list).toContain(row);
    expect(row.split("=")[1]).not.toMatch(/\d/);
  });

  it("has no such row where the reader can read the level, where an exception is all there is, or where nothing is written", () => {
    expect(rows("sv", card({ assessment: { ...masked, levelHours: 600 } }))).toContain("Rektorns nivå för läraren, vid heltid=600 h");
    expect(rows("sv", card({ assessment: { ...masked, exceptionKind: "SMALL_GROUP" } })).some((row) => row.includes("visas inte"))).toBe(false);
    expect(rows("sv", card({})).some((row) => row.includes("visas inte"))).toBe(false);
  });
});
