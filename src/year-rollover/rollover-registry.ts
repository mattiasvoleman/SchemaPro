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
 * later fails that test until somebody decides, and says why — as timplan
 * P2's AcademicYearTimplans did until it got its entry below (carried by
 * cohort), and as staffing Fas 5's tjänster and uppdrag did (carried when the
 * admin asks for them).
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
 *
 * OPTIONAL CARRIES. A PROMOTED or COPIED entry with an `option` is written
 * only when the request turns that option on; with it off the entry is left
 * behind exactly as its `whenOff` says — the reason and the preview count a
 * SKIPPED entry would have — so carriedModels() and skippedModels() take the
 * request's options. Today only staffing Fas 5's `carryStaffing` is one: a
 * rollover without it lists TeacherEmployment and TeacherDuty as skipped, in
 * the words it always has.
 *
 * SECOND WRITERS. A table one step copies may also be written by another
 * step, with other rows and other rules: an uppdrag's blocked slot is an
 * AvailabilityConstraints row the `duties` step writes, beside the class
 * rules the `classRules` step copies. `alsoWrittenBy` names that step, which
 * rows, and their column rules, held to the DMMF like the entry's own.
 */

/** How one column of a carried row is filled. */
export type ColumnRule =
  /** A fresh id from the database default. */
  | 'NEW_ID'
  /** The source row's value, unchanged. */
  | 'COPY'
  /**
   * The source row's value, unchanged — written only when it is not the
   * column's default, and otherwise left to that default. For a column added
   * with a default every existing row holds (TeachingRequirement.lessonLengths,
   * '{}' on every uniform row): naming it in every write would change the SQL,
   * and the planHash over the writes, of a school that never uses it.
   */
  | 'COPY_UNLESS_DEFAULT'
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
  /**
   * A grade of the new year's timplan per årskurs: the grade above a source
   * row whose class moves up (g−1 → g), or a grade the source attaches. See
   * rollover-timplans.ts.
   */
  | 'COHORT_GRADE'
  /**
   * The plan that grade follows: the source row's for g−1 when a class moves
   * up from g−1, kept whatever its status; otherwise the newest DECIDED plan
   * that speaks for the grade, of the form of the grade's own source row and
   * of the lydelse the cohort entering the grade started under, or that own
   * row's plan when no decided plan does.
   */
  | 'COHORT_PLAN'
  /** The column's default (timestamps, isActive false). */
  | 'DEFAULT'
  /**
   * An uppdrag's label with every whole-token occurrence of its group's name
   * replaced by the successor's ("Mentor 7B" → "Mentor 8B"); the source label
   * when the group has no successor or the result would pass 80 characters.
   * See rollover-staffing.ts.
   */
  | 'PROMOTE_LABEL'
  /**
   * The uppdrag's group's successor through StudentGroup.predecessorId (never
   * an INTAKE twin), or null when it has none.
   */
  | 'FOLLOW_GROUP'
  /**
   * A NEW constraint holding the uppdrag's blocked time in the new year, made
   * by dutySlotConstraintData; null when the source has no slot or its slot is
   * off the solver's grid. The source's own constraint stays with its year.
   */
  | 'NEW_SLOT'
  /** DUTY_SLOT_REASON, the bare word a colleague may read; never the source row's reason. */
  | 'DUTY_SLOT_REASON'
  /**
   * Always null in a carried row, because of which rows are carried: a weekly
   * STUDENT_GROUP class rule has no user, no room and no date. Written as
   * null rather than "copied" so the write audit can tell a column the copy
   * forgot from one it never has a value for.
   */
  | 'NULL';

/** The rollover's write steps, in the order they run. */
export type RolloverStepName =
  | 'year'
  | 'groups'
  | 'members'
  | 'requirements'
  | 'breaks'
  | 'classRules'
  | 'timplans'
  | 'employments'
  | 'duties';

export const ROLLOVER_STEP_ORDER: readonly RolloverStepName[] = [
  'year',
  'groups',
  'members',
  'requirements',
  'breaks',
  'classRules',
  'timplans',
  'employments',
  'duties',
];

/** The request switches an entry's carry can depend on. */
export type RolloverOption = 'carryStaffing';
export type RolloverOptions = Partial<Record<RolloverOption, boolean>>;

/** Another step that writes rows of the same table, with its own rules. */
export interface SecondWriter {
  step: RolloverStepName;
  rows: string;
  columns: Record<string, ColumnRule>;
}

