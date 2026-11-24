import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_STAGES } from './engine-timing';
import { TIMEOUT_PHASES, TIMEOUT_STAGES, timeoutReportOf, type TimeoutReportView } from './timeout-report';

/*
 * WHERE A TIMED-OUT RUN'S TIME WENT (omgång 13, M2): what the gateway keeps of the engine's TimeoutReport.
 * The reply is read with no runtime validation and the column is a jsonb the page trusts, so what is kept is
 * rebuilt from the closed set of names and the finite numbers it may hold, and a report that is not wholly
 * well formed is not kept in part.
 */

const report = (): Record<string, unknown> => ({
  totalSeconds: 109,
  budgetSeconds: 100,
  configuredBudgetSeconds: 100,
  callerWaitSeconds: null,
  stages: [
    { stage: 'PRECHECKS', seconds: 0.4 },
    { stage: 'BUILD', seconds: 4 },
    { stage: 'SEARCH_CLEAN', seconds: 60 },
    { stage: 'SEARCH_CLONE', seconds: 40 },
    { stage: 'PROBE', seconds: 5 },
  ],
  search: {
    solutions: 0,
    phases: [
      { phase: 'CLEAN', seconds: 60, conflicts: 118344, branches: 920113 },
      { phase: 'CLONE', seconds: 40, conflicts: null, branches: null },
    ],
  },
  weekLoadCut: false,
});

