import type { Row } from './rollover-world';

/**
 * defaultRolloverRows() exactly as it stood at fa4a3d6, written out rather
 * than imported, for the one test that pins the rollover's planHash.
 *
 * WHY A FROZEN COPY. Staffing Fas 5 makes the rollover able to carry tjänster
 * and uppdrag, and promises that a rollover without that option plans and
 * hashes exactly as before — an old browser tab's preview stays executable
 * across the deploy. The pin is the literal hash of this school's plan. Pinned
 * over the live fixture it would break whenever somebody adds a row there for
 * another test, for a reason that has nothing to do with the promise; pinned
 * over this copy it breaks only when the planner or the hash serializer
 * changes what a rollover without the option writes. The fixture's staffing
 * rows are the minimal ones of fa4a3d6 (a year id, a slot id, a kind): with
 * the option off the rollover only counts them.
 *
 * A function, so each test mutates its own copy.
 */
export function rolloverRowsAtFa4a3d6(): Record<string, Row[]> {
  return {
    academicYear: [
      { id: 'a0000000-0000-4000-8000-00000000000a', schoolId: '33333333-3333-4333-8333-333333333333', name: '2026/27', startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z'), isActive: true, predecessorId: null, graduatingGradeLevel: null },
    ],
    studentGroup: [
      { id: 'b0000000-0000-4000-8000-000000000007', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: '7A', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
      { id: 'b0000000-0000-4000-8000-000000000008', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: '8A', kind: 'CLASS', gradeLevel: 8, predecessorId: null },
      { id: 'b0000000-0000-4000-8000-000000000009', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: '9A', kind: 'CLASS', gradeLevel: 9, predecessorId: null },
      { id: 'b0000000-0000-4000-8000-0000000000a7', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: 'Ma7 grupp 1', kind: 'TEACHING_GROUP', gradeLevel: 7, predecessorId: null },
    ],
    user: [
      { id: 'c0000000-0000-4000-8000-000000000071', role: 'STUDENT', isActive: true, studentGroupId: 'b0000000-0000-4000-8000-000000000007' },
      { id: 'c0000000-0000-4000-8000-000000000072', role: 'STUDENT', isActive: true, studentGroupId: 'b0000000-0000-4000-8000-000000000007' },
      { id: 'c0000000-0000-4000-8000-000000000081', role: 'STUDENT', isActive: true, studentGroupId: 'b0000000-0000-4000-8000-000000000008' },
      { id: 'c0000000-0000-4000-8000-000000000091', role: 'STUDENT', isActive: true, studentGroupId: 'b0000000-0000-4000-8000-000000000009' },
      { id: 'c0000000-0000-4000-8000-0000000000ff', role: 'STUDENT', isActive: false, studentGroupId: 'b0000000-0000-4000-8000-000000000007' },
      { id: 'd0000000-0000-4000-8000-00000000000a', role: 'TEACHER', isActive: true, studentGroupId: null },
      { id: 'd0000000-0000-4000-8000-00000000000b', role: 'TEACHER', isActive: false, studentGroupId: null },
    ],
    studentGroupMember: [
      { studentGroupId: 'b0000000-0000-4000-8000-0000000000a7', studentId: 'c0000000-0000-4000-8000-000000000071', student: { studentGroupId: 'b0000000-0000-4000-8000-000000000007' } },
      { studentGroupId: 'b0000000-0000-4000-8000-0000000000a7', studentId: 'c0000000-0000-4000-8000-000000000081', student: { studentGroupId: 'b0000000-0000-4000-8000-000000000008' } },
      { studentGroupId: 'b0000000-0000-4000-8000-0000000000a7', studentId: 'c0000000-0000-4000-8000-000000000091', student: { studentGroupId: 'b0000000-0000-4000-8000-000000000009' } },
    ],
    teachingRequirement: [
      { id: '00000000-0000-4000-8000-000000000001', academicYearId: 'a0000000-0000-4000-8000-00000000000a', subjectId: 'e0000000-0000-4000-8000-0000000000aa', studentGroupId: 'b0000000-0000-4000-8000-000000000007', teacherId: 'd0000000-0000-4000-8000-00000000000a', coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, minutesBefore: 0, minutesAfter: 0, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, subject: { name: 'Matematik' } },
      { id: '00000000-0000-4000-8000-000000000002', academicYearId: 'a0000000-0000-4000-8000-00000000000a', subjectId: 'e0000000-0000-4000-8000-0000000000bb', studentGroupId: 'b0000000-0000-4000-8000-000000000007', teacherId: 'd0000000-0000-4000-8000-00000000000b', coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, minutesBefore: 0, minutesAfter: 0, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, subject: { name: 'Svenska' } },
      { id: '00000000-0000-4000-8000-000000000003', academicYearId: 'a0000000-0000-4000-8000-00000000000a', subjectId: 'e0000000-0000-4000-8000-0000000000aa', studentGroupId: 'b0000000-0000-4000-8000-000000000008', teacherId: 'd0000000-0000-4000-8000-00000000000a', coTeacherId: 'd0000000-0000-4000-8000-00000000000a', lessonsPerWeek: 3, minutesPerLesson: 60, minutesBefore: 0, minutesAfter: 0, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, subject: { name: 'Matematik' } },
      { id: '00000000-0000-4000-8000-000000000004', academicYearId: 'a0000000-0000-4000-8000-00000000000a', subjectId: 'e0000000-0000-4000-8000-0000000000aa', studentGroupId: 'b0000000-0000-4000-8000-000000000009', teacherId: 'd0000000-0000-4000-8000-00000000000a', coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, minutesBefore: 0, minutesAfter: 0, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, subject: { name: 'Matematik' } },
      { id: '00000000-0000-4000-8000-000000000005', academicYearId: 'a0000000-0000-4000-8000-00000000000a', subjectId: 'e0000000-0000-4000-8000-0000000000aa', studentGroupId: 'b0000000-0000-4000-8000-0000000000a7', teacherId: 'd0000000-0000-4000-8000-00000000000a', coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, minutesBefore: 0, minutesAfter: 0, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, subject: { name: 'Matematik' } },
      { id: '00000000-0000-4000-8000-000000000006', academicYearId: 'a0000000-0000-4000-8000-00000000000a', subjectId: 'e0000000-0000-4000-8000-0000000000cc', studentGroupId: 'b0000000-0000-4000-8000-000000000007', teacherId: null, coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, minutesBefore: 0, minutesAfter: 0, teacherLoadPercent: 100, coTeacherLoadPercent: 100, recurrence: 'ODD_WEEKS', startDate: new Date('2027-01-11T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z'), subject: { name: 'Teknik' } },
    ],
    schoolBreak: [
      { id: 'f0000000-0000-4000-8000-000000000001', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: 'Höstlov', kind: 'HOLIDAY', startDate: new Date('2026-10-26T00:00:00.000Z'), endDate: new Date('2026-10-30T00:00:00.000Z'), minGradeLevel: null, maxGradeLevel: null },
      { id: 'f0000000-0000-4000-8000-000000000002', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: 'Jullov', kind: 'HOLIDAY', startDate: new Date('2026-12-21T00:00:00.000Z'), endDate: new Date('2027-01-06T00:00:00.000Z'), minGradeLevel: null, maxGradeLevel: null },
      { id: 'f0000000-0000-4000-8000-000000000003', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: 'Påsklov', kind: 'HOLIDAY', startDate: new Date('2027-03-29T00:00:00.000Z'), endDate: new Date('2027-04-02T00:00:00.000Z'), minGradeLevel: null, maxGradeLevel: null },
      { id: 'f0000000-0000-4000-8000-000000000004', academicYearId: 'a0000000-0000-4000-8000-00000000000a', name: 'Studiedagar v53', kind: 'HOLIDAY', startDate: new Date('2026-12-28T00:00:00.000Z'), endDate: new Date('2026-12-30T00:00:00.000Z'), minGradeLevel: null, maxGradeLevel: null },
    ],
    availabilityConstraint: [
      { id: 'f1000000-0000-4000-8000-000000000001', resourceType: 'STUDENT_GROUP', studentGroupId: 'b0000000-0000-4000-8000-000000000007', dayOfWeek: 5, date: null, startTime: new Date('1970-01-01T13:00:00.000Z'), endTime: new Date('1970-01-01T15:00:00.000Z'), type: 'UNAVAILABLE', reason: 'Elevens val', minGradeLevel: null, maxGradeLevel: null },
    ],
    frameTime: [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00.000Z'), endTime: new Date('1970-01-01T15:30:00.000Z') },
    ],
    localTimplan: [
      { id: 'f2000000-0000-4000-8000-000000000001', name: 'Utkast 2027', schoolForm: 'GRUNDSKOLA', status: 'DRAFT', decidedAt: null, createdAt: new Date('2027-02-01T00:00:00.000Z'), nationalVersion: { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' }, entries: [] },
    ],
    academicYearTimplan: [
      { schoolId: '33333333-3333-4333-8333-333333333333', academicYearId: 'a0000000-0000-4000-8000-00000000000a', gradeLevel: 7, localTimplanId: 'f2000000-0000-4000-8000-000000000001' },
      { schoolId: '33333333-3333-4333-8333-333333333333', academicYearId: 'a0000000-0000-4000-8000-00000000000a', gradeLevel: 8, localTimplanId: 'f2000000-0000-4000-8000-000000000001' },
      { schoolId: '33333333-3333-4333-8333-333333333333', academicYearId: 'a0000000-0000-4000-8000-00000000000a', gradeLevel: 9, localTimplanId: 'f2000000-0000-4000-8000-000000000001' },
    ],
    subject: [
      { id: 'e0000000-0000-4000-8000-0000000000aa', name: 'Matematik' },
      { id: 'e0000000-0000-4000-8000-0000000000bb', name: 'Svenska' },
      { id: 'e0000000-0000-4000-8000-0000000000cc', name: 'Teknik' },
    ],
    staffingPolicy: [],
    teacherSubjectQualification: [],
    masterLesson: [
      { academicYearId: 'a0000000-0000-4000-8000-00000000000a', isLocked: true },
      { academicYearId: 'a0000000-0000-4000-8000-00000000000a', isLocked: false },
    ],
    lunchSitting: [
      { academicYearId: 'a0000000-0000-4000-8000-00000000000a', isGenerated: false },
    ],
    teacherEmployment: [
      { academicYearId: 'a0000000-0000-4000-8000-00000000000a' },
    ],
    teacherDuty: [
      { academicYearId: 'a0000000-0000-4000-8000-00000000000a', blockedConstraintId: 'slot', kind: 'RASTVAKT' },
    ],
  };
}
