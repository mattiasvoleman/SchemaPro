import { STAFFING_FIELDS, mergeRequirement, touchesStaffing } from './staffing-enforcement';
import type { LoadRequirement } from './teacher-load';

const BASE = {
  id: 'req-1',
  subjectId: 'idh',
  subjectName: 'Idrott och hälsa',
  studentGroupId: 'g-7a',
  groupName: '7A',
  gradeSpan: { min: 7, max: 7 },
};

const STORED: LoadRequirement = {
  ...BASE,
  teacherId: 'anna',
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 80,
  lessonLengths: [80, 40],
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
};

describe('mergeRequirement', () => {
  it('keeps the stored lengths when the patch names none', () => {
    expect(mergeRequirement(STORED, BASE, { teacherId: 'bo' })).toMatchObject({
      teacherId: 'bo',
      lessonsPerWeek: 2,
      minutesPerLesson: 80,
      lessonLengths: [80, 40],
    });
  });

  it('overlays the resolved shape the writer hands in, all three fields together', () => {
    expect(
      mergeRequirement(STORED, BASE, { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] }),
    ).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
  });

  it('gives a create the column’s empty list', () => {
    expect(mergeRequirement(null, BASE, {})).toMatchObject({
      lessonsPerWeek: 1,
      minutesPerLesson: 60,
      lessonLengths: [],
    });
  });
});

describe('touchesStaffing', () => {
  it('counts the lengths as a staffing field: they change what a row charges', () => {
    expect(STAFFING_FIELDS).toContain('lessonLengths');
    expect(touchesStaffing({ lessonLengths: [] })).toBe(true);
    expect(touchesStaffing({ minutesBefore: 10 })).toBe(false);
  });
});
