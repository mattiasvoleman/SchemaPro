import { ApiError, apiRequest } from './api';
import { isNetworkError } from './coverRequests';
import type { Translate } from '../i18n';
import type { LeaveContactMode, LeavePolicy, LeaveRequestRow, LeaveRequestStatus, LeaveShortNotice } from '../types';

/**
 * Leave requests (ledighetsansökan), through the gateway.
 *
 * GET /api/v1/leave-requests answers the requests row security shows the
 * caller, a guardian's own children's with their reasons, and records the
 * read in the read log (Läslogg). Newest first, at most 200; the screen shows
 * the first 50 in that order, as it did when it asked Supabase itself. Each
 * row carries the role its decision was made in: the pupil's mentor or
 * rektor (decidedAs, Mentorns ledighetsbeslut). The answer also carries who
 * asked, who decided when and the names, which no screen draws.
 *
 * A request is made through the gateway too. It derives the school from the
 * pupil and the requester from the bearer, so the phone no longer reads the
 * child's Users row, and it sends no status: a new request is undecided, and
 * the school decides it; when the request is short enough for the school's
 * delegation the database tells the pupil's mentor. A refusal (400 for an end
 * before the start, a request of more than a year or a reason outside 3..1000
 * characters, 403 for another family's child) is the gateway client's
 * ApiError, thrown as it came.
 *
 * LEDIGHETSPOLICY. The school's three choices (GET /api/v1/leave-policy) say
 * what the form asks and what a row shows; every one is off as a school
 * leaves it, and the app draws only what the answer says. The policy can be
 * missing (a gateway from before it answers 404 without a code), and then it
 * is the all-off one. A request can carry a temporary contact (three fields,
 * all or none), and a refusal of it, or of a request that comes too late,
 * arrives as a `code` the screen words in the reader's language
 * (filingErrorText); LEAVE_REQUEST_TOO_LATE names the school's minimum in
 * `params.days`. A guardian answers a request that waits for every
 * guardian's consent with POST .../consent (answerLeaveConsent); the answer
 * cannot be changed, so it is sent live and never queued.
 */

const LEAVES_SHOWN = 50;

export async function fetchLeaveRequests(): Promise<LeaveRequestRow[]> {
  const rows = await apiRequest<LeaveRequestRow[]>('/api/v1/leave-requests');
  return rows.slice(0, LEAVES_SHOWN);
}

export interface LeaveRequestInput {
  readonly studentId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  /** The temporary contact during the leave: all three or none, an empty one counts as none. */
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly contactRelation?: string;
}

/** What the gateway answers a filing: whether the school asked for consent, and whether it came later than the school's minimum. */
export interface LeaveRequestFiled {
  readonly id: string;
  readonly studentId: string;
  readonly status: LeaveRequestStatus;
  readonly consentRequired?: boolean;
  readonly shortNotice?: boolean;
}

/** `value` trimmed, or undefined when nothing is left. */
const filled = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The reason is sent trimmed, the way the screen measured it. A contact field
 * is sent trimmed and only when it holds something: an empty one is "none",
 * and a request without a contact carries none of the three keys.
 */
export function requestLeave(input: LeaveRequestInput): Promise<LeaveRequestFiled> {
  const contact = {
    contactName: filled(input.contactName),
    contactPhone: filled(input.contactPhone),
    contactRelation: filled(input.contactRelation),
  };
  return apiRequest('/api/v1/leave-requests', {
    method: 'POST',
    body: {
      studentId: input.studentId,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason.trim(),
      ...(contact.contactName !== undefined ? { contactName: contact.contactName } : {}),
      ...(contact.contactPhone !== undefined ? { contactPhone: contact.contactPhone } : {}),
      ...(contact.contactRelation !== undefined ? { contactRelation: contact.contactRelation } : {}),
    },
  });
}

/** What a school that has chosen nothing has: no consent, no minimum, no contact. */
export const DEFAULT_LEAVE_POLICY: LeavePolicy = {
  requireAllGuardians: false,
  minDaysAhead: null,
  shortNotice: 'REFUSE',
  contact: 'OFF',
};

const CONTACT_MODES: readonly LeaveContactMode[] = ['OFF', 'OPTIONAL', 'REQUIRED'];
const SHORT_NOTICE_MODES: readonly LeaveShortNotice[] = ['REFUSE', 'FLAG'];

/** A policy as the gateway sent it, with anything this build does not understand read as "off". */
function policyOf(raw: Partial<Record<keyof LeavePolicy, unknown>> | null | undefined): LeavePolicy {
  const days = raw?.minDaysAhead;
  return {
    requireAllGuardians: raw?.requireAllGuardians === true,
    minDaysAhead: typeof days === 'number' && Number.isInteger(days) && days >= 1 ? days : null,
    shortNotice: SHORT_NOTICE_MODES.find((mode) => mode === raw?.shortNotice) ?? DEFAULT_LEAVE_POLICY.shortNotice,
    contact: CONTACT_MODES.find((mode) => mode === raw?.contact) ?? DEFAULT_LEAVE_POLICY.contact,
  };
}

