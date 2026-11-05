/*
 * SCHEMABRYTANDE AKTIVITET: WHAT REPLACES WHAT, as pure functions.
 *
 * An activity cancels the lessons its selection takes (the avbokning, see
 * cancellation-selection.ts) and puts ONE lesson in their place for each class
 * or group and day. These functions say which classes those are, which groups
 * the cancellation must also take so that nobody is left with half a day, and
 * when each replacement lesson starts and ends. No Prisma, no clock: the
 * service reads, these decide, the service writes.
 *
 * ## Who gets a replacement lesson (the OWNERS)
 *
 *   GROUPS   the groups the administrator named. A half of a named class is
 *            folded into its class: 7A's replacement lesson is for all of 7A,
 *            and a half named alone (7A-halva 1) is its own owner, for its own
 *            pupils. A teaching group named is an owner.
 *   GRADES   every class (kind CLASS, not a half) whose årskurs is in the span.
 *   SCHOOL   every class of the year.
 *
 * Teaching groups that are not named reach the owners through their pupils:
 * a cancelled Spanska 7 lesson belongs to the class each of its pupils goes
 * in, by the lesson's roster, not by the group's name. So a teaching group
 * with pupils from 7A, 7B and 7C puts one stretch on each class's day.
 *
 * ## What the cancellation must also take (EXPANSION, GROUPS only)
 *
 * A named class takes its halves, and every teaching group (a språkval, a
 * nivågrupp, SvA7, a block's group) whose pupils ALL go in the named classes:
 * they are away with the class, and a lesson left standing would be taught to
 * an empty room and marked absent. A group with pupils of other classes too is
 * left, and named in the preview as a lesson that goes on for some of the
 * pupils (CONTINUING): cancelling it would take lessons from classes the
 * activity is not for.
 *
 * ## When a replacement lesson is held
 *
 * From the first start to the last end of the lessons it replaces that day,
 * whose roster holds at least one of the owner's pupils. One lesson, so one
 * register for the day; it spans the lunch and the gaps between lessons, which
 * is where the class is on a friluftsdag. The minutes of the timplan do not
 * come from its length but from the school's credits (see the migration).
 */

export interface GroupFacts {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  /** The class this group is a half of, or null. */
  halfOfId: string | null;
}

export type ActivityScope = 'SCHOOL' | 'GRADES' | 'GROUPS';

export interface ScopeRule {
  scope: ActivityScope;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  /** The groups the administrator named (GROUPS). */
  groupIds: readonly string[];
}

/** The groups that get a replacement lesson, in name order. */
export function ownersOf(rule: ScopeRule, groups: readonly GroupFacts[]): GroupFacts[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  let owners: GroupFacts[];
  if (rule.scope === 'GROUPS') {
    const named = new Set(rule.groupIds);
    owners = [...named]
      .map((id) => byId.get(id))
      .filter((group): group is GroupFacts => group !== undefined)
      // A half rides on its class when the class is named too.
      .filter((group) => group.halfOfId === null || !named.has(group.halfOfId));
  } else if (rule.scope === 'GRADES') {
    owners = groups.filter(
      (group) =>
        group.kind === 'CLASS' &&
        group.halfOfId === null &&
        group.gradeLevel !== null &&
        rule.minGradeLevel !== null &&
        rule.maxGradeLevel !== null &&
        group.gradeLevel >= rule.minGradeLevel &&
        group.gradeLevel <= rule.maxGradeLevel,
    );
  } else {
    owners = groups.filter((group) => group.kind === 'CLASS' && group.halfOfId === null);
  }
  return owners.sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.id.localeCompare(b.id));
}

/**
 * The groups the cancellation takes for a GROUPS selection: the named ones,
 * their halves, and every teaching group all of whose pupils go in a named
 * class. `homeClassOfMembers` maps a group to the home class of each of its
 * members (a class's own pupils are not asked: a class is named, or it is not).
 */
export function expandNamedGroups(
  named: readonly string[],
  groups: readonly GroupFacts[],
  homeClassOfMembers: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out = new Set(named);
  const namedClasses = new Set(named.filter((id) => groups.find((group) => group.id === id)?.kind === 'CLASS'));
  for (const group of groups) {
    if (out.has(group.id)) continue;
    if (group.halfOfId !== null && namedClasses.has(group.halfOfId)) {
      out.add(group.id);
      continue;
    }
    if (group.kind !== 'TEACHING_GROUP') continue;
    const homes = homeClassOfMembers.get(group.id) ?? [];
    if (homes.length > 0 && homes.every((home) => namedClasses.has(home))) out.add(group.id);
  }
  return [...out];
}

