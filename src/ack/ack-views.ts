import type { AckRule } from '@prisma/client';

/** What the answers look like; the web and the app have their own copies of these shapes. */

export interface AckSettingsView {
  enabled: boolean;
  /** Days before the one reminder; null: none. */
  remindAfterDays: number | null;
}

/** A pupil the caller may ask about: an administrator's every pupil, a teacher's mentees. */
export interface AckPupilChoice {
  id: string;
  name: string;
  className: string | null;
  /** Guardians who would be asked: linked and active. Zero: nobody can be asked about the pupil. */
  guardians: number;
}

export interface AckCreated {
  id: string;
  pupils: number;
  guardians: number;
  /** Pupils with no guardian to ask, left out of the request. */
  withoutGuardian: string[];
}

/** A request in the staff's list: counts only, no pupil. */
export interface AckListItem {
  id: string;
  title: string;
  rule: AckRule;
  authorName: string;
  createdAt: string;
  /** Pupils the caller sees in it. */
  pupils: number;
  /** Of those, how many are met. */
  met: number;
  /** Guardians who have not confirmed and still can. */
  waiting: number;
  remindAt: string | null;
  reminderSent: boolean;
}

export type AckGuardianState = 'CONFIRMED' | 'WAITING' | 'ENDED';

export interface AckGuardianRow {
  id: string;
  name: string;
  state: AckGuardianState;
  /** When they confirmed. */
  ackedAt: string | null;
  /** When the one reminder went to them. */
  remindedAt: string | null;
}

export interface AckPupilRow {
  id: string;
  name: string;
  className: string | null;
  met: boolean;
  guardians: AckGuardianRow[];
}

export interface AckDetail {
  id: string;
  title: string;
  body: string;
  rule: AckRule;
  authorName: string;
  createdAt: string;
  remindAt: string | null;
  reminderSentAt: string | null;
  pupils: AckPupilRow[];
}

/** A request as its guardian sees it: their own children, their own confirmation and no one else's. */
export interface AckMine {
  id: string;
  title: string;
  body: string;
  rule: AckRule;
  authorName: string;
  createdAt: string;
  children: Array<{ id: string; name: string }>;
  ackedAt: string | null;
}

export interface AckConfirmed {
  ackedAt: string;
}
