"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { WeekSheet, type Translate } from "@/components/timetable-sheet/week-sheet";
import { candidateSheet, type WeekNames, type WeekTargetKind, type YearBounds } from "@/lib/candidates/week";
import type { RosterIndex } from "@/lib/lesson-audience";
import type { MasterLesson } from "@/lib/types";

export interface CandidateWeekProps {
  lessons: readonly MasterLesson[];
  kind: WeekTargetKind;
  targetId: string;
  title: string;
  /** The sheet's first line: on this page, the candidate's name. */
  school: string;
  monday: string;
  /** The läsår: no lesson is drawn on a day before its start or after its end. */
  year: YearBounds;
  names: WeekNames;
  /** Who is in which group, for a class's or a group's week (lib/lesson-audience.ts). */
  roster: RosterIndex;
}

/*
 * One week of a candidate, drawn by the same component that draws a printed
 * week and Schemavisaren (components/timetable-sheet/week-sheet.tsx): a list
 * on a phone, the grid on a wider screen. React.lazy, so the sheet and its
 * lane arithmetic load only once somebody looks at a week.
 */
export default function CandidateWeek({ lessons, kind, targetId, title, school, monday, year, names, roster }: CandidateWeekProps) {
  const tViewer = useTranslations("publicViewer");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const { startDate, endDate } = year;
  const document = useMemo(
    () => candidateSheet({ lessons, kind, targetId, title, school, monday, year: { startDate, endDate }, names, roster }),
    [lessons, kind, targetId, title, school, monday, startDate, endDate, names, roster],
  );
  return (
    <WeekSheet
      document={document}
      locale={locale}
      t={tViewer as unknown as Translate}
      tDays={tDays as unknown as Translate}
      variant="page"
      headingLevel={2}
      idPrefix="candidate-week"
    />
  );
}
