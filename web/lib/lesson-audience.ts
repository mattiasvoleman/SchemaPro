/**
 * Who, of one class, actually sits in a lesson.
 *
 * The timetable filtered by `lesson.studentGroupId === viewGroup`, which asks a
 * NAME question of data that is a SET: a lesson belongs to its owner group, its
 * extra groups and any individually named pupils. So filtering to 4.1 hid the
 * maths half sitting in 4ma1, and hid a lesson 4.2 owns that 4.1 also attends.
 *
 * The database already answers this correctly from the other side — the RLS
 * policy `calendar_lessons_teaching_group_select` gives a pupil their
 * teaching-group lessons — so a pupil in 4.1 sees their 4ma1 maths on their own
 * phone while the administrator filtering to 4.1 does not.
 *
 * A CLASS IS NOT ONE BODY, which lib/gaps.ts settled first and argued at
 * length: "while Ma71 runs, sixteen of the class are taught and the other
 * fourteen may have nothing at all". So a lesson is in a class's week when it
 * holds at least one of its pupils, and it carries HOW MANY — drawing 4ma1 as a
 * whole-class block would contradict a module already shipped, and omitting it
 * would contradict the pupil's own portal.
 */

import {
  keptByOf,
  lessonPupils,
  replacedSubjectOf,
  replacingBySubject,
  yearsOf,
  type KeptByRow,
} from "./replacing-groups";

/**
 * A pupil roster, indexed the way both questions here need it.
 *
 * An EMPTY index is the whole of the loading and not-yet-imported story, and
 * deliberately not a flag: a class with no known pupils falls through to the
 * NAME test with no fraction, which is what an in-flight query and a school
 * that has not imported its pupils both want. The roster can then only ever ADD
 * cards, so the grid never blanks — the flicker is fewer→more, not empty→full,
 * and a school that built its timetable before importing pupils sees its own
 * week rather than something indistinguishable from data loss.
 */
export interface RosterIndex {
  /** groupId → the pupils in it, home classes and teaching groups alike. */
  membersOf: Map<string, Set<string>>;
  /**
   * half → the class it is cut from (Halvklasser). A half's lesson is its
   * class's business by name, as a lesson naming the class is: before anyone
   * is placed it holds none of the class's pupils, yet it keeps the whole
   * class off the hour, and a 7A view without it would show the slöjd hour
   * free and refuse the drag into it for a lesson nobody can see.
   */
  halfOf?: Map<string, string>;
  /**
   * Ersättande grupper (Elevlistan i uppföljningen): the groups replacing a
   * subject, every group's läsår and kind. A pupil in SvA7 is not in the room
   * for 7A's svenska (lib/replacing-groups.ts lessonPupils), so 7A's svenska
   * holds "24/28" of 7A and none of SvA7. Absent in a school with no
   * replacing group, which counts as it always did.
   */
  replacing?: {
    bySubject: Map<string, string[]>;
    yearOf: Map<string, string>;
    groups: Map<string, KeptByRow & { academicYearId?: string | null }>;
  };
}

/** The fields of a lesson that decide who is in the room. */
export interface LessonAudienceInput {
  studentGroupId: string;
  extraGroupIds: string[];
  studentIds: string[];
  /** Its subject: a group replacing it takes its members out of the room. Absent, nobody leaves. */
  subjectId?: string;
}

export interface Audience {
  /** How many of the viewed class sit in this lesson. */
  attending: number;
  /** How many pupils the viewed class has; 0 when the roster is unknown. */
  cohortSize: number;
  /**
   * The lesson NAMES the viewed class, rather than reaching it through pupils.
   *
   * Kept apart from the fraction because they answer different questions. A
   * språkval that happens to hold all 28 is `28/28` and still not the class's
   * own lesson; a lesson 4.2 owns with 4.1 attending is the class's business
   * even though 4.1 is not the owner.
   */
  named: boolean;
}

/**
 * `studentGroupOf` is studentId → home class (null for a pupil with none), and
 * `memberships` are the teaching-group rows. Either may be undefined while its
 * query is in flight, which is a different fact from an empty one.
 */
export function buildRosterIndex(
  studentGroupOf: Map<string, string | null> | undefined,
  memberships: Array<{ studentId: string; studentGroupId: string }> | undefined,
  groups: ReadonlyArray<{
    id: string;
    halfOfId?: string | null;
    kind?: string | null;
    replacesSubjectId?: string | null;
    academicYearId?: string | null;
  }> = [],
): RosterIndex {
  const membersOf = new Map<string, Set<string>>();
  const halfOf = new Map(groups.flatMap((group) => (group.halfOfId ? [[group.id, group.halfOfId] as const] : [])));
  const bySubject = replacingBySubject(replacedSubjectOf(groups));
  const replacing =
    bySubject.size === 0
      ? undefined
      : { bySubject, yearOf: yearsOf(groups), groups: new Map(groups.map((group) => [group.id, group])) };
  if (studentGroupOf === undefined || memberships === undefined) {
    return { membersOf, halfOf, ...(replacing ? { replacing } : {}) };
  }

  const add = (groupId: string, studentId: string) => {
    let set = membersOf.get(groupId);
    if (!set) membersOf.set(groupId, (set = new Set()));
    set.add(studentId);
  };

  for (const [studentId, homeClass] of studentGroupOf) {
    // A pupil with no home class is skipped HERE and still reachable through
    // their teaching groups below — the two sources are independent, and a
    // pupil belongs to a teaching group whether or not a class was recorded.
    if (homeClass !== null) add(homeClass, studentId);
  }
  for (const row of memberships) add(row.studentGroupId, row.studentId);

  return { membersOf, halfOf, ...(replacing ? { replacing } : {}) };
}

