import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { JobRunner } from '../jobs/job-runner';
import type { SupabaseAdminService } from '../users/supabase-admin.service';
import { GALLRING_INTERVAL_MS, GALLRING_JOB, GallringJob, NIGHTLY_ROW_CAP, PURGE_BATCH } from './gallring.job';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const config = (background: boolean) => ({ get: () => ({ background }) }) as unknown as ConfigService;

/**
 * A database stand-in for one night: `purges` says what each
 * app.gallring_purge call answers per kind, in order; `due` is
 * app.gallring_departed_due's list, and app.gallring_claim_person answers
 * each listed person's login unless `spared` names them (reactivated or
 * spared since the list was read).
 */
function night(
  options: {
    schools?: string[];
    purges?: Record<string, number[]>;
    due?: Array<{ user_id: string; auth_id: string; invited: boolean }>;
    spared?: string[];
    gone?: string[];
    failBegin?: string;
  } = {},
) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const purges = Object.fromEntries(Object.entries(options.purges ?? {}).map(([kind, answers]) => [kind, [...answers]]));
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    const values = (statement as Statement).values;
    calls.push({ text, values });
    if (text.includes('app.gallring_schools()')) return (options.schools ?? []).map((id) => ({ id }));
    if (text.includes('app.gallring_begin(')) {
      if (values[0] === options.failBegin) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      return [{ run: `run-${values[0] as string}` }];
    }
    if (text.includes('app.gallring_purge(')) return [{ n: purges[values[1] as string]?.shift() ?? 0 }];
    if (text.includes('app.gallring_departed_due(')) return (options.due ?? []).map(({ user_id }) => ({ user_id }));
    if (text.includes('app.gallring_claim_person(')) {
      const person = (options.due ?? []).find((p) => p.user_id === values[1]);
      return person && !options.spared?.includes(person.user_id) ? [{ auth_id: person.auth_id, invited: person.invited }] : [];
    }
    if (text.includes('app.gallring_pseudonymise(')) {
      return [{ n: (values[1] as string[]).filter((id) => !options.gone?.includes(id)).length }];
    }
    return [];
  });
  tx.$executeRaw = jest.fn(async (statement: unknown) => {
    calls.push({ text: sql(statement), values: (statement as Statement).values });
    return 1;
  });
  const runner = new JobRunner();
  const claim = jest.spyOn(runner, 'claimNightly').mockImplementation(async (_job, _hour, ids) =>
    ids.map((schoolId) => ({ schoolId, localDay: new Date('2026-10-21T00:00:00Z') })),
  );
  const finish = jest.spyOn(runner, 'finishNightly').mockResolvedValue();
  const settled = jest.spyOn(runner, 'settled');
  const supabase = { deleteUser: jest.fn().mockResolvedValue(undefined) };
  const job = new GallringJob(prisma as unknown as PrismaService, supabase as unknown as SupabaseAdminService, config(true), runner);
  return { job, runner, calls, claim, finish, settled, supabase, prisma };
}

