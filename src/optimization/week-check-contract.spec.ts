// FIRST, as the built application reads it (see optimization-module.di.spec.ts). Kept first on purpose.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { Logger } from '@nestjs/common';
import { testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  WEEK_CHECK_SKIPPED,
  WEEK_CHECK_VERDICTS,
  type AiEngineWeekCheckResponse,
  type WeekCheckYear,
} from './interfaces/week-check.interface';
import type { OptimizationProxyService, PrepareResult } from './optimization-proxy.service';
import { WEEK_CHECK_PATH, WeekCheckService } from './week-check.service';

void MasterLessonsService;

/**
 * Kontrollera veckan's wire contract, pinned from the gateway's side.
 *
 * The engine's models (optimization-engine/app/schemas/week_check.py) forbid
 * extra fields, and its request IS Generera's: a name changed on one side only
 * is a 422 for the whole request or a key this gateway never reads. The mirror
 * of these lists is tests/test_week_check.py (RESPONSE_KEYS, YEAR_KEYS and the
 * OpenAPI enums); either half failing means the two sides have parted company.
 * Fix the code, not the list, and change both halves in the commit that
 * deploys the engine.
 */
const RESPONSE_FIELDS = ['conflicts', 'elapsedMs', 'requestId', 'skipped', 'verdict', 'years'];
const YEAR_FIELDS = ['capacityMinutes', 'demandMinutes', 'over', 'percent', 'year'];
/** What the ENGINE can leave out; the gateway adds `ENGINE` for a week it never asked about. */
const ENGINE_SKIPPED = ['LUNCH_STAGE', 'PLACEMENTS_PROBE', 'WEEK_LOAD_DEADLINE'];

const year = (): WeekCheckYear => ({ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false });

/** Every field the engine declares, so that a field added to the interface fails to compile here. */
const reply = (): AiEngineWeekCheckResponse => ({
  requestId: '55555555-5555-4555-8555-555555555555',
  verdict: 'TIGHT',
  years: [year()],
  conflicts: { summary: '', summaryCode: '', summaryParams: {}, conflicts: [] },
  skipped: ['LUNCH_STAGE'],
  elapsedMs: 5,
});

describe('Kontrollera veckan: the wire contract', () => {
  const user = testUser();
  const payload = {
    requestId: '55555555-5555-4555-8555-555555555555',
    academicYearId: '44444444-4444-4444-8444-444444444444',
    requirements: [{ id: 'r' }],
    rooms: [],
    constraints: [],
    teacherWorkRules: [],
    groupConflicts: [],
  };
  let proxy: { prepareSchedule: jest.Mock; callAiEngine: jest.Mock; realiseConflicts: jest.Mock };
  let service: WeekCheckService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    proxy = {
      prepareSchedule: jest.fn(async () => ({ ready: true, payload, storedRules: null, anonMaps: {} }) as unknown as PrepareResult),
      callAiEngine: jest.fn(async () => reply()),
      realiseConflicts: jest.fn((conflicts: unknown) => conflicts ?? null),
    };
    const prisma = { withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => run({})) };
    service = new WeekCheckService(prisma as unknown as PrismaService, proxy as unknown as OptimizationProxyService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads exactly the response fields the engine declares', () => {
    expect(Object.keys(reply()).sort()).toEqual(RESPONSE_FIELDS);
    expect(Object.keys(year()).sort()).toEqual(YEAR_FIELDS);
  });

  it('names the three verdicts and the three things the engine can leave out, as the engine does', () => {
    expect([...WEEK_CHECK_VERDICTS]).toEqual(['OK', 'TIGHT', 'IMPOSSIBLE']);
    expect([...WEEK_CHECK_SKIPPED].filter((name) => name !== 'ENGINE')).toEqual(ENGINE_SKIPPED);
  });

  it('asks the engine at /api/v1/check-week with Generera\'s payload, field for field and nothing added', async () => {
    await service.check('44444444-4444-4444-8444-444444444444', user);

    const [path, sent] = proxy.callAiEngine.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/v1/check-week');
    expect(path).toBe(WEEK_CHECK_PATH);
    // No weights, no search, no relaxation: a check carries none of a run's tuning.
    expect(Object.keys(sent).sort()).toEqual(Object.keys(payload).sort());
    expect(sent).not.toHaveProperty('weights');
    expect(sent).not.toHaveProperty('search');
    expect(sent).not.toHaveProperty('relaxation');
  });

  it('passes a year on with exactly the year fields, whatever else the engine adds', async () => {
    proxy.callAiEngine.mockResolvedValue({ ...reply(), years: [{ ...year(), shiny: true }] });

    const view = await service.check('44444444-4444-4444-8444-444444444444', user);

    expect(Object.keys(view.years[0]!).sort()).toEqual(YEAR_FIELDS);
  });

  it('answers with exactly the fields the web reads, and the engine\'s request id and nothing else of its own', async () => {
    const view = await service.check('44444444-4444-4444-8444-444444444444', user);

    // web/lib/week-check.ts (WeekCheckResult): verdict, years, conflicts, skipped, elapsedMs, checkedBy.
    expect(Object.keys(view).sort()).toEqual(['checkedBy', 'conflicts', 'elapsedMs', 'skipped', 'verdict', 'years']);
  });
});
