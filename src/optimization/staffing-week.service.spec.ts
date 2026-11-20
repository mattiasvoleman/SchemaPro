// FIRST, as the built application reads it (see optimization-module.di.spec.ts): the proxy's constructor must see the
// clash rule's file before the proxy's own is read. Kept first on purpose; do not let an import sorter move it.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { ConflictException, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { BASIS_PARTS, type BasisParts } from './candidate-basis';
import type { StaffingWeekDto } from './dto/staffing-week.dto';
import type { AiEngineScheduleRequest, AnonymousRequirement } from './interfaces/ai-engine-payload.interface';
import type { AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import type { OptimizationProxyService, PrepareResult } from './optimization-proxy.service';
import type { StaffingProposalService } from './staffing-proposal.service';
import { STAFFING_WEEK_BUDGET_MS, STAFFING_WEEK_MIN_CALL_MS, StaffingWeekService } from './staffing-week.service';
import { weekBasisOf, withWeekBasis } from './staffing-week';
import { WEEK_CHECK_PATH, WEEK_CHECK_TIMEOUT_MS } from './week-check.service';

void MasterLessonsService;

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const STAFFING_BASIS = 'a'.repeat(64);
const user = testUser();

const anon = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const real = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The teachers: the id the payload names them by, and the real one a proposal speaks in. */
const ENGINE = { eva: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ola: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const REAL = { eva: 'e1e1e1e1-0000-4000-8000-0000000000e1', ola: 'e2e2e2e2-0000-4000-8000-0000000000e2', newbie: 'e4e4e4e4-0000-4000-8000-0000000000e4' };

const post = (n: number, overrides: Partial<AnonymousRequirement> = {}): AnonymousRequirement => ({
  id: anon(n),
  subjectId: 'engine-subject',
  studentGroupId: 'engine-group',
  teacherId: ENGINE.eva,
  lessonsPerWeek: 4,
  minutesPerLesson: 40,
  minutesBefore: 0,
  minutesAfter: 0,
  studentGroupSize: 20,
  requiredRoomType: null,
  coTeacherId: null,
  minGradeLevel: 9,
  maxGradeLevel: 9,
  ...overrides,
});

const row = (percent: number, over = false, year = 9) => ({
  year,
  demandMinutes: Math.round((percent * 2200) / 100),
  capacityMinutes: 2200,
  percent,
  over,
});
const answer = (overrides: Partial<AiEngineWeekCheckResponse> = {}): AiEngineWeekCheckResponse => ({
  requestId: 'r',
  verdict: 'TIGHT',
  years: [row(95)],
  skipped: ['LUNCH_STAGE'],
  elapsedMs: 10,
  conflicts: null,
  ...overrides,
});
const under = (): AiEngineWeekCheckResponse => answer({ verdict: 'OK', years: [] });

const parts = (overrides: Partial<BasisParts> = {}): BasisParts =>
  ({ ...Object.fromEntries(BASIS_PARTS.map((part) => [part, `${part}-digest`])), ...overrides }) as BasisParts;

const dto = (changes: StaffingWeekDto['changes'], overrides: Partial<StaffingWeekDto> = {}): StaffingWeekDto => ({
  academicYearId: YEAR_ID,
  basisSha256: STAFFING_BASIS,
  changes,
  ...overrides,
});
const change = (n: number, from: string | null, to: string) => ({ requirementId: real(n), fromTeacherId: from, toTeacherId: to });

describe('StaffingWeekService', () => {
  let tx: { academicYear: { findUnique: jest.Mock } };
  let proxy: { prepareSchedule: jest.Mock; callAiEngine: jest.Mock; realiseConflicts: jest.Mock };
  let staffing: { currentBasis: jest.Mock };
  let service: StaffingWeekService;
  let requirements: AnonymousRequirement[];
  let numbering: 'NIOARIG' | 'TIOARIG';
  let preparedParts: BasisParts;
  let ready: boolean;

  const build = (storedRules: unknown = null) => {
    const prepared = ready
      ? {
          ready: true,
          payload: { requestId: 'q', academicYearId: YEAR_ID, requirements, rooms: [], constraints: [], teacherWorkRules: [], groupConflicts: [] },
          storedRules,
          anonMaps: { requirementAnonMap: new Map(requirements.map((r, i) => [real(i + 1), r.id])) },
          teacherAnonMap: new Map([
            [REAL.eva, ENGINE.eva],
            [REAL.ola, ENGINE.ola],
          ]),
          basisParts: preparedParts,
          periodStretches: null,
        }
      : { ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' };
    proxy.prepareSchedule.mockResolvedValue(prepared as unknown as PrepareResult);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Three posts of year 9, Eva's; and one of year 8 that is Ola's.
    requirements = [post(1), post(2), post(3), post(4, { teacherId: ENGINE.ola, minGradeLevel: 8, maxGradeLevel: 8 })];
    numbering = 'NIOARIG';
    preparedParts = parts();
    ready = true;
    tx = { academicYear: { findUnique: jest.fn(async () => ({ id: YEAR_ID, gradeNumbering: numbering })) } };
    proxy = {
      prepareSchedule: jest.fn(),
      callAiEngine: jest.fn(async () => answer()),
      realiseConflicts: jest.fn((conflicts: unknown) => conflicts ?? null),
    };
    staffing = { currentBasis: jest.fn(async () => STAFFING_BASIS) };
    build();
    const prisma = { withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => run(tx)) };
    service = new StaffingWeekService(
      prisma as unknown as PrismaService,
      proxy as unknown as OptimizationProxyService,
      staffing as unknown as StaffingProposalService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const answers = (...list: AiEngineWeekCheckResponse[]) => {
    let call = 0;
    proxy.callAiEngine.mockImplementation(async () => list[Math.min(call++, list.length - 1)]);
  };
  const sent = (n: number) => proxy.callAiEngine.mock.calls[n]![1] as AiEngineScheduleRequest;

  describe('what is asked of the engine', () => {
    it('asks the week as it stands, then the week with the proposal, each at the check\'s route, and nothing else', async () => {
      answers(answer({ years: [row(95)] }), answer({ years: [row(98)] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(proxy.callAiEngine).toHaveBeenCalledTimes(2);
      expect(proxy.callAiEngine.mock.calls.map((call) => call[0])).toEqual([WEEK_CHECK_PATH, WEEK_CHECK_PATH]);
      expect(view.calls).toBe(2);
      expect(view.status).toBe('DONE');
    });

    it('sends the week as it stands exactly as the fetch built it, and the week with the proposal as that with the proposed lead laid over its post and nothing else', async () => {
      await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      const fetched = (await proxy.prepareSchedule.mock.results[0]!.value).payload as AiEngineScheduleRequest;
      expect(sent(0)).toEqual(fetched);
      expect(sent(1).requirements[0]).toEqual({ ...requirements[0], teacherId: ENGINE.ola });
      expect(sent(1).requirements.slice(1)).toEqual(requirements.slice(1));
      expect({ ...sent(1), requirements: [] }).toEqual({ ...sent(0), requirements: [] });
      // No real id of a person or a post is in what the engine is sent.
      for (const call of proxy.callAiEngine.mock.calls) {
        expect(JSON.stringify(call[1])).not.toContain(REAL.ola);
        expect(JSON.stringify(call[1])).not.toContain(real(1));
      }
    });

    it('fetches the week as Generera does, but with the posts nobody teaches in it even where the school\'s policy refuses to generate with them', async () => {
      await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(proxy.prepareSchedule).toHaveBeenCalledTimes(1);
      expect(proxy.prepareSchedule.mock.calls[0]![3]).toMatchObject({ skipUnstaffedRefusal: true });
    });

    it('sends the school\'s saved lunch rules with it, as the check does', async () => {
      const rules = { lunch: { windowStart: '11:00' } };
      build(rules);

      await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(sent(0).rules).toEqual(rules);
      expect(sent(1).rules).toEqual(rules);
    });

    it('waits for the first check as long as a check may take and for the second as long as is left of the budget, and never less than the smallest wait', async () => {
      await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      const waits = proxy.callAiEngine.mock.calls.map((call) => (call[3] as { timeoutMs: number }).timeoutMs);
      expect(waits[0]).toBeLessThanOrEqual(WEEK_CHECK_TIMEOUT_MS);
      expect(waits[0]).toBeGreaterThanOrEqual(STAFFING_WEEK_MIN_CALL_MS);
      expect(waits[1]).toBeLessThanOrEqual(STAFFING_WEEK_BUDGET_MS);
      expect(waits[1]).toBeGreaterThanOrEqual(STAFFING_WEEK_MIN_CALL_MS);
    });

    it('gives the second check only what is left of the budget: a slow first check shortens the wait of the second, so the two never outlast the web\'s own wait', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-20T10:00:00Z') });
      // The first check takes ten seconds. The second, begun with twenty left, may wait twenty at most: the budget is for both.
      proxy.callAiEngine.mockImplementationOnce(async () => {
        jest.setSystemTime(Date.now() + 10_000);
        return answer();
      });

      await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      const waits = proxy.callAiEngine.mock.calls.map((call) => (call[3] as { timeoutMs: number }).timeoutMs);
      expect(waits).toHaveLength(2);
      expect(waits[1]).toBeLessThanOrEqual(STAFFING_WEEK_BUDGET_MS - 10_000);
      expect(waits[1]).toBeGreaterThanOrEqual(STAFFING_WEEK_MIN_CALL_MS);
    });

    it('asks nothing and fetches nothing when nothing is selected', async () => {
      const view = await service.check(dto([]), user);

      expect(view).toMatchObject({ status: 'NOT_CHECKED', reason: 'NO_CHANGES', years: [], verdicts: null, basisSha256: null, calls: 0 });
      expect(view.overlay).toEqual({ given: 0, laidOver: 0, notLaidOver: 0, fromNobody: 0, newToTheWeek: 0 });
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('asks nothing when none of the changes is a post of the week (written at another post\'s times, or a lead the payload does not carry): the week after would be the week before', async () => {
      const view = await service.check(dto([{ requirementId: real(99), fromTeacherId: REAL.eva, toTeacherId: REAL.ola }]), user);

      expect(view).toMatchObject({ status: 'NOT_CHECKED', reason: 'NO_CHANGES', basisSha256: null });
      expect(view.overlay).toMatchObject({ given: 1, laidOver: 0, notLaidOver: 1 });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });
  });

  describe('the answer', () => {
    it('says a proposal that makes a year\'s week tighter is TIGHTER and warns, with both figures counted in this call', async () => {
      answers(answer({ years: [row(95)] }), answer({ years: [row(98)] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.worse).toBe(true);
      expect(view.years).toHaveLength(1);
      expect(view.years[0]).toMatchObject({ year: 9, verdict: 'TIGHTER' });
      expect(view.years[0]!.before).toMatchObject({ kind: 'LOAD', percent: 95 });
      expect(view.years[0]!.after).toMatchObject({ kind: 'LOAD', percent: 98 });
      expect(view.verdicts).toEqual({ before: 'TIGHT', after: 'TIGHT' });
    });

    it('says a proposal that makes the week lighter is LOOSER and does not warn', async () => {
      answers(answer({ years: [row(98)] }), answer({ years: [row(93)] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.years[0]!.verdict).toBe('LOOSER');
      expect(view.worse).toBe(false);
    });

    it('shows a year that goes from under the threshold to a figure (it has a row after only), and one that goes the other way (a row before only)', async () => {
      answers(under(), answer({ years: [row(90)] }));
      const tighter = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(tighter.years[0]).toMatchObject({ verdict: 'TIGHTER', before: { kind: 'UNDER', below: 85 } });
      expect(tighter.worse).toBe(true);

      answers(answer({ years: [row(90)] }), under());
      const looser = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(looser.years[0]).toMatchObject({ verdict: 'LOOSER', after: { kind: 'UNDER', below: 85 } });
      expect(looser.worse).toBe(false);
    });

    it('says nothing is tighter or looser when both weeks are over the supply: each is only the first period the engine refused', async () => {
      // 107 % before and 144 % after, and the other way round: a proposal that can only relax shows as worse by the engine's counting.
      answers(answer({ verdict: 'IMPOSSIBLE', years: [row(107, true)] }), answer({ verdict: 'IMPOSSIBLE', years: [row(144, true)] }));
      const up = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      answers(answer({ verdict: 'IMPOSSIBLE', years: [row(144, true)] }), answer({ verdict: 'IMPOSSIBLE', years: [row(107, true)] }));
      const down = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      for (const view of [up, down]) {
        expect(view.years[0]!.verdict).toBe('STILL_OVER');
        expect(view.worse).toBe(false);
      }
    });

    /*
     * THE ENGINE STOPS AT THE FIRST WEEK IT REFUSES, FOR EVERY YEAR (_prechecks). The numbers are the engine's own
     * (optimization-engine/tests/test_staffing_week.py): year 8 over in the autumn at 107 %, year 9 at 91 % in the autumn
     * and 95 % in the spring answers (8: 107 % over, 9: 91 %); with year 9's spring raised to 144 % the answer is the same.
     */
    it('does not set a year\'s figure beside another when the week is refused in ANOTHER year: its row holds only the weeks counted before the refusal', async () => {
      const refusedInYear8 = () => answer({ verdict: 'IMPOSSIBLE', years: [row(107, true, 8), row(91, false, 9)] });
      // A proposal that takes year 9's spring over the supply cannot be seen: both answers say 91 %.
      answers(refusedInYear8(), refusedInYear8());

      const same = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(same.years).toHaveLength(1);
      expect(same.years[0]).toMatchObject({ year: 9, verdict: 'NOT_COMPARED', before: { atLeast: true, percent: 91 }, after: { atLeast: true, percent: 91 } });

      // And a year counted to its end before is not "lighter" because the week after is refused in another year and counted less.
      answers(answer({ years: [row(95, false, 9)] }), refusedInYear8());
      const lighter = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(lighter.years[0]).toMatchObject({ year: 9, verdict: 'NOT_COMPARED', after: { atLeast: true, percent: 91 } });
    });

    it('says a week that goes over the supply is TIGHTER and one that comes under it LOOSER', async () => {
      answers(answer({ years: [row(97)] }), answer({ verdict: 'IMPOSSIBLE', years: [row(102, true)] }));
      const over = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      answers(answer({ verdict: 'IMPOSSIBLE', years: [row(102, true)] }), answer({ years: [row(97)] }));
      const back = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(over.years[0]!.verdict).toBe('TIGHTER');
      expect(over.worse).toBe(true);
      expect(back.years[0]!.verdict).toBe('LOOSER');
      expect(back.worse).toBe(false);
    });

    it('does not compare a figure the engine\'s seconds cut: it says "at least" and is never better or worse', async () => {
      answers(answer({ years: [row(95)] }), answer({ years: [row(99)], skipped: ['WEEK_LOAD_DEADLINE'] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.years[0]).toMatchObject({ verdict: 'NOT_COMPARED', after: { kind: 'LOAD', atLeast: true } });
      expect(view.worse).toBe(false);
      // The cut is the same when it is the week as it stands that was cut.
      answers(answer({ years: [row(99)], skipped: ['WEEK_LOAD_DEADLINE'] }), answer({ years: [row(90)] }));
      const other = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(other.years[0]!.verdict).toBe('NOT_COMPARED');
    });

    it('says a year whose count was cut before the engine reached it is unknown, and not compared', async () => {
      answers(answer({ years: [row(95)] }), answer({ years: [], skipped: ['WEEK_LOAD_DEADLINE'] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.years[0]).toMatchObject({ verdict: 'NOT_COMPARED', after: { kind: 'UNKNOWN' } });
    });

    it('says a week the engine refuses for another reason after the proposal is NEWLY_REFUSED, with the sentence, and warns', async () => {
      const refusal = {
        summary: 'x',
        summaryCode: 'TEACHER_HOURS_EXCEED_WEEK',
        summaryParams: { teacher: 'T' },
        conflicts: [],
      };
      answers(answer({ years: [row(95)] }), answer({ verdict: 'IMPOSSIBLE', years: [], conflicts: refusal }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      // No year row after: the year asked about is counted from the refusal, and the verdict of the whole week is the warning.
      expect(view.verdicts).toEqual({ before: 'TIGHT', after: 'IMPOSSIBLE' });
      expect(view.years[0]).toMatchObject({ verdict: 'NEWLY_REFUSED', after: { kind: 'REFUSED', code: 'TEACHER_HOURS_EXCEED_WEEK' } });
      expect(view.worse).toBe(true);
    });

    it('warns when the engine refuses the whole week after the proposal and did not before, though no year is named', async () => {
      answers(under(), answer({ verdict: 'IMPOSSIBLE', years: [] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.years).toEqual([]);
      expect(view.worse).toBe(true);
    });

    it('warns of a year that is tighter after the proposal although more years than fit on the screen are touched: the warning is about all of them', async () => {
      // One post for years 1 to 9. The nine years' rows: year 1 is the lightest and the only one that gets tighter; the heavier eight get lighter.
      requirements = [post(1, { minGradeLevel: 1, maxGradeLevel: 9 })];
      build();
      const years = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      answers(
        answer({ years: years.map((year) => row(year === 1 ? 86 : 95, false, year)) }),
        answer({ years: years.map((year) => row(year === 1 ? 88 : 93, false, year)) }),
      );

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.years).toHaveLength(6);
      expect(view.years.map((year) => year.year)).not.toContain(1);
      expect(view.worse).toBe(true);
    });

    it('shows only the years a change touches: a year of a post that was not moved is not "affected" by the proposal', async () => {
      answers(
        answer({ years: [row(95, false, 9), row(90, false, 8)] }),
        answer({ years: [row(97, false, 9), row(91, false, 8)] }),
      );

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.years.map((year) => year.year)).toEqual([9]);
    });

    it('names years in the läsår\'s own numbering', async () => {
      numbering = 'TIOARIG';
      answers(answer({ years: [row(95)] }), answer({ years: [row(97)] }));

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      // The engine says årskurs 9 (NIOARIG); a tioårig läsår calls it 10.
      expect(view.years[0]!.year).toBe(10);
    });

    it('counts what became of the changes: laid over, left out, from nobody, and a teacher who has nothing else in the week', async () => {
      requirements = [post(1, { teacherId: null }), post(2), post(3)];
      build();

      const view = await service.check(
        dto([change(1, null, REAL.newbie), change(2, REAL.eva, REAL.ola), { requirementId: real(99), fromTeacherId: null, toTeacherId: REAL.ola }]),
        user,
      );

      expect(view.overlay).toEqual({ given: 3, laidOver: 2, notLaidOver: 1, fromNobody: 1, newToTheWeek: 1 });
    });
  });

  describe('the basis an apply carries', () => {
    it('returns the proposal\'s basis and the week\'s together when a figure was made, from the week the fetch read', async () => {
      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.basisSha256).toBe(withWeekBasis(STAFFING_BASIS, weekBasisOf(preparedParts)));
      expect(view.basisSha256).not.toBe(STAFFING_BASIS);
    });

    it('moves with the week: a room, a rule or a pupil changed gives another digest', async () => {
      const first = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      preparedParts = parts({ rooms: 'a room was added' });
      build();
      const second = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(second.basisSha256).not.toBe(first.basisSha256);
    });

    it('refuses a proposal that has gone old as an apply does (409 STAFF_PROPOSAL_STALE), before the engine is asked, so the digest it returns is never built on a stale proposal', async () => {
      staffing.currentBasis.mockResolvedValue('b'.repeat(64));

      const result = service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      await expect(result).rejects.toBeInstanceOf(ConflictException);
      await expect(result).rejects.toMatchObject({ response: { code: 'STAFF_PROPOSAL_STALE' } });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('reads the proposal\'s basis and the week in one transaction, so the two agree', async () => {
      const prisma = { withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => run(tx)) };
      service = new StaffingWeekService(
        prisma as unknown as PrismaService,
        proxy as unknown as OptimizationProxyService,
        staffing as unknown as StaffingProposalService,
      );

      await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(staffing.currentBasis.mock.calls[0]![0]).toBe(tx);
      expect(proxy.prepareSchedule.mock.calls[0]![0]).toBe(tx);
    });

    it('is a 404 for a year the school has not got', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(service.check(dto([change(1, REAL.eva, REAL.ola)]), user)).rejects.toBeInstanceOf(NotFoundException);
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });
  });

  describe('advice, not a gate: a figure that could not be made is an answer, never an error', () => {
    it('says so when the gateway\'s own pre-flight refuses the week, and when every post is hand-placed', async () => {
      ready = false;
      build();
      const refused = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(refused).toMatchObject({ status: 'NOT_CHECKED', reason: 'NOT_READY', basisSha256: null });

      ready = true;
      requirements = [];
      build();
      const placed = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(placed).toMatchObject({ status: 'NOT_CHECKED', reason: 'NO_POSTS', basisSha256: null });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('says an engine without the check is older, for either of the two checks', async () => {
      proxy.callAiEngine.mockRejectedValueOnce(new HttpException('Not Found', HttpStatus.NOT_FOUND));
      const first = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(first).toMatchObject({ status: 'NOT_CHECKED', reason: 'ENGINE_OLDER', basisSha256: null });

      proxy.callAiEngine.mockReset();
      proxy.callAiEngine.mockResolvedValueOnce(answer()).mockRejectedValueOnce(new HttpException('Not Found', HttpStatus.NOT_FOUND));
      const second = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);
      expect(second).toMatchObject({ status: 'NOT_CHECKED', reason: 'ENGINE_OLDER', basisSha256: null });
    });

    it('says the engine failed, for either check, and for an answer it cannot read, without throwing', async () => {
      proxy.callAiEngine.mockReset();
      proxy.callAiEngine.mockRejectedValueOnce(new HttpException('boom', HttpStatus.SERVICE_UNAVAILABLE));
      expect(await service.check(dto([change(1, REAL.eva, REAL.ola)]), user)).toMatchObject({ status: 'NOT_CHECKED', reason: 'ENGINE_ERROR', basisSha256: null });

      proxy.callAiEngine.mockReset();
      proxy.callAiEngine.mockResolvedValueOnce(answer()).mockRejectedValueOnce(new Error('socket hang up'));
      expect(await service.check(dto([change(1, REAL.eva, REAL.ola)]), user)).toMatchObject({ status: 'NOT_CHECKED', reason: 'ENGINE_ERROR', basisSha256: null });

      proxy.callAiEngine.mockReset();
      proxy.callAiEngine.mockResolvedValueOnce(answer({ verdict: 'SOMETHING_NEW' as never }));
      expect(await service.check(dto([change(1, REAL.eva, REAL.ola)]), user)).toMatchObject({ status: 'NOT_CHECKED', reason: 'ENGINE_ERROR' });

      proxy.callAiEngine.mockReset();
      proxy.callAiEngine.mockResolvedValueOnce({ requestId: 'r' } as never);
      expect(await service.check(dto([change(1, REAL.eva, REAL.ola)]), user)).toMatchObject({ status: 'NOT_CHECKED', reason: 'ENGINE_ERROR' });
    });

    it('begins no second check when too little of the budget is left, and says it was too slow', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-20T10:00:00Z') });
      // The first check takes all but five seconds of the budget (a heavy school): the second could not finish inside it.
      proxy.callAiEngine.mockImplementationOnce(async () => {
        jest.setSystemTime(Date.now() + STAFFING_WEEK_BUDGET_MS - STAFFING_WEEK_MIN_CALL_MS + 1_000);
        return answer();
      });

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view).toMatchObject({ status: 'NOT_CHECKED', reason: 'TOO_SLOW', calls: 1, basisSha256: null });
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1);
    });

    it('begins the second check when the budget leaves room for it', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-20T10:00:00Z') });
      proxy.callAiEngine.mockImplementationOnce(async () => {
        jest.setSystemTime(Date.now() + STAFFING_WEEK_BUDGET_MS - STAFFING_WEEK_MIN_CALL_MS - 1_000);
        return answer();
      });

      const view = await service.check(dto([change(1, REAL.eva, REAL.ola)]), user);

      expect(view.status).toBe('DONE');
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(2);
    });
  });
});
