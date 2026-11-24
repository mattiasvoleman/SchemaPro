import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { NodeEnv } from '../config/env.validation';
import { EngineTimingService, TIMING_READ_MS, TIMING_REFRESH_MS, TIMING_RETRY_MS } from './engine-timing.service';
import { INCIDENT_BODY, INCIDENT_BODY_WITHOUT_DEADLINE, PRODUCTION_BODY } from './__fixtures__/engine-timing-body';

/*
 * THE ENGINE'S TIMES, READ FROM THE ENGINE, and the start that refuses a wait
 * that is shorter than the engine can need (M1, Tidskedjan).
 *
 * What these pin is that nothing depends on the engine answering: a 404 (an older
 * engine), a refused connection and an unreadable body all leave the cache empty
 * and the API waiting as it always has, and only a start that READ the engine and
 * found AI_ENGINE_TIMEOUT_MS shorter than it can need refuses, in production.
 */

interface Harness {
  service: EngineTimingService;
  get: jest.Mock;
}

const harness = (
  over: { timeoutMs?: number; nodeEnv?: NodeEnv; candidatesMax?: number; pathIdleLimitSeconds?: number } = {},
): Harness => {
  const get = jest.fn();
  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key !== 'aiEngine') throw new TypeError(`Configuration key "${key}" does not exist`);
      return {
        baseUrl: 'http://solver.test',
        apiKey: 'k'.repeat(32),
        ...('timeoutMs' in over ? { timeoutMs: over.timeoutMs } : {}),
        ...('pathIdleLimitSeconds' in over ? { pathIdleLimitSeconds: over.pathIdleLimitSeconds } : {}),
      };
    }),
    get: jest.fn((key: string) => {
      if (key === 'app') return { nodeEnv: over.nodeEnv ?? NodeEnv.Production };
      if (key === 'candidates') return over.candidatesMax === undefined ? undefined : { maxSeconds: over.candidatesMax };
      return undefined;
    }),
  } as unknown as ConfigService;
  const service = new EngineTimingService({ get } as unknown as HttpService, config);
  return { service, get };
};

const notFound = () => {
  const error = new AxiosError('Request failed with status code 404');
  error.response = { status: 404, data: { code: 'HTTP_ERROR', message: 'Not Found' } } as never;
  return error;
};

