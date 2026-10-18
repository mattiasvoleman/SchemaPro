import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TeacherWorkRule } from "@/lib/types";
import { TeacherWorkTimeSummary, hasAnyRule, splitHours } from "./teacher-work-time-summary";

/**
 * What this file guards: a stored rule read back on every staff row, and the
 * difference between NOTHING SAID and a rule that says only one thing.
 *
 * The summary is drawn on /admin/people for every member of staff, by every
 * administrator, so two mistakes would be seen by everybody: "no
 * working-time rule" over a row that holds a cap or a wish — the school would
 * believe the generator free where it is not — and a line for a field that is
 * null, which would promise a teacher a rule nobody wrote.
 */

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

/** A stored row as PostgREST returns it — note the seconds on the clocks. */
const rule = (overrides: Partial<TeacherWorkRule> = {}): TeacherWorkRule => ({
  id: "w-1",
  userId: "t-1",
  lunchMinutes: 30,
  lunchStartTime: "10:30:00",
  lunchEndTime: "13:30:00",
  minDailyRestMinutes: 660,
  maxTeachingMinutesPerDay: null,
  preferredFreeDayOfWeek: null,
  ...overrides,
});

const NO_LUNCH_OR_REST = {
  lunchMinutes: null,
  lunchStartTime: null,
  lunchEndTime: null,
  minDailyRestMinutes: null,
};

describe("the summary beside the form", () => {
  it("spells out that a teacher has no rule", () => {
    render(<TeacherWorkTimeSummary rule={undefined} />);

    expect(screen.getByText("noRule")).toBeInTheDocument();
  });

  it("spells it out for a row of nulls too", () => {
    render(<TeacherWorkTimeSummary rule={rule(NO_LUNCH_OR_REST)} />);

    expect(screen.getByText("noRule")).toBeInTheDocument();
  });

  it("reads a full rule back without the seconds", () => {
    render(<TeacherWorkTimeSummary rule={rule()} />);

    expect(screen.getByText("summaryLunch(30|10:30|13:30)")).toBeInTheDocument();
    expect(screen.getByText("summaryRestHours(11)")).toBeInTheDocument();
    // Nothing said about a cap or a day the row does not hold.
    expect(screen.queryByText(/summaryDayCap/)).toBeNull();
    expect(screen.queryByText(/summaryFreeDay/)).toBeNull();
  });

  it("reads a rest with a remainder as hours and minutes", () => {
    render(<TeacherWorkTimeSummary rule={rule({ minDailyRestMinutes: 570 })} />);

    expect(screen.getByText("summaryRestHoursMinutes(9|30)")).toBeInTheDocument();
  });

  it("names only the half a rest-only rule sets", () => {
    render(
      <TeacherWorkTimeSummary
        rule={rule({ lunchMinutes: null, lunchStartTime: null, lunchEndTime: null })}
      />,
    );

    expect(screen.queryByText(/summaryLunch/)).toBeNull();
    expect(screen.getByText("summaryRestHours(11)")).toBeInTheDocument();
  });

  it("reads a cap back in minutes, and the free day by its number for the sentence to name", () => {
    render(
      <TeacherWorkTimeSummary rule={rule({ maxTeachingMinutesPerDay: 270, preferredFreeDayOfWeek: 5 })} />,
    );

    expect(screen.getByText("summaryDayCap(270)")).toBeInTheDocument();
    expect(screen.getByText("summaryFreeDay(5)")).toBeInTheDocument();
  });

  it("does not say 'no rule' over a row that holds only a cap", () => {
    render(<TeacherWorkTimeSummary rule={rule({ ...NO_LUNCH_OR_REST, maxTeachingMinutesPerDay: 300 })} />);

    expect(screen.queryByText("noRule")).toBeNull();
    expect(screen.getByText("summaryDayCap(300)")).toBeInTheDocument();
    expect(screen.queryByText(/summaryLunch|summaryRest/)).toBeNull();
  });

  it("does not say 'no rule' over a row that holds only a wish", () => {
    render(<TeacherWorkTimeSummary rule={rule({ ...NO_LUNCH_OR_REST, preferredFreeDayOfWeek: 3 })} />);

    expect(screen.queryByText("noRule")).toBeNull();
    expect(screen.getByText("summaryFreeDay(3)")).toBeInTheDocument();
  });
});

describe("whether a stored row says anything", () => {
  it("is no for no row, and for a row of nulls", () => {
    expect(hasAnyRule(undefined)).toBe(false);
    expect(hasAnyRule(rule(NO_LUNCH_OR_REST))).toBe(false);
  });

  it("is yes for any one field alone, the soft wish included", () => {
    expect(hasAnyRule(rule({ ...NO_LUNCH_OR_REST, lunchMinutes: 30 }))).toBe(true);
    expect(hasAnyRule(rule({ ...NO_LUNCH_OR_REST, lunchStartTime: "10:30:00" }))).toBe(true);
    expect(hasAnyRule(rule({ ...NO_LUNCH_OR_REST, lunchEndTime: "13:30:00" }))).toBe(true);
    expect(hasAnyRule(rule({ ...NO_LUNCH_OR_REST, minDailyRestMinutes: 660 }))).toBe(true);
    expect(hasAnyRule(rule({ ...NO_LUNCH_OR_REST, maxTeachingMinutesPerDay: 300 }))).toBe(true);
    expect(hasAnyRule(rule({ ...NO_LUNCH_OR_REST, preferredFreeDayOfWeek: 5 }))).toBe(true);
  });

  it("reads a row without the two newer keys by the four it has", () => {
    const { maxTeachingMinutesPerDay: _cap, preferredFreeDayOfWeek: _day, ...older } = rule(NO_LUNCH_OR_REST);
    expect(hasAnyRule(older as TeacherWorkRule)).toBe(false);
  });
});

describe("minutes read back as hours", () => {
  it("splits a whole number of hours", () => {
    expect(splitHours(660)).toEqual({ hours: 11, minutes: 0 });
  });

  it("splits a remainder", () => {
    expect(splitHours(570)).toEqual({ hours: 9, minutes: 30 });
  });

  it("handles less than an hour", () => {
    expect(splitHours(45)).toEqual({ hours: 0, minutes: 45 });
  });
});
