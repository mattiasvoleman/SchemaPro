import type { AdminProfile } from "@/lib/admin-areas";

/*
 * Krisläge's wire shapes (src/crisis/crisis-views.ts, crisis.controller.ts and
 * dto/crisis.dto.ts), as the gateway answers and takes them.
 *
 * Mirrored by hand, like lib/cover-request-types.ts, and TYPES ONLY: nothing
 * here costs a byte of JavaScript. The words a status is shown in, and the
 * rules about it, are lib/crisis-view.ts.
 *
 * A pupil's status is what the lists say, in one word: FOUND, MISSING and AWAY
 * are marks; ABSENT_BEFORE is "not marked, and absent before the alarm" (nobody
 * is asked to find them); UNREPORTED is "not marked, and expected: someone
 * still has to say". A mark overrules ABSENT_BEFORE.
 *
 * AWAY ("Inte i huset") is the administration's alone: a pupil nobody has seen
 * and who is not thought to be in the building. It is counted for itself, never
 * as found and never as missing, and a teacher who sends it is refused (400).
 */

export type CrisisKind = "EVACUATION" | "LOCKDOWN";
export type CrisisMode = "LIVE" | "DRILL";
/**
 * Why a pupil is on a group: the lesson going on, the lesson they are on their way to in a break, or no
 * lesson at all (NO_LESSON): the alarm's one group of every pupil who is on no lesson's list, answered for
 * by the administration. Its `groupName` and `subjectName` are Swedish stand-ins from the gateway; a page
 * says it in its own language (lib/crisis-view.ts groupLabel).
 */
export type CallBasis = "LESSON" | "NEXT_LESSON" | "NO_LESSON";
export type PupilStatus = "FOUND" | "MISSING" | "AWAY" | "ABSENT_BEFORE" | "UNREPORTED";
export type PriorSource = "ATTENDANCE" | "REPORTED";
/** What a pupil can be marked: the marks that become a status. */
export type PupilMark = "FOUND" | "MISSING" | "AWAY";
/** What a mark says. RETRACTED withdraws the sender's own "found with me" (the pupil is unmarked again); it is never a pupil's status. */
export type MarkState = PupilMark | "RETRACTED";

export interface CrisisSettings {
  startProfiles: AdminProfile[];
  notifyGuardiansAfter: boolean;
}

export interface PupilCounts {
  pupils: number;
  found: number;
  missing: number;
  /** Marked not in the building by the administration: its own count, never added to `found`. */
  away: number;
  absentBefore: number;
  unreported: number;
}

export interface PupilView {
  studentId: string;
  firstName: string;
  lastName: string;
  status: PupilStatus;
  priorAbsentSource: PriorSource | null;
  /** When the latest mark was made, by the sender's clock. */
  markedAt: string | null;
  /** Who made it (the administration's view only). */
  markedBy: string | null;
}

export interface TeacherView {
  userId: string | null;
  name: string | null;
  role: "LEAD" | "ASSISTANT" | "SUBSTITUTE";
  /** Their first mark on the call. */
  answeredAt: string | null;
}

export interface CallView {
  id: string;
  lessonId: string | null;
  basis: CallBasis;
  groupName: string;
  subjectName: string;
  roomName: string | null;
  lessonStartsAt: string;
  lessonEndsAt: string;
  completedAt: string | null;
  /** Nobody is on the call to answer for it: the administration marks the group. */
  uncovered: boolean;
  teachers: TeacherView[];
  counts: PupilCounts;
  pupils: PupilView[];
}

export interface AlarmView {
  id: string;
  kind: CrisisKind;
  mode: CrisisMode;
  startedAt: string;
  startedBy: string | null;
  endedAt: string | null;
  endedBy: string | null;
  autoEnded: boolean;
  endNote: string | null;
  guardiansNotifiedAt: string | null;
}

