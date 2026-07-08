"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useProfile } from "@/components/profile-context";
import {
  useGroups,
  useRooms,
  useSubjects,
  useTeacherLessons,
} from "@/lib/queries";
import { calendarLessonToGrid } from "@/lib/lesson-mapper";
import { addDays, startOfIsoWeek, toDateString } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { WeekSchedule } from "@/components/schedule/week-schedule";

export default function TeacherSchedulePage() {
  const t = useTranslations("schedule");
  const { profile } = useProfile();
  const [weekStart, setWeekStart] = useState(() => startOfIsoWeek(new Date()));

  const fromDate = toDateString(weekStart);
  const toDate = toDateString(addDays(weekStart, 6));

  const { data: lessons, isLoading } = useTeacherLessons(profile.id, fromDate, toDate);
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

  return (
    <div>
      <PageHeader title={t("title")} />
      <WeekSchedule
        weekStart={weekStart}
        onWeekChange={setWeekStart}
        lessons={gridLessons}
        isLoading={isLoading}
      />
    </div>
  );
}
