import type { PlannedGroup, PlannedPupilInput } from '../common/timplan-planned';
import { audiencesOf } from './audience';

const MA = 'subject-ma';
const SV = 'subject-sv';

const klass = (id: string, gradeLevel: number | null): PlannedGroup => ({ id, name: id, kind: 'CLASS', gradeLevel });
const team = (id: string, extra: Partial<PlannedGroup> = {}): PlannedGroup => ({ id, name: id, kind: 'TEACHING_GROUP', gradeLevel: null, ...extra });
const pupil = (id: string, homeGroupId: string | null, groupIds: string[] = []): PlannedPupilInput => ({ id, homeGroupId, groupIds });

describe('audiencesOf', () => {
  const groups = [klass('7A', 7), klass('8A', 8), klass('9X', null), team('MaN'), team('SvA', { replacesSubjectId: SV })];
  const pupils = [
    pupil('p1', '7A', ['MaN']),
    pupil('p2', '7A', ['SvA']),
    pupil('p3', '7A'),
    pupil('p4', '8A', ['MaN']),
    pupil('p5', '9X'),
    pupil('p6', null, ['MaN']),
    pupil('p7', 'other-year-class'),
  ];
  const audiences = audiencesOf(groups, pupils);

  it("gives a pupil the årskurs of their home class this year, and none when it is another year's or has none", () => {
    expect(audiences.gradeOf.get('p1')).toBe(7);
    expect(audiences.gradeOf.get('p4')).toBe(8);
    expect(audiences.gradeOf.get('p5')).toBeNull();
    expect(audiences.gradeOf.get('p6')).toBeNull();
    expect(audiences.gradeOf.get('p7')).toBeNull();
  });

  it("counts as the school's pupils only those with a class of the year, per årskurs", () => {
    expect([...audiences.schoolPupils].sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(audiences.pupilsPerGrade.get(7)).toBe(3);
    expect(audiences.pupilsPerGrade.get(8)).toBe(1);
    expect(audiences.pupilsPerGrade.get(null)).toBe(1);
  });

  it('puts a class row on its home class and a teaching group row on its members, across classes', () => {
    expect(audiences.audienceOf('8A', MA)).toEqual(['p4']);
    expect(audiences.audienceOf('MaN', MA)).toEqual(['p1', 'p4', 'p6']);
    expect(audiences.membersOf('MaN')).toEqual(['p1', 'p4', 'p6']);
    expect(audiences.membersOf('nobody')).toEqual([]);
  });

  it("takes a replacing group's pupils off the class's lessons in its subject, and only in that subject", () => {
    expect(audiences.audienceOf('7A', SV)).toEqual(['p1', 'p3']);
    expect(audiences.audienceOf('7A', MA)).toEqual(['p1', 'p2', 'p3']);
    expect(audiences.audienceOf('SvA', SV)).toEqual(['p2']);
  });

  it('answers a repeated question from memory and a group without pupils with nobody', () => {
    expect(audiences.audienceOf('7A', MA)).toBe(audiences.audienceOf('7A', MA));
    expect(audiences.audienceOf('no-such-group', MA)).toEqual([]);
  });

  it("knows a class's own årskurs and a teaching group's as none", () => {
    expect(audiences.groupGradeOf('7A')).toBe(7);
    expect(audiences.groupGradeOf('9X')).toBeNull();
    expect(audiences.groupGradeOf('MaN')).toBeNull();
    expect(audiences.groupGradeOf('nobody')).toBeNull();
  });

  it('ignores a membership of a group that is not of the year', () => {
    const odd = audiencesOf([klass('7A', 7)], [pupil('q1', '7A', ['gone'])]);
    expect(odd.membersOf('gone')).toEqual([]);
    expect(odd.schoolPupils).toEqual(['q1']);
  });
});
