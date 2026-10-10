"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useProfile } from "@/components/profile-context";
import {
  useCalendarRasts,
  useGroups,
  useRooms,
  useSubjects,
  useTeacherLessons,
} from "@/lib/queries";
import { calendarLessonToGrid, calendarRastToBand } from "@/lib/lesson-mapper";
import { teacherRastBands } from "@/lib/rasts";
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
  const { data: rasts } = useCalendarRasts(fromDate, toDate);

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

  // A lesson the teacher covers says so under its group: "7A · Vikarie".
  // Marked here, not in the shared mapper every schedule draws through.
  const substituteMarker = t("substituteMarker");
  const gridLessons = useMemo(
    () =>
      (lessons ?? []).map((lesson) => {
        const grid = calendarLessonToGrid(lesson, subjectById, groupById, roomById);
        return lesson.assignmentRole === "SUBSTITUTE"
          ? { ...grid, subtitle: grid.subtitle ? `${grid.subtitle} · ${substituteMarker}` : substituteMarker }
          : grid;
      }),
    [lessons, subjectById, groupById, roomById, substituteMarker],
  );

  /**
   * The rasts of the classes this teacher actually takes this week.
   *
   * Narrowed here rather than in the query because only this page knows the
   * week's lessons — staff RLS hands over the whole school's rows, and drawing
   * twenty classes' breaks would be twenty stripes on every column.
   *
   * EVERY window is drawn, not only the ones every stage agrees on. The teacher
   * who takes åk 3 in the morning and åk 8 in the afternoon is exactly the
   * person who needs to see two different breaks, and an intersection would
   * give them none.
   */
  const rastBands = useMemo(() => {
    const taught = new Set((lessons ?? []).map((lesson) => lesson.studentGroupId));
    const mine = (rasts ?? []).filter((rast) => taught.has(rast.studentGroupId));
    const groupNameOf = new Map(
      (groups ?? []).map((group) => [group.id, group.name] as const),
    );
    return teacherRastBands(mine, groupNameOf, calendarRastToBand);
  }, [rasts, lessons, groups]);

  return (
    <div>
      <PageHeader title={t("title")} />
      <WeekSchedule
        weekStart={weekStart}
        onWeekChange={setWeekStart}
        lessons={gridLessons}
        isLoading={isLoading}
        bands={rastBands}
      />
    </div>
  );
}
