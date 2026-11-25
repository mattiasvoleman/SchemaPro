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
      return [...match![1]!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((quoted) => quoted[1]!);
    };

    // The engine may name a step the gateway does not know (it deploys first): the report skips it. What must hold is
    // that every step the gateway knows is one the engine still has, in the engine's order, so that a name the engine
    // dropped or renamed turns this red, and that the gateway's two lists of them agree.
    const subsequence = (known: readonly string[], engine: readonly string[]): boolean => {
      let at = 0;
      for (const name of known) {
        at = engine.indexOf(name, at);
        if (at < 0) return false;
        at += 1;
      }
      return true;
    };

    it('lists the steps in the order the engine does, with nothing the engine has dropped, and the gateway’s two lists agree', () => {
      const engine = literalOf('TimeoutStageName');
      expect(engine.length).toBeGreaterThanOrEqual(6);
      expect(subsequence(TIMEOUT_STAGES, engine)).toBe(true);
      expect(subsequence(ENGINE_STAGES, engine)).toBe(true);
      expect([...ENGINE_STAGES]).toEqual([...TIMEOUT_STAGES]);
    });

    // The steps the engine names that this gateway skips for now. A name is put here in the engine's own PR (the gateway may
    // deploy after it, and the page learns the name later) and leaves when TIMEOUT_STAGES has it. It is what keeps a step the
    // engine has added from going unseen: the check above lets the engine add one, and nothing else would say that the card
    // still leaves it out.
    const SKIPPED_FOR_NOW: readonly string[] = ['START'];

    it('names every step of the engine that the gateway does not know, so that none is skipped unseen', () => {
      const unknown = literalOf('TimeoutStageName').filter((name) => !(TIMEOUT_STAGES as readonly string[]).includes(name));
      expect(unknown).toEqual([...SKIPPED_FOR_NOW]);
    });

    it('can tell a name the engine has added from one it has dropped (the check above has teeth)', () => {
      const engine = ['PRECHECKS', 'BUILD', 'YEARS', 'SITES', 'SEARCH_CLEAN', 'SEARCH_CLONE', 'PROBE'];
      expect(subsequence(TIMEOUT_STAGES, engine)).toBe(true); // added: allowed
      expect(subsequence(TIMEOUT_STAGES, engine.filter((name) => name !== 'SITES'))).toBe(false); // dropped
      expect(subsequence(TIMEOUT_STAGES, ['BUILD', 'PRECHECKS', 'SITES', 'SEARCH_CLEAN', 'SEARCH_CLONE', 'PROBE'])).toBe(false); // reordered
    });

    it('lists the searches that report their effort as the engine does', () => {
      const engine = literalOf('TimeoutPhaseName');
      expect(engine.length).toBeGreaterThanOrEqual(2);
      expect([...TIMEOUT_PHASES]).toEqual(engine);
    });
  });

  describe('a step the engine has added and the gateway does not know yet (g425, L-2)', () => {
    const withSteps = (stages: unknown[]): Record<string, unknown> => ({ ...report(), stages });

    it('is skipped, and the steps around it are kept in their order', () => {
      const kept = timeoutReportOf(
        withSteps([
          { stage: 'PRECHECKS', seconds: 0.4 },
          { stage: 'YEARS', seconds: 30 },
          { stage: 'BUILD', seconds: 4 },
          { stage: 'START', seconds: 12.34 },
          { stage: 'SEARCH_CLEAN', seconds: 60 },
        ]),
      );

      expect(kept).not.toBeNull();
      expect(kept?.stages).toEqual([
        { stage: 'PRECHECKS', seconds: 0.4 },
        { stage: 'BUILD', seconds: 4 },
        { stage: 'SEARCH_CLEAN', seconds: 60 },
      ]);
      // The rest of the report is the engine's, whole: the total still counts the step that is not shown.
      expect(kept?.totalSeconds).toBe(109);
      expect(kept?.search.phases).toHaveLength(2);
    });

    it('carries the seconds of what it skipped, so that a page can say that part of the run went to steps it has no name for', () => {
      const kept = timeoutReportOf(
        withSteps([
          { stage: 'PRECHECKS', seconds: 0.4 },
          { stage: 'YEARS', seconds: 30 },
          { stage: 'BUILD', seconds: 4 },
          { stage: 'START', seconds: 12.34 },
        ]),
      );

      expect(kept?.otherSeconds).toBe(42.3);
      // The steps listed and the seconds left out are the engine's steps, whole.
      const listed = (kept?.stages ?? []).reduce((sum, step) => sum + step.seconds, 0);
      expect(Math.round((listed + (kept?.otherSeconds ?? 0)) * 10) / 10).toBe(46.7);
    });

    it('carries no seconds of what it skipped when it skipped nothing, so that a report of known steps is what it was', () => {
      expect('otherSeconds' in (timeoutReportOf(report()) as object)).toBe(false);
      expect('otherSeconds' in (timeoutReportOf(withSteps([{ stage: 'YEARS', seconds: 0 }])) as object)).toBe(false);
    });

    it('keeps the seconds it skipped when its own output is read again, and adds to them', () => {
      const once = timeoutReportOf(withSteps([{ stage: 'YEARS', seconds: 30 }, { stage: 'BUILD', seconds: 4 }]));
      expect(once?.otherSeconds).toBe(30);
      expect(timeoutReportOf(once)).toEqual(once);
      expect(timeoutReportOf({ ...once, stages: [{ stage: 'START', seconds: 5 }] })?.otherSeconds).toBe(35);
    });

    it.each([
      ['seconds that are not a number', 'a while'],
      ['negative seconds', -1],
      ['no number at all', null],
    ])('is a malformed report with %s skipped', (_what, other) => {
      expect(timeoutReportOf({ ...report(), otherSeconds: other })).toBeNull();
    });

    it('leaves a report of nothing but such steps with no steps and the rest of it', () => {
      const kept = timeoutReportOf(withSteps([{ stage: 'YEARS', seconds: 90 }]));
      expect(kept?.stages).toEqual([]);
      expect(kept?.budgetSeconds).toBe(100);
    });

    it('is read the same the second time: what is kept is accepted unchanged', () => {
      const once = timeoutReportOf(withSteps([{ stage: 'YEARS', seconds: 30 }, { stage: 'BUILD', seconds: 4 }]));
      expect(timeoutReportOf(once)).toEqual(once);
    });

    it.each([
      ['a step with no readable seconds', { stage: 'YEARS', seconds: 'a while' }],
      ['a step with negative seconds', { stage: 'YEARS', seconds: -1 }],
      ['a step that is not an object', 'YEARS'],
      ['a step with no name', { seconds: 3 }],
      ['a name that is no word', { stage: 'years of the school', seconds: 3 }],
      ['a name in lower case', { stage: 'years', seconds: 3 }],
      ['a name of 41 characters', { stage: 'A'.repeat(41), seconds: 3 }],
    ])('is still a malformed report with %s', (_what, entry) => {
      expect(timeoutReportOf(withSteps([{ stage: 'BUILD', seconds: 4 }, entry]))).toBeNull();
    });

    it('knows a name of 40 characters for a word, the longest the engine could have written', () => {
      expect(timeoutReportOf(withSteps([{ stage: 'A'.repeat(40), seconds: 3 }, { stage: 'BUILD', seconds: 4 }]))?.stages).toEqual([
        { stage: 'BUILD', seconds: 4 },
      ]);
    });

    it('still counts the skipped steps toward the cap on how many a report may carry', () => {
      const many = Array.from({ length: 13 }, (_, index) => ({ stage: index % 2 ? 'YEARS' : 'BUILD', seconds: 1 }));
      expect(timeoutReportOf(withSteps(many))).toBeNull();
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
    // A step the engine has added but the gateway does not know is skipped, not refused (its own describe above); one that is no word is refused.
    ['a stage whose name is no word', { ...report(), stages: [{ stage: 'thinking hard', seconds: 1 }] }],
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
    expect(timeoutReportOf({ ...report(), configuredBudgetSeconds: day + 1 })).toBeNull();
    expect(timeoutReportOf({ ...report(), stages: [{ stage: 'BUILD', seconds: day + 1 }] })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: day + 1 }] } })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: most + 1, phases: [] } })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 1, conflicts: most + 1 }] } })).toBeNull();
    expect(timeoutReportOf({ ...report(), search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 1, branches: most + 1 }] } })).toBeNull();
  });

  it('keeps exactly as many steps and searches as it allows: twelve and six, where the tests above hold one more out', () => {
    // The upper side is held by 'more than twelve stages' and 'more than six phases'. A cap lowered by one (the engine's own
    // most is six steps and two searches, so nothing would be lost in production) is what only this side sees.
    const stage = { stage: 'BUILD', seconds: 1 };
    const phase = { phase: 'CLEAN', seconds: 1, conflicts: 1, branches: 1 };
    expect(timeoutReportOf({ ...report(), stages: Array.from({ length: 12 }, () => stage) })?.stages).toHaveLength(12);
    expect(timeoutReportOf({ ...report(), search: { solutions: 0, phases: Array.from({ length: 6 }, () => phase) } })?.search.phases).toHaveLength(6);
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
