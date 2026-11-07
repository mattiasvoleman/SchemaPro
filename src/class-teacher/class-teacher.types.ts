/**
 * Klasslärarens schema: the words the gateway, the database and the web share.
 *
 * The frame's reasons are the database's own (app.class_teacher_frame answers
 * them), so there is one list, and the web translates each by its code. The
 * Swedish sentences here are what an API client without the web's strings gets.
 */

export const FRAME_REASONS = [
  'NOT_APPOINTED',
  'LESSON_GONE',
  'OTHER_CLASS',
  'HALF_CLASS',
  'PARKED',
  'JOINT_LESSON',
  'OTHER_TEACHER',
  'BLOCK',
  'SHARED_POST',
  'REPLACING_GROUP',
  'SHARED_TEACHER',
  'SHARED_ROOM',
  'TIME_CLOSED',
  'TARGET_CLOSED',
  'NOT_A_REGULAR_LESSON',
  'NOT_SCHEDULED',
  'PAST',
  'COVERED',
  'HAS_ATTENDANCE',
  'PENDING_TEMPLATE_CHANGE',
  'PENDING_OCCASION_CHANGE',
  'TARGET_MISSING',
  'WEEKEND',
  'ROOM_NOT_FOUND',
  'ROOM_NEEDS_APPROVAL',
  'SPLIT_MINUTES',
] as const;

export type FrameReason = (typeof FRAME_REASONS)[number];

export const FRAME_MESSAGES: Readonly<Record<FrameReason, string>> = {
  NOT_APPOINTED: 'Du är inte utsedd till klasslärare för den här klassen.',
  LESSON_GONE: 'Lektionen finns inte längre.',
  OTHER_CLASS: 'Lektionen tillhör en annan klass.',
  HALF_CLASS: 'Lektionen gäller en halvklass, eller klassen har halvklasser i ämnet. Den ändras av schemaläggaren.',
  PARKED: 'Lektionen är parkerad och har ingen tid att ändra.',
  JOINT_LESSON: 'Lektionen delas med andra klasser eller med elever från andra klasser.',
  OTHER_TEACHER: 'Lektionen har en annan lärare än du.',
  BLOCK: 'Lektionen ligger i ett block som läggs parallellt med andra lektioner.',
  SHARED_POST: 'Lektionens timplanspost delas mellan flera lärare.',
  REPLACING_GROUP: 'Elever i klassen går till en ersättande grupp i ämnet.',
  SHARED_TEACHER: 'Du delas med en annan skola, så dina tider bestäms av schemaläggaren.',
  SHARED_ROOM: 'Salen är utlånad till eller från en annan skola.',
  TIME_CLOSED: 'Tiden är inte öppen för klasslärarens ändringar.',
  TARGET_CLOSED: 'Den nya tiden ligger utanför de tider som är öppna för klasslärare.',
  NOT_A_REGULAR_LESSON: 'Lektionen är inte en vanlig lektion ur klassens schema.',
  NOT_SCHEDULED: 'Lektionen är redan inställd eller genomförd.',
  PAST: 'Tiden har redan börjat eller passerat.',
  COVERED: 'Lektionen har en vikarie och hanteras av vikarietavlan.',
  HAS_ATTENDANCE: 'Närvaro är redan registrerad på lektionen.',
  PENDING_TEMPLATE_CHANGE: 'En ändring av klassens mall väntar för den här lektionen. Publicera eller släng den först.',
  PENDING_OCCASION_CHANGE: 'Ett undantag för ett datum väntar för den här lektionen. Publicera eller släng det först.',
  TARGET_MISSING: 'Den nya tiden eller salen saknas.',
  WEEKEND: 'Lektioner läggs måndag till fredag.',
  ROOM_NOT_FOUND: 'Salen finns inte.',
  ROOM_NEEDS_APPROVAL: 'Salen kräver godkännande och bokas i stället av expeditionen.',
  SPLIT_MINUTES: 'Delarna ska vara minst 15 minuter var och tillsammans lika långa som lektionen.',
};

export const CHANGE_KINDS = ['OCCASION_MOVE', 'OCCASION_CANCEL', 'OCCASION_ROOM', 'TEMPLATE_MOVE', 'TEMPLATE_SPLIT'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const isOccasionKind = (kind: ChangeKind): boolean => kind.startsWith('OCCASION_');

/** The problem `code`s the routes answer with, one place so the web and the specs spell them alike. */
export const CODES = {
  /** 403: the change is outside the frame; `reason` says which part. */
  OUTSIDE_FRAME: 'CLASS_TEACHER_OUTSIDE_FRAME',
  /** 403: the caller is not klasslärare of the class. */
  NOT_APPOINTED: 'CLASS_TEACHER_NOT_APPOINTED',
  /** 409: the lesson changed since the klasslärare read it; `changed` or `current` says how. */
  STALE: 'CLASS_TEACHER_STALE',
  /** 409: a draft already waits for the lesson; `existing` is it. */
  DRAFT_EXISTS: 'CLASS_TEACHER_DRAFT_EXISTS',
  /** 409: the draft was changed by someone else; `current` is it as it stands. */
  REV: 'CLASS_TEACHER_REV',
  /** 409: the change meets a clash in the timetable; `conflicts` names them. */
  CONFLICT: 'CLASS_TEACHER_CONFLICT',
  /** 409: the administrator the appointment runs as is gone or no longer writes what the work needs. */
  APPOINTER_GONE: 'CLASS_TEACHER_APPOINTER_GONE',
  /** 403: the school has not let a klasslärare publish. */
  PUBLISH_OFF: 'CLASS_TEACHER_PUBLISH_OFF',
  /** 404: the lesson or the draft is not there. */
  GONE: 'CLASS_TEACHER_GONE',
  /** 400: the change asks for nothing. */
  NO_CHANGE: 'CLASS_TEACHER_NO_CHANGE',
} as const;

/** One field of a lesson that is not what it was. */
export interface FieldChange {
  field: string;
  was: unknown;
  now: unknown;
}

/** A clash, named by what clashes and with which lesson, never by a person. */
export interface ConflictView {
  kind: 'TEACHER' | 'ROOM' | 'GROUP' | 'AVAILABILITY' | 'BREAK' | 'BOOKING';
  other?: { className: string; subjectName: string; day?: number; date?: string; start: string; end: string };
}

export type Verdict =
  | { state: 'OK' }
  | { state: 'REFUSED'; reason: FrameReason }
  | { state: 'STALE'; changed: FieldChange[] }
  | { state: 'GONE' }
  | { state: 'CONFLICT'; conflicts: ConflictView[] };

/** A draft, as the klasslärare and the schemaläggare read it. Times are HH:MM, dates YYYY-MM-DD. */
export interface ChangeView {
  id: string;
  studentGroupId: string;
  kind: ChangeKind;
  status: 'DRAFT' | 'PUBLISHED';
  masterLessonId: string | null;
  calendarLessonId: string | null;
  date: string | null;
  targetDate: string | null;
  targetDayOfWeek: number | null;
  targetStart: string | null;
  targetEnd: string | null;
  targetRoomId: string | null;
  keepEnd: string | null;
  note: string | null;
  baseVersion: string;
  rev: number;
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** What publication did with each draft it was asked to publish. */
export interface PublishOutcome {
  id: string;
  outcome: 'PUBLISHED' | 'REFUSED' | 'STALE' | 'CONFLICT' | 'GONE' | 'FAILED';
  reason?: FrameReason;
  changed?: FieldChange[];
  conflicts?: ConflictView[];
}