export interface AlarmSummary extends AlarmView {
  /** Pupils on the NO_LESSON group; they are in `counts` like all the others. */
  unlisted: number;
  calls: number;
  /** Calls that are complete, or have nobody to ask. */
  callsComplete: number;
  counts: PupilCounts;
  teachers: number;
  teachersAnswered: number;
}

export interface AlarmDetail {
  alarm: AlarmSummary;
  calls: CallView[];
}

/** A pupil a teacher on the call found who is on another list (or none): "found with me". */
export interface FoundHereView {
  studentId: string;
  firstName: string;
  lastName: string;
  /** The pupil's own class, so that two of the same name can be told apart. */
  className: string | null;
  /** When the teacher marked them, by the sender's clock. */
  markedAt: string;
}

/**
 * A pupil of the school who is on none of a teacher's lists, as the search for "found with me" answers
 * (POST /crisis/mine/pupils). Held nowhere: not in the list the teacher is given, not on the device.
 */
export interface OtherPupilView {
  studentId: string;
  firstName: string;
  lastName: string;
  className: string | null;
}

/** A teacher's group, as the page shows it and keeps it offline. */
export interface MyCall {
  id: string;
  lessonId: string | null;
  basis: CallBasis;
  groupName: string;
  subjectName: string;
  roomName: string | null;
  lessonStartsAt: string;
  lessonEndsAt: string;
  completedAt: string | null;
  /** The colleagues who answer for the group beside the teacher. */
  colleagues: string[];
  counts: PupilCounts;
  pupils: PupilView[];
  /** Pupils not on this list whom a teacher on the call found; they count on the pupil's own list, not here. */
  foundHere: FoundHereView[];
}

export interface MyAlarm extends AlarmView {
  calls: MyCall[];
  /**
   * Pupils this teacher found who are on none of their lists and were found with no group: a teacher with no
   * group right now can say they found a pupil too (a mark sent with `alarmId` in place of `callId`).
   */
  foundFree: FoundHereView[];
}

export interface MyCrisisResponse {
  /** The moment the gateway answered; a page holding the list offline shows how old it is. */
  asOf: string;
  alarms: MyAlarm[];
}

export interface ProtocolMark {
  at: string;
  receivedAt: string;
  studentId: string;
  /** The pupil's own group. */
  groupName: string;
  /** The group of the teacher who found them, when that is not the pupil's own ("found with me"). */
  foundIn: { groupName: string; basis: CallBasis } | null;
  /** FOUND, MISSING and AWAY are what was said; RETRACTED is a teacher taking back a find. */
  state: MarkState;
  by: string | null;
  onBehalf: boolean;
  late: boolean;
}

export interface ProtocolView extends AlarmDetail {
  marks: ProtocolMark[];
}

/**
 * One mark as the gateway takes it (MarkDto): the client's own uuid v4 id, so sending it twice stores it once.
 * Exactly one of `callId` (the group), `lessonId` (a phone's own list) and `alarmId` (a teacher with no group:
 * "found"); this page sends the first and the last.
 */
export interface MarkInput {
  id: string;
  callId?: string;
  alarmId?: string;
  studentId: string;
  state: MarkState;
  /** When the mark was made, by the sender's clock. */
  at: string;
}

/** A pupil's name and class, as a pupil picked in the search has them. */
export interface PupilName {
  firstName: string;
  lastName: string;
  className: string | null;
}

/**
 * A mark as the page keeps it until the gateway has taken it. A pupil found who is on no list of the teacher's
 * carries their name and class, so that the row can be drawn at once, offline, with no roster held. It is never
 * sent (the gateway refuses what it does not know), and goes with the mark when the mark is sent.
 */
export interface QueuedMark extends MarkInput {
  pupil?: PupilName;
}

/** What a mark call answers (MarkResult): `unresolved` are marks that belong to no alarm of the caller's. */
export interface MarkResult {
  stored: number;
  duplicates: number;
  unresolved: string[];
}

export interface StartAlarmInput {
  kind: CrisisKind;
  mode: CrisisMode;
}
