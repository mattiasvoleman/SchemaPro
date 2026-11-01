import { lessonNamed, PUPIL_LIST as f, pupilListMembers, pupilNamed, WITH_SVA, WITHOUT } from '../../test/utils/pupil-list';
import { keptByOf, lessonPupils, replacedSubjectOf, replacingBySubject, yearsOf } from './replacing-groups';

/**
 * Elevlistan i uppföljningen: one lesson's pupils, as every reader that lists
 * or counts them asks it (replacing-groups.ts lessonPupils). The fixture was
 * GENERATED from this implementation (scripts/generate-pupil-list-fixture.ts);
 * web/lib/pupil-list.contract.test.ts replays it with the web's copy, and the
 * readers' own specs replay its two schools (test/utils/pupil-list.ts): SS12000
 * v1 and v2, the class book, the register's reported absences, the
 * timetable's "x/y", the timplan's line statistics.
 */

describe("a lesson's pupils agree with the shared fixture", () => {
  it('has the three cases: a pupil in a group replacing svenska, one in a support group replacing nothing, and a school with no replacing group', () => {
    expect(WITH_SVA.groups.some((group) => group.replacesSubjectId !== null)).toBe(true);
    expect(WITHOUT.groups.every((group) => group.replacesSubjectId === null)).toBe(true);
    const classSvenska = lessonNamed('7A:s svenska').id;
    expect(WITH_SVA.expected[classSvenska]!.off).toEqual([pupilNamed('Alva'), pupilNamed('Eva')].sort());
    expect(WITH_SVA.expected[classSvenska]!.on).toContain(pupilNamed('Bo'));
  });

  it('pins the läsår and keptBy: last year\'s SvA6 takes Dag off nothing this year, and Sv7f\'s own svenska keeps Eva of SvA7', () => {
    expect(WITH_SVA.groups.find((group) => group.name === 'SvA6')).toMatchObject({ academicYearId: f.pastAcademicYearId });
    expect(WITH_SVA.expected[lessonNamed('7A:s svenska').id]!.on).toContain(pupilNamed('Dag'));
    expect(WITH_SVA.expected[lessonNamed('Sv7f:s svenska').id]).toEqual({ on: [pupilNamed('Eva')], off: [] });
  });

  it.each(f.schools.map((school) => [school.name, school] as const))('%s', (_name, school) => {
    const groups = new Map(school.groups.map((group) => [group.id, group]));
    const bySubject = replacingBySubject(replacedSubjectOf(school.groups));
    for (const lesson of f.lessons) {
      const keptBy = keptByOf(groups.get(lesson.groupIds[0]!));
      const scope = { ...lesson, academicYearId: f.academicYearId, ...(keptBy ? { keptBy } : {}) };
      expect([lesson.name, lessonPupils(scope, pupilListMembers(), bySubject, yearsOf(school.groups))]).toEqual([lesson.name, school.expected[lesson.id]]);
    }
  });

  it('a school with no replacing group: nobody is off, and on is the union of the groups and the named, as before', () => {
    const members = pupilListMembers();
    for (const lesson of f.lessons) {
      const union = new Set(lesson.named);
      for (const groupId of lesson.groupIds) for (const pupil of members.get(groupId) ?? []) union.add(pupil);
      expect(WITHOUT.expected[lesson.id]).toEqual({ on: [...union].sort(), off: [] });
    }
  });
});