export type Disposition =
  | { kind: 'ROOT'; columns: Record<string, ColumnRule>; step: 'year'; reason: string }
  | {
      kind: 'PROMOTED' | 'COPIED';
      columns: Record<string, ColumnRule>;
      step: RolloverStepName;
      reason: string;
      /** Carried only when the request turns this on. */
      option?: RolloverOption;
      /** What the entry is with its option off: a SKIPPED entry's reason and count. */
      whenOff?: { reason: string; previewCount: true };
      alsoWrittenBy?: SecondWriter[];
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
      lessonLengths: 'COPY_UNLESS_DEFAULT',
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
      'and TEACHER, ROOM and GRADE_LEVEL rows carry no year at all. TEACHER rows are written only as uppdrag ' +
      'slots, by the duties step; a teacher’s own rows have no year and are never written.',
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      resourceType: 'COPY',
      userId: 'NULL',
      roomId: 'NULL',
      studentGroupId: 'MAP_GROUP',
      minGradeLevel: 'COPY',
      maxGradeLevel: 'COPY',
      dayOfWeek: 'COPY',
      date: 'NULL',
      startTime: 'COPY',
      endTime: 'COPY',
      type: 'COPY',
      reason: 'COPY',
      ...timestamps,
    },
    alsoWrittenBy: [
      {
        step: 'duties',
        rows: "resourceType = 'TEACHER': a carried uppdrag's slot, a new row for the duty's teacher",
        columns: {
          id: 'NEW_ID',
          schoolId: 'COPY',
          resourceType: 'COPY',
          userId: 'COPY',
          roomId: 'NULL',
          studentGroupId: 'NULL',
          minGradeLevel: 'NULL',
          maxGradeLevel: 'NULL',
          dayOfWeek: 'COPY',
          date: 'NULL',
          startTime: 'COPY',
          endTime: 'COPY',
          type: 'COPY',
          reason: 'DUTY_SLOT_REASON',
          ...timestamps,
        },
      },
    ],
  },

  AcademicYearTimplan: {
    kind: 'PROMOTED',
    step: 'timplans',
    reason:
      'Timplan per årskurs follows the cohort: next year’s åk g follows the plan this year’s åk g−1 follows when a class ' +
      'moves up from it, a draft included; a grade no class moves into takes the newest decided plan that speaks for it, ' +
      'as a new läsår does, or keeps its own plan when no decided plan does.',
    columns: {
      schoolId: 'COPY',
      academicYearId: 'TARGET_YEAR',
      gradeLevel: 'COHORT_GRADE',
      localTimplanId: 'COHORT_PLAN',
      ...timestamps,
    },
  },

  User: {
    kind: 'AT_ACTIVATION',
    reason:
      'A pupil’s home class (studentGroupId) moves when the new year is activated, not at the rollover: the old year is still running.',
  },

  /**
   * Who sat in which class (timplan P4). The rollover writes no history and
   * moves no pupil; the activation's moves are what the Users trigger
   * records, in the activation's own transaction (migration 20261010120000),
   * and the old year's segments stay with the old year as its record.
   */
  StudentEnrollment: {
    kind: 'AT_ACTIVATION',
    reason:
      'A pupil’s class history is written by the database when the activation moves them; the rollover writes none, and the old year’s history stays with it.',
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
    kind: 'COPIED',
    step: 'employments',
    option: 'carryStaffing',
    reason:
      'Tjänster carry into the next year when the admin asks for them ("Ta med tjänster och uppdrag"): ' +
      'an active TEACHER or SCHOOL_ADMIN keeps percent, nedsättning, contract, target and signature, ' +
      'and the preview names every nedsättning and target override, which are often agreed for one year.',
    whenOff: {
      reason: 'Tjänster are rolled by staffing Fas 5, which decides what a post carries into the next year.',
      previewCount: true,
    },
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      userId: 'COPY',
      academicYearId: 'TARGET_YEAR',
      employmentPercent: 'COPY',
      reductionPercent: 'COPY',
      contractKind: 'COPY',
      teachingTargetMinutesPerWeek: 'COPY',
      signature: 'COPY',
      note: 'COPY',
      ...timestamps,
    },
  },
  TeacherDuty: {
    kind: 'COPIED',
    step: 'duties',
    option: 'carryStaffing',
    reason:
      'Uppdrag carry with the tjänster: a mentorskap follows its class to the successor ("Mentor 7B" becomes ' +
      '"Mentor 8B") and is left behind with a class that graduates or ends; another uppdrag of such a class is ' +
      'carried without it; a blocked slot becomes a new slot of the new year.',
    whenOff: {
      reason:
        'Uppdrag and their blocked slots are rolled by staffing Fas 5 (mentorskap through the group link); ' +
        'until then the new year has none, and the preview says how many slots that frees.',
      previewCount: true,
    },
    columns: {
      id: 'NEW_ID',
      schoolId: 'COPY',
      userId: 'COPY',
      academicYearId: 'TARGET_YEAR',
      kind: 'COPY',
      label: 'PROMOTE_LABEL',
      minutesPerWeek: 'COPY',
      countsAsTeaching: 'COPY',
      subjectId: 'COPY',
      studentGroupId: 'FOLLOW_GROUP',
      blockedConstraintId: 'NEW_SLOT',
      note: 'COPY',
      ...timestamps,
    },
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
  /**
   * Not carried, and not counted in the preview. A credit is the school's
   * decision about ONE date of the old year ("the friluftsdag 25 September
   * counts as 300 min idrott"); next year's friluftsdagar fall on other dates
   * and are decided again. Carrying one to a guessed date would credit
   * minutes for a day that may hold no friluftsdag at all — overstating the
   * delivered time, which is the very figure Skolinspektionen checks. The lov
   * that carry are where the breaks page offers "Räkna tid för dagen" again.
   */
  TimplanCredit: {
    kind: 'SKIPPED',
    reason:
      'A credit is the school’s decision about one date of the old year; next year’s friluftsdagar have their own dates and are decided again.',
  },
  /**
   * Not carried, and not counted. The history of a post (staffing Fas 3) is a
   * record of what the old year's tjänst WAS, version by version, cited by
   * that year's samverkan protokoll; copied into the new year it would claim
   * changes nobody made there. A post carried with `carryStaffing` starts the
   * new year's history itself — the trigger logs it as created, by the admin
   * who ran the rollover.
   */
  TeacherEmploymentLog: {
    kind: 'SKIPPED',
    reason:
      'The history of the old year’s tjänster is that year’s record; a carried tjänst starts the new year’s history as created.',
  },
  /**
   * Not carried, and not counted. The school's published "Undervisningstid"
   * (timplan P4) is a snapshot computed for the year that was active; the card
   * stops showing it once another year is activated, and the new year's is
   * published again from the new year's figures.
   */
  TimplanStatementPublication: {
    kind: 'SKIPPED',
    reason:
      'The pupils’ published undervisningstid is a snapshot of the old year; the new year’s is published again from its own figures.',
  },
  TimplanStatement: {
    kind: 'FOLLOWS',
    parent: 'TimplanStatementPublication',
    reason: 'The rows of a statement that is not carried.',
  },
  /**
   * Publicering (20261011090000): a publication says which grundschema was
   * valid over which dates of ITS year. The new year has published nothing
   * yet; its first publication starts its own timeline.
   */
  TimetablePublication: {
    kind: 'SKIPPED',
    reason: 'The old year’s publications and their validity stay with it; the new year is published on its own.',
  },
  PublishedLesson: {
    kind: 'FOLLOWS',
    parent: 'TimetablePublication',
    reason: 'The lessons a publication of the old year published.',
  },
  PublishedLunchSitting: {
    kind: 'FOLLOWS',
    parent: 'TimetablePublication',
    reason: 'The meals a publication of the old year published (20261011130000).',
  },
  /**
   * Bulk avbokning (20261011110000): a batch is a decision about dates of
   * ITS year — prao in week 12 — and its rows are that year's lessons.
   */
  CancellationBatch: {
    kind: 'SKIPPED',
    reason: 'A bulk avbokning cancelled dates of the old year; the new year has its own.',
  },
  CancellationBatchLesson: {
    kind: 'FOLLOWS',
    parent: 'CancellationBatch',
    reason: 'The lessons a batch of the old year cancelled.',
  },
  CancellationBatchCredit: {
    kind: 'FOLLOWS',
    parent: 'CancellationBatch',
    reason: 'The credits a batch of the old year handed off.',
  },
  /**
   * The public viewer (20261011120000): a share link names a class or a
   * year's index of classes, so it is the old year's; the new year's classes
   * are shared again, by links of their own.
   */
  PublicTimetableLink: {
    kind: 'SKIPPED',
    reason: 'A share link of the old year names its classes; the new year is shared with links of its own.',
  },
  PublicationPendingRemoval: {
    kind: 'FOLLOWS',
    parent: 'CalendarLesson',
    reason: 'A dated lesson of the old year whose template a draft deleted; it stays with its lesson.',
  },
};

