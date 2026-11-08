/**
 * Ledighetspolicy (K4): the numbers and the name of the pass over the requests that wait for every
 * guardian's consent. The rules themselves are the database's (migration 20270205091000): when a
 * request has its consent is app.leave_consent_met_raw, who can still answer is
 * app.ack_receipt_open, and nothing here decides either.
 */

/** The pass, in the JobRunner and in JobRuns. */
export const LEAVE_CONSENT_JOB = 'leave-consent';
/** How often it looks. The reminder is due after two days, so a quarter of an hour is precise enough. */
export const LEAVE_CONSENT_INTERVAL_MS = 15 * 60 * 1000;
/** The reminders one pass writes at most (app.leave_consent_pass); the rest are for the next pass. */
export const LEAVE_CONSENT_PASS_LIMIT = 200;
