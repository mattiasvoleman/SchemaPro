import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';

/**
 * What one login may ask of each of the two reads that build a grid in the API
 * process (a week of a large school weighs up to 2 MB). A person loading the
 * page, stepping through days and searching for who is free stays well below it.
 */
export const PER_LOGIN = { limit: 30, ttl: 60_000 };
/**
 * Per address, the global ThrottlerGuard's bucket for each of the two routes: a
 * ceiling against one address with many logins. A school's staff arrive from
 * one address (a NAT) and open the page together, which a bucket of 30 would
 * have refused for most of them; the cost of one request is bounded by the
 * login's own bucket, so this one only has to stop a flood.
 */
export const PER_ADDRESS = { limit: 1200, ttl: 60_000 };
/** Keys held before the store first sweeps the idle ones (WindowedThrottlerStorage). */
export const SWEEP_ABOVE = 10_000;
/** The refusal's code, which the web says calmly instead of "could not be fetched". */
export const RATE_LIMITED = 'SCHOOL_DAY_RATE_LIMITED';

/**
 * The rate limit of GET /api/v1/school-day and /school-day/free, per verified
 * login and route in place of the global guard's per address.
 *
 * The web asks the API directly from each person's browser, so the address a
 * request arrives from is the school's NAT: the global guard's 30 a minute
 * would be one bucket for every teacher of a school, 60 teachers opening the
 * page together got 30 errors, and the block (a minute for the whole address)
 * took the view of everyone whose poll then fell due. So this guard keys on the
 * login, which JwtAuthGuard has set by the time a controller's guards run, and
 * the global guard keeps a high ceiling per address (PER_ADDRESS). A request
 * without a login (it would be refused anyway) keys on its address. The key is
 * a hash, so the store holds no login id. The route is part of the key: the
 * grid and the search each have their own quota.
 *
 * The refusal is 429 with Retry-After and the code RATE_LIMITED, which the
 * exception filter keeps.
 */
@Injectable()
export class SchoolDayThrottlerGuard implements CanActivate {
  private readonly logins = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const who = request.user?.authId ? `login:${request.user.authId}` : `ip:${request.ip ?? 'unknown'}`;
    const key = createHash('sha256').update(`${context.getHandler().name}:${who}`).digest('hex');
    const seen = await this.logins.increment(key, PER_LOGIN.ttl, PER_LOGIN.limit, PER_LOGIN.ttl, 'school-day');
    if (seen.isBlocked) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('Retry-After', String(Math.max(seen.timeToBlockExpire, 1)));
      throw new HttpException(
        { message: 'Too many requests for Skolans dag; wait a minute.', code: RATE_LIMITED },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Keys held, for the tests that bound them. */
  get keysHeld(): number {
    return this.logins.size;
  }
}
