import { splitExemptions } from "@/lib/exemptions";
import { useMemo, useState, useEffect, useCallback } from "react";
import { closedWeeksOf } from "@/lib/closed-weeks";
import { timeToMinutes } from "@/lib/utils";
import { buildRosterIndex } from "@/lib/lesson-audience";
import {
  buildGroupConflictMap,
  type LunchOf,
  type Meal,
  buildPupilBufferMap,
  type Placement,
  detectConflicts,
  toPlacement,
  validatePlacement,
  pupilBufferOf,
} from "@/lib/conflicts";
import { buildGradeSpans } from "@/lib/grade-span";
import { breaksRoomLock } from "@/lib/room-locks";
import { type LessonChange } from "@/components/schedule/timetable-grid";
import type { useTimetableRealtime } from "@/lib/use-timetable-realtime";
import type { MasterLesson } from "@/lib/types";
import type { TimetableReads } from "./use-timetable-reads";

/**
 * The live clash engine: the indexes the page builds from what it read, the clash map over every
 * lesson, and the predicate a drag is checked with. Validation always runs against ALL lessons, not
 * just the filtered view.
 */
export function useScheduleEngine(inputs: Pick<TimetableReads, "groups" | "shownYear" | "schoolBreaks" | "people" | "memberships" | "lunchSettings" | "rooms" | "subjects" | "lessons" | "lunchSittings" | "requirements" | "roomRules" | "constraints" | "frameTimes"> & {
  peers: ReturnType<typeof useTimetableRealtime>["peers"];
  editing: MasterLesson | null;
}) {
  const { groups, shownYear, schoolBreaks, people, memberships, lunchSettings, rooms, subjects, lessons, lunchSittings, requirements, roomRules, constraints, frameTimes, peers, editing } = inputs;


  /*
   * The groups, split by kind. A school has a couple of dozen classes and can
   * have hundreds of teaching groups — Kunskapsskolan has 24 and 300 — so one
   * flat list buries the class a rektor is looking for.
   */
  /** The groups of the year on screen: a lesson added here belongs to it. */
  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === shownYear?.id),
    [groups, shownYear?.id],
  );
  const closedWeeks = useMemo(
    () =>
      shownYear && schoolBreaks
        ? closedWeeksOf(
            { startDate: shownYear.startDate, endDate: shownYear.endDate },
            schoolBreaks,
            yearGroups.map((group) => group.gradeLevel),
          )
        : undefined,
    [shownYear, schoolBreaks, yearGroups],
  );

  // The grid's teacher rows, the lesson dialogs' teacher pick and the name on a
  // lesson: a teacher, or an administrator who teaches (Users.teaches). Written
  // out and not through lib/teaching-staff.ts: this page sits close to its bundle
  // budget. Not the substitute pick, which is the cover board's and stays TEACHER.
  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" || (person.role === "SCHOOL_ADMIN" && person.teaches === true)),
    [people],
  );
  const students = useMemo(
    () => (people ?? []).filter((person) => person.role === "STUDENT" && person.isActive),
    [people],
  );
  /** studentId → their class id (participant-aware conflict checks). */
  const studentGroupOf = useMemo(
    () => new Map(students.map((student) => [student.id, student.studentGroupId])),
    [students],
  );
  /**
   * The teaching groups' memberships of the pupils who are there. The gateway answers every row of the school's groups, a pupil who has left
   * included (and her rows stay in the groups she was in), while the judge reads active pupils only, as the generator does: two groups
   * that share only a pupil who has left share no pupil, and the grid must not paint them as clashing (the fall file's inactive pupils,
   * E3, granskaren g503 #503 L-1).
   */
  // Undefined stays undefined: the roster has not come, which the roster index says by it (lib/lesson-audience.ts).
  const activeMemberships = useMemo(
    () => memberships?.filter((row) => studentGroupOf.has(row.studentId)),
    [memberships, studentGroupOf],
  );
  /**
   * groupId -> the years it holds, so a GRADE_LEVEL rule can reach it.
   *
   * A teaching group has no year of its own, so it is derived from its members'
   * home classes — the same derivation the server does for the solver payload.
   * Without this the rule matches nothing and is ignored in silence; see
   * lib/grade-span.ts.
   */
  //
  // In NIOARIG (grade-numbering.ts): every rule these spans meet here — year
  // rules, frames, lunch, rasts, room locks — is school-wide and stated so,
  // and a tioårig läsår's 10A is the 9 a "7–9" frame binds, as the solver
  // payload sends it.
  const gradeSpanOf = useMemo(
    () =>
      buildGradeSpans({
        // The shown year's groups only, as the server reads them: a home class
        // of another year (the active one, while the projection loads) would
        // lend a teaching group a grade in another numbering.
        groups: (groups ?? []).filter((group) => group.academicYearId === shownYear?.id),
        membersByGroup: (activeMemberships ?? []).reduce((map, row) => {
          const list = map.get(row.studentGroupId);
          if (list) list.push(row.studentId);
          else map.set(row.studentGroupId, [row.studentId]);
          return map;
        }, new Map<string, string[]>()),
        homeClassOf: studentGroupOf,
        numbering: shownYear?.gradeNumbering,
      }),
    [groups, activeMemberships, studentGroupOf, shownYear?.id, shownYear?.gradeNumbering],
  );

  /** Groups sharing students — the manual-edit twin of the engine's pairs, halves included. */
  const pupilRelation = useMemo(
    () => buildGroupConflictMap(studentGroupOf, activeMemberships ?? [], groups),
    [studentGroupOf, activeMemberships, groups],
  );

  /** The groups that are somebody's home. A teaching group is not one. */
  const homeClassIds = useMemo(
    () => (groups ?? []).filter((g) => g.kind === "CLASS").map((g) => g.id),
    [groups],
  );

  /**
   * The same pupils, counted rather than merely paired.
   *
   * Deliberately not built on pupilRelation above: that is a BOOLEAN "these
   * two groups share at least one pupil", which cannot tell a two-pupil choir
   * from a fourteen-pupil maths half and never reads a lesson's individually
   * named studentIds at all. Both indexes are wanted — one answers "may these
   * collide", this one answers "how much of this class is in the room".
   */
  const rosterIndex = useMemo(
    () => buildRosterIndex(studentGroupOf, activeMemberships, groups),
    [studentGroupOf, activeMemberships, groups],
  );

  /*
   * Delade salar: two classes in a hall the school lets be shared are no ROOM
   * clash while their pupils fit its seats. The check is fetched on demand,
   * only once Skolregler hold the rule on, so a school that never does pays no
   * byte for it (lib/shared-rooms-board.ts); until it has arrived every room is
   * exclusive, the safe reading. The relation it lays on is the one above.
   */
  const sharedMode = lunchSettings?.placementSharedMode;
  const sharing = sharedMode === "SOFT" || sharedMode === "HARD";
  const [withSharing, setWithSharing] = useState<
    typeof import("@/lib/shared-rooms-board").withSharedRooms | null
  >(null);
  useEffect(() => {
    if (sharing) {
      import("@/lib/shared-rooms-board").then((board) => setWithSharing(() => board.withSharedRooms), () => {});
    }
  }, [sharing]);
  const groupConflictMap = useMemo(
    () => (withSharing ? withSharing(pupilRelation, rooms ?? [], sharedMode, rosterIndex) : pupilRelation),
    [withSharing, pupilRelation, rooms, sharedMode, rosterIndex],
  );

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
  // The look-up of the name a lesson already carries takes everybody in the list, not the pick's: a mark taken off
  // later leaves her on her lessons, and a lesson without its teacher's name reads as one nobody has.
  const teacherById = useMemo(
    () => new Map((people ?? []).map((person) => [person.id, person])),
    [people],
  );
  /** Everyone, pupils who have left included: a saved version still names them. */
  const personById = useMemo(
    () => new Map((people ?? []).map((person) => [person.id, person])),
    [people],
  );
  const lessonById = useMemo(
    () => new Map((lessons ?? []).map((lesson) => [lesson.id, lesson])),
    [lessons],
  );

  // -------------------------------------------------------------------
  // Live conflict engine: highlight existing clashes, validate drags.
  // Validation always runs against ALL lessons, not just the filtered view.
  // -------------------------------------------------------------------

  /**
   * Each group's meal, keyed `groupId:weekday` for the conflict check.
   *
   * Built from every sitting, not only the filtered group's: the check runs on
   * the lesson's own groups, and a lesson for a class that is not the one being
   * looked at is still a lesson on that class's meal.
   */
  const lunchOf = useMemo<LunchOf | undefined>(() => {
    if (!lunchSittings) return undefined;
    // A class may eat at another time in another part of the läsår, so a day
    // can hold several meals; the check holds a lesson to those of its weeks.
    const meals = new Map<string, Meal[]>();
    for (const sitting of lunchSittings) {
      const key = `${sitting.studentGroupId}:${sitting.dayOfWeek}`;
      const meal: Meal = {
        startMinutes: timeToMinutes(sitting.startTime),
        endMinutes: timeToMinutes(sitting.endTime),
        startDate: sitting.startDate,
        endDate: sitting.endDate,
      };
      const held = meals.get(key);
      if (held) held.push(meal);
      else meals.set(key, [meal]);
    }
    return meals;
  }, [lunchSittings]);

  /**
   * The pupils' ombyte and dusch, per (class, subject).
   *
   * `undefined` while the timplan has not answered, which is the file's own
   * convention for "not checked" — and the honest reading: a buffer nobody has
   * loaded yet must not be reported as 0 and let a drag through that the API
   * then refuses with a 409. `useRequirements` is keyed on the läsår, so this
   * follows the year the grid is showing.
   */
  const pupilBuffers = useMemo(
    () => (requirements ? buildPupilBufferMap(requirements) : undefined),
    [requirements],
  );

  /**
   * Whether a placement sits in a room its subject's locks forbid.
   *
   * The subject comes off the lesson and the stage off its group, so this is a
   * closure over the page's own maps rather than another argument list.
   */
  const roomLock = useMemo(() => {
    const locks = (roomRules ?? []).filter((rule) => rule.kind === "LOCK");
    if (locks.length === 0) return undefined;
    return (placement: Placement) => {
      const lesson = placement.id ? lessonById.get(placement.id) : undefined;
      if (!lesson) return false;
      return breaksRoomLock(
        locks,
        lesson.subjectId,
        gradeSpanOf.get(lesson.studentGroupId),
        placement.roomId,
      );
    };
  }, [roomRules, lessonById, gradeSpanOf]);

  const foundConflicts = useMemo(
    () =>
      detectConflicts(
        lessons ?? [],
        constraints ?? [],
        studentGroupOf,
        groupConflictMap,
        gradeSpanOf,
        frameTimes,
        lunchOf,
        roomLock,
        pupilBuffers,
        closedWeeks,
      ),
    [
      lessons,
      constraints,
      studentGroupOf,
      groupConflictMap,
      gradeSpanOf,
      frameTimes,
      lunchOf,
      roomLock,
      pupilBuffers,
      closedWeeks,
    ],
  );

  // UNDANTAG MED FLIT: a hit for a rule the lesson has been given an exemption for is no conflict, and is said apart (the card's märke, the
  // krocklistan's rubrik). The grid, the header's count and the list all read the map without it; a page where no lesson has one reads its own map.
  const { conflicts: conflictMap, exemptions: exemptionMap, standing: exemptionStanding } = useMemo(() => splitExemptions(foundConflicts, lessonById), [foundConflicts, lessonById]);

  /** lessonId → collaborator label (soft edit-locks from presence). */
  const remoteEditors = useMemo(() => {
    const map = new Map<string, string>();
    for (const peer of peers) {
      if (peer.editingLessonId && (!editing || peer.editingLessonId !== editing.id)) {
        map.set(peer.editingLessonId, peer.label);
      }
    }
    return map;
  }, [peers, editing]);

  /**
   * Everything that OCCUPIES a slot. A parked lesson does not: it is on the
   * tray, and its remembered day and time are not a placement. Reading them
   * as one would refuse B the very slot A was lifted out of.
   */
  const placements = useMemo(
    () =>
      (lessons ?? [])
        .filter((lesson) => !lesson.isParked)
        .map((lesson) => toPlacement(lesson, pupilBuffers)),
    [lessons, pupilBuffers],
  );

  const validateChange = useCallback(
    (id: string, change: LessonChange, without?: ReadonlySet<string>): boolean => {
      const lesson = lessonById.get(id);
      if (!lesson) return false;
      // A lesson written from a förläggning is changed in Förlägg i veckan: refused during the drag, not after the drop (409). Let go
      // where it already is it stands, as the server lets it (assertPlacedLessonStands): a parked one put back on its own slot, and a
      // drag that ends where it began.
      if (lesson.fromPlacement) {
        const own = toPlacement(lesson);
        return change.dayOfWeek === own.dayOfWeek && change.startMinutes === own.startMinutes && change.endMinutes === own.endMinutes;
      }
      // The school day (SCHOOL_DAY, the gateway's judge of a hand edit): a lesson is not dropped on a Saturday or a Sunday. One that already
      // stands on one may stay and be dropped within it (låt stå), but not on another weekend day, and one back from the tray stands nowhere.
      if (change.dayOfWeek > 5 && (change.dayOfWeek !== lesson.dayOfWeek || lesson.isParked)) return false;
      return (
        validatePlacement(
          {
            id,
            dayOfWeek: change.dayOfWeek,
            startMinutes: change.startMinutes,
            endMinutes: change.endMinutes,
            teacherId: lesson.teacherId,
            coTeacherId: lesson.coTeacherId,
            roomId: lesson.roomId,
            studentGroupId: lesson.studentGroupId,
            // Ersättande grupper: SvA7 may be dragged beside 7A's svenska.
            subjectId: lesson.subjectId,
            extraGroupIds: lesson.extraGroupIds,
            studentIds: lesson.studentIds,
            // Its weeks and its window of dates, as the gateway's judge holds them: left off, a lesson of the autumn was refused a time
            // that a lesson of the spring holds, and one on odd weeks a time of the even weeks (found by the fall file's richer worlds).
            recurrence: lesson.recurrence,
            startDate: lesson.startDate,
            endDate: lesson.endDate,
            // The dragged lesson's OWN ombyte and dusch. Left off, the
            // candidate would be checked without the minutes every other
            // placement on the grid is carrying: the drag would be let into a
            // slot the API then refuses with a 409, and only after the move
            // has visibly happened.
            ...pupilBufferOf(pupilBuffers, lesson),
          },
          // A block card's lessons move together: none is in another's way.
          without ? placements.filter((placement) => !without.has(placement.id ?? "")) : placements,
          constraints ?? [],
          studentGroupOf,
          groupConflictMap,
          gradeSpanOf,
          frameTimes,
          lunchOf,
          // NO room lock here, and the omission is the design. This predicate
          // BLOCKS a drag, and it builds its candidate with the lesson's
          // current room because a drag moves time and not place. Pass the lock
          // in and the day a school writes one, every lesson of that subject
          // already sitting elsewhere becomes undraggable in time — silently,
          // for a reason that has nothing to do with the move. The violation
          // shows as a conflict on the grid instead.
          undefined,
          // The weeks of a lov: a lesson dragged beside one it meets only in jullov is no clash.
          closedWeeks,
        ).length === 0
      );
    },
    [
      lessonById,
      placements,
      constraints,
      studentGroupOf,
      groupConflictMap,
      gradeSpanOf,
      frameTimes,
      lunchOf,
      pupilBuffers,
      closedWeeks,
    ],
  );

  return { yearGroups, closedWeeks, teachers, students, studentGroupOf, gradeSpanOf, homeClassIds, rosterIndex, groupConflictMap, subjectById, groupById, roomById, teacherById, personById, lessonById, lunchOf, pupilBuffers, conflictMap, exemptionMap, exemptionStanding, remoteEditors, placements, validateChange };
}

export type ScheduleEngine = ReturnType<typeof useScheduleEngine>;