describe('EngineTimingService', () => {
  let logged: { warn: string[]; error: string[]; log: string[] };

  beforeEach(() => {
    logged = { warn: [], error: [], log: [] };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void logged.warn.push(String(message)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => void logged.error.push(String(message)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => void logged.log.push(String(message)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('refresh', () => {
    it("reads the engine's times with the service key, no redirect and a short wait", async () => {
      const { service, get } = harness();
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));

      const timing = await service.refresh();

      expect(get).toHaveBeenCalledWith('http://solver.test/api/v1/timing', {
        headers: { 'X-API-Key': 'k'.repeat(32), Accept: 'application/json' },
        maxRedirects: 0,
        timeout: TIMING_READ_MS,
      });
      expect(timing?.routes.optimize?.ceilingSeconds).toBe(230);
      expect(service.current()).toBe(timing);
      expect(service.supportsDeadline()).toBe(true);
      expect(service.candidateTimes()).toEqual({ probeSeconds: 20, headroomSeconds: 30 });
    });

    it('leaves nothing for an older engine, which answers 404, and is not an error', async () => {
      const { service, get } = harness({ timeoutMs: 240_000 });
      get.mockReturnValue(throwError(() => notFound()));

      await expect(service.refresh()).resolves.toBeNull();

      expect(service.current()).toBeNull();
      expect(service.supportsDeadline()).toBe(false);
      expect(service.candidateTimes()).toBeUndefined();
      // The wait is the one that was set: nothing changed for an engine that says nothing.
      expect(service.waitMs('optimize')).toBe(240_000);
    });

    it.each([
      ['a refused connection', () => throwError(() => new AxiosError('connect ECONNREFUSED'))],
      ['a failure that is not axios’s', () => throwError(() => new Error('socket closed'))],
      ['an answer that is not the engine’s', () => of({ data: '<html>Bad gateway</html>' })],
      ['an answer that is the engine’s of another version', () => of({ data: { version: 0 } })],
    ])('leaves nothing for %s', async (_name, reply) => {
      const { service, get } = harness();
      get.mockReturnValue(reply());

      await expect(service.refresh()).resolves.toBeNull();
    });

    it('stops waiting for an engine that does not answer', async () => {
      jest.useFakeTimers();
      const { service, get } = harness();
      get.mockReturnValue(timer(TIMING_READ_MS * 3).pipe(mergeMap(() => of({ data: PRODUCTION_BODY }))));

      const reading = service.refresh();
      await jest.advanceTimersByTimeAsync(TIMING_READ_MS + 10);

      await expect(reading).resolves.toBeNull();
    });

    it('replaces what it believed: an engine rolled back to an older one stops being believed', async () => {
      const { service, get } = harness();
      get.mockReturnValueOnce(of({ data: PRODUCTION_BODY }));
      await service.refresh();
      expect(service.supportsDeadline()).toBe(true);

      get.mockReturnValueOnce(throwError(() => notFound()));
      await service.refresh();

      expect(service.supportsDeadline()).toBe(false);
    });

    it('forgets on request: a field the engine refused was one it said it could take', async () => {
      const { service, get } = harness();
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await service.refresh();

      service.forget();

      expect(service.current()).toBeNull();
      expect(service.supportsDeadline()).toBe(false);
    });
  });

  describe('ensure: an engine that has said nothing is asked again before a call', () => {
    it('asks again once TIMING_RETRY_MS has passed, so an API that started before its engine does not wait 120 s for ten minutes', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-18T10:00:00Z') });
      const { service, get } = harness();
      get.mockReturnValueOnce(throwError(() => new AxiosError('connect ECONNREFUSED')));
      await service.refresh();
      expect(service.current()).toBeNull();
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));

      await service.ensure();
      expect(get).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2026-11-18T10:00:00Z').getTime() + TIMING_RETRY_MS + 1);
      await service.ensure();

      expect(get).toHaveBeenCalledTimes(2);
      expect(service.waitMs('optimize')).toBe(240_000);
    });

    it('does not ask an engine that is known, and does not ask an older one on every call', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-18T10:00:00Z') });
      const known = harness();
      known.get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await known.service.refresh();
      jest.setSystemTime(Date.now() + 10 * TIMING_RETRY_MS);
      await known.service.ensure();
      expect(known.get).toHaveBeenCalledTimes(1);

      const older = harness();
      older.get.mockReturnValue(throwError(() => notFound()));
      await older.service.ensure();
      await older.service.ensure();
      await older.service.ensure();
      expect(older.get).toHaveBeenCalledTimes(1);
    });

    it('never asks in a test, which has no engine behind it', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-18T10:00:00Z') });
      const { service, get } = harness({ nodeEnv: NodeEnv.Test });
      jest.setSystemTime(Date.now() + 10 * TIMING_RETRY_MS);

      await service.ensure();

      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('the wait', () => {
    it("is counted from the engine's ceiling when AI_ENGINE_TIMEOUT_MS is not set", async () => {
      const { service, get } = harness();
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await service.refresh();

      expect(service.waitMs('optimize')).toBe(240_000);
      expect(service.waitMs('optimize-rooms')).toBe(50_000);
    });

    it('is the one that was set when it is, and 120 s when nothing is set and the engine says nothing', async () => {
      const set = harness({ timeoutMs: 90_000 });
      set.get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await set.service.refresh();
      expect(set.service.waitMs('optimize')).toBe(90_000);

      const nothing = harness();
      expect(nothing.service.waitMs('optimize')).toBe(120_000);
    });
  });

  describe('noteWait', () => {
    it('says once, however many calls follow, that a wait that was set is shorter than the engine can need', async () => {
      const { service, get } = harness({ timeoutMs: 120_000 });
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await service.refresh();

      service.noteWait('optimize');
      service.noteWait('optimize');
      service.noteWait('optimize');

      expect(logged.error).toHaveLength(1);
      expect(logged.error[0]).toContain('AI_ENGINE_TIMEOUT_MS=120000 is shorter than the engine can need');
    });

    it('says nothing for a wait that holds, one that is derived, another route, or an engine that said nothing', async () => {
      const holds = harness({ timeoutMs: 240_000 });
      holds.get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await holds.service.refresh();
      holds.service.noteWait('optimize');
      holds.service.noteWait('optimize-rooms');

      const derived = harness();
      derived.get.mockReturnValue(of({ data: PRODUCTION_BODY }));
      await derived.service.refresh();
      derived.service.noteWait('optimize');

      const silent = harness({ timeoutMs: 120_000 });
      silent.service.noteWait('optimize');

      expect(logged.error).toEqual([]);
    });
  });

  describe('the start', () => {
    it('refuses to start in production when AI_ENGINE_TIMEOUT_MS is set and shorter than the engine can need, and says which number to change', async () => {
      const { service, get } = harness({ timeoutMs: 120_000, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /AI_ENGINE_TIMEOUT_MS=120000 is shorter than the engine can need: .* Set AI_ENGINE_TIMEOUT_MS to 240000 or more, or remove it .* SOLVER_MAX_TIME_SECONDS on the engine to 65 or less\./,
      );
      service.onModuleDestroy();
    });

    it('starts in production with the wait the docs recommend, and with none set', async () => {
      for (const timeoutMs of [240_000, 235_000, undefined]) {
        const { service, get } = harness(timeoutMs === undefined ? {} : { timeoutMs });
        get.mockReturnValue(of({ data: PRODUCTION_BODY }));

        await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
        service.onModuleDestroy();
      }
    });

    it('says it and starts anywhere but production', async () => {
      for (const nodeEnv of [NodeEnv.Development]) {
        const { service, get } = harness({ timeoutMs: 120_000, nodeEnv });
        get.mockReturnValue(of({ data: PRODUCTION_BODY }));

        await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
        service.onModuleDestroy();
      }
      expect(logged.error.some((line) => line.includes('AI_ENGINE_TIMEOUT_MS=120000 is shorter'))).toBe(true);
    });

    it('does not ask the engine in a test: the suites build the app with no engine behind it', async () => {
      const { service, get } = harness({ timeoutMs: 120_000, nodeEnv: NodeEnv.Test });

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

      expect(get).not.toHaveBeenCalled();
      expect(service.current()).toBeNull();
    });

    it('starts, and says it, when the engine does not state its times: an older engine, or one that is not up yet', async () => {
      const { service, get } = harness({ timeoutMs: 120_000, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(throwError(() => notFound()));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.onModuleDestroy();

      expect(logged.warn).toHaveLength(1);
      expect(logged.warn[0]).toContain('does not state its times');
      expect(logged.warn[0]).toContain('120000 ms');
    });

    it('starts when the engine is unreachable, which is the ordinary case at a deploy', async () => {
      const { service, get } = harness({ timeoutMs: 1_000, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(throwError(() => new AxiosError('connect ECONNREFUSED')));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.onModuleDestroy();
    });

    it('says, without refusing, that CANDIDATE_MAX_SECONDS is above the engine’s budget and so does nothing', async () => {
      const { service, get } = harness({ candidatesMax: 240 });
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.onModuleDestroy();

      expect(logged.warn).toEqual([expect.stringContaining('CANDIDATE_MAX_SECONDS=240 is above the engine')]);
    });

    it('reads the engine again every ten minutes, whether or not it answered the first time, and stops with the app', async () => {
      jest.useFakeTimers();
      const { service, get } = harness();
      get.mockReturnValueOnce(throwError(() => new AxiosError('connect ECONNREFUSED')));
      get.mockReturnValue(of({ data: PRODUCTION_BODY }));

      await service.onApplicationBootstrap();
      expect(get).toHaveBeenCalledTimes(1);
      expect(service.current()).toBeNull();

      await jest.advanceTimersByTimeAsync(TIMING_REFRESH_MS);
      expect(get).toHaveBeenCalledTimes(2);
      expect(service.current()?.routes.optimize?.ceilingSeconds).toBe(230);

      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(TIMING_REFRESH_MS * 3);
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  describe('the road to the engine (omgång 15, the 2026-11-23 incident)', () => {
    it('holds the wait it derives from the engine’s ceiling to what the road holds: 290 s, not the 600 s the incident’s engine makes of 590 + 10', async () => {
      const { service, get } = harness({ pathIdleLimitSeconds: 300 });
      get.mockReturnValue(of({ data: INCIDENT_BODY }));
      await service.refresh();

      expect(service.unclampedWaitMs('optimize')).toBe(600_000);
      expect(service.waitMs('optimize')).toBe(290_000);
      // The engine's other routes fit and are not touched.
      expect(service.waitMs('optimize-rooms')).toBe(50_000);
    });

    it('is the wait it always was on a road with no limit', async () => {
      const { service, get } = harness();
      get.mockReturnValue(of({ data: INCIDENT_BODY }));
      await service.refresh();

      expect(service.waitMs('optimize')).toBe(600_000);
    });

    it('says at the start, in the log and as a warning, what the road does and which numbers to change, and starts: the deployment it is said about is serving', async () => {
      const { service, get } = harness({ pathIdleLimitSeconds: 300, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(of({ data: INCIDENT_BODY }));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.onModuleDestroy();

      const said = logged.warn.filter((line) => line.includes('closes a request that sends nothing after 300 s'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('SOLVER_MAX_TIME_SECONDS on the engine to 235 or less');
      expect(said[0]).toContain('AI_ENGINE_URL=http://<the engine\'s service>.railway.internal:<its port>');
      expect(logged.error).toEqual([]);
      expect(logged.log.join('\n')).toContain(
        'the API waits 290 s (counted from that), held to what the road to the engine holds (300 s, AI_ENGINE_PATH_IDLE_LIMIT_SECONDS).',
      );
    });

    it('does not refuse a production start for it, whatever the engine can need: the API must go on serving while the deployment is read', async () => {
      const { service, get } = harness({ pathIdleLimitSeconds: 30, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(of({ data: INCIDENT_BODY }));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.onModuleDestroy();
    });

    it('says it once whether the start or the first Generera says it first', async () => {
      const { service, get } = harness({ pathIdleLimitSeconds: 300 });
      get.mockReturnValue(of({ data: INCIDENT_BODY }));
      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      service.noteWait('optimize');
      service.noteWait('optimize');

      expect(logged.warn.filter((line) => line.includes('closes a request that sends nothing'))).toHaveLength(1);
    });

    it('says for an engine older than deadlineSeconds that it cannot be asked to answer inside the wait', async () => {
      const { service, get } = harness({ pathIdleLimitSeconds: 300 });
      get.mockReturnValue(of({ data: INCIDENT_BODY_WITHOUT_DEADLINE }));
      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      expect(logged.warn.join('\n')).toContain('older than deadlineSeconds and cannot be asked to answer inside that');
    });

    it('says nothing of the road when the engine’s ceiling fits it, or the road has no limit', async () => {
      for (const over of [{ pathIdleLimitSeconds: 300 }, {}]) {
        const { service, get } = harness(over);
        get.mockReturnValue(of({ data: over.pathIdleLimitSeconds === undefined ? INCIDENT_BODY : PRODUCTION_BODY }));
        await service.onApplicationBootstrap();
        service.onModuleDestroy();
      }

      expect(logged.warn.filter((line) => line.includes('closes a request that sends nothing'))).toEqual([]);
      expect(logged.log.some((line) => line.includes('held to what the road'))).toBe(false);
    });

    it('does not call a wait that was set to 600000 "shorter than the engine can need" because the road cuts it', async () => {
      const { service, get } = harness({ timeoutMs: 600_000, pathIdleLimitSeconds: 300, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(of({ data: INCIDENT_BODY }));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.noteWait('optimize');
      service.onModuleDestroy();

      expect(logged.error).toEqual([]);
      expect(service.waitMs('optimize')).toBe(290_000);
    });

    it('says, when the engine does not state its times, that a wait that was set long is held to what the road holds', async () => {
      const { service, get } = harness({ timeoutMs: 600_000, pathIdleLimitSeconds: 300, nodeEnv: NodeEnv.Production });
      get.mockReturnValue(throwError(() => notFound()));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      service.onModuleDestroy();

      expect(logged.warn).toHaveLength(1);
      expect(logged.warn[0]).toContain('does not state its times');
      expect(logged.warn[0]).toContain('waits 290000 ms for a call, held to what the road to the engine holds');
      expect(logged.warn[0]).toContain('300 s (AI_ENGINE_PATH_IDLE_LIMIT_SECONDS)');
    });
  });
});
