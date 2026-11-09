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
  copy: { alreadyDecided: string; fallback: string; awaitingConsent?: string },
): string {
  // Ledighetspolicy: a request still waiting for a guardian's consent is not
  // decided yet. The buttons are off for it, so this is a stale list.
  if (copy.awaitingConsent && error instanceof ApiError && error.status === 409 && error.code === "LEAVE_AWAITING_CONSENT") {
    return copy.awaitingConsent;
  }
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
 * What the family's form says of a request the gateway refused. Its bounds
 * come with a code (LeaveService.createLeaveRequest), which this words in
 * the reader's language; anything else is the gateway's own message, as
 * before. The school's choices (Ledighetspolicy) are three more codes: a
 * request filed closer to its first day than the school's minimum
 * (params.days is that minimum), and a contact the school requires or that
 * was given in part.
 */
export function leaveRequestError(
  error: unknown,
  copy: {
    tooLong: (days: number) => string;
    endsBeforeStart: string;
    fallback: string;
    tooLate: (days: number) => string;
    contactRequired: string;
    contactIncomplete: string;
  },
): string {
  if (error instanceof ApiError && error.status === 400) {
    if (error.code === "LEAVE_REQUEST_TOO_LONG") {
      const days = Number(error.params?.days);
      return copy.tooLong(Number.isFinite(days) && days > 0 ? days : LEAVE_REQUEST_MAX_DAYS);
    }
    if (error.code === "LEAVE_REQUEST_ENDS_BEFORE_START") return copy.endsBeforeStart;
    if (error.code === "LEAVE_REQUEST_TOO_LATE") {
      const days = Number(error.params?.days);
      return copy.tooLate(Number.isFinite(days) && days > 0 ? days : 0);
    }
    if (error.code === "LEAVE_CONTACT_REQUIRED") return copy.contactRequired;
    if (error.code === "LEAVE_CONTACT_INCOMPLETE") return copy.contactIncomplete;
  }
  return error instanceof Error ? error.message : copy.fallback;
}

/**
 * What a guardian is told when the answer to a request for consent was
 * refused (POST /leave-requests/:id/consent). The answer is final, so
 * every refusal says why nothing changed: the request was decided or ended
 * in between, the custody has ended, or the other answer was already given.
 */
export function leaveConsentError(
  error: unknown,
  copy: {
    notAGuardian: string;
    notFound: string;
    requestEnded: string;
    custodyEnded: string;
    answered: string;
    fallback: string;
  },
): string {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === "LEAVE_CONSENT_NOT_A_GUARDIAN") return copy.notAGuardian;
    if (error.status === 404 && error.code === "LEAVE_CONSENT_NOT_FOUND") return copy.notFound;
    if (error.status === 409) {
      if (error.code === "LEAVE_CONSENT_REQUEST_ENDED") return copy.requestEnded;
      if (error.code === "LEAVE_CONSENT_CUSTODY_ENDED") return copy.custodyEnded;
      if (error.code === "LEAVE_CONSENT_ANSWERED") return copy.answered;
    }
  }
  return error instanceof Error ? error.message : copy.fallback;
}
