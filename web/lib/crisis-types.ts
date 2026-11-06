import type { AdminProfile } from "@/lib/admin-areas";

/*
 * Krisläge's wire shapes (src/crisis/crisis-views.ts, crisis.controller.ts and
 * dto/crisis.dto.ts), as the gateway answers and takes them.
 *
 * Mirrored by hand, like lib/cover-request-types.ts, and TYPES ONLY: nothing
 * here costs a byte of JavaScript. The words a status is shown in, and the
 * rules about it, are lib/crisis-view.ts.
 *
 * A pupil's status is what the lists say, in one word: FOUND and MISSING are
 * marks; ABSENT_BEFORE is "not marked, and absent before the alarm" (nobody is
 * asked to find them); UNREPORTED is "not marked, and expected: someone still
 * has to say". A mark overrules ABSENT_BEFORE.
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
export type PupilStatus = "FOUND" | "MISSING" | "ABSENT_BEFORE" | "UNREPORTED";
export type PriorSource = "ATTENDANCE" | "REPORTED";
export type MarkState = "FOUND" | "MISSING";

export interface CrisisSettings {
  startProfiles: AdminProfile[];
  notifyGuardiansAfter: boolean;
}

export interface PupilCounts {
  pupils: number;
  found: number;
  missing: number;
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

/** A pupil of the school who is on none of a teacher's lists: who a teacher can say they found. */
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
   * Every other pupil of the school, by name: a teacher who finds a pupil who is not on their lists picks them
   * here. May hold a thousand names, and is kept offline with the lists.
   */
  others: OtherPupilView[];
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
  state: MarkState;
  by: string | null;
  onBehalf: boolean;
  late: boolean;
}

export interface ProtocolView extends AlarmDetail {
  marks: ProtocolMark[];
}

/** One mark as the gateway takes it (MarkDto): the client's own uuid v4 id, so sending it twice stores it once. */
export interface MarkInput {
  id: string;
  callId: string;
  studentId: string;
  state: MarkState;
  /** When the mark was made, by the sender's clock. */
  at: string;
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
