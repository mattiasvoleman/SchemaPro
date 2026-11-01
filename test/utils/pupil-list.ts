import fixture from '../../src/common/__fixtures__/pupil-list-cases.json';

/**
 * Elevlistan i uppföljningen: the shared school of
 * src/common/__fixtures__/pupil-list-cases.json, typed, for the readers'
 * specs that replay it (src/common/pupil-list.contract.spec.ts says which).
 */

export interface PupilListGroup {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  halfOfId: string | null;
  replacesSubjectId: string | null;
  academicYearId: string;
}

export interface PupilListSchool {
  name: string;
  groups: PupilListGroup[];
  cases: Record<string, string>;
  expected: Record<string, { on: string[]; off: string[] }>;
}

export interface PupilListFixture {
  academicYearId: string;
  /** Last läsår: SvA6's, which takes nobody off this year's lessons. */
  pastAcademicYearId: string;
  subjects: { id: string; name: string; nationalCode: string }[];
  pupils: { id: string; name: string; homeGroupId: string; groupIds: string[] }[];
  lessons: { id: string; name: string; subjectId: string; groupIds: string[]; named: string[] }[];
  schools: PupilListSchool[];
}

export const PUPIL_LIST = fixture as unknown as PupilListFixture;

/** The school with a group replacing svenska, and the same school with none. */
export const [WITH_SVA, WITHOUT] = PUPIL_LIST.schools as [PupilListSchool, PupilListSchool];

/** Each group's pupils: home classes and teaching groups alike. */
export function pupilListMembers(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const pupil of PUPIL_LIST.pupils) {
    for (const groupId of [pupil.homeGroupId, ...pupil.groupIds]) out.set(groupId, (out.get(groupId) ?? new Set()).add(pupil.id));
  }
  return out;
}

/** A pupil's or a lesson's id by its name in the fixture. */
export const pupilNamed = (name: string) => PUPIL_LIST.pupils.find((pupil) => pupil.name === name)!.id;
export const lessonNamed = (name: string) => PUPIL_LIST.lessons.find((lesson) => lesson.name === name)!;
export const subjectCoded = (code: string) => PUPIL_LIST.subjects.find((subject) => subject.nationalCode === code)!.id;