/** The groups a lesson names, and the classes of any halves among them. */
function namedBy(lesson: LessonAudienceInput, index: RosterIndex): Set<string> {
  const named = new Set([lesson.studentGroupId, ...lesson.extraGroupIds]);
  for (const groupId of [...named]) {
    const theClass = index.halfOf?.get(groupId);
    if (theClass) named.add(theClass);
  }
  return named;
}

/**
 * What this lesson means for one class, or null if it means nothing.
 *
 * The attendees are built as ONE UNION of pupil ids before the intersection is
 * counted. Summing per-group intersections instead would count a pupil twice
 * when a lesson names two groups that both hold them — which is exactly the
 * shape a class split into two named halves has.
 */
export function audienceFor(
  lesson: LessonAudienceInput,
  viewGroupId: string,
  index: RosterIndex,
): Audience | null {
  const named = namedBy(lesson, index).has(viewGroupId);

  const cohort = index.membersOf.get(viewGroupId);
  if (!cohort || cohort.size === 0) {
    // Nobody known in this class — still loading, never imported, or a group
    // that really is empty. The name test still holds, and a fraction over
    // zero would be worse than no fraction at all.
    return named ? { attending: 0, cohortSize: 0, named } : null;
  }
  const cohortSize = cohort.size;

  const attendees = attendeesOf(lesson, index);
  let attending = 0;
  for (const studentId of attendees) if (cohort.has(studentId)) attending += 1;

  if (attending === 0) return named ? { attending, cohortSize, named } : null;
  return { attending, cohortSize, named };
}

/**
 * Everyone in the room, as ONE set of pupil ids.
 *
 * The union is the whole point. Handling the groups separately double-counts a
 * pupil that two named groups both hold, which is exactly the shape a class
 * split into two named halves has.
 *
 * Less the pupils a replacing group takes off the lesson: the same union,
 * asked of lessonPupils, which SS12000, the class book and the register ask
 * too.
 */
function attendeesOf(
  lesson: LessonAudienceInput,
  index: RosterIndex,
): Set<string> {
  const replacing = index.replacing;
  if (replacing && lesson.subjectId !== undefined && replacing.bySubject.has(lesson.subjectId)) {
    const own = replacing.groups.get(lesson.studentGroupId);
    const { on } = lessonPupils(
      {
        subjectId: lesson.subjectId,
        groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
        keptBy: keptByOf(own),
        ...(own?.academicYearId ? { academicYearId: own.academicYearId } : {}),
        named: lesson.studentIds,
      },
      index.membersOf,
      replacing.bySubject,
      replacing.yearOf,
    );
    return new Set(on);
  }
  const attendees = new Set<string>();
  for (const groupId of [lesson.studentGroupId, ...lesson.extraGroupIds]) {
    for (const studentId of index.membersOf.get(groupId) ?? []) {
      attendees.add(studentId);
    }
  }
  for (const studentId of lesson.studentIds) attendees.add(studentId);
  return attendees;
}

/**
 * Which home classes a change to this lesson reaches.
 *
 * Asked of the LESSON, never of the filter: moving 4ma1 moves it for 4.2's
 * pupils too, and the administrator who dragged it was looking at 4.1. A
 * filter is what you happen to be looking at; this is who it lands on.
 *
 * `homeClasses` is the ids of the groups that are classes — a teaching group is
 * not somebody's home, and counting 4ma1 alongside 4.1 and 4.2 would report
 * three where the honest answer is two.
 */
export function homeClassesReached(
  lesson: LessonAudienceInput,
  homeClasses: Iterable<string>,
  index: RosterIndex,
): string[] {
  const attendees = attendeesOf(lesson, index);
  const named = namedBy(lesson, index);
  const reached: string[] = [];
  for (const groupId of homeClasses) {
    if (named.has(groupId)) {
      // A named class counts even with no roster: the lesson says so itself.
      reached.push(groupId);
      continue;
    }
    for (const studentId of index.membersOf.get(groupId) ?? []) {
      if (attendees.has(studentId)) {
        reached.push(groupId);
        break;
      }
    }
  }
  return reached;
}

/**
 * Whether to print the fraction on this card.
 *
 * Only when the class is PARTLY there. A `28/28` on every one of a class's own
 * lessons is noise on the ninety-percent case, and a språkval that happens to
 * hold the whole class really is wholly booked — marking it partial would be a
 * second lie rather than a correction of the first. A class's own svenska that
 * SvA7 takes four of is partly there, "24/28", and says so.
 */
export function showsFraction(audience: Audience): boolean {
  return audience.cohortSize > 0 && audience.attending < audience.cohortSize;
}
