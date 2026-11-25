/**
 * Wire contract for the realtime gateway. This mirrors the payload the mobile
 * client already consumes (`mobile/src/types` — `CalendarLessonUpdatedPayload`),
 * so the server must not change shape without updating the app.
 *
 * PII note: `studentIds` are opaque UUIDs and the names are school-catalog
 * labels (subject/room), not personal data.
 */
export interface RealtimeLesson {
  id: string;
  /** ISO 8601 instants. */
  startTime: string;
  endTime: string;
  subjectName: string;
  roomName: string;
  studentIds: string[];
  /** Present so web/mobile can render cancellations without a refetch. */
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
}

export interface CalendarLessonUpdatedPayload {
  lessonId: string;
  updatedLesson: RealtimeLesson;
}

export const LESSON_UPDATED_EVENT = 'calendar_lesson_updated';

/** Master timetable changed — collaborating admin clients refetch. */
export const MASTER_TIMETABLE_UPDATED_EVENT = 'master_timetable_updated';

/**
 * What the master timetable event carries: when, and for a change of a few lessons which ones.
 *
 * `lessonIds` are the master lessons the change created, changed or removed, as opaque UUIDs and nothing else: not what
 * changed in them, and not a row. The row is the client's to read, under its own row-level security, so the event gives a
 * socket nothing it could not read. Absent, the change is not a few lessons (a regeneration, an import, a restore, a
 * room optimisation) or is not known to be, and the client reads the year again, as it did before the ids existed. A
 * client from before them ignores the field. Over `MASTER_TIMETABLE_IDS_MAX` the field is left out as well: a list that
 * long is not cheaper to read than the year.
 */
export interface MasterTimetableUpdatedPayload {
  changedAt: string;
  lessonIds?: string[];
}
export const MASTER_TIMETABLE_IDS_MAX = 200;

/** Presence roster for the timetable editor (soft edit-locks). */
export const TIMETABLE_PRESENCE_EVENT = 'timetable_presence';

export interface TimetablePeer {
  userId: string;
  /** Display label ("First L."), never an email. */
  label: string;
  /** Master lesson the peer currently has open in the editor, if any. */
  editingLessonId: string | null;
}

/**
 * The cover board changed for a span of days (Vikarieplanering): to the
 * school's admins only, and dates only — no lesson, no person, no reason.
 * The board refetches when the span overlaps the days it shows.
 */
export const COVER_BOARD_UPDATED_EVENT = 'cover_board_updated';

export interface CoverBoardUpdatedPayload {
  /** YYYY-MM-DD, school-local, inclusive. */
  from: string;
  to: string;
  changedAt: string;
}

/**
 * An alarm of Krisläge changed: started or ended (to the staff room, which the
 * phones listen to), or marked (to the school's admins, whose live view
 * refetches). The payload is the alarm's id and a time. It names no pupil,
 * group, place or teacher, and not even what changed: whoever hears it asks
 * the gateway, which answers each by their own row-level security.
 */
export const CRISIS_UPDATED_EVENT = 'crisis_updated';

export interface CrisisUpdatedPayload {
  alarmId: string;
  changedAt: string;
}
