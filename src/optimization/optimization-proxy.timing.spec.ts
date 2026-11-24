import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { NEVER, of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { EngineTimingService } from './engine-timing.service';
import { INCIDENT_BODY, INCIDENT_BODY_WITHOUT_DEADLINE, PRODUCTION_BODY } from './__fixtures__/engine-timing-body';
import { engineMayStillBeSolving, OptimizationProxyService } from './optimization-proxy.service';
import type { PrismaService } from '../database/prisma.service';

/*
 * THE API'S WAIT FOR THE ENGINE, AND WHAT IT CARRIES (M1, Tidskedjan).
 *
 * callAiEngine is the one door to every route of the engine. What it waits, and
 * what it sends along, now follow what the engine says its times are
 * (EngineTimingService); and an engine that says nothing is waited for exactly as
 * before. The engine's 503 at its ceiling is read from the body both sides' tests
 * share (optimization-engine/tests/data/solver_timeout_body.json), so a rewording
 * on either side fails here or there.
 */

const SHARED = JSON.parse(
  readFileSync(join(__dirname, '../../optimization-engine/tests/data/solver_timeout_body.json'), 'utf8'),
) as { code: string; sentences: Record<string, string>; detailsWithStage: Record<string, string | number> };

const maps = () => ({
  requirementAnonMap: new Map<string, string>(),
  roomAnonMap: new Map<string, string>(),
  groupAnonMap: new Map<string, string>(),
  roomTypeAnonMap: new Map<string, string>(),
  constraintAnonMap: new Map<string, string>(),
  workRuleAnonMap: new Map<string, string>(),
  nameById: new Map<string, string>(),
  lessonAnonMap: new Map<string, string>(),
});

interface Built {
  service: OptimizationProxyService;
  timing: EngineTimingService;
  post: jest.Mock;
  get: jest.Mock;
  call: (path: string, payload?: object, options?: { timeoutMs?: number }) => Promise<unknown>;
}

/** The proxy with the engine's times read (or not), and the wait AI_ENGINE_TIMEOUT_MS gives (or not). */
const build = async (
  over: { timeoutMs?: number; body?: unknown | null; pathIdleLimitSeconds?: number } = {},
): Promise<Built> => {
  const post = jest.fn();
  const get = jest.fn();
  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key !== 'aiEngine') throw new TypeError(`Configuration key "${key}" does not exist`);
      return {
        baseUrl: 'http://solver.test',
        apiKey: 'k'.repeat(32),
        ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
        ...(over.pathIdleLimitSeconds === undefined ? {} : { pathIdleLimitSeconds: over.pathIdleLimitSeconds }),
      };
    }),
    get: jest.fn((key: string) => (key === 'app' ? { nodeEnv: 'production' } : undefined)),
  } as unknown as ConfigService;
  const http = { post, get } as unknown as HttpService;
  const timing = new EngineTimingService(http, config);
  const body = 'body' in over ? over.body : PRODUCTION_BODY;
  get.mockReturnValue(body === null ? throwError(() => new AxiosError('Request failed with status code 404')) : of({ data: body }));
  await timing.refresh();
  const service = new OptimizationProxyService({} as unknown as PrismaService, http, config, undefined, timing);
  const call = (path: string, payload: object = { requestId: 'r' }, options: { timeoutMs?: number } = {}) =>
    (
      service as unknown as {
        callAiEngine: (p: string, body: unknown, m: unknown, o: unknown) => Promise<unknown>;
      }
    ).callAiEngine(path, payload, maps(), options);
  return { service, timing, post, get, call };
};

const refusedWith = (status: number, data: unknown) => {
  const error = new AxiosError('boom');
  error.response = { status, data } as never;
  return error;
};

