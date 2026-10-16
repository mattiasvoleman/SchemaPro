import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';
import { tokenHashOf } from '../publication/public-token';
import { feedTokenOf } from './feed-token';

/**
 * Per feed: a calendar asks every few minutes at most, and twenty in ten
 * minutes is a calendar gone wrong or an address in too many hands.
 */
export const PER_FEED = { limit: 20, ttl: 10 * 60_000 };
/**
 * Per asking address. A calendar service asks for all its users from a few
 * of its own addresses (every school's guardians in one service are
 * thousands of feeds from a handful of addresses, each asked every few
 * minutes), so the bound is wide: what it stops is one address asking the
 * database fifty times a second, which the feeds' own limit cannot. A
 * guessed address is no threat at any rate (a token is 256 bits).
 */
export const PER_CLIENT = { limit: 3000, ttl: 60_000 };
/** Keys either store holds before it first sweeps the idle ones (WindowedThrottlerStorage). */
export const SWEEP_ABOVE = 10_000;

/**
 * The calendar feed's own rate limit (Kalenderprenumeration,
 * 20261112091000), in place of the global one, as the public viewer has
 * its own: calendars, not people, ask, and the global per-address bucket
 * would put a whole calendar service's users in one.
 *
 *   per client  the asking address (the API's trusted proxy hop decides
 *               request.ip); no header of the caller's moves it;
 *   per feed    the address's hash, whoever asks, counted only for a
 *               request the client limit let through and only for a token
 *               of a feed's shape, so a refused or malformed request costs
 *               no feed a hit and grows no map.
 *
 * A refusal is 429 with Retry-After and Cache-Control: no-store, and the
 * feed's noindex and no-referrer, as every answer of it carries.
 */
@Injectable()
export class CalendarFeedThrottlerGuard implements CanActivate {
  private readonly clients = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });
  private readonly feeds = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const byClient = await this.clients.increment(
      `ip:${request.ip ?? 'unknown'}`,
      PER_CLIENT.ttl,
      PER_CLIENT.limit,
      PER_CLIENT.ttl,
      'calendar-feed-client',
    );
    if (byClient.isBlocked) this.refuse(response, byClient.timeToBlockExpire);
    const token = feedTokenOf(request.params?.['file']);
    // A token that cannot be a feed is the controller's 404; it costs no feed a hit.
    if (token === null) return true;
    const byFeed = await this.feeds.increment(tokenHashOf(token), PER_FEED.ttl, PER_FEED.limit, PER_FEED.ttl, 'calendar-feed');
    if (byFeed.isBlocked) this.refuse(response, byFeed.timeToBlockExpire);
    return true;
  }

  private refuse(response: Response, seconds: number): never {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', String(Math.max(seconds, 1)));
    throw new ThrottlerException();
  }

  /** Keys held, for the tests that bound them. */
  get keysHeld(): { clients: number; feeds: number } {
    return { clients: this.clients.size, feeds: this.feeds.size };
  }
}
