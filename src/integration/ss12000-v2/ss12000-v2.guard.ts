import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WindowedThrottlerStorage } from '../../common/windowed-throttler-storage';
import { PrismaService } from '../../database/prisma.service';
import { KEY_SHAPE, resolveIntegrationKey } from '../integration-key';
import { v2Errors } from './errors';
import type { Scope } from './scopes';

/** Per key: v1's 120 a minute, now counted per key and not per address (A5.10). */
export const PER_KEY = { limit: 120, ttl: 60_000 };
/** Per address, before a key is resolved: bounds what unknown keys cost the database. */
export const PER_ADDRESS = { limit: 600, ttl: 60_000 };

export interface Ss12000V2Request extends Request {
  ss12000?: { schoolId: string; keyId: string; scopes: ReadonlySet<Scope> };
}

/** The presented key: S1's BearerAuth (`Authorization: Bearer sp_…`) or the house's `X-API-Key`. */
export function presentedKey(request: Request): string | null {
  const authorization = request.headers['authorization'];
  const header = request.headers['x-api-key'];
  const bearer =
    typeof authorization === 'string' && /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : null;
  const apiKey = typeof header === 'string' ? header.trim() : null;
  if (bearer && apiKey && bearer !== apiKey) return null;
  const key = bearer ?? apiKey;
  return key && KEY_SHAPE.test(key) ? key : null;
}

/**
 * Authenticates /ss12000/v2.0 and limits it per key.
 *
 * S1's securitySchemes is BearerAuth (http, bearer). The integration key is
 * that bearer: an opaque token the provider issued (bearerFormat "JWT" is a
 * documentation hint, not a rule a static token can break). X-API-Key is
 * accepted too, as v1 takes it. One lookup reads the key, its school and its
 * scopes (resolveIntegrationKey); an unknown, revoked or malformed key is
 * 401 with `WWW-Authenticate: Bearer` in S1's Error shape.
 *
 * The global ThrottlerGuard keys on req.ip, so one Vklass address serving
 * many schools would share one bucket; v2 skips it and counts per key here
 * (120 a minute), after a per-address bound on attempts (600 a minute)
 * that keeps unknown keys from costing a lookup each without end. Both
 * stores sweep idle keys. A refusal is 429 with Retry-After.
 */
@Injectable()
export class Ss12000V2Guard implements CanActivate {
  // Process-wide, like the limit itself: Nest may build the guard more than
  // once (as a provider and as the controller's injectable).
  private static addresses = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
  private static keys = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Ss12000V2Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const byAddress = await Ss12000V2Guard.addresses.increment(`ip:${request.ip ?? 'unknown'}`, PER_ADDRESS.ttl, PER_ADDRESS.limit, PER_ADDRESS.ttl, 'v2-address');
    if (byAddress.isBlocked) this.refuse(response, byAddress.timeToBlockExpire);

    const key = presentedKey(request);
    if (!key) throw v2Errors.unauthenticated();
    const resolved = await resolveIntegrationKey(this.prisma, key, { touch: true });
    if (!resolved) throw v2Errors.unauthenticated();

    const byKey = await Ss12000V2Guard.keys.increment(resolved.id, PER_KEY.ttl, PER_KEY.limit, PER_KEY.ttl, 'v2-key');
    if (byKey.isBlocked) this.refuse(response, byKey.timeToBlockExpire);

    request.ss12000 = { schoolId: resolved.schoolId, keyId: resolved.id, scopes: new Set(resolved.scopes) };
    return true;
  }

  /** Forgets every count: the e2e suite's, between specs that share one app. */
  static resetCounters(): void {
    Ss12000V2Guard.addresses = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
    Ss12000V2Guard.keys = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
  }

  private refuse(response: Response, seconds: number): never {
    response.setHeader('Retry-After', String(Math.max(seconds, 1)));
    throw v2Errors.tooMany();
  }
}
