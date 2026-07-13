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

/** Presence roster for the timetable editor (soft edit-locks). */
export const TIMETABLE_PRESENCE_EVENT = 'timetable_presence';

export interface TimetablePeer {
  userId: string;
  /** Display label ("First L."), never an email. */
  label: string;
  /** Master lesson the peer currently has open in the editor, if any. */
  editingLessonId: string | null;
}
