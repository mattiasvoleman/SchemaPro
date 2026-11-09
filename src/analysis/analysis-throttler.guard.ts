import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';

/**
 * What one login may ask of each of the four views of Analys och planering,
 * which build a school's figures in the API process (a roster of 2 000 pupils
 * and a report of 120 teachers). A person opening the page and stepping
 * through years stays far below it.
 */
export const PER_LOGIN = { limit: 20, ttl: 60_000 };
/**
 * Per address, the global ThrottlerGuard's bucket for these routes: a ceiling
 * against one address with many logins. A school's staff arrive from one
 * address (a NAT), so the login's bucket is the real limit and this one only
 * has to stop a flood (throttle-per-login, not per address).
 */
export const PER_ADDRESS = { limit: 600, ttl: 60_000 };
/** Keys held before the store first sweeps the idle ones (WindowedThrottlerStorage). */
export const SWEEP_ABOVE = 10_000;
/** The refusal's code, which the web says calmly instead of "could not be fetched". */
export const ANALYSIS_RATE_LIMITED = 'ANALYSIS_RATE_LIMITED';

/**
 * The rate limit of the four views, per verified login and route in place of
 * the global guard's per address (see SchoolDayThrottlerGuard, which this is
 * the pattern of): JwtAuthGuard has set the login by the time a controller's
 * guards run, a request without one keys on its address, the key is a hash,
 * and the refusal is 429 with Retry-After and a code the web words.
 */
@Injectable()
export class AnalysisThrottlerGuard implements CanActivate {
  private readonly logins = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const who = request.user?.authId ? `login:${request.user.authId}` : `ip:${request.ip ?? 'unknown'}`;
    const key = createHash('sha256').update(`${context.getHandler().name}:${who}`).digest('hex');
    const seen = await this.logins.increment(key, PER_LOGIN.ttl, PER_LOGIN.limit, PER_LOGIN.ttl, 'analysis');
    if (seen.isBlocked) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('Retry-After', String(Math.max(seen.timeToBlockExpire, 1)));
      throw new HttpException(
        { message: 'Too many requests for Analys och planering; wait a minute.', code: ANALYSIS_RATE_LIMITED },
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
