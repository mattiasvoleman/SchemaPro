import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALL_MARGIN_SECONDS,
  ENGINE_CEILING_CODE,
  ENGINE_CEILING_SENTENCES,
  FALLBACK_WAIT_MS,
  LEGACY_HEADROOM_SECONDS,
  LEGACY_PROBE_SECONDS,
  MAX_DEADLINE_SECONDS,
  WAIT_MARGIN_SECONDS,
  candidateBudgetNote,
  candidateCallMs,
  candidateTimesOf,
  deadlineSecondsOf,
  engineCeilingParams,
  isEngineCeilingBody,
  parseEngineTiming,
  routeOf,
  supportsDeadline,
  waitMsAtLeast,
  waitMsFor,
  waitShortfall,
  type EngineTiming,
} from './engine-timing';
import { CALL_HEADROOM_SECONDS, PROBE_SECONDS } from './candidate-variants';
import { PRODUCTION_BODY } from './__fixtures__/engine-timing-body';

/*
 * THE ENGINE'S TIMES, AS THE API READS THEM (M1, Tidskedjan).
 *
 * The numbers here are the engine's own for the production settings (180 s
 * budget, 20 s probe, 30 s of headroom: a ceiling of 230 s) and the body is the
 * one GET /api/v1/timing answers, as optimization-engine/tests/test_timing.py
 * pins it.
 */

const SHARED = JSON.parse(
  readFileSync(join(__dirname, '../../optimization-engine/tests/data/solver_timeout_body.json'), 'utf8'),
) as { code: string; sentences: Record<string, string>; detailsWithStage: Record<string, string | number> };

const production = (): EngineTiming => parseEngineTiming(PRODUCTION_BODY)!;

describe('routeOf', () => {
  it('knows the four routes by their paths, and the generator by its legacy path too', () => {
    expect(routeOf('/v1/schedule')).toBe('optimize');
    expect(routeOf('/api/v1/optimize')).toBe('optimize');
    expect(routeOf('/api/v1/optimize-rooms')).toBe('optimize-rooms');
    expect(routeOf('/api/v1/staff')).toBe('staff');
    expect(routeOf('/api/v1/plan-exams')).toBe('plan-exams');
  });

  it('knows no other path', () => {
    expect(routeOf('/api/v1/timing')).toBeNull();
    expect(routeOf('/health')).toBeNull();
    expect(routeOf('/api/v1/optimize/')).toBeNull();
  });
});

describe('parseEngineTiming', () => {
  it('reads the body the engine answers', () => {
    expect(production()).toEqual({
      version: 1,
      capabilities: ['deadlineSeconds'],
      transferMarginSeconds: 5,
      routes: PRODUCTION_BODY.routes,
    });
  });

  it.each([
    ['nothing', null],
    ['a string, as a proxy answers', '<html>Not Found</html>'],
    ['an object with no version', { ...PRODUCTION_BODY, version: undefined }],
    ['a version of zero', { ...PRODUCTION_BODY, version: 0 }],
    ['capabilities that are not names', { ...PRODUCTION_BODY, capabilities: [1] }],
    ['no capabilities', { ...PRODUCTION_BODY, capabilities: undefined }],
    ['a negative transfer margin', { ...PRODUCTION_BODY, transferMarginSeconds: -1 }],
    ['no routes', { ...PRODUCTION_BODY, routes: undefined }],
    ['routes the gateway knows none of', { ...PRODUCTION_BODY, routes: { other: PRODUCTION_BODY.routes.optimize } }],
  ])('says nothing of %s: an engine that does not say', (_name, body) => {
    expect(parseEngineTiming(body)).toBeNull();
  });

  it('keeps the routes it can read and leaves the one it cannot', () => {
    const odd = parseEngineTiming({
      ...PRODUCTION_BODY,
      routes: { ...PRODUCTION_BODY.routes, staff: { budgetSeconds: 'ten' }, 'plan-exams': { ...PRODUCTION_BODY.routes['plan-exams'], ceilingSeconds: -5 } },
    });

    expect(Object.keys(odd!.routes).sort()).toEqual(['optimize', 'optimize-rooms']);
  });

  it('knows whether the engine can be sent a deadline', () => {
    expect(supportsDeadline(production())).toBe(true);
    expect(supportsDeadline(parseEngineTiming({ ...PRODUCTION_BODY, capabilities: [] }))).toBe(false);
    // A capability of some later engine is not this one: only the field this gateway sends counts.
    expect(supportsDeadline(parseEngineTiming({ ...PRODUCTION_BODY, capabilities: ['somethingElse'] }))).toBe(false);
    expect(supportsDeadline(null)).toBe(false);
  });
});

