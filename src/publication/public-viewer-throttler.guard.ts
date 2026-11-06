import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';
import { tokenHashOf, viewerTokenOf } from './public-token';
import { MISSES, ViewerMissLimiter } from './viewer-miss-limiter';

/** Per viewer address: a class opening the link at 08:00 is thirty addresses. */
export const PER_CLIENT = { limit: 120, ttl: 60_000 };
/** Per link, whoever reads it: a link scraped from many addresses still stops. */
export const PER_LINK = { limit: 600, ttl: 60_000 };
/** Keys either store holds before it first sweeps the idle ones (WindowedThrottlerStorage). */
export const SWEEP_ABOVE = 10_000;

/**
 * The public viewer's own rate limit, in place of the global one.
 *
 * The global ThrottlerGuard keys on req.ip, and every family reading a
 * timetable through the web arrives from the web server's address — one
 * bucket for the whole school. Adding a named throttler to ThrottlerModule
 * would instead apply it to EVERY route of the API (the guard is global),
 * changing every DIRECT school's limits. So the viewer's controller skips the
 * global guard and this one keys twice, in storages of its own:
 *
 *   per client  the viewer's address as ViewerMissLimiter decides it (the web
 *               server's word for it, only beside its proxy key);
 *   per link    the token's hash, whoever asks — counted only for a request
 *               the client limit let through, and only for a token of the
 *               link's shape. A refused request costing the link a hit let
 *               one address lock a link for every family by sending 600 a
 *               minute; a malformed token costing a key let anyone grow the
 *               map for ever with random paths. Both stores also sweep their
 *               idle keys (SWEEP_ABOVE).
 *
 * And a third, charged after the fact: an address that has asked for too
 * many links or codes that do not exist is refused outright for a while
 * (ViewerMissLimiter), before the database is asked.
 *
 * A refusal is 429 with Cache-Control: no-store, so no cache keeps it, and
 * the viewer's noindex and no-referrer, as every answer of it carries.
 */
@Injectable()
export class PublicViewerThrottlerGuard implements CanActivate {
  private readonly clients = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });
  private readonly links = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });

  constructor(private readonly limiter: ViewerMissLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const client = this.limiter.clientOf(request);
    const byClient = await this.clients.increment(client, PER_CLIENT.ttl, PER_CLIENT.limit, PER_CLIENT.ttl, 'viewer-client');
    if (byClient.isBlocked) this.refuse(response, byClient.timeToBlockExpire);
    if (this.limiter.spent(client)) this.refuse(response, MISSES.block / 1000);
    const token = viewerTokenOf(request.params?.['token']);
    // A token that cannot be a link is the controller's 404; it costs no link a hit.
    if (token === null) return true;
    const byLink = await this.links.increment(tokenHashOf(token), PER_LINK.ttl, PER_LINK.limit, PER_LINK.ttl, 'viewer-link');
    if (byLink.isBlocked) this.refuse(response, byLink.timeToBlockExpire);
    return true;
  }

  private refuse(response: Response, seconds: number): never {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', String(Math.max(seconds, 1)));
    throw new ThrottlerException();
  }

  /** Keys held, for the tests that bound them. */
  get keysHeld(): { clients: number; links: number } {
    return { clients: this.clients.size, links: this.links.size };
  }
}
