import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The largest body the API accepts.
 *
 * Express defaults to 100 kB, which is smaller than the biggest payload the
 * import DTOs themselves permit — 2000 teaching-group membership rows is about
 * 130 kB — so the declared `@ArrayMaxSize` caps were unreachable and a real
 * school file was refused by the transport before validation ever saw it. The
 * row caps, not the byte count, are what should bound an import; this is sized
 * to fit every declared cap with headroom.
 */
export const MAX_BODY_SIZE = '1mb';

/**
 * HTTP-layer settings that must be identical in production and under test.
 *
 * Kept out of `main.ts` because the e2e harness builds its own application and
 * would otherwise run with different limits than production — which is exactly
 * how an oversized-import bug reached a live school while the suite stayed
 * green.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  app.useBodyParser('urlencoded', { limit: MAX_BODY_SIZE, extended: true });
}
