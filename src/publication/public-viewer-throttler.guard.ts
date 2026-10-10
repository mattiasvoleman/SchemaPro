import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { PublicViewerConfig } from '../config/configuration';
import { WindowedThrottlerStorage } from '../common/windowed-throttler-storage';
import { tokenHashOf } from './public-token';

/** Per viewer address: a class opening the link at 08:00 is thirty addresses. */
export const PER_CLIENT = { limit: 120, ttl: 60_000 };
/** Per link, whoever reads it: a link scraped from many addresses still stops. */
export const PER_LINK = { limit: 600, ttl: 60_000 };

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
 *   per link    the token's hash, whoever asks.
 *
 * A refusal is 429 with Cache-Control: no-store, so no cache keeps it.
 */
@Injectable()
export class PublicViewerThrottlerGuard implements CanActivate {
  private readonly clients = new WindowedThrottlerStorage();
  private readonly links = new WindowedThrottlerStorage();
  private readonly proxyKey: Buffer | null;

  constructor(config: ConfigService) {
    const key = config.get<PublicViewerConfig>('publicViewer')?.proxyKey;
    this.proxyKey = key ? Buffer.from(key) : null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const client = this.clientOf(request);
    const token = typeof request.params?.['token'] === 'string' ? request.params['token'] : '';
    const [byClient, byLink] = await Promise.all([
      this.clients.increment(client, PER_CLIENT.ttl, PER_CLIENT.limit, PER_CLIENT.ttl, 'viewer-client'),
      this.links.increment(tokenHashOf(token), PER_LINK.ttl, PER_LINK.limit, PER_LINK.ttl, 'viewer-link'),
    ]);
    if (byClient.isBlocked || byLink.isBlocked) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Retry-After', String(Math.max(byClient.timeToBlockExpire, byLink.timeToBlockExpire, 1)));
      throw new ThrottlerException();
    }
    return true;
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
