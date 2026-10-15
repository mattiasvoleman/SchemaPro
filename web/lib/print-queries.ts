"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ValidityPeriod } from "@/lib/print-sheet";
import type { PublicDay, PublicKind } from "@/lib/public-timetable";
import type { TeacherDisplay } from "@/lib/publication-types";

/*
 * Utskrift (src/publication/print.controller.ts, 20261102090000): the
 * admin's print set and the validity of any week. Beside the pages that use
 * them, for the bundle: /admin/publishing/print reads the set, and a
 * person's own printout asks the validity the moment it prints
 * (components/timetable-sheet/print-week-button.tsx).
 */

/** One sheet of the set: a class's, a teacher's or a room's week, by Schemavisaren's whitelist. */
export interface PrintSetSheet {
  id: string;
  title: string;
  days: PublicDay[];
}

/** GET /print/timetables. */
export interface PrintSet {
  kind: PublicKind;
  school: string;
  academicYearId: string;
  week: { from: string; to: string; isoWeek: string };
  validity: ValidityPeriod[];
  teachers: TeacherDisplay;
  meals: boolean;
  sheets: PrintSetSheet[];
}

export interface PrintSetQuery {
  kind: PublicKind;
  /** Any day of the week. */
  date: string;
  /** Null: the school's Schemavisaren choice; for a teachers' set the signature when it names nobody. */
  teachers: TeacherDisplay | null;
  /** Null: the school's setting. */
  meals: boolean | null;
}

/**
 * The display a set uses when the admin has not chosen: the school's own for
 * Schemavisaren, so a set names no more than the school's public pages do —
 * save a teachers' set, titled by its teacher, which takes the signature
 * when the school names nobody. The gateway's defaultTeacherDisplay, said
 * here so the page's select shows what is sent.
 */
export function defaultDisplay(school: TeacherDisplay | undefined, kind: PublicKind): TeacherDisplay {
  const own = school ?? "NONE";
  return kind === "TEACHER" && own === "NONE" ? "SIGNATURE" : own;
}

export const PRINT_KEYS = { set: ["printSet"] as const, validity: ["timetableValidity"] as const };

export function printSetPath(query: PrintSetQuery): string {
  const search = new URLSearchParams({ kind: query.kind, date: query.date });
  if (query.teachers) search.set("teachers", query.teachers);
  if (query.meals !== null) search.set("meals", String(query.meals));
  return `/api/v1/print/timetables?${search.toString()}`;
}

/** `enabled` false while the school's settings, which the defaults come from, are not read. */
export function usePrintSet(query: PrintSetQuery, enabled = true) {
  return useQuery({
    queryKey: [...PRINT_KEYS.set, query.kind, query.date, query.teachers, query.meals],
    enabled,
    retry: false,
    placeholderData: (previous) => previous,
    queryFn: () => api.get<PrintSet>(printSetPath(query)),
  });
}

/**
 * The periods the week of `day` is valid for, asked when a person prints
 * their own week. Never throws: a printout without a validity line is still
 * the week, so a failure answers undefined and the sheet says nothing.
 */
export async function weekValidity(day: string): Promise<ValidityPeriod[] | undefined> {
  try {
    const answer = await api.get<{ week: { from: string; to: string }; validity: ValidityPeriod[] }>(
      `/api/v1/timetable-validity?week=${encodeURIComponent(day)}`,
    );
    return answer.validity;
  } catch {
    return undefined;
  }
}
