import { BadRequestException, HttpException, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Ss12000V2ExceptionFilter, v2Errors } from './errors';

function respond(exception: unknown, url = '/ss12000/v2.0/persons?civicNo=199001011234&nameContains=Girgensohn') {
  const response = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getRequest: () => ({ method: 'GET', originalUrl: url, url }), getResponse: () => response }) };
  new Ss12000V2ExceptionFilter().catch(exception, host as never);
  return response;
}

describe('Ss12000V2ExceptionFilter', () => {
  let lines: string[];
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    lines = [];
    spies = (['warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
    );
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('answers S1\'s Error, and logs the path and the status but never the query', () => {
    const res = respond(v2Errors.invalidFilter('civicNo'));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'INVALID_FILTER', message: expect.any(String) });
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(lines.join('\n')).toContain('GET /ss12000/v2.0/persons -> 400 INVALID_FILTER');
    expect(lines.join('\n')).not.toMatch(/199001011234|Girgensohn/);
  });

  it('a 404 has no body, a 401 asks for a bearer', () => {
    const missing = respond(v2Errors.notFound());
    expect(missing.statusCode).toBe(404);
    expect(missing.ended).toBe(true);
    expect(missing.body).toBeUndefined();
    expect(respond(new NotFoundException()).ended).toBe(true);
    expect(respond(v2Errors.unauthenticated()).headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('maps the framework\'s exceptions and an unknown one to S1\'s shape, the unknown logged as an error', () => {
    expect(respond(new ThrottlerException()).body).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(respond(new PayloadTooLargeException()).body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(respond(new BadRequestException('bad json')).body).toMatchObject({ code: 'INVALID_BODY' });
    expect(respond(new HttpException('teapot', 418)).body).toMatchObject({ code: 'HTTP_418' });
    const crash = respond(new Error('boom: Girgensohn'));
    expect(crash.statusCode).toBe(500);
    expect(crash.body).toEqual({ code: 'INTERNAL', message: expect.any(String) });
    expect(JSON.stringify(crash.body)).not.toContain('Girgensohn');
    expect(respond(v2Errors.tooLarge(), '').statusCode).toBe(503);
  });
});
