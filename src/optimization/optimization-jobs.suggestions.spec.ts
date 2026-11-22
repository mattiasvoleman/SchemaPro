import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { OptimizationJobsService, jobView } from './optimization-jobs.service';
import type { OptimizationProxyService } from './optimization-proxy.service';
import { failedSuggestions, runningSuggestions, suggestionsFromEngine, type Realiser } from './suggestions';
import type { AiEngineSuggestChangesResponse } from './interfaces/suggest-changes.interface';

/*
 * What a run's analysis looks like to a reader (OptimizationJobsService.get / list, jobView): the column is read through the whitelist,
 * an analysis that has been RUNNING too long reads as the failure it is, a cap's teacher is named by whom this reader may see, and the
 * Users id the column keeps never leaves. The button is offered for the runs the five rules can have ended, and for no other.
 */

const JOB_ID = '66666666-6666-4666-8666-666666666666';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const RULE = '11111111-1111-4111-8111-111111111111';
const TEACHER = '99999999-9999-4999-8999-999999999999';
const STARTED = '2027-03-05T10:00:00.000Z';
const NOW = new Date('2027-03-05T10:01:30.000Z');

const realiser: Realiser = { real: (id) => id, nameOf: () => undefined, teacherOfRule: (id) => (id === RULE ? TEACHER : undefined) };

const answer = (changes: AiEngineSuggestChangesResponse['changes']): AiEngineSuggestChangesResponse => ({
  requestId: 'r', verdict: 'CHANGES', changes, verified: true, searchSeconds: 60, verifySeconds: 2, elapsedMs: 1,
});

const cap = {
  rule: 'TEACHER_DAILY_CAP' as const, cost: 168, current: 300, needed: 330, weekdays: [3], requirementIds: [], roomIds: [], resourceIds: [RULE], proof: 'SOLVED' as const,
};
const days = {
  rule: 'TEACHER_WORK_DAYS' as const, cost: 1200, current: 3, needed: 4, weekdays: [2], requirementIds: [], roomIds: [], resourceIds: [], proof: 'SOLVED_TOGETHER' as const,
};

const done = suggestionsFromEngine(answer([cap]), realiser, STARTED, NOW);

const row = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  academicYearId: YEAR_ID,
  status: 'SUCCEEDED',
  solverStatus: 'INFEASIBLE',
  lessonsGenerated: 0,
  conflictSummary: null,
  conflicts: [],
  error: null,
  errorCode: null,
  createdAt: new Date('2027-03-05T09:00:00.000Z'),
  finishedAt: new Date('2027-03-05T09:03:00.000Z'),
  suggestions: null,
  ...over,
});

