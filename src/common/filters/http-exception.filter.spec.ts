import {
  ConflictException,
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

  it('carries a thrower’s code, so a client can act on the problem without parsing it', () => {
    // A stale room proposal means "compute again"; the page tells that apart
    // from a clash by this field alone.
    filter.catch(
      new ConflictException({ message: 'Grundschemat har ändrats.', code: 'ROOM_PROPOSAL_STALE' }),
      host,
    );

    expect(body()).toMatchObject({
      status: 409,
      detail: 'Grundschemat har ändrats.',
      code: 'ROOM_PROPOSAL_STALE',
    });
  });

  it('drops a code that is not a token, and every other key of the body', () => {
    filter.catch(
      new ConflictException({ message: 'Nope.', code: 'two words', internal: 'x' }),
      host,
    );

    expect(body()).not.toHaveProperty('code');
    expect(body()).not.toHaveProperty('internal');
  });

  it('drops a code that is not a string, even one that would spell a token', () => {
    filter.catch(new ConflictException({ message: 'Nope.', code: 409 }), host);

    expect(body()).not.toHaveProperty('code');
  });

  it('carries the params of a coded refusal, so the client renders the sentence itself', () => {
    filter.catch(
      new ConflictException({
        message: 'Läraren saknar behörighet i Matematik för åk 7–9.',
        code: 'STAFF_TEACHER_NOT_QUALIFIED',
        params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' },
      }),
      host,
    );

    expect(body()).toMatchObject({
      status: 409,
      code: 'STAFF_TEACHER_NOT_QUALIFIED',
      params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' },
    });
  });

  it.each([
    ['a nested object', { role: { name: 'Anna' } }],
    ['an array', ['Matematik']],
    ['a long text', { subject: 'x'.repeat(201) }],
    ['a key that is not a name', { 'two words': 'x' }],
    ['a number that is not finite', { minutes: Number.NaN }],
    ['more than twenty values', Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, i]))],
  ])('drops the whole params member when it holds %s', (_label, params) => {
    filter.catch(
      new ConflictException({ message: 'Nej.', code: 'STAFF_TEACHER_OVER_TARGET', params }),
      host,
    );

    expect(body()).toMatchObject({ code: 'STAFF_TEACHER_OVER_TARGET' });
    expect(body()).not.toHaveProperty('params');
  });

  it('drops params that come without a code: they name no sentence', () => {
    filter.catch(new ConflictException({ message: 'Nej.', params: { minutes: 3 } }), host);

    expect(body()).not.toHaveProperty('params');
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
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [409, 'Conflict'],
    [413, 'Payload Too Large'],
    [415, 'Unsupported Media Type'],
    [503, 'Service Unavailable'],
    [500, 'Internal Server Error'],
  ])('titles a %i as "%s" and keeps the thrower’s detail', (status, title) => {
    filter.catch(new HttpException('Detail from the thrower.', status), host);

    expect(body()).toMatchObject({ status, title, detail: 'Detail from the thrower.' });
  });

  it.each([
    ['P2002', 409, 'Conflict', 'A resource with the same unique identifier already exists.'],
    ['P2025', 404, 'Not Found', 'The requested resource does not exist.'],
    ['P2003', 400, 'Bad Request', 'The request references a resource that does not exist.'],
  ])('maps Prisma %s to %i without leaking metadata', (code, status, title, detail) => {
    filter.catch(prismaError(code), host);

    expect(response.status).toHaveBeenCalledWith(status);
    expect(body()).toMatchObject({ status, title, detail });
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
      title: 'Bad Request',
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

  describe('a request body that body-parser refused before any handler ran', () => {
    /** What body-parser rejects with: a plain Error with a `type` and a status of its own. */
    const bodyParserError = (type: string, status: number) =>
      Object.assign(new Error('raw body-parser message'), {
        type,
        status,
        statusCode: status,
        expose: true,
      });

    it.each([
      [
        'entity.too.large',
        413,
        'Payload Too Large',
        'The request body is too large. Split the import into smaller files and upload them one at a time.',
      ],
      ['entity.parse.failed', 400, 'Bad Request', 'The request body is not valid JSON.'],
      [
        'encoding.unsupported',
        415,
        'Unsupported Media Type',
        'The request body uses an unsupported content encoding.',
      ],
    ])('answers %s with %i and says what to do about it', (type, status, title, detail) => {
      // Not a 500: the CSV import one row too large used to come back as "an
      // unexpected error occurred", sending the caller after a server fault.
      filter.catch(bodyParserError(type, status), host);

      expect(response.status).toHaveBeenCalledWith(status);
      expect(body()).toMatchObject({ status, title, detail });
      expect(JSON.stringify(body())).not.toContain('raw body-parser message');
    });

    it('does not let a thrown object that is no Error borrow one of those answers', () => {
      filter.catch({ type: 'entity.too.large', status: 413 }, host);

      expect(response.status).toHaveBeenCalledWith(500);
      expect(body()).toMatchObject({ title: 'Internal Server Error' });
    });
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
