/**
 * The fields a column of a school's file can be pointed at, per kind of import (Kolumnmappning, X2).
 *
 * THE CONTRACT BETWEEN THE GATEWAY AND THE WEB. A saved template names a field by its id, and the id must mean
 * the same on both sides: the web's catalogue (web/lib/column-fields.ts) writes them, this list refuses what is
 * not one. They are held equal by a shared fixture, `__fixtures__/import-fields.json`, which both sides read
 * (import-fields.spec.ts here, web/lib/column-fields.test.ts there), so a field added on one side and not the
 * other fails a test instead of a school's saved template.
 *
 * The ids are the importers' own. The eleven CSV kinds use the row field names of web/lib/csv.ts's mappers
 * (`firstName`, `groupName`, `lessonsPerWeek`); `timplan` the keys of its mapper (web/lib/timplan-csv.ts); and
 * `scheduleLessons` the columns of the flat timetable (src/schedule-exchange/lesson-table.ts), without the
 * columns Rastra's own export writes and a reader ignores (ids, length, period, locked). The two combined fields
 * of `scheduleLessons` are the mapping's own: `timeRange` is one cell holding start and end, `teacherList` one
 * cell holding the lead teacher and the co-teacher. The web splits them before anything is sent, and the file
 * that goes on to the gateway has the ordinary columns.
 *
 * The list of kinds is also the CHECK of "ImportMappingTemplates" (20270223090000); the spec reads the migration
 * and holds the two equal.
 */
export const IMPORT_TEMPLATE_FIELDS = {
  students: ['firstName', 'lastName', 'email', 'phone', 'className'],
  guardians: ['firstName', 'lastName', 'email', 'phone', 'studentEmail'],
  teachers: ['firstName', 'lastName', 'email', 'phone', 'employmentPercent', 'reductionPercent', 'contractKind', 'signature'],
  classes: ['name', 'gradeLevel', 'kind', 'halfOf', 'replacesSubject'],
  teachingGroups: ['groupName', 'email'],
  roomTypes: ['name'],
  rooms: ['name', 'code', 'roomType', 'capacity', 'minGradeLevel', 'maxGradeLevel', 'building', 'floor'],
  subjects: ['name', 'code', 'color', 'roomType', 'nationalCode', 'countsTowardTimplan'],
  requirements: [
    'groupName',
    'subject',
    'lessonsPerWeek',
    'minutesPerLesson',
    'lessonLengths',
    'minutesBefore',
    'minutesAfter',
    'teacherEmail',
    'teacherSignature',
    'coTeacherEmail',
    'coTeacherSignature',
    'teacherLoadPercent',
    'coTeacherLoadPercent',
    'recurrence',
    'startDate',
    'endDate',
  ],
  teacherQualifications: ['teacherEmail', 'subject', 'minGrade', 'maxGrade', 'kind'],
  teacherDuties: [
    'teacherEmail',
    'kind',
    'label',
    'minutesPerWeek',
    'countsAsTeaching',
    'subject',
    'groupName',
    'validFrom',
    'validTo',
    'note',
  ],
  timplan: ['subject', 'gradeLevel', 'minutesPerWeek', 'note'],
  scheduleLessons: [
    'group',
    'extraGroups',
    'subject',
    'subjectCode',
    'teacher',
    'teacherName',
    'teacherEmail',
    'coTeacher',
    'coTeacherName',
    'coTeacherEmail',
    'room',
    'day',
    'start',
    'end',
    'weeks',
    'from',
    'to',
    'block',
    'timeRange',
    'teacherList',
  ],
} as const satisfies Record<string, readonly string[]>;

export type ImportTemplateKind = keyof typeof IMPORT_TEMPLATE_FIELDS;

/** In the order of the migration's CHECK. */
export const IMPORT_TEMPLATE_KINDS = Object.keys(IMPORT_TEMPLATE_FIELDS) as ImportTemplateKind[];

/**
 * Pairs of fields a template may not place together, because the second of each would be read twice: a combined
 * field makes the columns it stands for, and a file that also has them says two things about one cell.
 */
export const IMPORT_TEMPLATE_CONFLICTS: Readonly<Partial<Record<ImportTemplateKind, readonly (readonly [string, string])[]>>> = {
  scheduleLessons: [
    ['timeRange', 'start'],
    ['timeRange', 'end'],
    ['teacherList', 'teacher'],
    ['teacherList', 'coTeacher'],
  ],
};

/** The most templates a school keeps per kind. A school has a handful of file layouts, not hundreds. */
export const IMPORT_TEMPLATE_LIMIT = 20;
