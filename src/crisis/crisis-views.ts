import type { AdminProfile } from '@prisma/client';

/**
 * WHAT THE GATEWAY ANSWERS ABOUT AN ALARM (Krisläge, F2).
 *
 * Two readers, two shapes, one source (the lists in the database):
 *
 *   * the administration's: every group, every teacher and every pupil of the
 *     alarm, counted, for the live view and for the protocol;
 *   * a teacher's: the alarm and the groups they answer for, with the pupils
 *     of those groups and nothing else. Row-level security gives each reader
 *     their rows (crisis_calls_teacher_select and its siblings), so the
 *     gateway builds the same view from whatever it was allowed to read.
 *
 * A pupil's status is what the lists say, in one word:
 *
 *   FOUND            marked found
 *   MISSING          marked missing
 *   AWAY             marked not in the building / not seen today, by the
 *                    administration (a teacher cannot say it): counted for
 *                    itself, never as found. A pupil nobody has seen is not a
 *                    pupil who was found.
 *   ABSENT_BEFORE    not marked, and absent before the alarm (the register of
 *                    the day, a report or a leave): nobody is asked to find them
 *   UNREPORTED       not marked, and expected: someone still has to say
 *
 * A mark overrules "absent before", so a pupil the register called absent who
 * turns up is FOUND, and one nobody expected to see and who is not there
 * stays ABSENT_BEFORE.
 */

export type CrisisKind = 'EVACUATION' | 'LOCKDOWN';
export type CrisisMode = 'LIVE' | 'DRILL';
/**
 * Why a pupil is on a group: the lesson going on (LESSON), the lesson they are on their way to in a break
 * (NEXT_LESSON), or no lesson at all (NO_LESSON): the one group of an alarm that gathers every pupil who is
 * on no other list (before the first lesson, after the last, between two lessons further apart than a
 * break, a lesson that is cancelled), because the school does not know where they are and the
 * administration answers for them. Its names are Swedish stand-ins; a screen says it in its own words.
 */
export type CallBasisView = 'LESSON' | 'NEXT_LESSON' | 'NO_LESSON';
export type PupilStatus = 'FOUND' | 'MISSING' | 'AWAY' | 'ABSENT_BEFORE' | 'UNREPORTED';
/** What a mark says. RETRACTED withdraws the sender's own found mark (the pupil is unmarked again); it is never a pupil's state. */
export type MarkState = 'FOUND' | 'MISSING' | 'AWAY' | 'RETRACTED';
export type PriorSourceView = 'ATTENDANCE' | 'REPORTED';

export interface CrisisSettingsView {
  startProfiles: AdminProfile[];
  notifyGuardiansAfter: boolean;
}

/** The defaults of a school that has set nothing: every profile that writes Drift. */
export const DEFAULT_START_PROFILES: readonly AdminProfile[] = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'];

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
  priorAbsentSource: PriorSourceView | null;
  /** When the latest mark was made, by the sender's clock. */
  markedAt: string | null;
  /** Who made it (the administration's view only). */
  markedBy: string | null;
}

export interface TeacherView {
  userId: string | null;
  name: string | null;
  role: 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE';
  /** Their first mark on the call. */
  answeredAt: string | null;
}

export interface CallView {
  id: string;
  lessonId: string | null;
  basis: CallBasisView;
  groupName: string;
  subjectName: string;
  roomName: string | null;
  lessonStartsAt: string;
  lessonEndsAt: string;
  /** Every pupil who was not absent before has a mark: the time of the last. */
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
  /** Pupils on the group nobody has a lesson with (NO_LESSON): they count in `counts` like all the others. */
  unlisted: number;
  calls: number;
  /** Calls that are complete, or have nobody to ask. */
  callsComplete: number;
  counts: PupilCounts;
  teachers: number;
  teachersAnswered: number;
}

/** The administration's view of one alarm. */
export interface AlarmDetail {
  alarm: AlarmSummary;
  calls: CallView[];
}

/** A pupil a teacher on the call found, who is on another list (or none): "found with me". */
export interface FoundHereView {
  studentId: string;
  firstName: string;
  lastName: string;
  /** The pupil's own class, so a teacher can tell two of the same name apart. */
  className: string | null;
  /** When the teacher marked them, by the sender's clock. */
  markedAt: string;
}

/** A pupil of the school who is on none of a teacher's lists, as the search for "found with me" answers. Held nowhere. */
export interface OtherPupilView {
  studentId: string;
  firstName: string;
  lastName: string;
  className: string | null;
}

/** A teacher's group, as the phone shows it and keeps it offline. */
export interface MyCall {
  id: string;
  lessonId: string | null;
  basis: CallBasisView;
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
  /** Pupils not on this list whom a teacher on the call found. They count on the pupil's own list, not here. */
  foundHere: FoundHereView[];
}

export interface MyAlarm extends AlarmView {
  calls: MyCall[];
  /**
   * Pupils this teacher found who are on no list of theirs and were found with no group: a teacher with no
   * group right now (a gap, a duty, a timetable that lacks them) can say they found a pupil too (send the mark
   * with `alarmId` in place of `callId`).
   */
  foundFree: FoundHereView[];
}

export interface MyCrisisResponse {
  /** The moment the gateway answered; a phone holding the list offline shows how old it is. */
  asOf: string;
  alarms: MyAlarm[];
}

export function statusOf(
  state: 'FOUND' | 'MISSING' | 'AWAY' | 'RETRACTED' | null,
  priorAbsentSource: PriorSourceView | null,
): PupilStatus {
  // RETRACTED is never kept as a pupil's state (a CHECK); read as unmarked all the same.
  if (state && state !== 'RETRACTED') return state;
  return priorAbsentSource ? 'ABSENT_BEFORE' : 'UNREPORTED';
}

export function countPupils(statuses: readonly PupilStatus[]): PupilCounts {
  const counts: PupilCounts = { pupils: statuses.length, found: 0, missing: 0, away: 0, absentBefore: 0, unreported: 0 };
  for (const status of statuses) {
    if (status === 'FOUND') counts.found++;
    else if (status === 'MISSING') counts.missing++;
    else if (status === 'AWAY') counts.away++;
    else if (status === 'ABSENT_BEFORE') counts.absentBefore++;
    else counts.unreported++;
  }
  return counts;
}

export function sumCounts(all: readonly PupilCounts[]): PupilCounts {
  return all.reduce<PupilCounts>(
    (total, c) => ({
      pupils: total.pupils + c.pupils,
      found: total.found + c.found,
      missing: total.missing + c.missing,
      away: total.away + c.away,
      absentBefore: total.absentBefore + c.absentBefore,
      unreported: total.unreported + c.unreported,
    }),
    { pupils: 0, found: 0, missing: 0, away: 0, absentBefore: 0, unreported: 0 },
  );
}

/** Surname, then first name, in Swedish order: a list a teacher reads aloud. */
export function byName(a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }): number {
  return a.lastName.localeCompare(b.lastName, 'sv') || a.firstName.localeCompare(b.firstName, 'sv');
}

/** The protocol: the alarm, its groups and the timeline of every mark. */
export interface ProtocolMark {
  at: string;
  receivedAt: string;
  studentId: string;
  /** The pupil's own group. */
  groupName: string;
  /** The group of the teacher who found them, when that is not the pupil's own ("found with me"). */
  foundIn: { groupName: string; basis: CallBasisView } | null;
  state: MarkState;
  by: string | null;
  onBehalf: boolean;
  late: boolean;
}

export interface ProtocolView extends AlarmDetail {
  marks: ProtocolMark[];
}
