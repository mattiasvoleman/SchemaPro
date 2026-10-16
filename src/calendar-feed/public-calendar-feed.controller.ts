import { createHash } from 'node:crypto';
import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { readFeed } from './calendar-feeds.service';
import { CalendarFeedThrottlerGuard } from './calendar-feed-throttler.guard';
import { feedTokenOf } from './feed-token';
import { feedIcs } from './ics';

/** The one answer for every address that is no live feed: malformed, unknown, revoked, switched off, its owner gone. */
export const FEED_NOT_FOUND = 'Kalendern finns inte.\r\n';

/** Each entry's DTSTAMP, which is the time of the ask and no change of the week (never folded: it is short). */
const DTSTAMP_LINES = /^DTSTAMP:\d{8}T\d{6}Z\r\n/gm;

/**
 * A calendar feed, as a calendar app asks for it: GET
 * public/v1/calendar-feeds/<token>[.ics], without signing in
 * (Kalenderprenumeration, 20261112091000).
 *
 * Everything it shows is decided in the database, by app.calendar_feed() —
 * a whitelist per audience the API cannot widen. The API only:
 *
 *   - answers ONE 404, byte for byte, for every address that does not
 *     resolve, so a guess learns nothing;
 *   - writes the week as iCalendar (ics.ts) with a weak ETag over the body
 *     less its DTSTAMP lines (the time of the ask, as METHOD:PUBLISH has
 *     it): weak, because the bytes differ by those lines, and the rest
 *     changes only when the week or the writing does, so a calendar that
 *     asks again is a 304 until then;
 *   - lets nothing between keep it (private, no-cache: each ask asks the
 *     database, so a revoked feed is gone at the next), and tags every
 *     answer noindex, nofollow and no-referrer, with no cookie;
 *   - rate-limits per asking address and per feed
 *     (CalendarFeedThrottlerGuard), skipping the global limit.
 *
 * A guardian's feed is written to the read log by the door (once per school
 * day), not here: the door is the read.
 */
@Controller('public/v1/calendar-feeds')
@Public()
@SkipThrottle()
@UseGuards(CalendarFeedThrottlerGuard)
export class PublicCalendarFeedController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':file')
  async feed(@Param('file') file: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    // Set by hand: with @Res() Nest's @Header decorators are not applied.
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const token = feedTokenOf(file);
    const document = token === null ? null : await readFeed(this.prisma, token);
    if (document === null) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).type('text/plain; charset=utf-8').send(FEED_NOT_FOUND);
      return;
    }
    const body = feedIcs(document, new Date());
    const etag = `W/"${createHash('sha256').update(body.replace(DTSTAMP_LINES, '')).digest('base64url')}"`;
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }
    response.setHeader('Content-Disposition', 'inline; filename="schema.ics"');
    response.status(200).type('text/calendar; charset=utf-8').send(body);
  }
}