describe('waitMsFor', () => {
  it('is AI_ENGINE_TIMEOUT_MS when it is set, whatever the engine says', () => {
    expect(waitMsFor('optimize', production(), 90_000)).toBe(90_000);
    expect(waitMsFor('optimize', null, 90_000)).toBe(90_000);
    expect(waitMsFor(null, production(), 90_000)).toBe(90_000);
  });

  it("is the engine's ceiling for the route and a margin when it is not: the engine answers first", () => {
    expect(WAIT_MARGIN_SECONDS).toBe(10);
    expect(waitMsFor('optimize', production())).toBe(240_000);
    expect(waitMsFor('optimize-rooms', production())).toBe(50_000);
    expect(waitMsFor('plan-exams', production())).toBe(60_000);
  });

  it('is 120 s for an engine that said nothing, or a path that is not timed', () => {
    expect(FALLBACK_WAIT_MS).toBe(120_000);
    expect(waitMsFor('optimize', null)).toBe(FALLBACK_WAIT_MS);
    expect(waitMsFor(null, production())).toBe(FALLBACK_WAIT_MS);
  });

  it('follows the engine when its budget is changed, with nothing set on this side', () => {
    const slower = parseEngineTiming({
      ...PRODUCTION_BODY,
      routes: { ...PRODUCTION_BODY.routes, optimize: { budgetSeconds: 300, probeSeconds: 20, headroomSeconds: 30, ceilingSeconds: 350 } },
    });

    expect(waitMsFor('optimize', slower)).toBe(360_000);
  });
});

describe('waitMsAtLeast', () => {
  it('is the caller’s own floor while the engine needs less, as the exam planner’s 90 s is', () => {
    expect(waitMsAtLeast('plan-exams', production(), 90_000)).toBe(90_000);
    expect(waitMsAtLeast('plan-exams', null, 90_000)).toBe(90_000);
    expect(waitMsAtLeast(null, production(), 90_000)).toBe(90_000);
  });

  it('is what the engine says the route needs, and a margin, once its budget was raised past the floor', () => {
    const raised = parseEngineTiming({
      ...PRODUCTION_BODY,
      routes: { ...PRODUCTION_BODY.routes, 'plan-exams': { budgetSeconds: 100, probeSeconds: 0, headroomSeconds: 30, ceilingSeconds: 130 } },
    });

    expect(waitMsAtLeast('plan-exams', raised, 90_000)).toBe(140_000);
  });

  it('never reads AI_ENGINE_TIMEOUT_MS: a caller with a floor of its own was never waiting by it', () => {
    expect(waitMsAtLeast.length).toBe(3);
  });
});

describe('deadlineSecondsOf', () => {
  it('is the wait in whole seconds, rounded down so the engine never counts on a second the API does not wait', () => {
    expect(deadlineSecondsOf(240_000)).toBe(240);
    expect(deadlineSecondsOf(240_999)).toBe(240);
    expect(deadlineSecondsOf(1_000)).toBe(1);
  });

  it('is at least a second and at most the engine’s hour', () => {
    expect(deadlineSecondsOf(0)).toBe(1);
    expect(deadlineSecondsOf(500)).toBe(1);
    expect(MAX_DEADLINE_SECONDS).toBe(3600);
    expect(deadlineSecondsOf(7_200_000)).toBe(3600);
  });
});

describe('a schemaförslag call’s wait', () => {
  it('is, at the engine’s defaults and when it has said nothing, exactly the +45 s and +20 s it always was', () => {
    expect(candidateCallMs(30, false)).toBe(75_000);
    expect(candidateCallMs(30, true)).toBe(95_000);
    expect(candidateCallMs(120, true)).toBe(185_000);
    // And the constants other code and tests quote say the same.
    expect(CALL_HEADROOM_SECONDS).toBe(LEGACY_HEADROOM_SECONDS + CALL_MARGIN_SECONDS);
    expect(CALL_HEADROOM_SECONDS).toBe(45);
    expect(PROBE_SECONDS).toBe(LEGACY_PROBE_SECONDS);
  });

  it('is the same at the production engine’s own figures: 20 s probe, 30 s headroom', () => {
    const times = candidateTimesOf(production());

    expect(times).toEqual({ probeSeconds: 20, headroomSeconds: 30 });
    expect(candidateCallMs(30, true, times)).toBe(95_000);
    expect(candidateCallMs(30, false, times)).toBe(75_000);
  });

  it('follows a probe the engine was set to 60 s (the review of #344, LÅG-9): it was 20 s here whatever it said', () => {
    const times = { probeSeconds: 60, headroomSeconds: 30 };

    expect(candidateCallMs(30, true, times)).toBe(135_000);
    // A call that asks for no probes does not wait for one.
    expect(candidateCallMs(30, false, times)).toBe(75_000);
  });

  it('follows the headroom the engine says', () => {
    expect(candidateCallMs(30, false, { probeSeconds: 20, headroomSeconds: 60 })).toBe(105_000);
  });

  it('is undefined while the engine has said nothing', () => {
    expect(candidateTimesOf(null)).toBeUndefined();
  });
});

