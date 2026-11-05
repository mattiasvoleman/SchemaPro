import type { CoverRecipientAnswer, CoverRequestStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * The requests and confirmations the cover board shows beside its pairs
 * (CoverService.board), and the one reading of a request every answer uses.
 * Plain functions over a transaction, so the board and the requests service
 * can both import them without importing each other.
 */

/** What the board shows of a request: nothing of the lessons' absent teachers' reasons, only ids. */
export interface BoardRequest {
  id: string;
  /** OPEN is read as EXPIRED once expiresAt has passed, whether or not the nightly job has settled it. */
  status: CoverRequestStatus;
  createdAt: string;
  expiresAt: string;
  requestedByUserId: string | null;
  acceptedByUserId: string | null;
  pairs: { absenceId: string; lessonId: string }[];
  recipients: { userId: string; answer: CoverRecipientAnswer; answeredAt: string | null }[];
}

export interface BoardConfirmation {
  absenceId: string;
  lessonId: string;
  userId: string;
  confirmedAt: string;
}

export const requestSelect = {
  id: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  requestedByUserId: true,
  acceptedByUserId: true,
  lessons: { select: { absenceId: true, calendarLessonId: true }, orderBy: [{ calendarLessonId: 'asc' as const }, { absenceId: 'asc' as const }] },
  recipients: { select: { userId: true, answer: true, answeredAt: true }, orderBy: [{ userId: 'asc' as const }] },
};

export function toBoardRequest(row: RequestRow, now: Date): BoardRequest {
  return {
    id: row.id,
    status: row.status === 'OPEN' && row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    requestedByUserId: row.requestedByUserId,
    acceptedByUserId: row.acceptedByUserId,
    pairs: row.lessons.map((line) => ({ absenceId: line.absenceId, lessonId: line.calendarLessonId })),
    recipients: row.recipients.map((recipient) => ({
      userId: recipient.userId,
      answer: recipient.answer,
      answeredAt: recipient.answeredAt ? recipient.answeredAt.toISOString() : null,
    })),
  };
}

export type RequestRow = Prisma.CoverRequestGetPayload<{ select: typeof requestSelect }>;

/** The requests with a lesson among these, and the confirmations of these lessons, for the board. */
export async function readBoardParts(
  tx: PrismaClient,
  lessonIds: readonly string[],
  now: Date,
): Promise<{ requests: BoardRequest[]; confirmations: BoardConfirmation[] }> {
  if (lessonIds.length === 0) return { requests: [], confirmations: [] };
  const ids = [...new Set(lessonIds)];
  const rows = await tx.coverRequest.findMany({
    where: { lessons: { some: { calendarLessonId: { in: ids } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: requestSelect,
  });
  const confirmations = await tx.coverConfirmation.findMany({
    where: { calendarLessonId: { in: ids } },
    select: { absenceId: true, calendarLessonId: true, userId: true, confirmedAt: true },
    orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
  });
  return {
    requests: rows.map((row) => toBoardRequest(row, now)),
    confirmations: confirmations.map((row) => ({
      absenceId: row.absenceId,
      lessonId: row.calendarLessonId,
      userId: row.userId,
      confirmedAt: row.confirmedAt.toISOString(),
    })),
  };
}
