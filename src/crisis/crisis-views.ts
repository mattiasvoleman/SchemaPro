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
export type CallBasisView = 'LESSON' | 'NEXT_LESSON';
export type PupilStatus = 'FOUND' | 'MISSING' | 'ABSENT_BEFORE' | 'UNREPORTED';
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
}

export interface MyAlarm extends AlarmView {
  calls: MyCall[];
}

export interface MyCrisisResponse {
  /** The moment the gateway answered; a phone holding the list offline shows how old it is. */
  asOf: string;
  alarms: MyAlarm[];
}

export function statusOf(
  state: 'FOUND' | 'MISSING' | null,
  priorAbsentSource: PriorSourceView | null,
): PupilStatus {
  if (state) return state;
  return priorAbsentSource ? 'ABSENT_BEFORE' : 'UNREPORTED';
}

export function countPupils(statuses: readonly PupilStatus[]): PupilCounts {
  const counts: PupilCounts = { pupils: statuses.length, found: 0, missing: 0, absentBefore: 0, unreported: 0 };
  for (const status of statuses) {
    if (status === 'FOUND') counts.found++;
    else if (status === 'MISSING') counts.missing++;
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
      absentBefore: total.absentBefore + c.absentBefore,
      unreported: total.unreported + c.unreported,
    }),
    { pupils: 0, found: 0, missing: 0, absentBefore: 0, unreported: 0 },
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
  groupName: string;
  state: 'FOUND' | 'MISSING';
  by: string | null;
  onBehalf: boolean;
  late: boolean;
}

export interface ProtocolView extends AlarmDetail {
  marks: ProtocolMark[];
}