describe('waitShortfall: an AI_ENGINE_TIMEOUT_MS that is set and shorter than the engine can need', () => {
  it('is null for a wait that holds the ceiling and the transfer margin, and for the one the docs recommend', () => {
    expect(waitShortfall(production(), 240_000)).toBeNull();
    expect(waitShortfall(production(), 235_000)).toBeNull();
    expect(waitShortfall(production(), 600_000)).toBeNull();
  });

  it('is null when it is not set, and when the engine has not said its times', () => {
    expect(waitShortfall(production(), undefined)).toBeNull();
    expect(waitShortfall(null, 120_000)).toBeNull();
    expect(waitShortfall(parseEngineTiming({ ...PRODUCTION_BODY, routes: { staff: PRODUCTION_BODY.routes.staff } }), 1_000)).toBeNull();
  });

  it('names the number to change when it is a second short of holding', () => {
    expect(waitShortfall(production(), 234_999)).not.toBeNull();
  });

  it('says which number to change, with the engine’s own figures and three ways out', () => {
    const shortfall = waitShortfall(production(), 120_000)!;

    expect(shortfall.minimumMs).toBe(235_000);
    expect(shortfall.sentence).toBe(
      'AI_ENGINE_TIMEOUT_MS=120000 is shorter than the engine can need: it searches for up to ' +
        'SOLVER_MAX_TIME_SECONDS=180 s, explains for SOLVER_PROBE_SECONDS=20 s and needs up to 30 s to build, ' +
        '230 s in all, and the API must wait at least 235 s. Set AI_ENGINE_TIMEOUT_MS to 240000 or more, or remove it ' +
        'so that the API waits as long as the engine says, or lower SOLVER_MAX_TIME_SECONDS on the engine to 65 or less.',
    );
  });

  it('leaves out the budget that does not exist when the wait is shorter than the probe and the headroom alone', () => {
    const shortfall = waitShortfall(production(), 50_000)!;

    expect(shortfall.sentence).toContain('AI_ENGINE_TIMEOUT_MS=50000');
    expect(shortfall.sentence).not.toContain('lower SOLVER_MAX_TIME_SECONDS');
    expect(shortfall.sentence.endsWith('so that the API waits as long as the engine says.')).toBe(true);
  });

  it('follows a budget the engine was set to 300 s', () => {
    const slower = parseEngineTiming({
      ...PRODUCTION_BODY,
      routes: { ...PRODUCTION_BODY.routes, optimize: { budgetSeconds: 300, probeSeconds: 20, headroomSeconds: 30, ceilingSeconds: 350 } },
    });

    const shortfall = waitShortfall(slower, 240_000)!;

    expect(shortfall.minimumMs).toBe(355_000);
    expect(shortfall.sentence).toContain('Set AI_ENGINE_TIMEOUT_MS to 360000 or more');
    expect(shortfall.sentence).toContain('to 185 or less');
  });
});

describe('candidateBudgetNote: CANDIDATE_MAX_SECONDS above the engine’s budget, which does nothing', () => {
  it('says so once the candidates ask for more than the engine will give any of them', () => {
    expect(candidateBudgetNote(production(), 240)).toBe(
      "CANDIDATE_MAX_SECONDS=240 is above the engine's SOLVER_MAX_TIME_SECONDS=180: the engine gives every schemaförslag candidate 180 s, not 240. " +
        'Raise SOLVER_MAX_TIME_SECONDS or lower CANDIDATE_MAX_SECONDS.',
    );
  });

  it('is silent while the setting holds, or nothing is known', () => {
    expect(candidateBudgetNote(production(), 120)).toBeNull();
    expect(candidateBudgetNote(production(), 180)).toBeNull();
    expect(candidateBudgetNote(null, 240)).toBeNull();
    expect(candidateBudgetNote(production(), undefined)).toBeNull();
  });
});