describe('a run read with its analysis', () => {
  describe('jobView', () => {
    it('has none for a run nobody asked about, and offers the button for a refusal', () => {
      const { view } = jobView(row(), null, new Map(), NOW);
      expect(view.suggestions).toBeNull();
      expect(view.suggestionsOffered).toBe(true);
    });

    it.each([
      ['a run with a timetable', { solverStatus: 'OPTIMAL' }, false],
      ['a run still going', { status: 'RUNNING', solverStatus: null }, false],
      ['a TIMEOUT', { solverStatus: 'TIMEOUT' }, true],
      ['a cap the week cannot hold', { status: 'FAILED', solverStatus: null, errorCode: 'TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK' }, true],
      ['an engine that was never reached', { status: 'FAILED', solverStatus: null, errorCode: 'ENGINE_NOT_REACHED' }, false],
    ])('offers the button for %s: %s', (_name, over, offered) => {
      expect(jobView(row(over), null, new Map(), NOW).view.suggestionsOffered).toBe(offered);
    });

    it('does not offer it for a run whose lease has run out: it is read as the abandonment it will become', () => {
      const lost = row({ status: 'RUNNING', solverStatus: null, leaseUntil: new Date('2027-03-05T09:30:00.000Z'), heartbeatAt: new Date('2027-03-05T09:29:00.000Z') });
      expect(jobView(lost, null, new Map(), NOW).view.suggestionsOffered).toBe(false);
    });

    it('shows the stored analysis with each cap\'s teacher named, and the Users id left behind', () => {
      const { view } = jobView(row({ suggestions: done }), null, new Map([[TEACHER, 'Anna Andersson']]), NOW);
      expect(view.suggestions).toMatchObject({ state: 'DONE', verdict: 'CHANGES', verified: true, total: 1 });
      expect(view.suggestions!.changes[0]).toMatchObject({ rule: 'TEACHER_DAILY_CAP', proof: 'SOLVED', current: 300, needed: 330, teacherNames: ['Anna Andersson'] });
      expect(JSON.stringify(view)).not.toContain(TEACHER);
    });

    it('names a teacher to every reader, for a cap is no HR fact, and names nobody a reader may not see', () => {
      expect(jobView(row({ suggestions: done }), null, new Map(), NOW).view.suggestions!.changes[0]!.teacherNames).toEqual([]);
    });

    it('shows a part-timer\'s days hidden to every reader, a reader with HR-läs included, since nothing HR is stored', () => {
      const stored = suggestionsFromEngine(answer([days]), realiser, STARTED, NOW);
      const posts = new Map([[TEACHER, { days: 3, stretch: null, name: 'Anna Andersson' }]]);
      for (const reader of [null, posts]) {
        const { view, revealed } = jobView(row({ suggestions: stored }), reader, new Map([[TEACHER, 'Anna Andersson']]), NOW);
        expect(view.suggestions!.changes).toEqual([expect.objectContaining({ rule: 'TEACHER_WORK_DAYS', hidden: true, current: null, needed: null, weekdays: [], teacherNames: [] })]);
        expect(JSON.stringify(view.suggestions)).not.toContain('Anna');
        expect(revealed).toEqual([]);
      }
    });

    it('reads an analysis that has been RUNNING for longer than any lasts as the failure it is', () => {
      const lost = runningSuggestions(new Date(NOW.getTime() - 10 * 60 * 1000));
      expect(jobView(row({ suggestions: lost }), null, new Map(), NOW).view.suggestions).toMatchObject({ state: 'FAILED', failure: 'ABANDONED' });
      const fresh = runningSuggestions(new Date(NOW.getTime() - 30 * 1000));
      expect(jobView(row({ suggestions: fresh }), null, new Map(), NOW).view.suggestions).toMatchObject({ state: 'RUNNING', failure: null });
    });

    it('shows a failed analysis with its code', () => {
      const failed = failedSuggestions(STARTED, 'ENGINE_LACKS_SUGGESTIONS', NOW);
      expect(jobView(row({ suggestions: failed }), null, new Map(), NOW).view.suggestions).toMatchObject({ state: 'FAILED', failure: 'ENGINE_LACKS_SUGGESTIONS' });
    });

    it.each([
      ['a column that is not an object', 'x'],
      ['another version', { ...done, version: 9 }],
      ['a change that says a part-timer\'s days in the open', { ...done, changes: [{ ...done.changes[0], rule: 'TEACHER_WORK_DAYS' }] }],
      ['a column with six changes at the longest, over what the check allows', { ...done, total: 6, changes: Array.from({ length: 6 }, () => ({
        ...done.changes[0], rule: 'ROOM_LOCK', requirementIds: [JOB_ID, YEAR_ID, RULE], roomIds: [JOB_ID, YEAR_ID, RULE],
        requirementNames: ['Ö'.repeat(80), 'Ö'.repeat(80), 'Ö'.repeat(80)], roomNames: ['Ö'.repeat(80), 'Ö'.repeat(80), 'Ö'.repeat(80)],
      })) }],
    ])('shows nothing of %s: a value that is not wholly well formed is not shown in part', (_name, value) => {
      expect(jobView(row({ suggestions: value }), null, new Map(), NOW).view.suggestions).toBeNull();
    });
  });

  describe('through the service', () => {
    let tx: TxMock;
    let prisma: PrismaMock;
    let service: OptimizationJobsService;

    beforeEach(() => {
      tx = createTxMock();
      prisma = createPrismaMock(tx);
      tx.scheduleChangeLog.findMany.mockResolvedValue([]);
      service = new OptimizationJobsService({ waitSeconds: 240 } as unknown as OptimizationProxyService, prisma as unknown as PrismaService);
    });

    it('reads the column with the run and names the teacher of a cap, once, by the ids the run names', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(row({ suggestions: done }));
      tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Anna', lastName: 'Andersson' }]);

      const view = await service.get(JOB_ID, testUser());

      expect(tx.optimizationJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ suggestions: true }) }));
      expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [TEACHER] } } }));
      expect(view.suggestions!.changes[0]!.teacherNames).toEqual(['Anna Andersson']);
    });

    it('reads no name for a run with no analysis', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(row());
      await service.get(JOB_ID, testUser());
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    it('carries it in the history too, a run at a time', async () => {
      tx.optimizationJob.findMany.mockResolvedValue([row({ suggestions: done }), row({ id: 'other', suggestions: null })]);
      tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Anna', lastName: 'Andersson' }]);

      const views = await service.list(YEAR_ID, testUser());

      expect(views.map((view) => view.suggestions?.state ?? null)).toEqual(['DONE', null]);
    });
  });
});
