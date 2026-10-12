import type { NotificationKind } from './notifications.service';

/**
 * Recipients per statement and per outbox entry. A whole-school avbokning
 * digest reaches some 1,800 people; they are written and resolved 500 at a
 * time, never cut off (the cap used to drop everybody past the 500th
 * silently). The e-mail is split further, to the provider's cap per mail,
 * by the delivery.
 */
export const RECIPIENT_CHUNK = 500;

/**
 * One notifyUsers call (or one RECIPIENT_CHUNK of it), as the delivery sees
 * it after the commit: the rows it wrote (with the ids the gateway gave them)
 * and, when the caller mirrors it to e-mail, the recipients' addresses as
 * they were inside the transaction.
 */
export interface OutboxEntry {
  schoolId: string;
  type: NotificationKind;
  meta: Record<string, unknown>;
  recipients: Array<{ userId: string; notificationId: string }>;
  email?: {
    subject: string;
    body: string;
    /** (userId, address) pairs, so an opt-out can be honoured by user after the commit. */
    recipients: Array<{ userId: string; email: string }>;
  };
}

/** Every notice of one committed transaction, delivered by one hook. */
export type OutboxBatch = readonly OutboxEntry[];
