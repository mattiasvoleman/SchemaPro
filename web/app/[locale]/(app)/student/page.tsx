"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  useCalendarLessons,
  useCalendarLunches,
  useCalendarRasts,
  useGroups,
  useRooms,
  useSubjects,
} from "@/lib/queries";
import {
  calendarLessonToGrid,
  calendarLunchToBand,
  calendarRastToBand,
} from "@/lib/lesson-mapper";
import { addDays, startOfIsoWeek, toDateString } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { useProfile } from "@/components/profile-context";
import { WeekSchedule } from "@/components/schedule/week-schedule";

/*
 * "Undervisningstid" (timplan P4): the pupil's hours over their current
 * stadium, as the school published them. Fetched after the page with lazy()
 * — this route is in the core tier, and the card is not what the page is
 * for — and a chunk that does not arrive renders nothing: an optional card
 * must never take the week away.
 */
const TeachingTimeCard = lazy(() =>
  import("@/components/teaching-time-card").then(
    (module) => ({ default: module.TeachingTimeCard }),
    () => ({ default: () => null }),
  ),
);

export default function StudentSchedulePage() {
  const t = useTranslations("schedule");
  const tLunch = useTranslations("lunch");
  const { profile } = useProfile();
  const [weekStart, setWeekStart] = useState(() => startOfIsoWeek(new Date()));

  const fromDate = toDateString(weekStart);
  const toDate = toDateString(addDays(weekStart, 6));

  // RLS scopes this to the student's own group automatically.
  const { data: lessons, isLoading } = useCalendarLessons(fromDate, toDate);
  const { data: lunches } = useCalendarLunches(fromDate, toDate);
  const { data: rasts } = useCalendarRasts(fromDate, toDate);
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

  /**
   * The meal of the class whose week this is.
   *
   * Filtered here as well as in the policy, and not as belt and braces: a
   * guardian reading this page has more than one child's class in reach, and a
   * teacher or an administrator has the whole school's. The policy decides what
   * may be read; this decides whose week is on screen. Two comments used to
   * stand here claiming RLS made a filter unnecessary — they were written
   * against a policy that matched the entire school.
   */
  const lunchBands = useMemo(
    () => [
      ...(lunches ?? [])
        .filter((lunch) => lunch.studentGroupId === profile.studentGroupId)
        .map((lunch) => calendarLunchToBand(lunch, tLunch("bandLabel"))),
      // The rasts read the same way, filtered by the same rule and for the same
      // reason: a guardian opening this page has more than one child's class in
      // reach.
      ...(rasts ?? [])
        .filter((rast) => rast.studentGroupId === profile.studentGroupId)
        .map(calendarRastToBand),
    ],
    [lunches, rasts, profile.studentGroupId, tLunch],
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
      {/* A pupil's own card only: any role may open this page, and the
          gateway answers a STUDENT with their own statement whatever is
          asked. A teacher is refused the route, so nobody else asks. */}
      {profile.role === "STUDENT" ? (
        <Suspense fallback={null}>
          <TeachingTimeCard studentId={profile.id} />
        </Suspense>
      ) : null}
    </div>
  );
}
