import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { NEVER, of, throwError } from 'rxjs';
import { EngineTimingService } from './engine-timing.service';
import { PRODUCTION_BODY } from './__fixtures__/engine-timing-body';
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
const build = async (over: { timeoutMs?: number; body?: unknown | null } = {}): Promise<Built> => {
  const post = jest.fn();
  const get = jest.fn();
  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key !== 'aiEngine') throw new TypeError(`Configuration key "${key}" does not exist`);
      return { baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }) };
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
