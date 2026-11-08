import { keptByOf, lessonPupils, replacedSubjectOf, replacingBySubject } from '../common/replacing-groups';
import type { PlannedGroup, PlannedPupilInput } from '../common/timplan-planned';

/*
 * Vilka elever en timplanspost når.
 *
 * Analys och planering divides a teacher's time by the pupils it is spent on,
 * and "the pupils of a row" is a question the school already has ONE answer
 * to (src/common/replacing-groups.ts, lessonPupils): the members of the row's
 * group, home class and teaching group alike, less the members a replacing
 * group takes off the lesson (SvA7 replaces Svenska, so 7A's svenska does not
 * count a pupil who is in SvA7). This module only builds the roster that rule
 * reads, from the pupils the timplan's own reader gives
 * (readPlannedInput, which reads a past year from its class history).
 *
 * A pupil's årskurs is the one of their home class in THIS year; a pupil whose
 * home class is not a class of the year, or has no årskurs, has none (null) and
 * is counted in no school figure, but still sits on the rows they are placed
 * on. A group with no pupil on it has an empty audience: the caller decides
 * what that means (its time stands on the group's own årskurs).
 *
 * PURE.
 */

export interface Audiences {
  /** pupilId -> the årskurs of their home class this year, or null. Every pupil reached. */
  gradeOf: ReadonlyMap<string, number | null>;
  /** The pupils whose home class is a class of the year: the school's pupils. */
  schoolPupils: readonly string[];
  /** Pupils per årskurs among the school's pupils; null keys a class without one. */
  pupilsPerGrade: ReadonlyMap<number | null, number>;
  /** The pupils on a timplanspost of this subject and group, sorted; empty when the group has none. */
  audienceOf(groupId: string, subjectId: string): readonly string[];
  /** Everyone placed in the group, whatever the subject: home class and teaching group alike. */
  membersOf(groupId: string): readonly string[];
  /** The group's own årskurs (a class's gradeLevel; a teaching group's is its members', so null here). */
  groupGradeOf(groupId: string): number | null;
}

export function audiencesOf(groups: readonly PlannedGroup[], pupils: readonly PlannedPupilInput[]): Audiences {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const members = new Map<string, Set<string>>();
  const add = (groupId: string, pupilId: string) => {
    let set = members.get(groupId);
    if (!set) members.set(groupId, (set = new Set()));
    set.add(pupilId);
  };

  const gradeOf = new Map<string, number | null>();
  const pupilsPerGrade = new Map<number | null, number>();
  const schoolPupils: string[] = [];
  for (const pupil of pupils) {
    const home = pupil.homeGroupId === null ? undefined : byId.get(pupil.homeGroupId);
    const inClass = home !== undefined && home.kind === 'CLASS';
    gradeOf.set(pupil.id, inClass ? home.gradeLevel : null);
    if (inClass) {
      add(home.id, pupil.id);
      schoolPupils.push(pupil.id);
      pupilsPerGrade.set(home.gradeLevel, (pupilsPerGrade.get(home.gradeLevel) ?? 0) + 1);
    }
    for (const groupId of new Set(pupil.groupIds)) if (byId.has(groupId)) add(groupId, pupil.id);
  }

  const bySubject = replacingBySubject(replacedSubjectOf(groups));
  const memo = new Map<string, readonly string[]>();
  return {
    gradeOf,
    schoolPupils,
    pupilsPerGrade,
    audienceOf(groupId, subjectId) {
      const key = `${groupId}|${subjectId}`;
      const known = memo.get(key);
      if (known) return known;
      const keptBy = keptByOf(byId.get(groupId));
      const { on } = lessonPupils(
        { subjectId, groupIds: [groupId], named: [], ...(keptBy === undefined ? {} : { keptBy }) },
        members,
        bySubject,
      );
      memo.set(key, on);
      return on;
    },
    membersOf(groupId) {
      return [...(members.get(groupId) ?? [])].sort();
    },
    groupGradeOf(groupId) {
      const group = byId.get(groupId);
      return group && group.kind === 'CLASS' ? group.gradeLevel : null;
    },
  };
}
