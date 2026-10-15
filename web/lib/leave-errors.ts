import { ApiError } from "@/lib/api";

/**
 * What an inbox says of a decision or a referral that failed. A 409
 * LEAVE_REQUEST_DECIDED is a lost race: a co-mentor or rektor decided first,
 * or the request was passed on. For the mentor a 404 says the same, since a
 * request no longer theirs is one their transaction does not find; rektor
 * reads every request, so a 404 there is the gateway's own message, like
 * anything else.
 */
export function leaveActionError(
  error: unknown,
  view: "admin" | "mentor",
  copy: { alreadyDecided: string; fallback: string },
): string {
  if (
    error instanceof ApiError &&
    ((error.status === 409 && error.code === "LEAVE_REQUEST_DECIDED") || (view === "mentor" && error.status === 404))
  ) {
    return copy.alreadyDecided;
  }
  return error instanceof Error ? error.message : copy.fallback;
}

/** The most days a leave request covers, as the gateway counts them (LEAVE_REQUEST_MAX_DAYS). */
export const LEAVE_REQUEST_MAX_DAYS = 366;

/**
 * The last day a request starting on `start` (yyyy-mm-dd) may end: a year
 * of LEAVE_REQUEST_MAX_DAYS days with the first. Undefined for no start.
 */
export function lastLeaveDay(start: string): string | undefined {
  const from = Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(from)) return undefined;
  return new Date(from + (LEAVE_REQUEST_MAX_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What the family's form says of a request the gateway refused. Its two
 * bounds come with a code (LeaveService.createLeaveRequest), which this
 * words in the reader's language; anything else is the gateway's own
 * message, as before.
 */
export function leaveRequestError(
  error: unknown,
  copy: { tooLong: (days: number) => string; endsBeforeStart: string; fallback: string },
): string {
  if (error instanceof ApiError && error.status === 400) {
    if (error.code === "LEAVE_REQUEST_TOO_LONG") {
      const days = Number(error.params?.days);
      return copy.tooLong(Number.isFinite(days) && days > 0 ? days : LEAVE_REQUEST_MAX_DAYS);
    }
    if (error.code === "LEAVE_REQUEST_ENDS_BEFORE_START") return copy.endsBeforeStart;
  }
  return error instanceof Error ? error.message : copy.fallback;
}
