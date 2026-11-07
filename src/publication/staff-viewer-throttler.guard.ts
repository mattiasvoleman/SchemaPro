import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { tokenHashOf, viewerTokenOf } from './public-token';
import { MISSES, PER_PERSON, PER_STAFF_LINK, ViewerMissLimiter } from './viewer-miss-limiter';

/**
 * The staff route's limits (GET /api/v1/schemavisaren/:token), in place of the
 * global one, which keys on the caller's address: these requests come from
 * the web server, and every teacher reading the viewer would share one
 * bucket. Three, all after the sign-in and the role have been checked:
 *
 *   per person   what one signed-in person may read in a minute, so that one
 *                account, or one stolen token, cannot hold the API's
 *                connections for every school;
 *   per link     what one link may be read through this route in a minute,
 *                whoever reads it (the public route has its own);
 *   misses       a person who has asked for too many links or codes that do
 *                not exist is refused for a while (ViewerMissLimiter); the
 *                route counts the miss when it answers its not-found.
 *
 * A signed-in teacher reading a week is a hit and costs nobody a miss.
 *
 * Every answer of the route, a refusal included, is for that caller alone:
 * private, no-store, noindex, no referrer. A refusal is 429 with Retry-After.
 */
@Injectable()
export class StaffViewerThrottlerGuard implements CanActivate {
  constructor(private readonly limiter: ViewerMissLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const user = request.user;
    if (!user) return true; // JwtAuthGuard answers a request with no person before this is asked.
    const who = `user:${user.userId ?? user.authId}`;
    if (this.limiter.spent(who)) this.refuse(response, MISSES.block / 1000);
    const person = await this.limiter.charge(who, PER_PERSON);
    if (person > 0) this.refuse(response, person);
    const token = viewerTokenOf(request.params?.['token']);
    if (token !== null) {
      const link = await this.limiter.charge(`link:${tokenHashOf(token)}`, PER_STAFF_LINK);
      if (link > 0) this.refuse(response, link);
    }
    return true;
  }

  private refuse(response: Response, seconds: number): never {
    response.setHeader('Retry-After', String(Math.max(Math.ceil(seconds), 1)));
    throw new ThrottlerException();
  }
}
