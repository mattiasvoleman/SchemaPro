/*
 * Vikariefrågan's wire shapes (src/cover/cover-requests.service.ts and
 * src/cover/cover-request-reads.ts), as the gateway answers them.
 *
 * Mirrored by hand, like lib/cover-types.ts, and types only: nothing here
 * costs a byte of JavaScript. NO FREE TEXT travels in a request, and NOTHING
 * HERE NAMES THE ABSENT TEACHER OR THE REASON on the colleague's side: the
 * gateway does not send either, and the colleague's page must not look them up.
 */

export type CoverRequestStatus = "OPEN" | "ACCEPTED" | "WITHDRAWN" | "EXPIRED" | "CLOSED";
export type RecipientAnswer = "PENDING" | "ACCEPTED" | "DECLINED";

/** cover-request-reads.ts BoardRequest. OPEN past expiresAt is already read as EXPIRED. */
export interface BoardRequest {
  id: string;
  status: CoverRequestStatus;
  createdAt: string;
  expiresAt: string;
  requestedByUserId: string | null;
  acceptedByUserId: string | null;
  pairs: { absenceId: string; lessonId: string }[];
  recipients: { userId: string; answer: RecipientAnswer; answeredAt: string | null }[];
}

/** cover-request-reads.ts BoardConfirmation: a vikarie's tap on one pass. */
export interface BoardConfirmation {
  absenceId: string;
  lessonId: string;
  userId: string;
  confirmedAt: string;
}

/** CreateCoverRequestDto: 1..12 lessons, 1..25 colleagues, 5..720 minutes. */
export interface CoverRequestInput {
  lessons: { lessonId: string; absenceId: string }[];
  recipientIds: string[];
  expiresInMinutes?: number;
}

/** cover-requests.service.ts FairnessRow: only people who were asked appear. */
export interface FairnessRow {
  userId: string;
  received: number;
  accepted: number;
  declined: number;
  /** Asked and never answered: taken by another, withdrawn, expired or just not answered. */
  unanswered: number;
}

export interface Fairness {
  from: string;
  to: string;
  rows: FairnessRow[];
}

export type MyRequestState =
  | "OPEN"
  | "ACCEPTED_BY_ME"
  | "DECLINED_BY_ME"
  | "TAKEN"
  | "WITHDRAWN"
  | "EXPIRED"
  | "CLOSED";

/** One lesson of a request as the colleague reads it: when and where, never whose. */
export interface MyRequestLesson {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
  roomName: string | null;
  /** No longer held: the question cannot be said yes to. */
  cancelled: boolean;
}

export interface MyCoverRequest {
  id: string;
  state: MyRequestState;
  createdAt: string;
  expiresAt: string;
  lessons: MyRequestLesson[];
}

/** A pass a cover decision gave the colleague, and whether they have confirmed it. */
export interface MyCoverPass {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
  roomName: string | null;
  confirmedAt: string | null;
}

export interface MyCover {
  requests: MyCoverRequest[];
  passes: MyCoverPass[];
}
