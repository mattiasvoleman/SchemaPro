import type { BatchLesson, BatchScope } from "@/lib/publication-types";

/**
 * Schemabrytande aktivitet: a MIRROR of what the gateway answers
 * (src/publication/schedule-activities.service.ts, schedule-activities.controller.ts
 * and dto/schedule-activity.dto.ts), written by hand as the other mirrors are.
 *
 * Kept apart from lib/publication-types.ts and lib/types.ts so that only
 * /admin/activities carries it. The avbokning's own types (BatchScope,
 * BatchLesson) are reused as types only: nothing here is code.
 */

export type ActivityTeacherRole = "LEAD" | "ASSISTANT";

/** A teacher responsible for a class or group during the activity (ActivityTeacherDto). */
export interface ActivityTeacher {
  studentGroupId: string;
  teacherId: string;
  role: ActivityTeacherRole;
}

/** The minutes each day gives a subject (ActivityCreditDto): 1–600, one line per subject. */
export interface ActivityCreditLine {
  subjectId: string;
  minutes: number;
}

/**
 * POST /schedule-activities/preview and POST /:id/preview
 * (ScheduleActivitySelectionDto). The gateway refuses a field it does not
 * know (forbidNonWhitelisted), so a preview carries no digest and no notify.
 */
export interface ActivitySelection {
  academicYearId: string;
  name: string;
  fromDate: string;
  toDate: string;
  startTime?: string;
  endTime?: string;
  scope: BatchScope;
  minGradeLevel?: number;
  maxGradeLevel?: number;
  groupIds?: string[];
  /** A subject that does not count toward the timplan. */
  replacementSubjectId: string;
  description?: string;
  teachers?: ActivityTeacher[];
  credits?: ActivityCreditLine[];
}

/** POST /schedule-activities and PATCH /:id (CreateScheduleActivityDto, UpdateScheduleActivityDto). */
export interface ActivityInput extends ActivitySelection {
  /** The preview's digest: a plan that moved since answers 409 CANCELLATION_STALE. */
  expectedDigest?: string;
  /** One notice per person the activity touches. The gateway's default is true. */
  notify?: boolean;
}

/** A class or group with a replacement lesson, and who is responsible for it (ActivityClassView). */
export interface ActivityClass {
  groupId: string;
  name: string;
  teachers: Array<{ teacherId: string; role: ActivityTeacherRole }>;
  /** Days it has a replacement lesson. */
  days: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface ActivityTeacherClash {
  teacherId: string;
  date: string;
  /** The class the teacher is responsible for that day. */
  groupName: string;
  /** The class whose lesson still stands in the time. */
  busyWith: string;
}

export interface ActivityWarnings {
  /** Classes with a replacement lesson and nobody responsible: the lesson counts as teacherless. */
  classesWithoutTeacher: string[];
  /** Lessons that go on for pupils of the activity's classes. */
  continuing: Array<{ name: string; lessons: number }>;
  /** Pupils on a cancelled lesson whom no class of the activity holds. */
  uncoveredPupils: number;
  /** At most 20. */
  teacherClashes: ActivityTeacherClash[];
}

/** POST /schedule-activities/preview and /:id/preview (ActivityPreview). */
export interface ActivityPreview {
  /** Lessons the activity cancels; on a change, those it holds after it. */
  matched: number;
  /** The first 50, in time order. */
  lessons: BatchLesson[];
  excluded: { started: number; notScheduled: number; attendance: number };
  ungradedGroups: string[];
  /** Groups beyond the named ones that the cancellation takes: halves and groups wholly inside the named classes. */
  expandedGroups: Array<{ id: string; name: string }>;
  classes: ActivityClass[];
  replacementLessons: number;
  warnings: ActivityWarnings;
  /** Dates a credit would be written for (whole days ahead of today only). */
  creditDates: string[];
  digest: string;
  /** Who a notice would reach: the lessons the activity newly takes. */
  audience: { pupils: number; guardians: number; teachers: number };
  /** Only on a change: what it puts back and what it takes. */
  change?: { released: number; taken: number };
}

/** GET /schedule-activities?academicYearId= (ScheduleActivityView). */
export interface ScheduleActivity {
  id: string;
  academicYearId: string;
  batchId: string;
  name: string;
  description: string | null;
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
  scope: BatchScope;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  /** The classes and groups the administrator named (GROUPS). */
  scopeGroupIds: string[];
  replacementSubject: { id: string; name: string; countsTowardTimplan: boolean } | null;
  cancelled: number;
  replacementLessons: number;
  /** How many credit rows it wrote (a day × a subject × a target). */
  credits: number;
  /** What each named subject is credited per day: the lines a change sends again. */
  creditLines: Array<{ subjectId: string; minutes: number }>;
  teachers: ActivityTeacher[];
  notifies: boolean;
  createdAt: string;
  createdByUserId: string | null;
  removedAt: string | null;
  reinstated: number;
  /** The subject counts toward the timplan now: the day's minutes would be counted twice. */
  doubleCounts: boolean;
  /** Ordinary lessons that have come into its days since it was made or last applied and that it has not cancelled; 0 once removed. */
  addedSince: number;
}

/** POST /schedule-activities. */
export interface ActivityCreated {
  activity: ScheduleActivity;
  cancelled: number;
  replacementLessons: number;
  credits: number;
}

/** PATCH /schedule-activities/:id. */
export interface ActivityChanged {
  activity: ScheduleActivity;
  released: number;
  taken: number;
}

/** POST /schedule-activities/:id/reapply: `added` is how many lessons it cancelled just now. */
export interface ActivityReapplied {
  activity: ScheduleActivity;
  added: number;
}

/** POST /schedule-activities/:id/remove/preview and /remove (RemovePreview). */
export interface ActivityRemovePreview {
  /** Lessons that come back. */
  reinstate: number;
  /** People the removal's notice reaches; 0 for an activity that told nobody. */
  notify: number;
  replacementsDeleted: number;
  /** Replacement lessons that have begun or carry attendance: kept, with the lessons they replaced. */
  replacementsKept: number;
  creditsDeleted: number;
  skippedRoomTaken: Array<{ lessonId: string; date: string; roomId: string; by: "LESSON" | "BOOKING" }>;
  removedTemplateMoved: Array<{ lessonId: string; date: string }>;
  /** Lessons the grundschema moved since the activity, carried to their new time that week and lessons again. Absent from a gateway older than the change. */
  relocated?: Array<{ lessonId: string; from: string; to: string }>;
  notReinstatable: number;
}