/**
 * GET /api/v1/leave-policy, for every role of the school. A 404 without a
 * code is a gateway that has no such route (one from before Ledighetspolicy):
 * the all-off policy, not an error on every visit. Any other failure is
 * thrown, and the screen keeps the policy it had.
 */
export async function fetchLeavePolicy(): Promise<LeavePolicy> {
  try {
    return policyOf(await apiRequest<Partial<Record<keyof LeavePolicy, unknown>> | undefined>('/api/v1/leave-policy'));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) return DEFAULT_LEAVE_POLICY;
    throw error;
  }
}

export type LeaveConsentAnswer = 'GIVEN' | 'REFUSED';

/** The gateway's answer to a consent: what was recorded, and where the request stands now. */
export interface LeaveConsentAnswered {
  readonly id: string;
  readonly answer: LeaveConsentAnswer;
  readonly state: 'WAITING' | 'GIVEN' | 'REFUSED';
}

/**
 * POST /api/v1/leave-requests/:id/consent, `{ consent }`. A guardian's own
 * answer, which cannot be changed: a refusal ends the request, and a yes is
 * final too. Throws the gateway's ApiError (consentErrorText words it).
 */
export function answerLeaveConsent(id: string, consent: boolean): Promise<LeaveConsentAnswered> {
  return apiRequest(`/api/v1/leave-requests/${encodeURIComponent(id)}/consent`, {
    method: 'POST',
    body: { consent },
  });
}

/** The record without `key`: a per-request flag or note taken off when its request is done with. */
export function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  void _dropped;
  return rest;
}

/**
 * The list row once the gateway has recorded the guardian's answer, so the
 * buttons are gone at once and a read that was already in the air cannot bring
 * them back (the screen reads again after it). A refusal ends the request, as
 * the gateway does. A row that carries no consent is left as it is.
 */
export function withConsentAnswer(
  row: LeaveRequestRow,
  done: { readonly answer: LeaveConsentAnswer; readonly state?: LeaveConsentAnswered['state'] },
): LeaveRequestRow {
  if (!row.consent) return row;
  return {
    ...row,
    status: done.answer === 'REFUSED' ? 'GUARDIAN_DECLINED' : row.status,
    consent: { ...row.consent, mine: done.answer, state: done.state ?? row.consent.state },
  };
}

// ─── What the screen says of a refusal ────────────────────────────────────────

/**
 * The sentence for a refusal of a filing, in the reader's language: the
 * school's minimum (`params.days`, else the policy's own `fallbackDays`), a
 * contact it requires, a contact that is only partly given. Any other
 * failure is the generic one.
 */
export function filingErrorText(error: unknown, t: Translate, fallbackDays: number | null = null): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'LEAVE_REQUEST_TOO_LATE': {
        const named = error.params?.['days'];
        const days = typeof named === 'number' && named >= 1 ? named : fallbackDays;
        return days === null ? t('leave.error.tooLateNoDays') : t('leave.error.tooLate', { count: days });
      }
      case 'LEAVE_CONTACT_REQUIRED':
        return t('leave.error.contactRequired');
      case 'LEAVE_CONTACT_INCOMPLETE':
        return t('leave.error.contactIncomplete');
    }
  }
  return isNetworkError(error) ? t('leave.error.offline') : t('leave.submitFailed');
}

/** Whether a refusal of a filing is the school asking for a contact, which the form must then show. */
export function asksForContact(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'LEAVE_CONTACT_REQUIRED' || error.code === 'LEAVE_CONTACT_INCOMPLETE');
}

export interface ConsentFailure {
  readonly text: string;
  /** The request has moved on without the guardian (decided, ended, custody over, not theirs to answer): the list is read again. */
  readonly moved: boolean;
}

/**
 * The sentence for a consent that was not recorded. An answer that cannot be
 * changed is told as such, and a request that has ended or been decided no
 * longer waits for the guardian. A phone with no network, or any other
 * failure, is "try again": nothing is kept, and the buttons stay.
 */
export function consentErrorText(error: unknown, t: Translate): ConsentFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'LEAVE_CONSENT_REQUEST_ENDED':
        return { text: t('leave.consent.errorEnded'), moved: true };
      case 'LEAVE_CONSENT_CUSTODY_ENDED':
        return { text: t('leave.consent.errorCustodyEnded'), moved: true };
      case 'LEAVE_CONSENT_ANSWERED':
        return { text: t('leave.consent.errorAnswered'), moved: true };
      case 'LEAVE_CONSENT_NOT_FOUND':
        return { text: t('leave.consent.errorNotAsked'), moved: true };
      case 'LEAVE_CONSENT_NOT_A_GUARDIAN':
        return { text: t('leave.consent.errorNotGuardian'), moved: false };
    }
  }
  return { text: isNetworkError(error) ? t('leave.consent.errorOffline') : t('leave.consent.errorFailed'), moved: false };
}

/** Who decided, as the list says it: the mentor, rektor, or nothing (still waiting, or decided before roles were recorded). */
export function deciderOf(row: Pick<LeaveRequestRow, 'status' | 'decidedAs'>): 'MENTOR' | 'ADMIN' | null {
  if (row.status === 'PENDING') return null;
  return row.decidedAs ?? null;
}
