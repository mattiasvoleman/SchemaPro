import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import type { ProblemDetails } from '../interfaces/problem-details.interface';

interface NormalizedError {
  status: number;
  title: string;
  detail: string;
  errors?: Record<string, string[]>;
}

/**
 * Catches every unhandled error and renders an RFC-7807 `application/problem+json`
 * response. Internal details (stack traces, SQL, Prisma metadata, PII) are
 * logged server-side under a correlation id but NEVER returned to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const traceId = randomUUID();
    const normalized = this.normalize(exception);

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: normalized.title,
      status: normalized.status,
      detail: normalized.detail,
      instance: request.originalUrl ?? request.url,
      traceId,
      ...(normalized.errors ? { errors: normalized.errors } : {}),
    };

    this.logError(exception, normalized, traceId, request);

    response
      .status(normalized.status)
      .setHeader('Content-Type', 'application/problem+json')
      .json(problem);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        title: 'Bad Request',
        detail: 'The request could not be processed.',
      };
    }

    const bodyParser = this.fromBodyParserError(exception);
    if (bodyParser) {
      return bodyParser;
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      title: 'Internal Server Error',
      detail: 'An unexpected error occurred. Please try again later.',
    };
  }

  /**
   * body-parser rejects a malformed or oversized body with a plain `Error`
   * carrying a `type` discriminator — not an `HttpException`. Without this it
   * fell through to the catch-all above, so a CSV import one row too large
   * came back as "an unexpected error occurred" with a 500, sending the caller
   * looking for a server fault that did not exist.
   *
   * Matched on `type` rather than on the `status` property these errors also
   * carry: an arbitrary thrown object must never be able to pick its own
   * response status.
   */
  private fromBodyParserError(exception: unknown): NormalizedError | null {
    if (!(exception instanceof Error)) return null;
    const type = (exception as Error & { type?: unknown }).type;

    switch (type) {
      case 'entity.too.large':
        return {
          status: HttpStatus.PAYLOAD_TOO_LARGE,
          title: this.titleFor(HttpStatus.PAYLOAD_TOO_LARGE),
          detail:
            'The request body is too large. Split the import into smaller ' +
            'files and upload them one at a time.',
        };
      case 'entity.parse.failed':
        return {
          status: HttpStatus.BAD_REQUEST,
          title: this.titleFor(HttpStatus.BAD_REQUEST),
          detail: 'The request body is not valid JSON.',
        };
      case 'encoding.unsupported':
        return {
          status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
          title: this.titleFor(HttpStatus.UNSUPPORTED_MEDIA_TYPE),
          detail: 'The request body uses an unsupported content encoding.',
        };
      default:
        return null;
    }
  }

  private fromHttpException(exception: HttpException): NormalizedError {
    const status = exception.getStatus();
    const body = exception.getResponse();
    const title = this.titleFor(status);

    if (typeof body === 'string') {
      return { status, title, detail: body };
    }

    const record = body as Record<string, unknown>;
    const rawMessage = record.message;

    // class-validator (via ValidationPipe) returns an array of messages.
    if (Array.isArray(rawMessage)) {
      return {
        status,
        title,
        detail: 'One or more fields failed validation.',
        errors: { body: rawMessage.map((message) => String(message)) },
      };
    }

    return {
      status,
      title,
      detail:
        typeof rawMessage === 'string' ? rawMessage : this.detailFor(status),
    };
  }

  private fromPrismaError(
    exception: Prisma.PrismaClientKnownRequestError,
  ): NormalizedError {
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          title: 'Conflict',
          detail: 'A resource with the same unique identifier already exists.',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          title: 'Not Found',
          detail: 'The requested resource does not exist.',
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          title: 'Bad Request',
          detail: 'The request references a resource that does not exist.',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          title: 'Internal Server Error',
          detail: 'An unexpected database error occurred.',
        };
    }
  }

  private logError(
    exception: unknown,
    normalized: NormalizedError,
    traceId: string,
    request: Request,
  ): void {
    // Log method + path + status only. Never log the request body (may contain PII).
    const context = `${request.method} ${request.url} -> ${normalized.status} [trace=${traceId}]`;

    if (normalized.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(context, stack);
    } else {
      this.logger.warn(context);
    }
  }

  private titleFor(status: number): string {
    return this.detailFor(status);
  }

  private detailFor(status: number): string {
    const known: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'Bad Request',
      [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
      [HttpStatus.FORBIDDEN]: 'Forbidden',
      [HttpStatus.NOT_FOUND]: 'Not Found',
      [HttpStatus.CONFLICT]: 'Conflict',
      [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
      [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported Media Type',
      [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
      [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
      [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
    };
    return known[status] ?? 'Error';
  }
}
