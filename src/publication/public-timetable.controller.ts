import { createHash } from 'node:crypto';
import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { PublicViewerThrottlerGuard } from './public-viewer-throttler.guard';
import { TOKEN_PATTERN, tokenHashOf } from './public-token';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar day in a sane span. `Date.parse` is no test: V8 rolls
 * 2026-02-30 over into March, and Postgres then refuses the ::date cast with
 * 22008 — an unauthenticated 500 and an ERROR line per request, before the
 * token is even looked up. Round-tripped instead, as the web's own check is.
 */
export function isViewerDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Schemavisaren: the PUBLISHED timetable of a class, a teacher or a room,
 * without logging in, behind a share link (migration 20261011120000).
 *
 * Everything it shows is decided in the database, by app.public_timetable()
 * — a whitelist the API cannot widen. The API only:
 *
 *   - answers ONE 404, byte for byte, for every link that does not resolve
 *     (malformed, unknown, revoked, switched off, target gone or hidden), so
 *     a guess learns nothing;
 *   - caches for a minute and no longer (public, max-age=60, s-maxage=60,
 *     no stale-while-revalidate): a revoked link is gone within a minute
 *     everywhere, and a 404 or a 429 is never stored;
 *   - tags every answer noindex, nofollow and no-referrer, sets no cookie,
 *     and answers a weak ETag over the document so a reload is a 304;
 *   - rate-limits per viewer address and per link (PublicViewerThrottlerGuard),
 *     skipping the global limit, which would put every family behind the web
 *     server in one bucket.
 *
 * GET :token/embed answers which websites may frame the link's viewer page
 * (20261102090000, app.public_timetable_embed): the web server's
 * frame-ancestors for /v/<token>/embed. The same 404 for a link that may not
 * be embedded as for one that does not exist, and the same minute of
 * caching, so a school that switches embedding off is out of the frame
 * within a minute, as a revoked link is gone.
 */
@Controller('public/v1/timetables')
@Public()
@SkipThrottle()
@UseGuards(PublicViewerThrottlerGuard)
export class PublicTimetableController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':token')
  async show(
    @Param('token') token: string,
    @Query('target') target: string | undefined,
    @Query('date') date: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Set by hand: with @Res() Nest's @Header decorators are not applied.
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const document = await this.read(token, target, date);
    if (document === null) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).json(NOT_FOUND);
      return;
    }
    const body = JSON.stringify(document);
    const etag = `W/"${createHash('sha256').update(body).digest('base64url')}"`;
    response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }
    response.status(200).type('application/json').send(body);
  }

  @Get(':token/embed')
  async embed(@Param('token') token: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const origins = await this.readEmbed(token);
    if (origins === null) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).json(NOT_FOUND);
      return;
    }
    const body = JSON.stringify({ frameAncestors: origins });
    const etag = `W/"${createHash('sha256').update(body).digest('base64url')}"`;
    // Kept a minute by the web server that asked, and by no cache between:
    // a school that switches embedding off is out of every frame within
    // that minute, whatever stands in front of the gateway.
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }
    response.status(200).type('application/json').send(body);
  }

  private async readEmbed(token: string): Promise<string[] | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const hash = tokenHashOf(token);
    const rows = await this.prisma.withPublicViewer((tx) =>
      tx.$queryRaw<{ origins: string[] | null }[]>(
        Prisma.sql`SELECT app.public_timetable_embed(${hash}) AS "origins"`,
      ),
    );
    const origins = rows?.[0]?.origins ?? null;
    return origins && origins.length > 0 ? origins : null;
  }

  private async read(token: string, target: string | undefined, date: string | undefined): Promise<unknown | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    if (target !== undefined && !UUID.test(target)) return null;
    if (date !== undefined && (typeof date !== 'string' || !isViewerDate(date))) return null;
    const hash = tokenHashOf(token);
    const rows = await this.prisma.withPublicViewer((tx) =>
      tx.$queryRaw<{ doc: unknown }[]>(
        Prisma.sql`SELECT app.public_timetable(${hash}, ${target ?? null}::uuid, ${date ?? null}::date) AS "doc"`,
      ),
    );
    return rows?.[0]?.doc ?? null;
  }
}

/** The one answer for every link that does not resolve. */
export const NOT_FOUND = { type: 'about:blank', title: 'Not Found', status: 404, detail: 'Schemat finns inte.' } as const;
