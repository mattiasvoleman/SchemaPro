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