describe('OptimizationProxyService: the wait and the deadline', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('what a call waits', () => {
    it("is the engine's own ceiling and a margin when AI_ENGINE_TIMEOUT_MS is not set, for the module's client AND for rxjs", async () => {
      const { call, post } = await build();
      post.mockReturnValue(of({ data: { status: 'OPTIMAL' } }));

      await call('/v1/schedule');

      expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 240_000 });
    });

    it('is AI_ENGINE_TIMEOUT_MS as it was set, as before: the module’s own client already waits that, so no per-call timeout rides along', async () => {
      const { call, post } = await build({ timeoutMs: 300_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');

      expect(Object.keys(post.mock.calls[0]![2] as object)).toEqual(['headers', 'maxRedirects']);
      expect((await build({ timeoutMs: 300_000 })).service.waitSeconds).toBe(300);
    });

    it('is 120 s for an engine that said nothing, with nothing set: the module’s default, so no per-call timeout either', async () => {
      const { call, post } = await build({ body: null });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');

      expect(Object.keys(post.mock.calls[0]![2] as object)).toEqual(['headers', 'maxRedirects']);
    });

    it('is the call’s own when it states one, as a schemaförslag call and a plan do', async () => {
      const { call, post } = await build({ timeoutMs: 300_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule', { requestId: 'r' }, { timeoutMs: 95_000 });

      expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 95_000 });
    });

    it('follows the route: the engine says 40 s of ceiling for a room proposal', async () => {
      const { call, post } = await build();
      post.mockReturnValue(of({ data: {} }));

      await call('/api/v1/optimize-rooms');

      expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 50_000 });
    });

    it('is what waitSeconds says, which a run’s lease and the page’s "up to N minutes" quote', async () => {
      expect((await build()).service.waitSeconds).toBe(240);
      expect((await build({ timeoutMs: 90_000 })).service.waitSeconds).toBe(90);
      expect((await build({ body: null })).service.waitSeconds).toBe(120);
      expect((await build({ body: null, timeoutMs: 240_000 })).service.waitSeconds).toBe(240);
    });

    it('says the engine’s ceiling, for a lease that wants it exact, once the engine has said it', async () => {
      expect((await build()).service.engineCeilingSeconds).toBe(230);
      expect((await build({ body: null })).service.engineCeilingSeconds).toBeUndefined();
    });

    it('says the engine’s probe and headroom for a schemaförslag call’s wait', async () => {
      expect((await build()).service.engineTimes()).toEqual({ probeSeconds: 20, headroomSeconds: 30 });
      expect((await build({ body: null })).service.engineTimes()).toBeUndefined();
    });

    it('is counted from the engine once an API that started before its engine reads it, not 120 s for ten minutes', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-18T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const { call, post, get } = await build({ body: null });
      post.mockReturnValue(of({ data: {} }));
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      jest.setSystemTime(Date.now() + 31_000);

      await call('/v1/schedule');

      expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 240_000 });
      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 240 });
      jest.useRealTimers();
    });

    it('is the one that was set when the service is built by hand, with no engine times at all', async () => {
      const post = jest.fn().mockReturnValue(of({ data: {} }));
      const config = {
        getOrThrow: () => ({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 50 }),
      } as unknown as ConfigService;
      const service = new OptimizationProxyService({} as unknown as PrismaService, { post } as unknown as HttpService, config);

      await (service as unknown as { callAiEngine: (...a: unknown[]) => Promise<unknown> }).callAiEngine('/v1/schedule', { a: 1 }, maps(), {});

      expect(service.waitSeconds).toBe(1);
      expect(post.mock.calls[0]![1]).toEqual({ a: 1 });
      // The module's own client waits those 50 ms already: nothing rides along, as before.
      expect(Object.keys(post.mock.calls[0]![2] as object)).toEqual(['headers', 'maxRedirects']);
    });
  });

  describe('the deadline a request carries', () => {
    it('is the call’s whole wait in seconds, to an engine that said it can take it', async () => {
      const { call, post } = await build({ timeoutMs: 240_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule', { requestId: 'r' });

      expect(post.mock.calls[0]![1]).toEqual({ requestId: 'r', deadlineSeconds: 240 });
    });

    it('is the derived wait when none is set', async () => {
      const { call, post } = await build();
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');

      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 240 });
    });

    it('is the schemaförslag call’s own wait: the engine fits a candidate inside it, not inside Generera’s', async () => {
      const { call, post } = await build({ timeoutMs: 240_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule', { requestId: 'r', search: { maxSeconds: 30 } }, { timeoutMs: 95_000 });

      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 95 });
    });

    it('is not sent to an engine that did not say it can take it: its models forbid a field they do not know', async () => {
      const older = await build({ body: null, timeoutMs: 240_000 });
      older.post.mockReturnValue(of({ data: {} }));
      await older.call('/v1/schedule', { requestId: 'r' });
      expect(older.post.mock.calls[0]![1]).toEqual({ requestId: 'r' });

      const without = await build({ body: { ...PRODUCTION_BODY, capabilities: [] }, timeoutMs: 240_000 });
      without.post.mockReturnValue(of({ data: {} }));
      await without.call('/v1/schedule', { requestId: 'r' });
      expect(without.post.mock.calls[0]![1]).toEqual({ requestId: 'r' });
    });

    it('is not sent to a route with no step after its budget: they have no field for it', async () => {
      const { call, post } = await build();
      post.mockReturnValue(of({ data: {} }));

      for (const path of ['/api/v1/optimize-rooms', '/api/v1/staff', '/api/v1/plan-exams']) await call(path, { requestId: 'r' });

      expect(post.mock.calls.map((c) => c[1])).toEqual([{ requestId: 'r' }, { requestId: 'r' }, { requestId: 'r' }]);
    });

    it('leaves the caller’s own payload as it was, and one that carries a deadline already as it was sent', async () => {
      const { call, post } = await build({ timeoutMs: 240_000 });
      post.mockReturnValue(of({ data: {} }));
      const mine = { requestId: 'r' };

      await call('/v1/schedule', mine);
      await call('/v1/schedule', { requestId: 'r', deadlineSeconds: 77 });

      expect(mine).toEqual({ requestId: 'r' });
      expect(post.mock.calls[1]![1]).toEqual({ requestId: 'r', deadlineSeconds: 77 });
    });

    it('is never longer than the engine takes: an hour', async () => {
      const { call, post } = await build({ timeoutMs: 7_200_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');

      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 3600 });
    });

    it('is sent again without it, and the times read again, when the engine was rolled back to one that refuses the field', async () => {
      const { call, post, timing, get } = await build({ timeoutMs: 240_000 });
      post.mockReturnValueOnce(
        throwError(() =>
          refusedWith(422, {
            code: 'VALIDATION_ERROR',
            message: 'Request payload failed schema validation.',
            details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'deadlineSeconds'], msg: 'Extra inputs are not permitted' }] },
          }),
        ),
      );
      post.mockReturnValueOnce(of({ data: { status: 'OPTIMAL' } }));
      // The engine is slow to answer the new read, as a real one is: what it said before must not be
      // believed meanwhile, which is the forgetting and not the reading.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      get.mockReturnValue(NEVER);

      await expect(call('/v1/schedule', { requestId: 'r' })).resolves.toEqual({ status: 'OPTIMAL' });
      jest.useRealTimers();

      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0]![1]).toEqual({ requestId: 'r', deadlineSeconds: 240 });
      expect(post.mock.calls[1]![1]).toEqual({ requestId: 'r' });
      // What the engine said it could do is no longer believed.
      expect(timing.supportsDeadline()).toBe(false);
    });

    it('does not mistake the refusal of another field for that one', async () => {
      const { call, post } = await build({ timeoutMs: 240_000 });
      post.mockReturnValue(
        throwError(() =>
          refusedWith(422, { details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'placements'], msg: 'x' }] } }),
        ),
      );
      post.mockReturnValueOnce(throwError(() => refusedWith(422, { details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'search'], msg: 'x' }] } })));

      await expect(call('/v1/schedule', { requestId: 'r', search: {} })).rejects.toMatchObject({ response: { code: 'ENGINE_LACKS_CANDIDATES' } });
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe("the engine's 503 at its ceiling, from any of its four routes", () => {
    const routes: [string, string][] = [
      ['optimize', '/v1/schedule'],
      ['optimize', '/api/v1/optimize'],
      ['optimize-rooms', '/api/v1/optimize-rooms'],
      ['staff', '/api/v1/staff'],
      ['plan-exams', '/api/v1/plan-exams'],
    ];

    it.each(routes)('is ENGINE_TIMED_OUT by its code (%s, %s)', async (route, path) => {
      const { call, post } = await build();
      post.mockReturnValue(
        throwError(() =>
          refusedWith(503, { code: SHARED.code, message: SHARED.sentences[route], details: { route, ceilingSeconds: 230 } }),
        ),
      );

      const thrown = await call(path).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(503);
      expect((thrown as HttpException).getResponse()).toMatchObject({ code: 'ENGINE_TIMED_OUT' });
      expect((thrown as HttpException).message).not.toContain('returned an error');
      expect(engineMayStillBeSolving(thrown)).toBe(true);
    });

    it.each(routes)('is ENGINE_TIMED_OUT by its sentence alone, from an engine older than the code (%s, %s)', async (route, path) => {
      const { call, post } = await build({ body: null });
      post.mockReturnValue(throwError(() => refusedWith(503, { code: 'HTTP_ERROR', message: SHARED.sentences[route] })));

      const thrown = await call(path).catch((error: unknown) => error);

      expect((thrown as HttpException).getResponse()).toMatchObject({ code: 'ENGINE_TIMED_OUT' });
    });

    it('says "Generate" for the generator and not for a room proposal, a staffing proposal or an exam plan', async () => {
      const { call, post } = await build();
      const answer = (route: string) => throwError(() => refusedWith(503, { code: SHARED.code, message: SHARED.sentences[route] }));

      post.mockReturnValueOnce(answer('optimize'));
      const generator = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;
      post.mockReturnValueOnce(answer('optimize-rooms'));
      const rooms = (await call('/api/v1/optimize-rooms').catch((error: unknown) => error)) as HttpException;

      expect(generator.message).toContain('before you run Generate again');
      expect(rooms.message).not.toContain('Generate');
      expect(rooms.message).toContain('did not answer within its longest wait');
    });

    it('keeps the generic sentence for any other 503, and for a 500 that says the same words', async () => {
      const { call, post } = await build();
      post.mockReturnValueOnce(throwError(() => refusedWith(503, { code: 'HTTP_ERROR', message: 'Service Unavailable' })));
      post.mockReturnValueOnce(throwError(() => refusedWith(500, { code: SHARED.code, message: SHARED.sentences.optimize })));

      const other = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;
      const broke = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

      expect(other.getResponse()).not.toMatchObject({ code: 'ENGINE_TIMED_OUT' });
      expect(other.message).toBe('The AI engine returned an error.');
      expect(broke.getResponse()).not.toMatchObject({ code: 'ENGINE_TIMED_OUT' });
    });

    it('reads the engine’s times again, since a ceiling nobody expected says they may have changed', async () => {
      const { call, post, get } = await build();
      get.mockClear();
      post.mockReturnValue(throwError(() => refusedWith(503, { code: SHARED.code, message: SHARED.sentences.optimize })));

      await call('/v1/schedule').catch(() => undefined);

      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  describe('what a run is told when no answer came (omgång 13, M2)', () => {
    it('carries where the engine’s solve was when its ceiling fell, as flat params (the body both sides read)', async () => {
      const { call, post } = await build();
      post.mockReturnValue(
        throwError(() => refusedWith(503, { code: SHARED.code, message: SHARED.sentences.optimize, details: SHARED.detailsWithStage })),
      );

      const thrown = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

      expect(thrown.getResponse()).toEqual({
        message: expect.stringContaining('did not answer within its longest wait'),
        code: 'ENGINE_TIMED_OUT',
        params: { ceilingSeconds: 230, stage: 'SEARCH_CLONE', stageSeconds: 160, elapsedSeconds: 230 },
      });
    });

    it('carries the ceiling alone from an engine that names no step, and nothing from one that sends no details', async () => {
      const { call, post } = await build();
      post.mockReturnValueOnce(
        throwError(() => refusedWith(503, { code: SHARED.code, message: SHARED.sentences.optimize, details: { route: 'optimize', ceilingSeconds: 230 } })),
      );
      post.mockReturnValueOnce(throwError(() => refusedWith(503, { code: SHARED.code, message: SHARED.sentences.optimize })));
      post.mockReturnValueOnce(throwError(() => refusedWith(503, { code: 'HTTP_ERROR', message: SHARED.sentences.optimize })));

      const withCeiling = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;
      const withoutDetails = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;
      const olderThanTheCode = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

      expect(withCeiling.getResponse()).toMatchObject({ code: 'ENGINE_TIMED_OUT', params: { ceilingSeconds: 230 } });
      // No `params` at all, not an empty one: the run's error is what it was before the field.
      expect(Object.keys(withoutDetails.getResponse() as object)).toEqual(['message', 'code']);
      expect(Object.keys(olderThanTheCode.getResponse() as object)).toEqual(['message', 'code']);
    });

    it('says the API’s own wait ran out as ENGINE_WAIT_EXPIRED, with the wait and the engine’s own ceiling', async () => {
      jest.useFakeTimers();
      try {
        const { call, post } = await build();
        post.mockReturnValue(NEVER);

        const pending = call('/v1/schedule').catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(240_000);
        const thrown = (await pending) as HttpException;

        expect(thrown.getStatus()).toBe(503);
        expect(thrown.getResponse()).toEqual({
          message: 'The AI engine did not respond in time.',
          code: 'ENGINE_WAIT_EXPIRED',
          params: { waitSeconds: 240, engineCeilingSeconds: 230 },
        });
        // The engine may still be solving for it, as it was before the code.
        expect(engineMayStillBeSolving(thrown)).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves out the engine’s ceiling when it has not said it, and for a route that is not the generator’s', async () => {
      jest.useFakeTimers();
      try {
        const older = await build({ body: null });
        older.post.mockReturnValue(NEVER);
        const pendingOlder = older.call('/v1/schedule').catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(120_000);

        const rooms = await build();
        rooms.post.mockReturnValue(NEVER);
        const pendingRooms = rooms.call('/api/v1/optimize-rooms').catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(240_000);

        expect(((await pendingOlder) as HttpException).getResponse()).toMatchObject({ params: { waitSeconds: 120 } });
        expect((((await pendingOlder) as HttpException).getResponse() as { params: object }).params).not.toHaveProperty('engineCeilingSeconds');
        expect((((await pendingRooms) as HttpException).getResponse() as { params: object }).params).not.toHaveProperty('engineCeilingSeconds');
      } finally {
        jest.useRealTimers();
      }
    });

    it('says a call that never reached the engine as ENGINE_NOT_REACHED, with the sentence it always had', async () => {
      const { call, post } = await build();
      const refused = new AxiosError('connect ECONNREFUSED 127.0.0.1:8000');
      refused.code = 'ECONNREFUSED';
      post.mockReturnValue(throwError(() => refused));

      const thrown = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

      expect(thrown.getStatus()).toBe(503);
      expect(thrown.getResponse()).toEqual({ message: 'The AI engine could not be reached.', code: 'ENGINE_NOT_REACHED' });
      // Nothing is solving: the call never arrived.
      expect(engineMayStillBeSolving(thrown)).toBe(false);
    });
  });

  describe('a wait that was set shorter than the engine can need', () => {
    it('is said in the log once, with the number to change, and the call is made all the same', async () => {
      const errors: string[] = [];
      jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
      const { call, post } = await build({ timeoutMs: 120_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');
      await call('/v1/schedule');

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Set AI_ENGINE_TIMEOUT_MS to 240000 or more');
      // And the request says how long this caller waits, so the engine answers inside it.
      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 120 });
      expect(post.mock.calls[1]![1]).toMatchObject({ deadlineSeconds: 120 });
    });

    it('is not said for a call whose own wait is stated: it is not the configured one', async () => {
      const errors: string[] = [];
      jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
      const { call, post } = await build({ timeoutMs: 120_000 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule', { requestId: 'r' }, { timeoutMs: 95_000 });

      expect(errors).toEqual([]);
    });
  });
});

describe('OptimizationProxyService: the HTTP client’s own timeout is the wait running out (review of #373, MEDEL-1)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // callAiEngine gives rxjs's timeout() and the client's `timeout` the same number of ms, and the client's fires
  // first (measured: 40 of 40 against a server that never answers). The NEVER observable of the specs above
  // only ever reaches rxjs's branch, so nothing showed that a real wait ended as "never reached".
  const axiosTimedOut = (ms: number) => {
    const error = new AxiosError(`timeout of ${ms}ms exceeded`);
    error.code = 'ECONNABORTED';
    return error;
  };

  it('says it as ENGINE_WAIT_EXPIRED, with the wait, and leaves the engine as possibly still solving', async () => {
    const { call, post } = await build();
    post.mockReturnValue(throwError(() => axiosTimedOut(240_000)));

    const thrown = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

    expect(thrown.getStatus()).toBe(503);
    expect(thrown.getResponse()).toEqual({
      message: 'The AI engine did not respond in time.',
      code: 'ENGINE_WAIT_EXPIRED',
      params: { waitSeconds: 240, engineCeilingSeconds: 230 },
    });
    expect(engineMayStillBeSolving(thrown)).toBe(true);
  });

  it('does not take a connect timeout of the operating system, or a refused connection, for it', async () => {
    const { call, post } = await build();
    const connect = new AxiosError('connect ETIMEDOUT 10.0.0.1:8000');
    connect.code = 'ETIMEDOUT';
    post.mockReturnValueOnce(throwError(() => connect));
    const refused = new AxiosError('connect ECONNREFUSED 127.0.0.1:8000');
    refused.code = 'ECONNREFUSED';
    post.mockReturnValueOnce(throwError(() => refused));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const thrown = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;
      expect(thrown.getResponse()).toEqual({ message: 'The AI engine could not be reached.', code: 'ENGINE_NOT_REACHED' });
    }
  });
});

describe('OptimizationProxyService: the road to the engine closes a request that sends nothing (omgång 15)', () => {
  /*
   * The 2026-11-23 incident. The engine ran with a 540 s budget, a ceiling of 590 s, and the API waited 600 s and
   * sent `deadlineSeconds: 600`, so the engine's clock never shortened the search; Railway's edge closed the
   * request at 300 s, and both runs of the only real school ended "The AI engine returned an error." with nothing
   * to show. With the road's limit known (300 s for a public https address) the API waits 290 s and says 290.
   */
  const warnings: string[] = [];

  beforeEach(() => {
    warnings.length = 0;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is where the incident was: a road with no known limit waits 600 s and tells the engine 600', async () => {
    const { call, post, service } = await build({ body: INCIDENT_BODY });
    post.mockReturnValue(of({ data: { status: 'OPTIMAL' } }));

    await call('/v1/schedule');

    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 600_000 });
    expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 600 });
    expect(service.waitSeconds).toBe(600);
  });

  it('waits 290 s and tells the engine 290 when the road closes a silent request at 300 s: the engine’s own clock then cuts the search', async () => {
    const { call, post, service } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
    post.mockReturnValue(of({ data: { status: 'OPTIMAL' } }));

    await call('/v1/schedule');

    // For the module's client AND for rxjs, from one number; and in the request, for the engine's Deadline.
    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 290_000 });
    expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 290 });
    // What a run's lease and the page's "up to N minutes" are counted from.
    expect(service.waitSeconds).toBe(290);
  });

  it('holds a wait the operator set (AI_ENGINE_TIMEOUT_MS=600000) to the same cap, and says nothing is wrong with the setting', async () => {
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
    const { call, post, service } = await build({ body: INCIDENT_BODY, timeoutMs: 600_000, pathIdleLimitSeconds: 300 });
    post.mockReturnValue(of({ data: {} }));

    await call('/v1/schedule');

    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 290_000 });
    expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 290 });
    expect(service.waitSeconds).toBe(290);
    // 600000 is not shorter than the engine can need: it is the road that cuts it, and that is said as the road's.
    expect(errors).toEqual([]);
  });

  it('holds a wait a caller stated for itself (a candidate, a plan) to the cap as well: the road closes a silent call whoever chose its length', async () => {
    const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
    post.mockReturnValue(of({ data: {} }));

    await call('/v1/schedule', { requestId: 'r' }, { timeoutMs: 400_000 });
    await call('/v1/schedule', { requestId: 'r' }, { timeoutMs: 95_000 });
    await call('/api/v1/plan-exams', { requestId: 'r' }, { timeoutMs: 500_000 });

    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 290_000 });
    expect(post.mock.calls[1]![2]).toMatchObject({ timeout: 95_000 });
    expect(post.mock.calls[2]![2]).toMatchObject({ timeout: 290_000 });
  });

  it('leaves the engine’s other routes as they were when they fit: a room proposal waits its 50 s', async () => {
    const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
    post.mockReturnValue(of({ data: {} }));

    await call('/api/v1/optimize-rooms');

    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 50_000 });
  });

  it('changes nothing for the production settings of before: a 240 s wait is under the cap', async () => {
    const { call, post, service } = await build({ pathIdleLimitSeconds: 300 });
    post.mockReturnValue(of({ data: {} }));

    await call('/v1/schedule');

    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 240_000 });
    expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 240 });
    expect(service.waitSeconds).toBe(240);
  });

  it('holds the wait to the road also for a proxy built without the timing service (the room and staffing proposals build it by hand): 290 s of a 600000 ms setting', () => {
    const config = {
      getOrThrow: jest.fn(() => ({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 600_000, pathIdleLimitSeconds: 300 })),
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const http = { post: jest.fn(), get: jest.fn() } as unknown as HttpService;

    const service = new OptimizationProxyService({} as unknown as PrismaService, http, config);

    expect(service.waitSeconds).toBe(290);
  });

  it('logs the status of a 5xx that says nothing a school may read, and whether the engine put a code in it: the next closed call leaves a number to read', async () => {
    const warnings: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)));
    const { call, post } = await build();
    post.mockReturnValueOnce(throwError(() => refusedWith(502, { status: 'error', code: 502, message: 'Application failed to respond' })));
    post.mockReturnValueOnce(throwError(() => refusedWith(500, { code: 'INTERNAL_ERROR', message: 'boom' })));

    await expect(call('/v1/schedule')).rejects.toBeInstanceOf(HttpException);
    await expect(call('/v1/schedule')).rejects.toBeInstanceOf(HttpException);

    expect(warnings.filter((line) => line.includes('answered 502'))).toEqual([expect.stringContaining('no code of the engine')]);
    expect(warnings.filter((line) => line.includes('answered 500'))).toEqual([expect.stringContaining('(INTERNAL_ERROR)')]);
  });

  it('holds a deadline the caller stated for itself to the wait the road leaves: the analysis of a refusal asks 195 s of a wait of 200 s, and a road that holds 120 s leaves 110', async () => {
    const { call, post } = await build({ pathIdleLimitSeconds: 120 });
    post.mockReturnValue(of({ data: {} }));

    await call('/api/v1/suggest-changes', { requestId: 'r', deadlineSeconds: 195 }, { timeoutMs: 200_000 });

    expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 110 });
    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 110_000 });
  });

  it('leaves a stated deadline that fits the wait as it was, on a road with a limit and on one with none', async () => {
    for (const pathIdleLimitSeconds of [300, undefined]) {
      const { call, post } = await build(pathIdleLimitSeconds === undefined ? {} : { pathIdleLimitSeconds });
      post.mockReturnValue(of({ data: {} }));

      await call('/api/v1/suggest-changes', { requestId: 'r', deadlineSeconds: 195 }, { timeoutMs: 200_000 });

      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 195 });
    }
  });

  it('is the road’s own number when the operator says it: AI_ENGINE_PATH_IDLE_LIMIT_SECONDS=120 holds a call to 110 s', async () => {
    const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 120 });
    post.mockReturnValue(of({ data: {} }));

    await call('/v1/schedule');

    expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 110_000 });
    expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 110 });
  });

  describe('an engine older than deadlineSeconds', () => {
    it('is waited for 290 s and sent no deadline: the field is never sent to an engine that did not say it can take it', async () => {
      const { call, post, service } = await build({ body: INCIDENT_BODY_WITHOUT_DEADLINE, pathIdleLimitSeconds: 300 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');

      expect(post.mock.calls[0]![2]).toMatchObject({ timeout: 290_000 });
      expect(post.mock.calls[0]![1]).not.toHaveProperty('deadlineSeconds');
      expect(service.waitSeconds).toBe(290);
    });

    it('is waited for 290 s, and its first Generera says in the log that it cannot be asked to answer inside that and which number to change', async () => {
      const { call, post } = await build({ body: INCIDENT_BODY_WITHOUT_DEADLINE, pathIdleLimitSeconds: 300 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');
      await call('/v1/schedule');

      const said = warnings.filter((line) => line.includes('closes a request that sends nothing'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('older than deadlineSeconds and cannot be asked to answer inside that');
      expect(said[0]).toContain('SOLVER_MAX_TIME_SECONDS on the engine to 235 or less');
    });

    it('is not a silent exception when the engine that said it can take a deadline refuses it: the call is sent again without it, still held to 290 s', async () => {
      const { call, post, get } = await build({ body: INCIDENT_BODY, timeoutMs: 600_000, pathIdleLimitSeconds: 300 });
      post.mockReturnValueOnce(
        throwError(() =>
          refusedWith(422, {
            code: 'HTTP_ERROR',
            message: 'Validation failed',
            details: { errors: [{ loc: ['body', 'deadlineSeconds'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] },
          }),
        ),
      );
      post.mockReturnValueOnce(of({ data: { status: 'OPTIMAL' } }));
      // The engine is slow to answer the new read, as a real one is: what it said before is not believed meanwhile.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      get.mockReturnValue(NEVER);

      await expect(call('/v1/schedule')).resolves.toEqual({ status: 'OPTIMAL' });
      jest.useRealTimers();

      expect(post.mock.calls[0]![1]).toMatchObject({ deadlineSeconds: 290 });
      expect(post.mock.calls[1]![1]).not.toHaveProperty('deadlineSeconds');
      expect(post.mock.calls[1]![2]).toMatchObject({ timeout: 290_000 });
    });
  });

  describe('what a run is told, once', () => {
    it('says in the log, with the first call, that the road holds the wait to 290 s and the search to what the engine can fit, once however many calls follow', async () => {
      const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
      post.mockReturnValue(of({ data: {} }));

      await call('/v1/schedule');
      await call('/v1/schedule');
      await call('/v1/schedule');

      const said = warnings.filter((line) => line.includes('closes a request that sends nothing'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('the API waits 290 s at most');
      // The search is cut short of its 540 s, to what the deadline leaves it; 235 is the budget that would fit whole
      // and is the remedy's number, not the search's length (the review of #416, L-4).
      expect(said[0]).toContain('its search is cut short of its 540 s');
      expect(said[0]).toContain('set SOLVER_MAX_TIME_SECONDS on the engine to 235 or less');
      expect(said[0]).not.toContain('about 235 s');
    });

    it('says nothing for a road that holds what the engine needs, or has no limit', async () => {
      for (const over of [{ pathIdleLimitSeconds: 300 }, { body: INCIDENT_BODY }]) {
        const { call, post } = await build(over);
        post.mockReturnValue(of({ data: {} }));

        await call('/v1/schedule');
      }

      expect(warnings.filter((line) => line.includes('closes a request that sends nothing'))).toEqual([]);
    });
  });

  it('ends a call that nothing answers at 290 s, by the API’s own wait and not by the road’s: ENGINE_PATH_CLOSED with the 290 s it waited', async () => {
    jest.useFakeTimers();
    try {
      const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
      post.mockReturnValue(NEVER);

      const pending = call('/v1/schedule').catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(289_000);
      let settled = false;
      void pending.then(() => (settled = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      const thrown = (await pending) as HttpException;

      expect(thrown.getStatus()).toBe(503);
      expect(thrown.getResponse()).toMatchObject({ code: 'ENGINE_PATH_CLOSED', params: { elapsedSeconds: 290, pathLimitSeconds: 300 } });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('OptimizationProxyService: a call the road to the engine closed is said as that (omgång 15)', () => {
  /*
   * The two Generera runs of 2026-11-23 stored "The AI engine returned an error." and nothing else: the edge answered a
   * 502 after 300 s, and the generic branch for an engine 5xx kept no code. A call that ends when the road is known to
   * close a silent one is now ENGINE_PATH_CLOSED, with how long it went on and what the road holds.
   */
  const errors: string[] = [];
  beforeEach(() => {
    errors.length = 0;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** The call ends with `error` after `afterMs` of the (fake) clock. */
  const endsAfter = async (
    afterMs: number,
    error: unknown,
    over: Parameters<typeof build>[0],
    path = '/v1/schedule',
    options: { timeoutMs?: number } = {},
  ) => {
    jest.useFakeTimers();
    const built = await build(over);
    built.post.mockReturnValue(timer(afterMs).pipe(mergeMap(() => throwError(() => error))));
    const pending = built.call(path, { requestId: 'r' }, options).catch((thrown: unknown) => thrown);
    await jest.advanceTimersByTimeAsync(afterMs + 1);
    return { thrown: (await pending) as HttpException, built };
  };

  const edge = (status: number, data: unknown = { status: 'error', code: status, message: 'Application failed to respond' }) => refusedWith(status, data);
  const closedSocket = () => {
    const error = new AxiosError('socket hang up');
    error.code = 'ECONNRESET';
    return error;
  };

  it('says an edge 502 after 285 s as ENGINE_PATH_CLOSED, with the time, the limit and what the engine can need', async () => {
    const { thrown } = await endsAfter(285_000, edge(502), { body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });

    expect(thrown.getStatus()).toBe(503);
    expect(thrown.getResponse()).toEqual({
      message: 'The connection to the AI engine was closed on the way before the engine answered. The engine may still be working.',
      code: 'ENGINE_PATH_CLOSED',
      params: { elapsedSeconds: 285, pathLimitSeconds: 300, engineCeilingSeconds: 590 },
    });
    // It may still be solving: a schemaförslag run keeps its deadline on this, and the page says to wait.
    expect(engineMayStillBeSolving(thrown)).toBe(true);
    expect(errors.some((line) => line.includes('closed a call after 285 s') && line.includes('AI_ENGINE_PATH_IDLE_LIMIT_SECONDS'))).toBe(true);
  });

  it.each([
    ['an edge 504', () => edge(504, undefined)],
    ['an edge 502 with an HTML body', () => edge(502, '<html>Bad gateway</html>')],
    ['a socket closed with no answer', () => closedSocket()],
  ])('says %s near the limit as ENGINE_PATH_CLOSED', async (_name, make) => {
    const { thrown } = await endsAfter(290_000, make(), { body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });

    expect(thrown.getResponse()).toMatchObject({ code: 'ENGINE_PATH_CLOSED', params: { elapsedSeconds: 290, pathLimitSeconds: 300 } });
  });

  it('leaves the engine’s ceiling out of the figures when the engine has not said it, and for a route that is not the generator’s', async () => {
    // A wait long enough to be held to the road's 290 s: an engine that said nothing waits 120 s, a room proposal 50.
    const silent = await endsAfter(285_000, edge(502), { body: null, timeoutMs: 600_000, pathIdleLimitSeconds: 300 });
    const rooms = await endsAfter(285_000, edge(502), { body: INCIDENT_BODY, pathIdleLimitSeconds: 300 }, '/api/v1/optimize-rooms', {
      timeoutMs: 500_000,
    });

    expect((silent.thrown.getResponse() as { params: object }).params).toEqual({ elapsedSeconds: 285, pathLimitSeconds: 300 });
    expect((rooms.thrown.getResponse() as { params: object }).params).not.toHaveProperty('engineCeilingSeconds');
  });

  it('keeps every other ending as it was: an edge 502 after five seconds is an engine that broke, and a reset after five is an engine not reached', async () => {
    const early502 = await endsAfter(5_000, edge(502), { body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
    const earlyReset = await endsAfter(5_000, closedSocket(), { body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });

    expect(early502.thrown.getStatus()).toBe(502);
    expect(early502.thrown.getResponse()).toEqual({ message: 'The AI engine returned an error.' });
    expect(earlyReset.thrown.getResponse()).toEqual({ message: 'The AI engine could not be reached.', code: 'ENGINE_NOT_REACHED' });
  });

  it('keeps a 502 that carries the engine’s own code as the engine’s, at any time', async () => {
    const { thrown } = await endsAfter(290_000, edge(502, { code: 'SOLVER_BUILD_FAILED', message: 'Model build failed.' }), {
      body: INCIDENT_BODY,
      pathIdleLimitSeconds: 300,
    });

    expect(thrown.getStatus()).toBe(502);
    expect(thrown.getResponse()).toEqual({ message: 'The AI engine returned an error.' });
  });

  it('is never said on a road with no limit: the private network’s 502 at 300 s is the engine’s or the network’s', async () => {
    const { thrown } = await endsAfter(300_000, edge(502), { body: INCIDENT_BODY, timeoutMs: 600_000 });

    expect(thrown.getStatus()).toBe(502);
    expect(thrown.getResponse()).toEqual({ message: 'The AI engine returned an error.' });
  });

  describe('the API’s own wait, when the road’s limit had shortened it', () => {
    it('is ENGINE_PATH_CLOSED at 290 s with the engine’s ceiling, and not "the wait is a setting of the service"', async () => {
      jest.useFakeTimers();
      const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
      post.mockReturnValue(NEVER);

      const pending = call('/v1/schedule').catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(290_000);
      const thrown = (await pending) as HttpException;

      expect(thrown.getStatus()).toBe(503);
      expect(thrown.getResponse()).toEqual({
        message: 'The connection to the AI engine was closed on the way before the engine answered. The engine may still be working.',
        code: 'ENGINE_PATH_CLOSED',
        params: { elapsedSeconds: 290, pathLimitSeconds: 300, engineCeilingSeconds: 590 },
      });
      expect(engineMayStillBeSolving(thrown)).toBe(true);
    });

    it('is the same for the HTTP client’s own timeout, which is what fires first against a real server', async () => {
      const { call, post } = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
      const timedOut = new AxiosError('timeout of 290000ms exceeded');
      timedOut.code = 'ECONNABORTED';
      post.mockReturnValue(throwError(() => timedOut));

      const thrown = (await call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

      expect(thrown.getResponse()).toMatchObject({ code: 'ENGINE_PATH_CLOSED', params: { pathLimitSeconds: 300 } });
    });

    it('is ENGINE_WAIT_EXPIRED as before when the road did not shorten it: a candidate’s own 95 s, the production 240 s', async () => {
      const candidate = await build({ body: INCIDENT_BODY, pathIdleLimitSeconds: 300 });
      const timedOut = new AxiosError('timeout of 95000ms exceeded');
      timedOut.code = 'ECONNABORTED';
      candidate.post.mockReturnValue(throwError(() => timedOut));
      const production = await build({ pathIdleLimitSeconds: 300 });
      const productionTimedOut = new AxiosError('timeout of 240000ms exceeded');
      productionTimedOut.code = 'ECONNABORTED';
      production.post.mockReturnValue(throwError(() => productionTimedOut));

      const own = (await candidate.call('/v1/schedule', { requestId: 'r' }, { timeoutMs: 95_000 }).catch((error: unknown) => error)) as HttpException;
      const plain = (await production.call('/v1/schedule').catch((error: unknown) => error)) as HttpException;

      expect(own.getResponse()).toMatchObject({ code: 'ENGINE_WAIT_EXPIRED', params: { waitSeconds: 95 } });
      expect(plain.getResponse()).toMatchObject({ code: 'ENGINE_WAIT_EXPIRED', params: { waitSeconds: 240, engineCeilingSeconds: 230 } });
    });
  });
});
