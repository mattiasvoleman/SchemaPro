"use client";

import { useLocale, useTranslations } from "next-intl";
import type { BreakView, Drawn, Row } from "@/lib/school-day";

/**
 * The words of Skolans dag that the grids and the finder both say: a time, a
 * day, a break, and the sentence that names one drawn lesson or block.
 *
 * A time is minutes since the school's local midnight (the gateway sends no
 * instant), so it is said as it is and the clock change never reaches here.
 */
export function useSchoolDayText() {
  const t = useTranslations("schoolDay");
  const locale = useLocale() === "en" ? "en-GB" : "sv-SE";

  /** 495 → "08:15"; the end of the day, 1440, is "24:00". */
  const clock = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

  const span = (from: number, to: number): string => `${clock(from)}–${clock(to)}`;

  /** "tis 3 nov." */
  const day = (iso: string): string =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });

  /** "tisdag 3 november 2026" */
  const dayLong = (iso: string): string =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  /** The årskurs span a narrowed lov covers: "åk 9", "åk 7–9". */
  const grades = (entry: Pick<BreakView, "minGradeLevel" | "maxGradeLevel">): string | null => {
    const { minGradeLevel: min, maxGradeLevel: max } = entry;
    if (min === null && max === null) return null;
    if (min !== null && max !== null) return min === max ? t("grades.one", { grade: min }) : t("grades.range", { min, max });
    return min !== null ? t("grades.from", { grade: min }) : t("grades.to", { grade: max! });
  };

  /** "Höstlov", "Studiedag: Planering", "Lov för åk 9: Prao". */
  const breakText = (entry: BreakView): string => {
    const span = grades(entry);
    const key = entry.kind === "HOLIDAY" ? "break.holiday" : "break.staffDay";
    return span ? t(`${key}For`, { name: entry.name, grades: span }) : t(key, { name: entry.name });
  };

  /** The protected persons' placeholder, wherever a name would stand in a printout. */
  const protectedName = () => t("protectedName");

  /** What the lesson or block IS, in words, for its accessible name and its tooltip. */
  const itemWords = (item: Drawn): { title: string; facts: string[] } => {
    if (item.type !== "LESSON") {
      return { title: t(`block.${item.type}`), facts: item.label ? [item.label] : [] };
    }
    const facts: string[] = [];
    if (item.groups.length > 0) facts.push(item.groups.join(", "));
    if (item.room) facts.push(item.room);
    const names = item.teachers.map((one) => one.name ?? protectedName());
    if (names.length > 0) facts.push(names.join(", "));
    if (item.hiddenTeachers > 0) facts.push(t("hiddenTeachers", { count: item.hiddenTeachers }));
    const state: string[] = [];
    if (item.status === "CANCELLED") state.push(item.cancelCause ? t("cancelledBy", { cause: t(`cause.${item.cancelCause}`) }) : t("cancelled"));
    if (item.status === "RESCHEDULED") state.push(t("rescheduled"));
    if (item.activity) state.push(t("activity"));
    return { title: item.subject ?? t("noSubject"), facts: [...facts, ...state] };
  };

  /** "08:15–09:00 Matematik, 7A, Sal 12, A Svensson, inställd": the sentence a screen reader gets for a block of the grid. */
  const itemName = (item: Drawn): string => {
    const { title, facts } = itemWords(item);
    return [span(item.startMinutes, item.endMinutes), [title, ...facts].join(", ")].join(" ");
  };

  /** The row's name; a person left out of a printout is the placeholder. */
  const rowName = (row: Pick<Row, "name">): string => row.name ?? protectedName();

  return { t, clock, span, day, dayLong, grades, breakText, protectedName, itemWords, itemName, rowName };
}
