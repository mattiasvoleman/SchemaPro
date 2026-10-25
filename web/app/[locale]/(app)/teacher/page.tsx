"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useProfile } from "@/components/profile-context";
import { useRouter } from "@/i18n/navigation";
import {
  useCalendarRasts,
  useGroups,
  useRooms,
  useSubjects,
  useTeacherLessons,
} from "@/lib/queries";
import { calendarLessonToGrid, calendarRastToBand } from "@/lib/lesson-mapper";
import { teacherRastBands } from "@/lib/teacher-rast-bands";
import { sheetFromGrid } from "@/lib/print-sheet";
import { isPassEntry, useSupervisionWeek, weekPassesToGrid } from "@/lib/supervision-week";
import { addDays, startOfIsoWeek, toDateString } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/layout/page-header";
import { WeekSchedule } from "@/components/schedule/week-schedule";

export default function TeacherSchedulePage() {
  const t = useTranslations("schedule");
  const { profile, school } = useProfile();
  const router = useRouter();
  const [weekStart, setWeekStart] = useState(() => startOfIsoWeek(new Date()));

  const fromDate = toDateString(weekStart);
  const toDate = toDateString(addDays(weekStart, 6));

  const { data: lessons, isLoading, isError } = useTeacherLessons(profile.id, fromDate, toDate);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: rasts } = useCalendarRasts(fromDate, toDate);
  // The week's rastvaktspass (Rastvakt i vardagen), through the gateway: a
  // read that fails is said beside the week and costs it none of its lessons.
  const passesQuery = useSupervisionWeek(fromDate, toDate);

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

  // Their passes as blocks beside the lessons, and on the printed week.
  const passTitle = t("passTitle");
  const passCover = t("passCover");
  const passHandedOver = t("passHandedOver");
  const passNoCover = t("passNoCover");
  const weekEntries = useMemo(
    () => [
      ...gridLessons,
      ...weekPassesToGrid(passesQuery.data?.passes ?? [], {
        title: passTitle,
        cover: passCover,
        handedOver: passHandedOver,
        noCover: passNoCover,
      }),
    ],
    [gridLessons, passesQuery.data, passTitle, passCover, passHandedOver, passNoCover],
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
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitleTeacher")} />
      {passesQuery.isError ? <Notice tone="warning">{t("passesLoadFailed")}</Notice> : null}
      {/* A failed read is said as one, under the week's own arrows, never
          drawn as "Inga lektioner denna vecka": a teacher would take an
          empty week at its word. The arrows stay, so a week that failed
          can be left for one that loads. */}
      <WeekSchedule
        weekStart={weekStart}
        onWeekChange={setWeekStart}
        lessons={weekEntries}
        isLoading={isLoading}
        isError={isError}
        bands={rastBands}
        // A lesson opens its page: ämne och läxa, the note to the substitute
        // (Lektionslogg), and from there its register.
        // A pass has no page of its own: its block says all there is.
        onLessonClick={(lesson) => {
          if (!isPassEntry(lesson)) router.push(`/teacher/lektion/${lesson.id}`);
        }}
        // Not while the passes load or could not be read: a printed week
        // without its rastvakt would say less than the page and not say so.
        printSheet={
          passesQuery.isLoading || passesQuery.isError
            ? undefined
            : () =>
                sheetFromGrid({
                  kind: "TEACHER",
                  title: `${profile.firstName} ${profile.lastName}`,
                  school: school?.name ?? "",
                  weekStart,
                  lessons: weekEntries,
                })
        }
      />
    </Page>
  );
}
