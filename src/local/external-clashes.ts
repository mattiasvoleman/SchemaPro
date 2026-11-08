import { Prisma, type PrismaClient } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import { PROFILE_WRITES } from '../auth/admin-areas';
import type { ExternalClashResponse } from './local-types';

/*
 * A DAY OF AN EXTERNAL BOOKING THAT STANDS IN A ROOM WITH A LESSON.
 *
 * A hire is registered against the schedule as it is. The schedule moves: a
 * publication writes a term of lessons in one transaction, and a lesson that
 * lands in the room the association has on Tuesdays does not ask the booking
 * first (the room's constraint is on bookings alone, 20260822131500, for the
 * reason it gives). So the clash is found afterwards, by the same overlap test
 * the registration used: a day that is active, not yet over, in a room where a
 * lesson that holds its time overlaps it.
 *
 * It is not stored. The list is a query, so it is right at every reading and
 * needs no state to keep in step with lessons that are moved, cancelled and
 * brought back; the expedition is told once by notice after a publication that
 * made one (flagAfterPublication), and the page shows the list at any time.
 */

export interface ClashRow {
  seriesId: string;
  dayId: string;
  organisation: string;
  targetName: string;
  startsAt: Date;
  endsAt: Date;
  lesson: string;
}

/** The most rows one reading names: a full school year of a hall let to many is a few hundred. */
const LIMIT = 500;

/**
 * The days that clash with a lesson, for the series named (all of the school's when none is).
 * Days of resources have no lessons to clash with.
 */
export async function clashRows(tx: PrismaClient, seriesIds: readonly string[] | null, limit = LIMIT): Promise<ClashRow[]> {
  const scope = seriesIds === null ? Prisma.empty : Prisma.sql`AND d."externalBookingId" = ANY(${[...seriesIds]}::uuid[])`;
  return tx.$queryRaw<ClashRow[]>`
    SELECT d."externalBookingId" AS "seriesId", d."id" AS "dayId", x."organisation", r."name" AS "targetName",
           d."startsAt", d."endsAt",
           btrim(coalesce(s."name", '') || ' ' || coalesce(g."name", '')) AS "lesson"
      FROM "RoomBookings" d
      JOIN "ExternalBookings" x ON x."id" = d."externalBookingId" AND x."schoolId" = d."schoolId"
      JOIN "Rooms" r ON r."id" = d."roomId" AND r."schoolId" = d."schoolId"
      JOIN "CalendarLessons" l ON l."roomId" = d."roomId" AND l."schoolId" = d."schoolId"
       AND l."status" IN ('SCHEDULED', 'COMPLETED')
       AND l."startsAt" >= d."startsAt" - interval '2 days' AND l."startsAt" < d."endsAt" AND l."endsAt" > d."startsAt"
      LEFT JOIN "Subjects" s ON s."id" = l."subjectId" AND s."schoolId" = l."schoolId"
      LEFT JOIN "StudentGroups" g ON g."id" = l."studentGroupId" AND g."schoolId" = l."schoolId"
     WHERE d."externalBookingId" IS NOT NULL
       AND d."status" IN ('PENDING', 'APPROVED')
       AND d."endsAt" > now()
       ${scope}
     ORDER BY d."startsAt", d."id", l."startsAt"
     LIMIT ${limit}`;
}

/** How many distinct days clash, for the notice. */
export async function clashCount(tx: PrismaClient): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ days: number }>>`
    SELECT count(DISTINCT d."id")::int AS "days"
      FROM "RoomBookings" d
      JOIN "CalendarLessons" l ON l."roomId" = d."roomId" AND l."schoolId" = d."schoolId"
       AND l."status" IN ('SCHEDULED', 'COMPLETED')
       AND l."startsAt" >= d."startsAt" - interval '2 days' AND l."startsAt" < d."endsAt" AND l."endsAt" > d."startsAt"
     WHERE d."externalBookingId" IS NOT NULL
       AND d."status" IN ('PENDING', 'APPROVED')
       AND d."endsAt" > now()`;
  return rows[0]?.days ?? 0;
}

export function toClashResponse(row: ClashRow, timeZone: string): ExternalClashResponse {
  return {
    seriesId: row.seriesId,
    dayId: row.dayId,
    organisation: row.organisation,
    targetName: row.targetName,
    date: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.startsAt),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    lesson: row.lesson,
  };
}

/**
 * After a publication has written its lessons, tell the expedition how many days of
 * external bookings now clash. In the publication's own transaction, so a publication
 * that is rolled back tells nobody; best effort otherwise: a failure here is logged
 * by the caller and never fails a publication.
 *
 * To the administrators who write Drift. The notice carries a number and nothing
 * else: the hirer is not a user, and a notice goes on as e-mail and push.
 */
export async function flagAfterPublication(
  tx: PrismaClient,
  notifications: Pick<NotificationsService, 'notifyUsers'>,
  schoolId: string,
): Promise<number> {
  const days = await clashCount(tx);
  if (days === 0) return 0;
  const profiles = (Object.keys(PROFILE_WRITES) as Array<keyof typeof PROFILE_WRITES>).filter((profile) =>
    PROFILE_WRITES[profile].includes('DRIFT'),
  );
  const admins = await tx.user.findMany({
    where: { role: 'SCHOOL_ADMIN', isActive: true, adminProfile: { in: profiles } },
    select: { id: true },
  });
  if (admins.length === 0) return days;
  await notifications.notifyUsers(tx, {
    schoolId,
    userIds: admins.map((admin) => admin.id),
    type: 'EXTERNAL_BOOKING_CLASH',
    meta: { days },
    email: {
      subject: 'External bookings clash with lessons / Externa bokningar krockar med lektioner',
      body:
        `${days} day(s) of external bookings now stand in a room that has a lesson. See Externa bokningar in Rastra.` +
        `\n\n${days} dag(ar) av externa bokningar står nu i en sal som har en lektion. Se Externa bokningar i Rastra.`,
    },
  });
  return days;
}
