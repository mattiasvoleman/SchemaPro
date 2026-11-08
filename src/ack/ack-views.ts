import type { AckReminderOutcome, AckRule } from '@prisma/client';

/** What the answers look like; the web and the app have their own copies of these shapes. */

/** A page of a list: the items, and the id to ask for the next page after (null: that was the last). */
export interface AckPage<T> {
  items: T[];
  next: string | null;
}

/**
 * Where a request's one reminder stands: NONE (the school chose no reminder), SCHEDULED (its time has not
 * come, or the pass has not reached it yet), and how it ended otherwise (AckReminderOutcome).
 *
 * WRITTEN is a SENT reminder whose e-mail and push the delivery has not said it handed over (reminderMirroredAt):
 * the notices are in the guardians' inboxes, which is all the database knows. It is not a failure and it is not
 * sent again; it is what a reminder is called while the mail is on its way, and for good when the process stopped
 * with the mail still in its queue or Resend did not take it.
 */
export type AckReminderState = 'NONE' | 'SCHEDULED' | 'WRITTEN' | AckReminderOutcome;

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
  reminder: AckReminderState;
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
  /** When at least one reminder was written to the inboxes; null unless the reminder is SENT or WRITTEN. */
  reminderSentAt: string | null;
  /** When the delivery said the e-mail and the push were taken; null unless the reminder is SENT. */
  reminderMirroredAt: string | null;
  reminder: AckReminderState;
  /** The reader may stop the reminder: it is scheduled, and they wrote the request or administer the school. */
  mayStopReminder: boolean;
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

export interface AckReminderStopped {
  reminder: AckReminderState;
}

/** One use of the day's limits: rows asked for in the last 24 hours, and the most there may be. */
export interface AckUsageLine {
  used: number;
  limit: number;
}

/**
 * Kvittens' use of the day (GET /usage): the school's (an administrator only), the caller's own share (null for a
 * login with no person, the huvudman's reader, who cannot send), and the senders who have used most (an administrator
 * who reads Drift). Receipts are the unit: one per guardian and pupil.
 */
export interface AckUsage {
  school: AckUsageLine | null;
  mine: AckUsageLine | null;
  senders: Array<AckUsageLine & { name: string }> | null;
}