describe('timeoutReportOf', () => {
  it('keeps a well formed report as it is', () => {
    expect(timeoutReportOf(report())).toEqual(report());
  });

  it('is idempotent: what it returns is accepted again unchanged, which is how the stored column is read', () => {
    const once = timeoutReportOf(report()) as TimeoutReportView;
    expect(timeoutReportOf(once)).toEqual(once);
  });

  it('knows the six steps and the two searches the engine names', () => {
    expect([...TIMEOUT_STAGES]).toEqual(['PRECHECKS', 'BUILD', 'SITES', 'SEARCH_CLEAN', 'SEARCH_CLONE', 'PROBE']);
    expect([...TIMEOUT_PHASES]).toEqual(['CLEAN', 'CLONE']);
  });

  describe('the names, read from the engine’s schema (the review of #376, U-1)', () => {
    // A step the engine adds passes a hand-written list on each side and every report with it is refused (null) in
    // production until the gateway follows. The three lists the gateway keeps (TIMEOUT_STAGES, TIMEOUT_PHASES and
    // engine-timing's ENGINE_STAGES, which reads a 503's details) are held to the two `Literal[...]` of
    // optimization-engine/app/schemas/schedule.py, read as text: the repository's way (year-periods.spec.ts reads
    // MAX_PERIODS from the same file) and no Python.
    const schema = readFileSync(join(__dirname, '..', '..', 'optimization-engine/app/schemas/schedule.py'), 'utf8');
    const literalOf = (name: string): string[] => {
      const match = new RegExp(`^${name} = Literal\\[([^\\]]*)\\]`, 'm').exec(schema);
      expect(match).not.toBeNull();
      return [...match![1]!.matchAll(/"([A-Z_]+)"/g)].map((quoted) => quoted[1]!);
    };

    it('lists the steps in the order the engine does, and the gateway’s two lists of them agree', () => {
      const engine = literalOf('TimeoutStageName');
      expect(engine.length).toBeGreaterThanOrEqual(6);
      expect([...TIMEOUT_STAGES]).toEqual(engine);
      expect([...ENGINE_STAGES]).toEqual(engine);
    });

    it('lists the searches that report their effort as the engine does', () => {
      const engine = literalOf('TimeoutPhaseName');
      expect(engine.length).toBeGreaterThanOrEqual(2);
      expect([...TIMEOUT_PHASES]).toEqual(engine);
    });
  });

  it('carries no key of its own choosing, at any depth', () => {
    const wide = report() as { stages: Record<string, unknown>[]; search: { phases: Record<string, unknown>[] } };
    wide.stages[0]!.note = 'x';
    wide.search.phases[0]!.requirementId = 'abc';
    const kept = JSON.stringify(timeoutReportOf({ ...wide, injected: 'x'.repeat(500), search: { ...wide.search, extra: 1 } }));

    expect(kept).not.toContain('note');
    expect(kept).not.toContain('requirementId');
    expect(kept).not.toContain('injected');
    expect(kept).not.toContain('extra');
  });

  it('reads the caller’s wait where it was said, and null where it was not', () => {
    expect(timeoutReportOf({ ...report(), callerWaitSeconds: 25 })?.callerWaitSeconds).toBe(25);
    expect(timeoutReportOf({ ...report(), callerWaitSeconds: undefined })?.callerWaitSeconds).toBeNull();
    const without = report();
    delete without.callerWaitSeconds;
    expect(timeoutReportOf(without)?.callerWaitSeconds).toBeNull();
  });

  it('says the week load was cut short only when the engine says so as a boolean', () => {
    expect(timeoutReportOf({ ...report(), weekLoadCut: true })?.weekLoadCut).toBe(true);
    const without = report();
    delete without.weekLoadCut;
    expect(timeoutReportOf(without)?.weekLoadCut).toBe(false);
    expect(timeoutReportOf({ ...report(), weekLoadCut: 'yes' })).toBeNull();
  });

  it('rounds seconds to the tenth the engine measures in, and reads solutions as none when it says nothing', () => {
    const kept = timeoutReportOf({
      ...report(),
      totalSeconds: 109.04,
      stages: [{ stage: 'BUILD', seconds: 4.26 }],
      search: { phases: [] },
    });

    expect(kept?.totalSeconds).toBe(109);
    expect(kept?.stages).toEqual([{ stage: 'BUILD', seconds: 4.3 }]);
    expect(kept?.search).toEqual({ solutions: 0, phases: [] });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['text', 'soon'],
    ['an array', [report()]],
    ['a number', 7],
    ['a budget that is not a whole number', { ...report(), budgetSeconds: 99.5 }],
    ['a budget that is not a number', { ...report(), budgetSeconds: '100' }],
    ['no configured budget', { ...report(), configuredBudgetSeconds: undefined }],
    ['a total that is negative', { ...report(), totalSeconds: -1 }],
    ['a total that is not finite', { ...report(), totalSeconds: Number.POSITIVE_INFINITY }],
    ['a total longer than a day', { ...report(), totalSeconds: 86_401 }],
    ['a caller’s wait that is not a number', { ...report(), callerWaitSeconds: 'soon' }],
    ['stages that are not a list', { ...report(), stages: { stage: 'BUILD', seconds: 1 } }],
    ['more than twelve stages', { ...report(), stages: Array.from({ length: 13 }, () => ({ stage: 'BUILD', seconds: 1 })) }],
    ['a stage the engine does not name', { ...report(), stages: [{ stage: 'THINKING', seconds: 1 }] }],
    ['a stage with no seconds', { ...report(), stages: [{ stage: 'BUILD' }] }],
    ['a stage that is not an object', { ...report(), stages: ['BUILD'] }],
    ['no search', { ...report(), search: undefined }],
    ['a search whose phases are not a list', { ...report(), search: { solutions: 0, phases: 'CLEAN' } }],
    ['more than six phases', { ...report(), search: { solutions: 0, phases: Array.from({ length: 7 }, () => ({ phase: 'CLEAN', seconds: 1 })) } }],
    ['a phase the engine does not name', { ...report(), search: { solutions: 0, phases: [{ phase: 'THIRD', seconds: 1 }] } }],
    ['a phase with conflicts that are not a whole number', { ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 1, conflicts: 1.5 }] } }],
    ['a negative count', { ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 1, branches: -1 }] } }],
    ['solutions that are not a whole number', { ...report(), search: { solutions: 0.5, phases: [] } }],
  ])('keeps nothing of %s: a half-read account is worse than none', (_label, value) => {
    expect(timeoutReportOf(value)).toBeNull();
  });

  it('accepts a figure at its upper limit and keeps nothing past it: a day of seconds, a million million counts', () => {
    const day = 86_400;
    const most = 1_000_000_000_000;
    const kept = timeoutReportOf({
      ...report(),
      totalSeconds: day,
      budgetSeconds: day,
      configuredBudgetSeconds: day,
      callerWaitSeconds: day,
      stages: [{ stage: 'BUILD', seconds: day }],
      search: { solutions: most, phases: [{ phase: 'CLEAN', seconds: day, conflicts: most, branches: most }] },
    });
    expect(kept).toEqual({
      totalSeconds: day,
      budgetSeconds: day,
      configuredBudgetSeconds: day,
      callerWaitSeconds: day,
      stages: [{ stage: 'BUILD', seconds: day }],
      search: { solutions: most, phases: [{ phase: 'CLEAN', seconds: day, conflicts: most, branches: most }] },
      weekLoadCut: false,
    });

    expect(timeoutReportOf({ ...report(), budgetSeconds: day + 1 })).toBeNull();
    expect(timeoutReportOf({ ...report(), callerWaitSeconds: day + 1 })).toBeNull();
    expect(timeoutReportOf({ ...report(), stages: [{ stage: 'BUILD', seconds: day + 1 }] })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: most + 1, phases: [] } })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 1, conflicts: most + 1 }] } })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 1, branches: most + 1 }] } })).toBeNull();
  });

  it('can never be larger than the column’s own check lets through: the fullest report it keeps is a fraction of 8 KiB', () => {
    // OptimizationJobs_report_is_a_small_object (20270228090000) refuses a report over 8192 bytes of jsonb text, and a refused write
    // would turn a TIMEOUT into a failed run. The limits are found by asking, not read from the constants: the most stages and the
    // most searches it accepts, each with every figure at its top. jsonb text is a little wider than JSON.stringify (a space after
    // every colon and comma), so the bound is twice the compact length: a limit raised here that would not fit there fails this
    // test, not a school's run.
    const day = 86_400;
    const most = 1_000_000_000_000;
    const full = (stages: number, phases: number) => ({
      totalSeconds: day,
      budgetSeconds: day,
      configuredBudgetSeconds: day,
      callerWaitSeconds: day,
      stages: Array.from({ length: stages }, () => ({ stage: 'SEARCH_CLEAN', seconds: day })),
      search: { solutions: most, phases: Array.from({ length: phases }, () => ({ phase: 'CLEAN', seconds: day, conflicts: most, branches: most })) },
      weekLoadCut: true,
    });
    let stages = 0;
    while (stages < 5_000 && timeoutReportOf(full(stages + 1, 0)) !== null) stages += 1;
    let phases = 0;
    while (phases < 5_000 && timeoutReportOf(full(0, phases + 1)) !== null) phases += 1;

    const fullest = timeoutReportOf(full(stages, phases));
    expect(fullest).not.toBeNull();
    expect(JSON.stringify(fullest).length * 2).toBeLessThanOrEqual(8192);
  });

  it('accepts the least a report is: no stage and no search, as a solve that closed before any step reports', () => {
    expect(
      timeoutReportOf({ totalSeconds: 0, budgetSeconds: 0, configuredBudgetSeconds: 0, stages: [], search: { phases: [] } }),
    ).toEqual({
      totalSeconds: 0,
      budgetSeconds: 0,
      configuredBudgetSeconds: 0,
      callerWaitSeconds: null,
      stages: [],
      search: { solutions: 0, phases: [] },
      weekLoadCut: false,
    });
  });
});
