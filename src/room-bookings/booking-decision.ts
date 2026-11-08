import type { RoomBookingStatus } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';

/*
 * The approval flow a room booking and a booking of a resource share.
 *
 * Both start PENDING when what they ask for requires approval and the booker is
 * not an administrator (who decides for themselves), and APPROVED otherwise; both
 * are decided once, by an administrator, who may leave a note; and the booker is
 * told. The two services read and write different tables and so keep their own
 * queries; what is the same is said here once, so that the second kind of
 * booking cannot decide, or tell the booker, differently from the first.
 */

/** PENDING when the thing requires approval and the booker is not an administrator; APPROVED otherwise. */
export function initialStatus(requiresApproval: boolean, role: Role | string): RoomBookingStatus {
  return requiresApproval && role !== Role.SCHOOL_ADMIN ? 'PENDING' : 'APPROVED';
}

export interface DecisionNoticeInput {
  status: 'APPROVED' | 'REJECTED';
  /** What was booked: the room's or the resource's name. */
  targetName: string;
  /** Which of the notice's meta keys carries the name: the web and the app read both. */
  targetKey: 'roomName' | 'resourceName';
  title: string;
  startsAt: Date;
  note?: string | null;
}

/**
 * The meta and the e-mail of the notice that tells the booker. A room's is
 * word for word what it was before resources existed; a resource's names the
 * resource in the same sentences. The notice type is ROOM_BOOKING_DECIDED for both.
 */
export function decisionNotice(input: DecisionNoticeInput): {
  meta: Record<string, unknown>;
  email: { subject: string; body: string };
} {
  const when = input.startsAt.toISOString();
  const approved = input.status === 'APPROVED';
  const resource = input.targetKey === 'resourceName';
  const kind = resource ? 'Resource booking' : 'Room booking';
  const kindSv = resource ? 'Resursbokning' : 'Lokalbokning';
  return {
    meta: {
      status: input.status,
      [input.targetKey]: input.targetName,
      title: input.title,
      startsAt: when,
      note: input.note ?? null,
    },
    email: {
      subject: `${kind} ${approved ? 'approved' : 'rejected'} / ${kindSv} ${approved ? 'godkänd' : 'avslagen'}`,
      body:
        `Your booking of ${input.targetName} (${input.title}) at ${when} was ${input.status.toLowerCase()}.` +
        (input.note ? `\nNote: ${input.note}` : '') +
        `\n\nDin bokning av ${input.targetName} (${input.title}) ${when} ${approved ? 'godkändes' : 'avslogs'}.`,
    },
  };
}