describe('the engine’s 503 at its ceiling (the body both sides’ tests read)', () => {
  it('is matched by its code', () => {
    expect(ENGINE_CEILING_CODE).toBe(SHARED.code);
    expect(isEngineCeilingBody({ code: SHARED.code, message: 'anything the engine words it as' })).toBe(true);
  });

  it('is matched, for an engine older than the code, by each route’s sentence, word for word', () => {
    expect(Object.values(SHARED.sentences).sort()).toEqual([...ENGINE_CEILING_SENTENCES].sort());
    for (const sentence of Object.values(SHARED.sentences)) {
      expect(isEngineCeilingBody({ code: 'HTTP_ERROR', message: sentence })).toBe(true);
    }
  });

  it('is not matched by another 503 or a body that is not the engine’s', () => {
    expect(isEngineCeilingBody({ code: 'HTTP_ERROR', message: 'Service Unavailable' })).toBe(false);
    expect(isEngineCeilingBody({ code: 'SOLVER_BUILD_ERROR', message: 'CP-SAT rejected the model' })).toBe(false);
    expect(isEngineCeilingBody({})).toBe(false);
    expect(isEngineCeilingBody(null)).toBe(false);
    expect(isEngineCeilingBody(undefined)).toBe(false);
    expect(isEngineCeilingBody({ message: ['Optimization timed out.'] })).toBe(false);
  });
});

describe('engineCeilingParams (omgång 13, M2: where the engine’s solve was when its ceiling fell)', () => {
  it('reads the body both sides share: the ceiling and the step with its two figures, never the route', () => {
    expect(engineCeilingParams({ details: SHARED.detailsWithStage })).toEqual({
      ceilingSeconds: 230,
      stage: 'SEARCH_CLONE',
      stageSeconds: 160,
      elapsedSeconds: 230,
    });
  });

  it('carries the ceiling alone when no step is named, and nothing when there are no details', () => {
    expect(engineCeilingParams({ details: { route: 'optimize', ceilingSeconds: 230 } })).toEqual({ ceilingSeconds: 230 });
    expect(engineCeilingParams({})).toBeUndefined();
    expect(engineCeilingParams(null)).toBeUndefined();
    expect(engineCeilingParams(undefined)).toBeUndefined();
    expect(engineCeilingParams({ details: null })).toBeUndefined();
    expect(engineCeilingParams({ details: 'soon' })).toBeUndefined();
    expect(engineCeilingParams({ details: [230] })).toBeUndefined();
    expect(engineCeilingParams({ details: { route: 'optimize' } })).toBeUndefined();
  });

  it.each(['PRECHECKS', 'BUILD', 'SITES', 'SEARCH_CLEAN', 'SEARCH_CLONE', 'PROBE'])('knows the step %s', (stage) => {
    expect(engineCeilingParams({ details: { ceilingSeconds: 40, stage, stageSeconds: 1, elapsedSeconds: 2 } })).toMatchObject({ stage });
  });

  it('carries the three figures of a step together or not at all', () => {
    const said = { ceilingSeconds: 230, stage: 'BUILD', stageSeconds: 4, elapsedSeconds: 5 };
    expect(engineCeilingParams({ details: { ...said, stageSeconds: undefined } })).toEqual({ ceilingSeconds: 230 });
    expect(engineCeilingParams({ details: { ...said, elapsedSeconds: undefined } })).toEqual({ ceilingSeconds: 230 });
    expect(engineCeilingParams({ details: { ...said, stage: undefined } })).toEqual({ ceilingSeconds: 230 });
    expect(engineCeilingParams({ details: { ...said, stage: 'THINKING' } })).toEqual({ ceilingSeconds: 230 });
    expect(engineCeilingParams({ details: { ...said, stage: 7 } })).toEqual({ ceilingSeconds: 230 });
  });

  it('leaves out a figure that is not a finite number of seconds, and rounds the rest to a tenth', () => {
    expect(
      engineCeilingParams({
        details: { ceilingSeconds: -1, stage: 'BUILD', stageSeconds: Number.NaN, elapsedSeconds: Number.POSITIVE_INFINITY },
      }),
    ).toBeUndefined();
    expect(engineCeilingParams({ details: { ceilingSeconds: '230' } })).toBeUndefined();
    expect(
      engineCeilingParams({ details: { ceilingSeconds: 230.04, stage: 'PROBE', stageSeconds: 112.26, elapsedSeconds: 0 } }),
    ).toEqual({ ceilingSeconds: 230, stage: 'PROBE', stageSeconds: 112.3, elapsedSeconds: 0 });
  });

  it('carries no key of its own choosing: a body can add whatever it likes and none of it reaches the run', () => {
    expect(
      engineCeilingParams({ details: { ceilingSeconds: 230, requirementId: 'abc', note: 'x'.repeat(500), route: 'optimize' } }),
    ).toEqual({ ceilingSeconds: 230 });
  });
});
