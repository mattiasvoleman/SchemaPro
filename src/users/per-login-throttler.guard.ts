import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';

/** Per login: a person loading pages, many tabs open, stays far below it. */
export const PER_LOGIN = { limit: 120, ttl: 60_000 };
/**
 * Per address, the global ThrottlerGuard's bucket for this route alone: the
 * web server asks from one address for every person whose login is marked
 * as several schools'. Past it the switcher is missing for a minute and the
 * pages render as for one school.
 */
export const PER_ADDRESS = { limit: 6000, ttl: 60_000 };
/** Keys held before the store first sweeps the idle ones (WindowedThrottlerStorage). */
export const SWEEP_ABOVE = 10_000;

/**
 * GET /api/v1/me/schools's rate limit, in place of the global one (Flera
 * skolor per inloggning).
 *
 * The web asks for the login's schools from its server, on every page it
 * renders for a login with several schools (web/lib/auth.ts), so every
 * request arrives from the web server's address. The global ThrottlerGuard
 * keys on req.ip: at its 120 a minute, one bucket for every such person of
 * every school, and the switcher would vanish for all of them as soon as a
 * school was busy. So the controller gives the global guard a bucket of its
 * own for this route (PER_ADDRESS), and this guard keys on the verified
 * login, which JwtAuthGuard has set by the time a controller's guards run;
 * a request without one (it would be refused anyway) keys on its address.
 * The key is a hash, so the store holds no login id. Like every route's,
 * both run after JwtAuthGuard (the global guards' order, app.module.ts).
 */
@Injectable()
export class PerLoginThrottlerGuard implements CanActivate {
  private readonly logins = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const who = request.user?.authId ? `login:${request.user.authId}` : `ip:${request.ip ?? 'unknown'}`;
    const key = createHash('sha256').update(who).digest('hex');
    const seen = await this.logins.increment(key, PER_LOGIN.ttl, PER_LOGIN.limit, PER_LOGIN.ttl, 'login');
    if (seen.isBlocked) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('Retry-After', String(Math.max(seen.timeToBlockExpire, 1)));
      throw new ThrottlerException();
    }
    return true;
  }

  /** Keys held, for the tests that bound them. */
  get keysHeld(): number {
    return this.logins.size;
  }
}