describe('GallringJob', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('registers every five minutes only when GALLRING_BACKGROUND is on, and leaves on shutdown', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const supabase = {} as SupabaseAdminService;
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const off = new GallringJob(prisma, supabase, config(false), runner);
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const on = new GallringJob(prisma, supabase, config(true), runner);
    on.onModuleInit();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: GALLRING_JOB, intervalMs: GALLRING_INTERVAL_MS }));
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('claims nothing and removes nothing while no school has decided a period', async () => {
    const { job, calls, claim, settled } = night();
    await job.tick();
    expect(calls.map((c) => c.text).join()).toContain('app.gallring_schools()');
    expect(calls).toHaveLength(1);
    expect(claim).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(GALLRING_JOB, expect.any(Date), { ok: true, counts: { schools: 0 } });
  });

  it('runs a claimed school\'s night: every row kind in batches until one comes back short, then the people, then finish', async () => {
    const { job, calls, claim, finish, settled } = night({
      schools: ['s1'],
      purges: { ATTENDANCE: [PURGE_BATCH, PURGE_BATCH, 7], NOTIFICATIONS: [0], CHANGE_LOGS: [3] },
    });
    await job.tick(new Date('2026-10-21T01:05:00Z'));
    expect(claim).toHaveBeenCalledWith(GALLRING_JOB, 3, ['s1'], 5, new Date('2026-10-21T01:05:00Z'));
    const purgeKinds = calls.filter((c) => c.text.includes('app.gallring_purge(')).map((c) => c.values[1]);
    expect(purgeKinds).toEqual([
      'ATTENDANCE', 'ATTENDANCE', 'ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'NOTIFICATIONS', 'CHANGE_LOGS', 'ABSENCE_REASONS',
    ]);
    // Every purge names the run and the batch size.
    for (const call of calls.filter((c) => c.text.includes('app.gallring_purge('))) {
      expect(call.values[0]).toBe('run-s1');
      expect(call.values[2]).toBe(PURGE_BATCH);
    }
    const order = calls.map((c) => /app\.(\w+)\(/.exec(c.text)?.[1]);
    expect(order[0]).toBe('gallring_schools');
    expect(order[1]).toBe('gallring_begin');
    expect(order.slice(-2)).toEqual(['gallring_departed_due', 'gallring_finish']);
    expect(finish).toHaveBeenCalledWith(GALLRING_JOB, 's1', expect.any(Date), expect.any(Date));
    expect(settled).toHaveBeenCalledWith(GALLRING_JOB, expect.any(Date), {
      ok: true,
      counts: { schools: 1, failed: 0, rows: 2 * PURGE_BATCH + 7 + 3, people: 0 },
    });
  });

  it('stops a kind at the night\'s cap and leaves the rest for the next night', async () => {
    const full = Math.ceil(NIGHTLY_ROW_CAP / PURGE_BATCH) + 5;
    const { job, calls } = night({ schools: ['s1'], purges: { ATTENDANCE: Array(full).fill(PURGE_BATCH) } });
    await job.tick();
    const attendance = calls.filter((c) => c.text.includes('app.gallring_purge(') && c.values[1] === 'ATTENDANCE');
    expect(attendance).toHaveLength(Math.ceil(NIGHTLY_ROW_CAP / PURGE_BATCH));
  });

  it('claims each person right before their login goes, pseudonymises them at once, and leaves whoever\'s login stays for the next night', async () => {
    const due = [
      { user_id: 'u-invited', auth_id: 'a-1', invited: true },
      { user_id: 'u-catalogue', auth_id: 'a-2', invited: false },
      { user_id: 'u-stuck', auth_id: 'a-3', invited: true },
    ];
    const { job, calls, supabase, settled } = night({ schools: ['s1'], due });
    supabase.deleteUser.mockImplementation(async (authId: string) => {
      calls.push({ text: 'deleteUser', values: [authId] });
      if (authId === 'a-3') throw new Error('Supabase delete failed: 500');
    });
    await job.tick();
    // Never for a catalogue-only person: their authId matches no login.
    expect(supabase.deleteUser.mock.calls).toEqual([['a-1'], ['a-3']]);
    const people = calls.filter((c) => /app\.gallring_(claim_person|pseudonymise)\(|^deleteUser$/.test(c.text));
    expect(people.map((c) => (c.text === 'deleteUser' ? ['deleteUser', c.values[0]] : [/app\.gallring_(\w+)\(/.exec(c.text)![1], c.values[1]]))).toEqual([
      ['claim_person', 'u-invited'],
      ['deleteUser', 'a-1'],
      ['pseudonymise', ['u-invited']],
      ['claim_person', 'u-catalogue'],
      ['pseudonymise', ['u-catalogue']],
      ['claim_person', 'u-stuck'],
      ['deleteUser', 'a-3'],
    ]);
    for (const call of people.filter((c) => c.text !== 'deleteUser')) expect(call.values[0]).toBe('run-s1');
    const finish = calls.find((c) => c.text.includes('app.gallring_finish('))!;
    expect(JSON.parse(finish.values[1] as string)).toEqual({ DEPARTED_PEOPLE_LOGIN: 1 });
    expect(settled).toHaveBeenCalledWith(GALLRING_JOB, expect.any(Date), expect.objectContaining({ counts: expect.objectContaining({ people: 2 }) }));
  });

  it('keeps the login of a person the claim no longer answers for, and names them for nothing', async () => {
    const due = [
      { user_id: 'u-reactivated', auth_id: 'a-1', invited: true },
      { user_id: 'u-gone', auth_id: 'a-2', invited: true },
    ];
    const { job, calls, supabase, settled } = night({ schools: ['s1'], due, spared: ['u-reactivated'] });
    await job.tick();
    expect(supabase.deleteUser.mock.calls).toEqual([['a-2']]);
    const pseudonymised = calls.filter((c) => c.text.includes('app.gallring_pseudonymise(')).map((c) => c.values[1]);
    expect(pseudonymised).toEqual([['u-gone']]);
    const finish = calls.find((c) => c.text.includes('app.gallring_finish('))!;
    expect(JSON.parse(finish.values[1] as string)).toEqual({});
    expect(settled).toHaveBeenCalledWith(GALLRING_JOB, expect.any(Date), expect.objectContaining({ counts: expect.objectContaining({ people: 1 }) }));
  });

  it('says so, by school id alone, when a login went and the person was no longer due a moment later', async () => {
    const due = [{ user_id: 'u-late', auth_id: 'a-1', invited: true }];
    const { job, supabase } = night({ schools: ['s1'], due, gone: ['u-late'] });
    await job.tick();
    expect(supabase.deleteUser.mock.calls).toEqual([['a-1']]);
    expect(spies[1]!.mock.calls.map((call) => call[0])).toContain('Gallring removed the login of a person no longer due [school=s1]');
  });

  it('carries on with the next school when one fails, and leaves the failed one unfinished for the claim to retry', async () => {
    const { job, finish, settled } = night({ schools: ['s1', 's2'], failBegin: 's1' });
    await job.tick();
    expect(finish.mock.calls.map((call) => call[1])).toEqual(['s2']);
    expect(settled).toHaveBeenCalledWith(GALLRING_JOB, expect.any(Date), {
      ok: true,
      counts: { schools: 2, failed: 1, rows: 0, people: 0 },
    });
    expect(spies[1]!.mock.calls.map((call) => call[0])).toContain('Gallring failed [school=s1, PrismaClientKnownRequestError]');
  });

  it('never overlaps itself, and a failing tick is counted as a failure and does not throw', async () => {
    const { job, prisma, settled } = night({ schools: [] });
    let release!: () => void;
    prisma.withDeliveryService.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
    const first = job.tick();
    const second = job.tick();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);

    prisma.withDeliveryService.mockRejectedValueOnce(Object.assign(new Error('db down'), { name: 'PrismaClientInitializationError' }));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(settled).toHaveBeenLastCalledWith(GALLRING_JOB, expect.any(Date), { ok: false, error: 'PrismaClientInitializationError' });
  });
});
