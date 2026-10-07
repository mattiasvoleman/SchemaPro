/**
 * Every table a läsårsrullning could be expected to carry, and what it does
 * with each — decided once, in writing, and checked against the schema.
 *
 * WHY A REGISTRY. "Nytt läsår" is the feature that quietly forgets a table:
 * somebody adds a per-year table in March, nobody thinks of the rollover, and
 * in June the new year arrives without it — no error, just a school that has
 * to type it all in again, or worse, a year that looks complete and is not.
 * rollover-registry.spec.ts enumerates every model that points at a läsår or a
 * group (from prisma/schema.prisma, and every *YearId column from the
 * generated DMMF) and fails until each one has an entry here. A table added
 * later — timplan P2's AcademicYearTimplans, staffing Fas 5's rolled
 * employments — fails that test until somebody decides, and says why.
 *
 * DISPOSITIONS.
 *  - ROOT: AcademicYear itself, the row the rollover creates first.
 *  - PROMOTED / COPIED: written into the new year, column by column per
 *    `columns`, by the step named in `step` (rollover-apply.ts). The spec
 *    checks the columns against the DMMF, so a column added to a carried
 *    table fails until it has a rule here too.
 *  - AT_ACTIVATION: not written by the rollover at all; the activation of the
 *    new year moves it (User.studentGroupId).
 *  - SKIPPED: left behind, with the reason a schemaläggare would ask for.
 *    `previewCount` means the preview counts the rows left behind.
 *  - FOLLOWS: a child of a SKIPPED model, left behind with its parent.
 */

/** How one column of a carried row is filled. */
export type ColumnRule =
  /** A fresh id from the database default. */
  | 'NEW_ID'
  /** The source row's value, unchanged. */
  | 'COPY'
  /** The new year's id. */
  | 'TARGET_YEAR'
  /** The source group's successor (or intake twin) in the new year. */
  | 'MAP_GROUP'
  /** The source row's own id: the predecessor link. */
  | 'SOURCE_ID'
  /** The source grade + 1 (null stays null; CARRY and INTAKE keep it). */
  | 'PROMOTE_GRADE'
  /** promoteName(), or the admin's override (src/common/year-rollover.ts). */
  | 'PROMOTE_NAME'
  /** mapDate(): whole-week shift, anchored at the year's bounds. */
  | 'SHIFT_DATE'
  /** proposeBreak(), or the dates the admin typed. */
  | 'BREAK_DATE'
  /** The teacher, unless the rollover clears them (inactive, twice, REFUSE). */
  | 'KEEP_TEACHER'
  /** The request: the new year's name, dates and graduating grade. */
  | 'FROM_REQUEST'
  /** The column's default (timestamps, isActive false). */
  | 'DEFAULT';

/** The rollover's write steps, in the order they run. */
export type RolloverStepName =
  | 'year'
  | 'groups'
  | 'members'
  | 'requirements'
  | 'breaks'
  | 'classRules';

export const ROLLOVER_STEP_ORDER: readonly RolloverStepName[] = [
  'year',
  'groups',
  'members',
  'requirements',
  'breaks',
  'classRules',
];

export type Disposition =
  | { kind: 'ROOT'; columns: Record<string, ColumnRule>; step: 'year'; reason: string }
  | {
      kind: 'PROMOTED' | 'COPIED';
      columns: Record<string, ColumnRule>;
      step: RolloverStepName;
      reason: string;
    }
  | { kind: 'AT_ACTIVATION'; reason: string }
  | { kind: 'SKIPPED'; reason: string; previewCount?: true }
  | { kind: 'FOLLOWS'; parent: string; reason: string };

const timestamps = { createdAt: 'DEFAULT', updatedAt: 'DEFAULT' } as const;

