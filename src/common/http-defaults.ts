import { BadRequestException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { REQUEST_BODY_NOT_JSON, REQUEST_BODY_NOT_JSON_DETAIL } from './filters/http-exception.filter';

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
 *
 * NO COMPRESSED REQUEST BODIES (`inflate: false`). No client of this API sends
 * one: the web and the app post plain JSON, and the integrations' imports are
 * plain JSON or form bodies. body-parser's inflate path is where
 * GHSA-27r3-jxmh-p828 lives (trailing bytes after a compressed body exhaust
 * the server), so a body with Content-Encoding gzip, deflate or br is refused
 * with 415 before anything decompresses it, whatever body-parser version runs.
 * Responses are unaffected: this concerns what the API reads, not what it
 * sends.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: MAX_BODY_SIZE, inflate: false });
  app.useBodyParser('urlencoded', { limit: MAX_BODY_SIZE, extended: true, inflate: false });
  // Straight after the parsers, which the adapter registers as it is told: an error middleware sees only what is registered before it.
  app.use(jsonParseRefusal);
}

/**
 * A body that is not JSON, as the one answer a page can word: a 400 with the code REQUEST_BODY_NOT_JSON.
 *
 * body-parser throws a SyntaxError carrying `type: 'entity.parse.failed'`, and Nest maps every SyntaxError to
 * `new BadRequestException(error.message)` before an exception filter is asked (routes-resolver.js, mapExternalException). What
 * a client got was Node's own sentence ("Unexpected end of JSON input", worded by the engine's version of V8) and no code, so the
 * filter's own branch for `entity.parse.failed` was never reached over HTTP (the review of #415, LÅG-1). This is an Express
 * error middleware (four arguments, which is how Express knows), and it passes every other error on as it came.
 */
export function jsonParseRefusal(error: unknown, _request: unknown, _response: unknown, next: (error?: unknown) => void): void {
  const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
  next(
    type === 'entity.parse.failed'
      ? new BadRequestException({ message: REQUEST_BODY_NOT_JSON_DETAIL, code: REQUEST_BODY_NOT_JSON })
      : error,
  );
}
