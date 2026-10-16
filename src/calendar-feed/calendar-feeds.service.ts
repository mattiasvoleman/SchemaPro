import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { newToken, tokenHashOf } from '../publication/public-token';
import type { CreateCalendarFeedDto } from './dto/calendar-feed.dto';
import type { FeedAudience, FeedDocument } from './ics';

export const CALENDAR_FEEDS_OFF = 'CALENDAR_FEEDS_OFF';
export const CALENDAR_FEED_NOT_FOUND = 'CALENDAR_FEED_NOT_FOUND';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A person's own feed, as their page lists it: never its address, which was shown once. */
export interface CalendarFeedView {
  id: string;
  audience: FeedAudience;
  /** The pupil whose week it is: the pupil's own id, a guardian's child's; null for a teacher's. */
  studentId: string | null;
  locale: 'sv' | 'en';
  createdAt: string;
  /** When a calendar last asked (at most every five minutes); null before the first. */
  lastUsedAt: string | null;
}

export interface CalendarFeedsView {
  /** Whether the school has feeds on for the caller's audience. */
  enabled: boolean;
  feeds: CalendarFeedView[];
}

/** POST's answer: the feed and its address's token, shown this once. */
export interface CreatedCalendarFeed {
  feed: CalendarFeedView;
  token: string;
}

export type FeedCounts = Record<FeedAudience, number>;

type CreateResult = { feed: Omit<CalendarFeedView, 'createdAt' | 'lastUsedAt'> & { createdAt: string; lastUsedAt: string | null } } | { refused: string };

/**
 * Kalenderprenumeration: a person's own calendar feeds (migration
 * 20261112091000). The feed's address is a capability: whoever holds it reads
 * the week, without signing in, until it is revoked. So the address is drawn
 * here (32 random bytes), shown in the answer that made it, and only its
 * sha256 is passed on; it is never read back.
 *
 * WHO MAY HAVE ONE is app.calendar_feed_create's: a teacher or an admin
 * their own week, a pupil theirs, a guardian a child of theirs, and only while
 * the school has the audience on. A new address revokes the one it replaces,
 * in the same transaction, so "make a new address" is this POST again. The
 * person lists and revokes only their own (RLS, and app.calendar_feed_revoke).
 *
 * THE READ LOG. Making or listing a feed reads nobody's personal data; the
 * schedule is read when a calendar asks (PublicCalendarFeedController), and
 * the door writes a guardian's feed there.
 */
@Injectable()
export class CalendarFeedsService {
  constructor(private readonly prisma: PrismaService) {}

  async mine(user: AuthenticatedUser): Promise<CalendarFeedsView> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const [answer] = await tx.$queryRaw<{ enabled: boolean | null }[]>`SELECT app.calendar_feed_audience_on() AS "enabled"`;
      // calendar_feeds_owner_select: the caller's own rows and nobody else's.
      const rows = await tx.calendarFeed.findMany({
        where: { revokedAt: null },
        select: { id: true, audience: true, studentId: true, locale: true, createdAt: true, lastUsedAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return {
        enabled: answer?.enabled === true,
        feeds: rows.map((row) => ({
          id: row.id,
          audience: row.audience,
          studentId: row.studentId,
          locale: row.locale === 'en' ? 'en' : 'sv',
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  async create(dto: CreateCalendarFeedDto, user: AuthenticatedUser): Promise<CreatedCalendarFeed> {
    requireSchoolId(user);
    const token = newToken();
    return this.prisma.withRls(user, async (tx) => {
      const [row] = await tx.$queryRaw<{ result: CreateResult | null }[]>`
        SELECT app.calendar_feed_create(${dto.studentId ?? null}::uuid, ${tokenHashOf(token)}, ${dto.locale ?? 'sv'}) AS "result"`;
      const result = row?.result ?? { refused: 'NO_PRINCIPAL' };
      if ('refused' in result) throw refusal(result.refused);
      return {
        feed: {
          id: result.feed.id,
          audience: result.feed.audience,
          studentId: result.feed.studentId,
          locale: result.feed.locale === 'en' ? 'en' : 'sv',
          createdAt: new Date(result.feed.createdAt).toISOString(),
          lastUsedAt: result.feed.lastUsedAt ? new Date(result.feed.lastUsedAt).toISOString() : null,
        },
        token,
      };
    });
  }

  async revoke(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    if (!UUID.test(id)) throw feedNotFound();
    const revoked = await this.prisma.withRls(user, async (tx) => {
      const [row] = await tx.$queryRaw<{ revoked: boolean }[]>`SELECT app.calendar_feed_revoke(${id}::uuid) AS "revoked"`;
      return row?.revoked === true;
    });
    if (!revoked) throw feedNotFound();
  }

  /** The admin's count of live feeds per audience, and nothing about whose. */
  async counts(user: AuthenticatedUser): Promise<FeedCounts> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.$queryRaw<{ audience: FeedAudience; live: bigint | number }[]>`
        SELECT "audience"::text AS "audience", "live" FROM app.calendar_feed_counts()`,
    );
    const counts: FeedCounts = { TEACHER: 0, STUDENT: 0, GUARDIAN: 0 };
    for (const row of rows ?? []) counts[row.audience] = Number(row.live);
    return counts;
  }
}

/** The feed's week by its address, or null for every address that is no live feed. */
export async function readFeed(prisma: PrismaService, token: string): Promise<FeedDocument | null> {
  const rows = await prisma.withPublicViewer((tx) =>
    tx.$queryRaw<{ document: FeedDocument | null }[]>`SELECT app.calendar_feed(${tokenHashOf(token)}) AS "document"`,
  );
  return rows?.[0]?.document ?? null;
}

function feedNotFound(): NotFoundException {
  return new NotFoundException({ message: 'Prenumerationen finns inte.', code: CALENDAR_FEED_NOT_FOUND });
}

function refusal(reason: string): Error {
  if (reason === 'AUDIENCE_OFF') {
    return new ConflictException({ message: 'Skolan har inte slagit på kalenderprenumeration för dig.', code: CALENDAR_FEEDS_OFF });
  }
  if (reason === 'NOT_YOURS') {
    // A child who is not the guardian's, or a week the role has none of: one answer, as for a stranger.
    return new NotFoundException({ message: 'Eleven finns inte.', code: 'STUDENT_NOT_FOUND' });
  }
  return new ForbiddenException();
}
