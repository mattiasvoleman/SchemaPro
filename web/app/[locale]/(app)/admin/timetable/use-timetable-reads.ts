import { useMemo } from "react";
import {
  useAcademicYears,
  useMasterLessons,
  useSubjects,
  useGroups,
  useRooms,
  usePeople,
  useConstraints,
  useRequirements,
  useLunchSettings,
  useSchoolBreaks,
  useGroupMemberships,
  useFrameTimes,
  useLunchSittings,
  useLunchSittingMutations,
  useRoomPreferences,
  useRasts,
} from "@/lib/queries";
import { usePlanningYear } from "@/lib/planning-year";
import { withProjectedHomes } from "@/lib/projected-rosters";

/**
 * Everything the timetable page READS: the year on screen and the lists of its grundschema. One hook
 * so that the page, the clash engine and the view each take what they need from one object.
 */
export function useTimetableReads() {
  /*
   * The grundschema on screen: this year's, or next year's before its
   * activation (lib/planning-year.ts). Every year-keyed read and write below
   * follows it — the lessons, the timplan, the meals, the versions, the room
   * proposal, publishing.
   */
  const planning = usePlanningYear();
  const shownYear = planning.year;
  /*
   * The years themselves, for the state ladder only (usePlanningYear reads
   * the same cached query). Without them a school whose years were still on
   * their way, or had failed, or had no active year was told "no
   * grundschema yet — generate one": a page that could not know saying so.
   * Pending includes the one render usePlanningYear holds the year back
   * for, so the empty state does not flash before the grid.
   */
  const yearsQuery = useAcademicYears();
  const yearPending = yearsQuery.isLoading || (planning.active !== null && shownYear === null);
  const {
    data: lessons,
    isLoading,
    isError: lessonsFailed,
    dataUpdatedAt: lessonsReadAt,
  } = useMasterLessons(shownYear?.id ?? null);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  /*
   * Next year's classes have no home pupils before its activation, so the
   * people are read with the class the activation will give each pupil it
   * moves — the overlay the gateway checks a drag against, laid over the rows
   * as it comes (lib/projected-rosters.ts). Everything derived from a pupil's
   * class below — studentGroupOf, the clash map, the grade spans, the roster
   * index — then sees next year's 8A as the server does. For this year the
   * same array comes back.
   */
  const { data: storedPeople } = usePeople();
  const people = useMemo(
    () => withProjectedHomes(storedPeople, planning.rosters),
    [storedPeople, planning.rosters],
  );
  const { data: constraints } = useConstraints();
  const { data: requirements } = useRequirements(shownYear?.id ?? null);

  const { data: lunchSettings } = useLunchSettings();
  /*
   * The weeks of the läsår no lesson is written in (jullov, sportlov): two lessons that can meet only in
   * such weeks are no clash, as the gateway's hand edit and the publish gate read them (lib/closed-weeks.ts).
   * Undefined until the breaks are read and for a year none of whose weeks a lov closes.
   */
  const { data: schoolBreaks } = useSchoolBreaks(shownYear?.id ?? null);
  const { data: memberships } = useGroupMemberships();
  const { data: frameTimes } = useFrameTimes();
  const { data: lunchSittings } = useLunchSittings(shownYear?.id ?? null);
  const lunchMutations = useLunchSittingMutations();
  const { data: roomRules } = useRoomPreferences();
  const { data: rasts } = useRasts();

  return { planning, shownYear, yearsQuery, yearPending, lessons, isLoading, lessonsFailed, lessonsReadAt, subjects, groups, rooms, people, constraints, requirements, lunchSettings, schoolBreaks, memberships, frameTimes, lunchSittings, lunchMutations, roomRules, rasts };
}

export type TimetableReads = ReturnType<typeof useTimetableReads>;
