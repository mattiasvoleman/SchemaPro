import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProblemDetails } from '../interfaces/problem-details.interface';
import { HttpExceptionFilter } from './http-exception.filter';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let logger: { warn: jest.Mock; error: jest.Mock };
  let response: {
    status: jest.Mock;
    setHeader: jest.Mock;
    json: jest.Mock;
  };
  let request: { method: string; url: string; originalUrl?: string };
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    logger = { warn: jest.fn(), error: jest.fn() };
    Object.assign(filter, { logger });

    request = {
      method: 'POST',
      url: '/api/v1/rooms',
      originalUrl: '/api/v1/rooms?include=bookings',
    };
    response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
  });

  const body = (): ProblemDetails =>
    response.json.mock.calls[0][0] as ProblemDetails;

  it('renders an HttpException as problem+json with its message as detail', () => {
    filter.catch(new NotFoundException('Booking not found.'), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/problem+json',
    );
    expect(body()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Booking not found.',
      instance: '/api/v1/rooms?include=bookings',
      traceId: expect.stringMatching(UUID_V4),
    });
  });

  it('uses a string exception body directly and falls back to "Error" for unknown statuses', () => {
    filter.catch(new HttpException('I am a teapot', 418), host);

    expect(response.status).toHaveBeenCalledWith(418);
    expect(body()).toMatchObject({
      title: 'Error',
      status: 418,
      detail: 'I am a teapot',
    });
  });

  it('collects class-validator message arrays into errors.body, stringified', () => {
    filter.catch(
      new HttpException({ message: ['name must be shorter', 42] }, 400),
      host,
    );

    expect(body()).toMatchObject({
      status: 400,
      detail: 'One or more fields failed validation.',
      errors: { body: ['name must be shorter', '42'] },
    });
  });

  it('falls back to the canonical status text when the body has no usable message', () => {
    filter.catch(new HttpException({}, HttpStatus.FORBIDDEN), host);

    expect(body()).toMatchObject({
      title: 'Forbidden',
      status: 403,
      detail: 'Forbidden',
    });
    // 403 came from an object body; the plain exception message path too:
    expect(body().errors).toBeUndefined();
  });

  it('maps 429 to its known title', () => {
    filter.catch(
      new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS),
      host,
    );

    expect(body()).toMatchObject({ title: 'Too Many Requests', status: 429 });
  });

  it.each([
    ['P2002', 409, 'A resource with the same unique identifier already exists.'],
    ['P2025', 404, 'The requested resource does not exist.'],
    ['P2003', 400, 'The request references a resource that does not exist.'],
  ])('maps Prisma %s to %i without leaking metadata', (code, status, detail) => {
    filter.catch(prismaError(code), host);

    expect(response.status).toHaveBeenCalledWith(status);
    expect(body()).toMatchObject({ status, detail });
    // The Prisma message ("Simulated ...") must never reach the client.
    expect(JSON.stringify(body())).not.toContain('Simulated');
  });

  it('maps an unrecognized Prisma error code to a generic 500', () => {
    filter.catch(prismaError('P2010'), host);

    expect(body()).toMatchObject({
      status: 500,
      title: 'Internal Server Error',
      detail: 'An unexpected database error occurred.',
    });
  });

  it('maps a Prisma validation error to a generic 400', () => {
    filter.catch(
      new Prisma.PrismaClientValidationError('bad query shape', {
        clientVersion: Prisma.prismaVersion.client,
      }),
      host,
    );

    expect(body()).toMatchObject({
      status: 400,
      detail: 'The request could not be processed.',
    });
    expect(JSON.stringify(body())).not.toContain('bad query shape');
  });

  it('hides unexpected errors behind a generic 500 and keeps the detail server-side', () => {
    filter.catch(new Error('secret internal detail'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(body()).toMatchObject({
      title: 'Internal Server Error',
      detail: 'An unexpected error occurred. Please try again later.',
    });
    expect(JSON.stringify(body())).not.toContain('secret internal detail');
  });

  it('logs 5xx with the stack under the same traceId it returned', () => {
    const boom = new Error('boom');
    filter.catch(boom, host);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    const [context, stack] = logger.error.mock.calls[0] as [string, string];
    expect(context).toContain('POST /api/v1/rooms -> 500');
    expect(context).toContain(`[trace=${body().traceId}]`);
    expect(stack).toBe(boom.stack);
  });

  it('logs a thrown non-Error 5xx without a stack', () => {
    filter.catch('boom-string', host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('-> 500'),
      undefined,
    );
  });

  it('logs 4xx as a warning, never as an error', () => {
    filter.catch(new ForbiddenException(), host);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain('POST /api/v1/rooms -> 403');
  });

  it('falls back to request.url for instance when originalUrl is missing', () => {
    delete request.originalUrl;

    filter.catch(new NotFoundException(), host);

    expect(body().instance).toBe('/api/v1/rooms');
  });
});