const isOn = (disposition: Disposition, options: RolloverOptions): boolean =>
  !('option' in disposition) || disposition.option === undefined || options[disposition.option] === true;

/** The models the rollover writes with these options, with their step. */
export function carriedModels(options: RolloverOptions = {}): { model: string; step: RolloverStepName }[] {
  return Object.entries(ROLLOVER_REGISTRY).flatMap(([model, disposition]) =>
    (disposition.kind === 'ROOT' || disposition.kind === 'PROMOTED' || disposition.kind === 'COPIED') &&
    isOn(disposition, options)
      ? [{ model, step: disposition.step }]
      : [],
  );
}

/**
 * The SKIPPED and FOLLOWS entries, as the preview lists them — and, with its
 * option off, an optional carry as its `whenOff` describes it, in its place.
 */
export function skippedModels(options: RolloverOptions = {}): { model: string; reason: string; counted: boolean }[] {
  return Object.entries(ROLLOVER_REGISTRY).flatMap(([model, disposition]) => {
    if (disposition.kind === 'SKIPPED') {
      return [{ model, reason: disposition.reason, counted: disposition.previewCount === true }];
    }
    if (disposition.kind === 'FOLLOWS') return [{ model, reason: disposition.reason, counted: false }];
    if ((disposition.kind === 'PROMOTED' || disposition.kind === 'COPIED') && !isOn(disposition, options)) {
      return disposition.whenOff
        ? [{ model, reason: disposition.whenOff.reason, counted: disposition.whenOff.previewCount === true }]
        : [];
    }
    return [];
  });
}
