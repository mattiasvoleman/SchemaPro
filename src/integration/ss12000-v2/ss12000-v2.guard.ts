import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WindowedThrottlerStorage } from '../../common/windowed-throttler-storage';
import { PrismaService } from '../../database/prisma.service';
import { HUVUDMAN_KEY_SHAPE, KEY_SHAPE, resolveHuvudmanKey, resolveIntegrationKey, type KeyHuvudman } from '../integration-key';
import { v2Errors } from './errors';
import type { Scope } from './scopes';

/** Per key: v1's 120 a minute, now counted per key and not per address (A5.10). */
export const PER_KEY = { limit: 120, ttl: 60_000 };
/**
 * Per address, FAILED attempts only (no key, a malformed one, an unknown or
 * revoked one): bounds what guessing costs the database. A request whose key
 * resolves never counts here, so one consumer address serving many schools
 * is limited per key alone (A5.10).
 */
export const PER_ADDRESS = { limit: 600, ttl: 60_000 };

export interface Ss12000V2Request extends Request {
  ss12000?: {
    schoolId: string;
    keyId: string;
    scopes: ReadonlySet<Scope>;
    /**
     * Huvudman (20261212090000): the key is a huvudman's (sh_…), and reads
     * these schools one at a time (Ss12000HuvudmanReads); schoolId is then
     * empty, which no service principal opens.
     */
    huvudman?: { huvudman: KeyHuvudman; schools: readonly string[] };
  };
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
  return key && (KEY_SHAPE.test(key) || HUVUDMAN_KEY_SHAPE.test(key)) ? key : null;
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
 * (120 a minute). A per-address bound (600 a minute) counts only attempts
 * that FAIL to authenticate, so unknown keys cannot cost a lookup each
 * without end; once an address is over it, its requests are refused before
 * the lookup until the window passes. Both stores sweep idle keys. A refusal
 * is 429 with Retry-After.
 */
@Injectable()
export class Ss12000V2Guard implements CanActivate {
  // Process-wide, like the limit itself: Nest may build the guard more than
  // once (as a provider and as the controller's injectable).
  private static addresses = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
  private static keys = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
  /** Addresses over the failed-attempt bound, until when (ms). */
  private static blocked = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Ss12000V2Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const address = `ip:${request.ip ?? 'unknown'}`;
    const until = Ss12000V2Guard.blocked.get(address);
    if (until !== undefined) {
      if (until > Date.now()) this.refuse(response, Math.ceil((until - Date.now()) / 1000));
      Ss12000V2Guard.blocked.delete(address);
    }

    const key = presentedKey(request);
    // A huvudman's key (sh_…) or a school's (sp_…), by its prefix.
    const ofHuvudman = key && HUVUDMAN_KEY_SHAPE.test(key) ? await resolveHuvudmanKey(this.prisma, key, { touch: true }) : null;
    const resolved = ofHuvudman ?? (key && KEY_SHAPE.test(key) ? await resolveIntegrationKey(this.prisma, key, { touch: true }) : null);
    if (!resolved) {
      const failed = await Ss12000V2Guard.addresses.increment(address, PER_ADDRESS.ttl, PER_ADDRESS.limit, PER_ADDRESS.ttl, 'v2-address');
      if (failed.isBlocked) {
        if (Ss12000V2Guard.blocked.size > 10_000) Ss12000V2Guard.blocked.clear();
        Ss12000V2Guard.blocked.set(address, Date.now() + failed.timeToBlockExpire * 1000);
        this.refuse(response, failed.timeToBlockExpire);
      }
      throw v2Errors.unauthenticated();
    }

    const byKey = await Ss12000V2Guard.keys.increment(resolved.id, PER_KEY.ttl, PER_KEY.limit, PER_KEY.ttl, 'v2-key');
    if (byKey.isBlocked) this.refuse(response, byKey.timeToBlockExpire);

    request.ss12000 = ofHuvudman
      ? {
          schoolId: '',
          keyId: ofHuvudman.id,
          scopes: new Set(ofHuvudman.scopes),
          huvudman: { huvudman: ofHuvudman.huvudman, schools: ofHuvudman.schools },
        }
      : { schoolId: (resolved as { schoolId: string }).schoolId, keyId: resolved.id, scopes: new Set(resolved.scopes) };
    return true;
  }

  /**
   * One more school read by a huvudman's key's request (Ss12000HuvudmanReads):
   * the key pays the per-key bound once for each school after the first, so
   * a /x/{id} that asks every school, or a lookup, costs what that many
   * requests of a school's key would. 429 when that is over the bound.
   */
  static async chargeSchool(keyId: string): Promise<void> {
    const byKey = await Ss12000V2Guard.keys.increment(keyId, PER_KEY.ttl, PER_KEY.limit, PER_KEY.ttl, 'v2-key');
    if (byKey.isBlocked) throw v2Errors.tooMany();
  }

  /** Forgets every count: the e2e suite's, between specs that share one app. */
  static resetCounters(): void {
    Ss12000V2Guard.addresses = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
    Ss12000V2Guard.keys = new WindowedThrottlerStorage(Date.now, { sweepAbove: 10_000 });
    Ss12000V2Guard.blocked = new Map();
  }

  private refuse(response: Response, seconds: number): never {
    response.setHeader('Retry-After', String(Math.max(seconds, 1)));
    throw v2Errors.tooMany();
  }
}
