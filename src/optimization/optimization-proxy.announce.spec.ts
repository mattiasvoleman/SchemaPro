import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { OptimizationProxyService, type PreparedSchedule } from './optimization-proxy.service';
import type { PrismaService } from '../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/*
 * GENERERA SÄGER TILL PERSONALRUMMET (E9, g465 L-4): a run that has written the week has replaced the master timetable under everyone who has it open,
 * and they are told once it has committed, so that they read the year (the event names no lesson: a run replaces them all). A run that wrote nothing left
 * the timetable as it was and tells nobody. In the draft mode only the administrators are told, as every writer of the draft does. A failure to tell is
 * logged and never fails a run that has written the week.
 *
 * The fetch and the write are the big spec's. Here the fetch is a stub and the write returns what it wrote.
 */
const USER = { userId: 'u-1', schoolId: 's-1', role: 'SCHOOL_ADMIN' } as unknown as AuthenticatedUser;
const PREPARED = {
  ready: true,
  requestId: 'r-1',
  academicYearId: 'y-1',
  schoolId: 's-1',
  payload: { requestId: 'r-1', academicYearId: 'y-1', requirements: [] },
  storedRules: null,
  anonMaps: { requirementAnonMap: new Map(), groupAnonMap: new Map() },
  freeDayWishes: [],
  consecutiveWishes: [],
  demand: [],
  mirrors: [],
  requirementRows: [],
  draftLessons: [],
} as unknown as PreparedSchedule;

function build(publishMode: 'DIRECT' | 'DRAFT' | null, written: unknown[] | null, readFails = false) {
  const post = jest.fn().mockReturnValue(of({ data: { requestId: 'r-1', status: 'OPTIMAL', lessons: [], lunches: [] } }));
  const config = {
    getOrThrow: jest.fn(() => ({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 240_000 })),
    get: jest.fn((key: string) => (key === 'app' ? { nodeEnv: 'production' } : undefined)),
  } as unknown as ConfigService;
  const findUnique = jest.fn(async () => {
    if (readFails) throw new Error('no connection');
    return publishMode ? { publishMode } : null;
  });
  // What happened, in order: the write, the commit of the transaction it ran in (withRls answers after it), and the telling.
  const order: string[] = [];
  const prisma = {
    withRls: jest.fn(async (_user: unknown, run: (t: unknown) => unknown) => {
      const result = await run({});
      order.push('commit');
      return result;
    }),
    queryWithRls: jest.fn((_user: unknown, run: (db: unknown) => unknown) => run({ publicationSettings: { findUnique } })),
  } as unknown as PrismaService;
  const realtime = { notifyMasterTimetableChanged: jest.fn(() => void order.push('told')) };
  const service = new OptimizationProxyService(prisma, { post } as unknown as HttpService, config, undefined, undefined, realtime as unknown as RealtimeService);
  jest.spyOn(service, 'prepareSchedule').mockResolvedValue(PREPARED);
  const persist = jest.spyOn(service as unknown as { persistMasterLessons: () => Promise<unknown> }, 'persistMasterLessons').mockImplementation(async () => {
    order.push('write');
    return written;
  });
  return { service, realtime, persist, findUnique, order };
}

describe('OptimizationProxyService: Generera tells the staff room that it wrote the week (E9, g465 L-4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('tells everyone who reads the grundschema, once, naming no lesson, after the write', async () => {
    const { service, realtime, persist } = build('DIRECT', []);
    await service.triggerScheduling('y-1', USER, null, null);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledTimes(1);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith('s-1', {});
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(realtime.notifyMasterTimetableChanged.mock.invocationCallOrder[0]!);
  });

  it('tells only once the transaction the write ran in has committed, not from inside it', async () => {
    // withRls answers after the commit; a telling from inside the write's callback is before it, and a client that reads the year on hearing it would read the old one.
    const { service, order } = build('DIRECT', []);
    await service.triggerScheduling('y-1', USER, null, null);
    // (the fetch before the engine call is a transaction too, and commits first)
    expect(order.slice(order.indexOf('write'))).toEqual(['write', 'commit', 'told']);
  });

  it('tells a school with no settings row as one that publishes directly', async () => {
    const { service, realtime } = build(null, []);
    await service.triggerScheduling('y-1', USER, null, null);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith('s-1', {});
  });

  it('tells only the administrators when the school publishes through a draft: the grundschema is the draft', async () => {
    const { service, realtime } = build('DRAFT', []);
    await service.triggerScheduling('y-1', USER, null, null);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith('s-1', { draft: true });
  });

  it('tells nobody when the run wrote nothing: the timetable is as it was', async () => {
    const { service, realtime, findUnique } = build('DIRECT', null);
    await service.triggerScheduling('y-1', USER, null, null);
    expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not fail a run that has written the week when the mode cannot be read, and tells everyone: a client told too much reads the year, one told nothing keeps the old week', async () => {
    const { service, realtime } = build('DRAFT', [], true);
    await expect(service.triggerScheduling('y-1', USER, null, null)).resolves.toHaveProperty('status');
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledTimes(1);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith('s-1', {});
  });

  it('is built by hand without a realtime (the specs and the probes): the run is as it was', async () => {
    const { service } = build('DIRECT', []);
    (service as unknown as { realtime: undefined }).realtime = undefined;
    await expect(service.triggerScheduling('y-1', USER, null, null)).resolves.toHaveProperty('status');
  });
});
