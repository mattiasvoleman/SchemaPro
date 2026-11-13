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
  'YEAR_ENDED',
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
  YEAR_ENDED: 'Läsåret är slut. Klassens schema från det läsåret ändras inte längre.',
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

/**
 * A refusal of the gateway's own, which the database's frame does not know: the lesson was written by Generera from a förläggning on
 * its timplanspost (MasterLessons.fromPlacement), and the editor refuses to move or change it (LESSON_IS_PLACED, 409,
 * MasterLessonsService.assertPlacedLessonStands) since the next Generera writes it again from the förläggning. A klasslärare's draft of
 * the template for such a lesson can never be published, so it is said so before it is written, listed and judged, and not as
 * "krockar i schemat" with nothing to point at (review of #293, LÅG-2 and the follow-up that named it). Kept apart from FRAME_REASONS,
 * which the web mirrors one for one (web/lib/class-teacher.contract.test.ts): a reason the web does not know is said there as
 * "the lesson cannot be changed by the class teacher", which is true, until the web has its own sentence for this one.
 */
export const LESSON_IS_PLACED_REASON = 'LESSON_IS_PLACED' as const;

export const LESSON_IS_PLACED_MESSAGE =
  'Lektionen är förlagd på timplanen och skrivs om därifrån vid varje Generera. Den ändras av schemaläggaren, på timplansposten.';

/** Why a lesson is not the class teacher's to change: the frame's reasons, and the one the gateway adds. */
export type RefusalReason = FrameReason | typeof LESSON_IS_PLACED_REASON;

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

/**
 * A clash, named by what clashes and with which lesson, never by a person.
 *
 * The first six are the clash rule's and a date's own (a lov, an approved
 * booking). FRAME, LUNCH and GRADE_RULE are the board's hard rules, the ones
 * G1's swap search holds a landing to (src/swaps/board-rules.ts): the stage's
 * ramtid, the class's meal, a closure on whole årskurser; they name no lesson.
 * EXCEPTION is a published change of one date that a change of the template
 * would carry to a third day (see ClassTeacherEngine.exceptionsOf); `other` is
 * that date's lesson.
 */
export interface ConflictView {
  kind: 'TEACHER' | 'ROOM' | 'GROUP' | 'AVAILABILITY' | 'BREAK' | 'BOOKING' | 'FRAME' | 'LUNCH' | 'GRADE_RULE' | 'EXCEPTION';
  other?: { className: string; subjectName: string; day?: number; date?: string; start: string; end: string };
}

/**
 * What publishing a change of the template takes out of the published
 * calendar: a lesson that the change would carry to a time that has begun, or
 * past the template's own end, is removed and not moved
 * (propagateTemplateChange), with the lesson log and the homework on it.
 * Said before the change is published, as the swap dialog says it.
 */
export interface RemovalView {
  /** Future dated lessons of the template that the change removes. */
  lessons: number;
  /** Of those, the ones a teacher has written a log, a homework or a note to a vikarie on. */
  withLog: number;
}

export type Verdict =
  | { state: 'OK'; removes?: RemovalView }
  | { state: 'REFUSED'; reason: RefusalReason }
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
  reason?: RefusalReason;
  changed?: FieldChange[];
  conflicts?: ConflictView[];
}
