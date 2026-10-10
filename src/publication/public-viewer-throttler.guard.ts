import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { PublicViewerConfig } from '../config/configuration';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';
import { TOKEN_PATTERN, tokenHashOf } from './public-token';

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
 *   per client  X-Viewer-Client-Ip, but only beside X-Viewer-Proxy-Key equal
 *               (in constant time) to PUBLIC_VIEWER_PROXY_KEY — the web server
 *               says whose request it forwards; anybody else's header is
 *               ignored and the caller's own address is used;
 *   per link    the token's hash, whoever asks — counted only for a request
 *               the client limit let through, and only for a token of the
 *               link's shape. A refused request costing the link a hit let
 *               one address lock a link for every family by sending 600 a
 *               minute; a malformed token costing a key let anyone grow the
 *               map for ever with random paths. Both stores also sweep their
 *               idle keys (SWEEP_ABOVE).
 *
 * A refusal is 429 with Cache-Control: no-store, so no cache keeps it, and
 * the viewer's noindex and no-referrer, as every answer of it carries.
 */
@Injectable()
export class PublicViewerThrottlerGuard implements CanActivate {
  private readonly clients = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });
  private readonly links = new WindowedThrottlerStorage(Date.now, { sweepAbove: SWEEP_ABOVE });
  private readonly proxyKey: Buffer | null;

  constructor(config: ConfigService) {
    const key = config.get<PublicViewerConfig>('publicViewer')?.proxyKey;
    this.proxyKey = key ? Buffer.from(key) : null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const client = this.clientOf(request);
    const byClient = await this.clients.increment(client, PER_CLIENT.ttl, PER_CLIENT.limit, PER_CLIENT.ttl, 'viewer-client');
    if (byClient.isBlocked) this.refuse(response, byClient.timeToBlockExpire);
    const token = typeof request.params?.['token'] === 'string' ? request.params['token'] : '';
    // A token that cannot be a link is the controller's 404; it costs no link a hit.
    if (!TOKEN_PATTERN.test(token)) return true;
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

  /** The viewer's address: the web server's word for it, if the web server proves it is speaking. */
  clientOf(request: Request): string {
    const forwarded = request.headers['x-viewer-client-ip'];
    const key = request.headers['x-viewer-proxy-key'];
    if (this.proxyKey && typeof forwarded === 'string' && typeof key === 'string' && forwarded.length <= 64) {
      const given = Buffer.from(key);
      if (given.length === this.proxyKey.length && timingSafeEqual(given, this.proxyKey)) return `fwd:${forwarded.trim()}`;
    }
    return `ip:${request.ip ?? 'unknown'}`;
  }
}
