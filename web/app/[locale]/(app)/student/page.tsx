"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  useCalendarLessons,
  useCalendarLunches,
  useGroups,
  useRooms,
  useSubjects,
} from "@/lib/queries";
import { calendarLessonToGrid, calendarLunchToBand } from "@/lib/lesson-mapper";
import { addDays, startOfIsoWeek, toDateString } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { WeekSchedule } from "@/components/schedule/week-schedule";

export default function StudentSchedulePage() {
  const t = useTranslations("schedule");
  const tLunch = useTranslations("lunch");
  const [weekStart, setWeekStart] = useState(() => startOfIsoWeek(new Date()));

  const fromDate = toDateString(weekStart);
  const toDate = toDateString(addDays(weekStart, 6));

  // RLS scopes this to the student's own group automatically.
  const { data: lessons, isLoading } = useCalendarLessons(fromDate, toDate);
  // The meal, in the pupil's own week. RLS scopes it the same way the lessons
  // are scoped, so no group filter is needed or wanted here.
  const { data: lunches } = useCalendarLunches(fromDate, toDate);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();

  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject])),
    [subjects],
  );
  const groupById = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group])),
    [groups],
  );
  const roomById = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, room])),
    [rooms],
  );

  const gridLessons = useMemo(
    () =>
      (lessons ?? []).map((lesson) =>
        calendarLessonToGrid(lesson, subjectById, groupById, roomById),
      ),
    [lessons, subjectById, groupById, roomById],
  );

  const lunchBands = useMemo(
    () => (lunches ?? []).map((lunch) => calendarLunchToBand(lunch, tLunch("bandLabel"))),
    [lunches, tLunch],
  );

  return (
    <div>
      <PageHeader title={t("title")} />
      <WeekSchedule
        weekStart={weekStart}
        onWeekChange={setWeekStart}
        lessons={gridLessons}
        isLoading={isLoading}
        bands={lunchBands}
      />
    </div>
  );
}