export const ROLLOVER_REGISTRY: Readonly<Record<string, Disposition>> = {
  AcademicYear: {
    kind: 'ROOT',
    step: 'year',
    reason: 'The new läsår itself, linked to the source by predecessorId.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      name: 'FROM_REQUEST',
      startDate: 'FROM_REQUEST',
      endDate: 'FROM_REQUEST',
      isActive: 'DEFAULT',
      predecessorId: 'SOURCE_ID',
      graduatingGradeLevel: 'FROM_REQUEST',
      ...timestamps,
    },
  },

  StudentGroup: {
    kind: 'PROMOTED',
    step: 'groups',
    reason:
      'Classes move up a grade (7A becomes 8A) and keep a link to the group they continue; ' +
      'graduating and skipped groups get no successor, an INTAKE class opens beside its successor without one.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      academicYearId: 'TARGET_YEAR',
      name: 'PROMOTE_NAME',
      kind: 'COPY',
      gradeLevel: 'PROMOTE_GRADE',
      predecessorId: 'SOURCE_ID',
      ...timestamps,
    },
  },

  StudentGroupMember: {
    kind: 'COPIED',
    step: 'members',
    reason:
      'A carried teaching group keeps its active pupils, except those whose home class graduates or has no successor.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      studentGroupId: 'MAP_GROUP',
      studentId: 'COPY',
      createdAt: 'DEFAULT',
    },
  },

  TeachingRequirement: {
    kind: 'COPIED',
    step: 'requirements',
    reason:
      'Timplansposter follow their cohort: 7A’s rows become 8A’s, with the teacher kept where the staffing policy allows.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      academicYearId: 'TARGET_YEAR',
      subjectId: 'COPY',
      studentGroupId: 'MAP_GROUP',
      teacherId: 'KEEP_TEACHER',
      coTeacherId: 'KEEP_TEACHER',
      lessonsPerWeek: 'COPY',
      minutesPerLesson: 'COPY',
      minutesBefore: 'COPY',
      minutesAfter: 'COPY',
      teacherLoadPercent: 'COPY',
      coTeacherLoadPercent: 'COPY',
      recurrence: 'COPY',
      startDate: 'SHIFT_DATE',
      endDate: 'SHIFT_DATE',
      ...timestamps,
    },
  },

  SchoolBreak: {
    kind: 'COPIED',
    step: 'breaks',
    reason:
      'Lov are carried only when ticked, at proposed dates the admin can edit: jullov and påsklov do not follow week numbers.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      academicYearId: 'TARGET_YEAR',
      name: 'COPY',
      kind: 'COPY',
      startDate: 'BREAK_DATE',
      endDate: 'BREAK_DATE',
      minGradeLevel: 'COPY',
      maxGradeLevel: 'COPY',
      ...timestamps,
    },
  },

  AvailabilityConstraint: {
    kind: 'COPIED',
    step: 'classRules',
    reason:
      'Weekly class rules move to the successor group; dated rows belong to a day of the old year, ' +
      'and TEACHER, ROOM and GRADE_LEVEL rows carry no year at all.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      resourceType: 'COPY',
      userId: 'COPY',
      roomId: 'COPY',
      studentGroupId: 'MAP_GROUP',
      minGradeLevel: 'COPY',
      maxGradeLevel: 'COPY',
      dayOfWeek: 'COPY',
      date: 'COPY',
      startTime: 'COPY',
      endTime: 'COPY',
      type: 'COPY',
      reason: 'COPY',
      ...timestamps,
    },
  },

  User: {
    kind: 'AT_ACTIVATION',
    reason:
      'A pupil’s home class (studentGroupId) moves when the new year is activated, not at the rollover: the old year is still running.',
  },

  MasterLesson: {
    kind: 'SKIPPED',
    previewCount: true,
    reason:
      'A weekly schedule is generated for the new year’s groups and rooms; last year’s placements, locked ones included, are not a valid start.',
  },
  MasterLessonGroup: {
    kind: 'FOLLOWS',
    parent: 'MasterLesson',
    reason: 'The extra classes of a lesson that is not carried.',
  },
  MasterLessonStudent: {
    kind: 'FOLLOWS',
    parent: 'MasterLesson',
    reason: 'The named pupils of a lesson that is not carried.',
  },
  CalendarLesson: {
    kind: 'SKIPPED',
    reason: 'Dated lessons of the old year; the new year publishes its own calendar from its own schedule.',
  },
  CalendarLessonGroup: {
    kind: 'FOLLOWS',
    parent: 'CalendarLesson',
    reason: 'The extra classes of a dated lesson of the old year.',
  },
  CalendarLessonStudent: {
    kind: 'FOLLOWS',
    parent: 'CalendarLesson',
    reason: 'The named pupils of a dated lesson of the old year.',
  },
  CalendarLessonTeacher: {
    kind: 'FOLLOWS',
    parent: 'CalendarLesson',
    reason: 'The teacher assignments of a dated lesson of the old year.',
  },
  AttendanceRecord: {
    kind: 'FOLLOWS',
    parent: 'CalendarLesson',
    reason: 'Närvaro recorded on the old year’s lessons stays with them, as history.',
  },
  CalendarRast: {
    kind: 'SKIPPED',
    reason: 'Dated raster of the old year; the new year’s are placed when its calendar is published.',
  },
  CalendarLunch: {
    kind: 'SKIPPED',
    reason: 'Dated lunches of the old year; the new year’s are placed when its calendar is published.',
  },
  LunchSitting: {
    kind: 'SKIPPED',
    previewCount: true,
    reason:
      'Lunch sittings are placed against the new year’s schedule; hand-pinned sittings are counted so they can be pinned again.',
  },
  TeacherEmployment: {
    kind: 'SKIPPED',
    previewCount: true,
    reason: 'Tjänster are rolled by staffing Fas 5, which decides what a post carries into the next year.',
  },
  TeacherDuty: {
    kind: 'SKIPPED',
    previewCount: true,
    reason:
      'Uppdrag and their blocked slots are rolled by staffing Fas 5 (mentorskap through the group link); ' +
      'until then the new year has none, and the preview says how many slots that frees.',
  },
  ScheduleVersion: {
    kind: 'SKIPPED',
    reason: 'Saved snapshots of the old year’s schedule are its history, not a starting point.',
  },
  ScheduleChangeLog: {
    kind: 'SKIPPED',
    reason: 'The change log of the old year’s schedule is its history and stays with it.',
  },
  OptimizationJob: {
    kind: 'SKIPPED',
    reason: 'Generation runs of the old year are its history; the new year runs its own.',
  },
};

/** The models the rollover writes, with their step. */
export function carriedModels(): { model: string; step: RolloverStepName }[] {
  return Object.entries(ROLLOVER_REGISTRY).flatMap(([model, disposition]) =>
    disposition.kind === 'ROOT' || disposition.kind === 'PROMOTED' || disposition.kind === 'COPIED'
      ? [{ model, step: disposition.step }]
      : [],
  );
}

/** The SKIPPED and FOLLOWS entries, as the preview lists them. */
export function skippedModels(): { model: string; reason: string; counted: boolean }[] {
  return Object.entries(ROLLOVER_REGISTRY).flatMap(([model, disposition]) =>
    disposition.kind === 'SKIPPED'
      ? [{ model, reason: disposition.reason, counted: disposition.previewCount === true }]
      : disposition.kind === 'FOLLOWS'
        ? [{ model, reason: disposition.reason, counted: false }]
        : [],
  );
}
