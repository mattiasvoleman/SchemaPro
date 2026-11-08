/**
 * The SQLSTATE a function or trigger of Ledighetspolicyn (20270201091000) raised, as the adapter
 * reports it: a raw refusal is P2010 with the code in driverAdapterError.cause, and the same text
 * is in the message. A model query that a trigger refuses (the filing's create, a decision's
 * updateMany) may come back in another class, so the codes of the triggers are also read from the
 * text they raised.
 *
 *   LV403 not a guardian        LV404 not asked about the request    LV409 decided or stopped
 *   LV410 custody ended         LV411 answered the other way         LV412 awaiting consent
 *   LV413 too late              LV414 contact required               LV415 contact incomplete
 */
export function leaveSqlStateOf(error: unknown): string | null {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  const message = error instanceof Error ? error.message : '';
  const named = /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
  if (named) return named;
  if (message.includes('LEAVE_AWAITING_CONSENT')) return 'LV412';
  if (message.includes('LEAVE_REQUEST_TOO_LATE')) return 'LV413';
  if (message.includes('LEAVE_CONTACT_REQUIRED')) return 'LV414';
  if (message.includes('LEAVE_CONTACT_INCOMPLETE')) return 'LV415';
  return null;
}

/** The minimum a LEAVE_REQUEST_TOO_LATE refusal names (DETAIL "days=N"), when the error carries it. */
export function tooLateDaysOf(error: unknown): number | null {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown; detail?: unknown } } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause;
  const text = [cause?.detail, cause?.originalMessage, error instanceof Error ? error.message : ''].filter((t): t is string => typeof t === 'string').join(' ');
  const days = /days=(\d+)/.exec(text)?.[1];
  return days ? Number(days) : null;
}
