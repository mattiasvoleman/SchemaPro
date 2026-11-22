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
