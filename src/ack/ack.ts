import type { AckRule } from '@prisma/client';

/**
 * Kvittens (F4): the numbers and the codes of a request for a guardian's
 * confirmation. The rules themselves are the database's (migration
 * 20270117091000): who is done is app.ack_status, who can still confirm is
 * app.ack_receipt_open, and nothing here decides either.
 */

/** The reminder pass, in the JobRunner and in JobRuns. */
export const ACK_JOB = 'ack-reminders';
/** How often it looks. The reminder is due after days, so a quarter of an hour is precise enough. */
export const ACK_INTERVAL_MS = 15 * 60 * 1000;
/** The requests one pass asks the database for (app.ack_remind_queue), oldest first. */
export const ACK_QUEUE_LIMIT = 200;
/**
 * How long one pass works through them before it stops and leaves the rest for the next: a request is a
 * transaction of its own under the delivery door's 5 s, so a pass always makes progress, and this is what
 * keeps it from running into the next tick.
 */
export const ACK_PASS_BUDGET_MS = 60_000;
/** A page of the lists: the default and the most a caller may ask for. */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

export const ACK_RULES: readonly AckRule[] = ['ANY', 'ALL'];
export const TITLE_MAX = 120;
export const BODY_MAX = 2000;
/** Pupils in one request. A whole school's, with two guardians each, is about 4 000 rows. */
export const PUPILS_MAX = 2000;
export const REMIND_DAYS_MIN = 1;
export const REMIND_DAYS_MAX = 30;

export const ACK_DISABLED = 'ACK_DISABLED';
export const ACK_NOT_FOUND = 'ACK_NOT_FOUND';
export const ACK_NOT_A_GUARDIAN = 'ACK_NOT_A_GUARDIAN';
export const ACK_CUSTODY_ENDED = 'ACK_CUSTODY_ENDED';
export const ACK_UNKNOWN_PUPIL = 'ACK_UNKNOWN_PUPIL';
export const ACK_NOT_YOUR_PUPIL = 'ACK_NOT_YOUR_PUPIL';
export const ACK_NO_GUARDIANS = 'ACK_NO_GUARDIANS';
/**
 * An eleventh request in an hour from one sender (KV429), more receipts in a day than the sender's share (KV427), more than
 * 20 000 receipts in a day for one school (KV428): all 429. The numbers are the database's (app.ack_day_limit); the
 * sender's share is 8 000 for an administrator and 2 000 for a teacher, and the usage endpoint says them.
 */
export const ACK_TOO_MANY_REQUESTS = 'ACK_TOO_MANY_REQUESTS';
export const ACK_SENDER_DAY_LIMIT = 'ACK_SENDER_DAY_LIMIT';
export const ACK_TOO_MANY_RECIPIENTS = 'ACK_TOO_MANY_RECIPIENTS';
/** The largest senders the usage names. */
export const USAGE_SENDERS = 5;
export const ACK_NOT_STAFF = 'ACK_NOT_STAFF';
