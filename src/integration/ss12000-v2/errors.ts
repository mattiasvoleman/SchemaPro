import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

/**
 * The v2.0 provider's errors, in S1's shape and nothing else.
 *
 * S1 Error is {code: string, message: string}, both required; 404 has NO
 * body (404_not_found); 400 is 400_invalid_filter or 400_invalid_id, 403
 * 403_not_authorised, 503 503_overload. 401 is not in S1 (it has 403 and
 * `default`): it is SchemaPro's extension for a missing or unknown key, an
 * Error body with `WWW-Authenticate: Bearer`, as RFC 6750 says. 429 is the
 * per-key limit, also an extension. Codes:
 *
 *   400 INVALID_FILTER         a parameter S1 does not define here, or a value
 *                              that is not what S1's schema says
 *   400 INVALID_ID             a path id that is not a uuid
 *   400 INVALID_PAGE_TOKEN     a token not ours, of another key or resource,
 *                              or with a parameter that differs from the
 *                              token's (S1: a token "kan inte kombineras med
 *                              andra filter men väl med limit")
 *   400 SORTKEY_NOT_SUPPORTED  a sortkey on a field SchemaPro never holds
 *   400 INVALID_BODY           a lookup or subscription body S1 does not shape
 *   401 UNAUTHENTICATED
 *   403 SCOPE_MISSING          the key's scopes do not reach the resource,
 *                              the expand or the referenced names
 *   409 WEBHOOK_SECRET_MISSING / SUBSCRIPTION_LIMIT
 *   429 TOO_MANY_REQUESTS
 *   503 TOO_LARGE
 *
 * The message is a fixed Swedish sentence per code (with at most a
 * parameter NAME), never a value a consumer sent.
 */
export class Ss12000V2Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Ss12000V2Error';
  }
}

export const v2Errors = {
  invalidFilter: (name: string) => new Ss12000V2Error(400, 'INVALID_FILTER', `Parametern ${name} gäller inte här, eller har ett värde som inte följer SS12000 2.1.0.`),
  invalidId: () => new Ss12000V2Error(400, 'INVALID_ID', 'Id:t är inget uuid.'),
  invalidPageToken: () => new Ss12000V2Error(400, 'INVALID_PAGE_TOKEN', 'pageToken kan bara kombineras med limit, och bara med samma parametrar som gav den.'),
  sortkeyNotSupported: () => new Ss12000V2Error(400, 'SORTKEY_NOT_SUPPORTED', 'SchemaPro har inte fältet den sorteringen gäller.'),
  invalidBody: () => new Ss12000V2Error(400, 'INVALID_BODY', 'Anropets innehåll följer inte SS12000 2.1.0.'),
  unauthenticated: () => new Ss12000V2Error(401, 'UNAUTHENTICATED', 'Ange en giltig integrationsnyckel som Bearer eller X-API-Key.'),
  scopeMissing: (scope: string) => new Ss12000V2Error(403, 'SCOPE_MISSING', `Nyckeln saknar omfånget ${scope}.`),
  notFound: () => new Ss12000V2Error(404, 'NOT_FOUND', ''),
  webhookSecretMissing: () => new Ss12000V2Error(409, 'WEBHOOK_SECRET_MISSING', 'Skolan har inte skapat någon signeringsnyckel för den här nyckeln ännu.'),
  subscriptionLimit: () => new Ss12000V2Error(409, 'SUBSCRIPTION_LIMIT', 'Nyckeln har redan tio aktiva prenumerationer.'),
  tooMany: () => new Ss12000V2Error(429, 'TOO_MANY_REQUESTS', 'För många anrop med den här nyckeln; försök igen om en stund.'),
  tooLarge: () => new Ss12000V2Error(503, 'TOO_LARGE', 'Svaret är för stort; använd limit och pageToken eller ett snävare urval.'),
} as const;

/**
 * Answers every v2 failure as S1's Error, and logs the method, the PATH and
 * the status — never the query string. The house filter logs request.url,
 * and a consumer's civicNo=, nameContains= or eduPersonPrincipalName= would
 * put a personnummer, a name or an email into the log on any 4xx; neither the
 * query nor the body is read here.
 */
@Catch()
export class Ss12000V2ExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Ss12000V2');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const { status, code, message } = this.normalise(exception);
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const line = `${request.method} ${path} -> ${status} ${code}`;
    if (status >= 500 && status !== 503) {
      this.logger.error(line, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(line);
    }
    response.setHeader('Cache-Control', 'no-store');
    if (status === HttpStatus.UNAUTHORIZED) response.setHeader('WWW-Authenticate', 'Bearer');
    if (status === HttpStatus.NOT_FOUND) {
      response.status(status).end();
      return;
    }
    response.status(status).json({ code, message });
  }

  private normalise(exception: unknown): { status: number; code: string; message: string } {
    if (exception instanceof Ss12000V2Error) {
      return { status: exception.status, code: exception.code, message: exception.message };
    }
    if (exception instanceof ThrottlerException) {
      const error = v2Errors.tooMany();
      return { status: error.status, code: error.code, message: error.message };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.NOT_FOUND) return { status, code: 'NOT_FOUND', message: '' };
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) return { status, code: 'PAYLOAD_TOO_LARGE', message: 'Anropet är för stort.' };
      if (status === HttpStatus.BAD_REQUEST) return { status, code: 'INVALID_BODY', message: v2Errors.invalidBody().message };
      return { status, code: `HTTP_${status}`, message: 'Anropet kunde inte utföras.' };
    }
    return { status: 500, code: 'INTERNAL', message: 'Ett oväntat fel inträffade.' };
  }
}