/** A cancelled lesson with the pupils it was for. */
export interface PlanLesson {
  id: string;
  /** The school's day, YYYY-MM-DD. */
  date: string;
  startsAt: Date;
  endsAt: Date;
  pupils: ReadonlySet<string>;
}

/** An owner with the pupils its replacement lesson is for. */
export interface PlanOwner {
  groupId: string;
  pupils: ReadonlySet<string>;
}

export interface PlannedReplacement {
  groupId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  /** The cancelled lessons it replaces, by id. */
  lessonIds: string[];
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (large.has(id)) return true;
  return false;
};

/** One replacement lesson per owner and day that has a cancelled lesson for the owner's pupils. */
export function planReplacements(lessons: readonly PlanLesson[], owners: readonly PlanOwner[]): PlannedReplacement[] {
  const out: PlannedReplacement[] = [];
  const byDate = new Map<string, PlanLesson[]>();
  for (const lesson of lessons) {
    const list = byDate.get(lesson.date);
    if (list) list.push(lesson);
    else byDate.set(lesson.date, [lesson]);
  }
  for (const owner of owners) {
    if (owner.pupils.size === 0) continue;
    for (const [date, list] of byDate) {
      const mine = list.filter((lesson) => intersects(lesson.pupils, owner.pupils));
      if (mine.length === 0) continue;
      out.push({
        groupId: owner.groupId,
        date,
        startsAt: new Date(Math.min(...mine.map((lesson) => lesson.startsAt.getTime()))),
        endsAt: new Date(Math.max(...mine.map((lesson) => lesson.endsAt.getTime()))),
        lessonIds: mine.map((lesson) => lesson.id).sort(),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.groupId.localeCompare(b.groupId));
}

/** Pupils on a cancelled lesson whom no owner holds: their lesson is gone and nothing replaces it. */
export function uncoveredPupils(lessons: readonly PlanLesson[], owners: readonly PlanOwner[]): number {
  const held = new Set<string>();
  for (const owner of owners) for (const pupil of owner.pupils) held.add(pupil);
  const loose = new Set<string>();
  for (const lesson of lessons) for (const pupil of lesson.pupils) if (!held.has(pupil)) loose.add(pupil);
  return loose.size;
}

/** The text a replacement lesson carries for the pupils: the activity's name, and what it says about the day. */
export function noteOf(name: string, description: string | null): string {
  return description ? `${name}: ${description}` : name;
}

/** The note a cancelled lesson carries: the avbokning's own, which a reversal looks for. */
export const cancelledNoteOf = (name: string): string => `Inställd: ${name}`;

/** A lesson a teacher has that the activity does not take. */
export interface BusyLesson {
  teacherId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  groupName: string;
}

export interface TeacherClash {
  teacherId: string;
  date: string;
  /** The class the teacher is responsible for that day. */
  groupId: string;
  /** The lesson that still stands in the time, by its class's name. */
  busyWith: string;
}

/**
 * A teacher responsible for a class is on that class's replacement lesson from
 * its start to its end. A lesson of theirs that is not cancelled in the same
 * time (a class outside the activity) is a clash: named, never refused, as the
 * school may mean one teacher to follow two classes.
 */
export function teacherClashes(
  plan: readonly PlannedReplacement[],
  responsible: ReadonlyArray<{ studentGroupId: string; teacherId: string }>,
  busy: readonly BusyLesson[],
): TeacherClash[] {
  const out: TeacherClash[] = [];
  for (const entry of plan) {
    for (const teacher of responsible.filter((row) => row.studentGroupId === entry.groupId)) {
      for (const lesson of busy) {
        if (lesson.teacherId !== teacher.teacherId || lesson.date !== entry.date) continue;
        if (lesson.startsAt < entry.endsAt && entry.startsAt < lesson.endsAt) {
          out.push({ teacherId: teacher.teacherId, date: entry.date, groupId: entry.groupId, busyWith: lesson.groupName });
        }
      }
    }
  }
  return out;
}
