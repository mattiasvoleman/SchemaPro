import type { PlannedGroup, PlannedPupilInput } from '../../common/timplan-planned';
import {
  DEFAULT_LOAD_POLICY,
  buildTeacherLoadReport,
  type LoadEmployment,
  type LoadInput,
  type LoadQualification,
  type LoadRequirement,
} from '../../staffing/teacher-load';
import { audiencesOf } from '../audience';

/*
 * A small school every analysis spec reads: three classes (7A with four
 * pupils, 8A with two, 9A with none), a mathematics group of pupils from 7A
 * and 8A, and three teachers.
 *
 *   ANNA   100 %, behörig i matematik åk 7–9: 7A Ma 3×60, 8A Ma 3×60
 *   BO      50 %, behörig i inget:           7A NO 2×60, 9A NO 1×60 (9A has no pupil)
 *   CY      80 %, behörig i matematik åk 7–9: MaN (the group) Ma 1×60 as co-teacher beside ANNA
 *
 * The riktmärke is 1080 minutes a week, so ANNA's 360 min is a third of a heltid.
 */
export const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
export const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const MA = 'subject-ma';
export const NO = 'subject-no';

export const groups: PlannedGroup[] = [
  { id: 'g7a', name: '7A', kind: 'CLASS', gradeLevel: 7 },
  { id: 'g8a', name: '8A', kind: 'CLASS', gradeLevel: 8 },
  { id: 'g9a', name: '9A', kind: 'CLASS', gradeLevel: 9 },
  { id: 'gman', name: 'MaN', kind: 'TEACHING_GROUP', gradeLevel: null },
];

export const pupils: PlannedPupilInput[] = [
  { id: 'p1', homeGroupId: 'g7a', groupIds: ['gman'] },
  { id: 'p2', homeGroupId: 'g7a', groupIds: [] },
  { id: 'p3', homeGroupId: 'g7a', groupIds: [] },
  { id: 'p4', homeGroupId: 'g7a', groupIds: [] },
  { id: 'p5', homeGroupId: 'g8a', groupIds: ['gman'] },
  { id: 'p6', homeGroupId: 'g8a', groupIds: [] },
];

export const audiences = audiencesOf(groups, pupils);

let sequence = 0;
export const requirement = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: `req-${(sequence += 1)}`,
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: 'g7a',
  groupName: '7A',
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 7 },
  ...overrides,
});

const employment = (userId: string, employmentPercent: number, signature: string): LoadEmployment => ({
  userId,
  employmentPercent,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature,
});

const qualification = (userId: string): LoadQualification => ({
  userId,
  subjectId: MA,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: 'LEGITIMATION',
  validFrom: null,
  validTo: null,
});

export function schoolInput(overrides: Partial<LoadInput> = {}): LoadInput {
  sequence = 0;
  return {
    year: YEAR,
    policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
    employments: [employment(ANNA, 100, 'ANN'), employment(BO, 50, 'BOO'), employment(CY, 80, 'CYY')],
    requirements: [
      requirement({ studentGroupId: 'g7a', groupName: '7A', teacherId: ANNA }),
      requirement({ studentGroupId: 'g8a', groupName: '8A', teacherId: ANNA, gradeSpan: { min: 8, max: 8 } }),
      requirement({ subjectId: NO, subjectName: 'NO', studentGroupId: 'g7a', groupName: '7A', teacherId: BO, lessonsPerWeek: 2 }),
      requirement({ subjectId: NO, subjectName: 'NO', studentGroupId: 'g9a', groupName: '9A', teacherId: BO, lessonsPerWeek: 1, gradeSpan: { min: 9, max: 9 } }),
      requirement({ studentGroupId: 'gman', groupName: 'MaN', teacherId: ANNA, coTeacherId: CY, lessonsPerWeek: 1, gradeSpan: { min: 7, max: 8 } }),
    ],
    qualifications: [qualification(ANNA), qualification(CY)],
    closures: [],
    duties: [],
    ...overrides,
  };
}

export const report = (overrides: Partial<LoadInput> = {}) => buildTeacherLoadReport(schoolInput(overrides));
