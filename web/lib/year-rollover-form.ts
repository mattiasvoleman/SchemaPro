// The läsår pages' own arithmetic: what the wizard starts from, what it sends,
// and what /admin/years calls each year. Pure, so it is tested here rather
// than through the pages — the rules the SERVER applies live in the mirror
// (lib/year-rollover.ts) and the gateway's planner, never here.

import { addDays } from "@/lib/year-rollover";
import type { AcademicYear, RolloverOptions } from "@/lib/types";

/**
 * Next year's name, guessed from this one: every digit run counts up by one
 * and keeps its width, so "2026/2027" → "2027/2028", "2026/27" → "2027/28"
 * and "Läsår 26-27" → "Läsår 27-28". A two-digit run wraps (99 → 00). A name
 * with no digits gives "" — the admin types one, rather than being offered
 * the same name back and refused for it.
 */
export function nextYearName(name: string): string {
  if (!/\d/.test(name)) return "";
  return name.replace(/\d+/g, (run) => {
    const next = String(Number(run) + 1);
    return next.length > run.length ? next.slice(-run.length) : next.padStart(run.length, "0");
  });
}

/**
 * The wizard's first answer for the new year: the name counted up and the
 * dates 52 weeks on. 364 days, not a calendar year, so the year starts on the
 * same weekday it did — a Monday start stays a Monday — which is also the
 * whole-week shift the planner moves periods by.
 */
export function defaultTarget(source: Pick<AcademicYear, "name" | "startDate" | "endDate">): {
  name: string;
  startDate: string;
  endDate: string;
} {
  return {
    name: nextYearName(source.name),
    startDate: addDays(source.startDate, 364),
    endDate: addDays(source.endDate, 364),
  };
}

export type YearStatus = "ACTIVE" | "UPCOMING" | "FINISHED";

/**
 * Aktivt, kommande or avslutat. With an active year, the others are placed
 * against it — a year that starts after the active one has not happened yet,
 * whatever today is, because activation is what makes a year current. With
 * none active, against today.
 */
export function yearStatus(
  year: Pick<AcademicYear, "isActive" | "startDate" | "endDate">,
  active: Pick<AcademicYear, "startDate"> | null,
  today: string,
): YearStatus {
  if (year.isActive) return "ACTIVE";
  if (active) return year.startDate > active.startDate ? "UPCOMING" : "FINISHED";
  return year.endDate < today ? "FINISHED" : "UPCOMING";
}

/** The year rolled from `yearId`, if any — at most one, the database says. */
export function successorOf<T extends Pick<AcademicYear, "predecessorId">>(
  years: readonly T[],
  yearId: string,
): T | null {
  return years.find((year) => year.predecessorId === yearId) ?? null;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that exists — 2027-02-30 does not, and the DTO would 400 it. */
export function isCalendarDay(value: string): boolean {
  if (!CALENDAR_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export type GroupChoiceState = {
  outcome?: "PROMOTE" | "CARRY" | "SKIP" | "INTAKE";
  /** Typed by the admin; blank means "the name the rule gives". */
  name?: string;
};

export type BreakChoiceState = { startDate?: string; endDate?: string };

export interface RolloverFormState {
  name: string;
  startDate: string;
  endDate: string;
  /** Null: the server's default (newest decided timplan, else the classes). */
  graduatingGradeLevel: number | null;
  groups: Record<string, GroupChoiceState>;
  carryTeachingGroups: boolean;
  carryTeachingGroupMembers: boolean;
  keepTeachers: boolean;
  carryClassRules: boolean;
  /** The SELECTED lov, by source break id; absent means not carried. */
  breaks: Record<string, BreakChoiceState>;
}

/**
 * The preview's request body, or null while the form cannot be previewed at
 * all — a blank name or a date that is not a day would only come back as a
 * 400 the admin is already looking at the field for.
 *
 * Only what differs from the defaults is sent: a group with no choice is
 * left out (the planner applies the rule), a blank typed name is no name, and
 * a lov date left as proposed is left out (the planner applies the proposal).
 * That keeps the request — and so the preview's cache key — stable while the
 * admin clicks around without changing anything.
 */
export function rolloverOptions(form: RolloverFormState): RolloverOptions | null {
  const name = form.name.trim();
  if (name === "" || !isCalendarDay(form.startDate) || !isCalendarDay(form.endDate)) return null;
  const groups = Object.entries(form.groups)
    .map(([sourceGroupId, choice]) => {
      const typed = choice.name?.trim();
      return {
        sourceGroupId,
        ...(choice.outcome ? { outcome: choice.outcome } : {}),
        ...(typed ? { name: typed } : {}),
      };
    })
    .filter((choice) => "outcome" in choice || "name" in choice)
    .sort((a, b) => (a.sourceGroupId < b.sourceGroupId ? -1 : 1));
  const breaks = Object.entries(form.breaks)
    .map(([sourceBreakId, choice]) => ({
      sourceBreakId,
      ...(choice.startDate && isCalendarDay(choice.startDate) ? { startDate: choice.startDate } : {}),
      ...(choice.endDate && isCalendarDay(choice.endDate) ? { endDate: choice.endDate } : {}),
    }))
    .sort((a, b) => (a.sourceBreakId < b.sourceBreakId ? -1 : 1));
  return {
    name,
    startDate: form.startDate,
    endDate: form.endDate,
    ...(form.graduatingGradeLevel !== null ? { graduatingGradeLevel: form.graduatingGradeLevel } : {}),
    ...(groups.length > 0 ? { groups } : {}),
    carryTeachingGroups: form.carryTeachingGroups,
    carryTeachingGroupMembers: form.carryTeachingGroupMembers,
    keepTeachers: form.keepTeachers,
    carryClassRules: form.carryClassRules,
    ...(breaks.length > 0 ? { breaks } : {}),
  };
}

/**
 * A problem's or a refusal's params as ICU values: lists (the colliding
 * names, the overlapping years) become one comma-separated string, because a
 * message is written around a value, not around an array.
 */
export function messageValues(
  params: Record<string, string | number | string[]> | undefined,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    values[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return values;
}
