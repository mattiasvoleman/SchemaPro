import {
  PATH_CLOSE_AFTER_SECONDS,
  PATH_CLOSE_BEFORE_SECONDS,
  PATH_MARGIN_SECONDS,
  clampToPath,
  closedByRoad,
  parseEngineTiming,
  pathShortfall,
  pathWaitCapMs,
  unclampedWaitMsFor,
  waitMsFor,
  type EngineTiming,
} from './engine-timing';
import { INCIDENT_BODY, INCIDENT_BODY_WITHOUT_DEADLINE, PRODUCTION_BODY } from './__fixtures__/engine-timing-body';

/*
 * THE ROAD'S LIMIT, AS THE WAIT AND THE LOG SAY IT (omgång 15, the 2026-11-23 incident).
 *
 * The engine ran with a 540 s budget (a ceiling of 590 s) and the API reached it through Railway's edge, which closes a
 * request that sends nothing after 300 s. The wait the API derived from the engine's ceiling was 600 s and the deadline
 * it sent the engine 600, so the engine's own clock never shortened the search, and both runs of the only real school
 * were closed at 300 s with nothing to show. These pin the numbers that make the engine answer before the road closes.
 */

const incident = (): EngineTiming => parseEngineTiming(INCIDENT_BODY)!;
const production = (): EngineTiming => parseEngineTiming(PRODUCTION_BODY)!;
const incidentWithoutDeadline = (): EngineTiming => parseEngineTiming(INCIDENT_BODY_WITHOUT_DEADLINE)!;

describe('pathWaitCapMs', () => {
  it('is the road’s limit less ten seconds, in milliseconds: the engine answers by the deadline, the wait ends at the cap, then the road closes', () => {
    expect(PATH_MARGIN_SECONDS).toBe(10);
    expect(pathWaitCapMs(300)).toBe(290_000);
    expect(pathWaitCapMs(120)).toBe(110_000);
  });

  it('is none for a road with no limit', () => {
    expect(pathWaitCapMs(undefined)).toBeUndefined();
  });

  it('never goes under a millisecond for a limit smaller than the margin', () => {
    expect(pathWaitCapMs(5)).toBe(1_000);
  });
});

describe('clampToPath', () => {
  it('holds a longer wait to the cap and leaves a shorter one alone', () => {
    expect(clampToPath(600_000, 300)).toBe(290_000);
    expect(clampToPath(290_000, 300)).toBe(290_000);
    expect(clampToPath(240_000, 300)).toBe(240_000);
  });

  it('leaves every wait alone on a road with no limit', () => {
    expect(clampToPath(600_000, undefined)).toBe(600_000);
  });
});

describe('waitMsFor with the road’s limit', () => {
  it('is 290 s for the incident’s engine, whose ceiling and margin make 600 s: the wait it was closed in the middle of', () => {
    expect(unclampedWaitMsFor('optimize', incident())).toBe(600_000);
    expect(waitMsFor('optimize', incident(), undefined, undefined)).toBe(600_000);
    expect(waitMsFor('optimize', incident(), undefined, 300)).toBe(290_000);
  });

  it('holds a wait the operator set (AI_ENGINE_TIMEOUT_MS) to the cap as well', () => {
    expect(waitMsFor('optimize', incident(), 600_000, 300)).toBe(290_000);
    expect(waitMsFor('optimize', incident(), 240_000, 300)).toBe(240_000);
  });

  it('holds the 120 s fallback of an engine that said nothing only when the road holds less than that', () => {
    expect(waitMsFor('optimize', null, undefined, 300)).toBe(120_000);
    expect(waitMsFor('optimize', null, undefined, 100)).toBe(90_000);
  });

  it('leaves a wait that already ends before the road does: the production settings, 240 s, are under 290', () => {
    expect(waitMsFor('optimize', production(), undefined, 300)).toBe(240_000);
  });
});

describe('pathShortfall', () => {
  it('is null on a road with no limit, and for an engine that has said nothing', () => {
    expect(pathShortfall(incident(), undefined)).toBeNull();
    expect(pathShortfall(null, 300)).toBeNull();
  });

  it('is null when the engine’s ceiling and its transfer margin fit under the cap: nothing is shortened', () => {
    expect(pathShortfall(production(), 300)).toBeNull();
    // 590 + 5 s fits a road of 610 s, and not one of 600.
    expect(pathShortfall(incident(), 605)).toBeNull();
    expect(pathShortfall(incident(), 600)).not.toBeNull();
  });

  it('says, for the incident’s engine, what the road does, how long the API waits, and which number to change', () => {
    const shortfall = pathShortfall(incident(), 300)!;

    expect(shortfall.capMs).toBe(290_000);
    // 290 s of wait, less the 5 s transfer, the 20 s probe and the 30 s headroom.
    expect(shortfall.fitsBudgetSeconds).toBe(235);
    expect(shortfall.sentence).toContain('closes a request that sends nothing after 300 s (AI_ENGINE_PATH_IDLE_LIMIT_SECONDS');
    expect(shortfall.sentence).toContain('SOLVER_MAX_TIME_SECONDS=540 s');
    expect(shortfall.sentence).toContain('up to 590 s');
    expect(shortfall.sentence).toContain('the API waits 290 s at most');
    expect(shortfall.sentence).toContain('its search is cut to about 235 s of its 540 s');
    expect(shortfall.sentence).toContain('a TIMEOUT with its explanation and suggestions');
    expect(shortfall.sentence).toContain('AI_ENGINE_URL=http://<the engine\'s service>.railway.internal:<its port>');
    expect(shortfall.sentence).toContain('set SOLVER_MAX_TIME_SECONDS on the engine to 235 or less');
    expect(shortfall.sentence).toContain('set AI_ENGINE_PATH_IDLE_LIMIT_SECONDS to that number (0: as long as it takes)');
  });

  it('says it differently for an engine older than deadlineSeconds: it cannot be asked to answer inside the wait', () => {
    const shortfall = pathShortfall(incidentWithoutDeadline(), 300)!;

    expect(shortfall.sentence).toContain('older than deadlineSeconds and cannot be asked to answer inside that');
    expect(shortfall.sentence).toContain('ends when the API\'s wait does, with nothing to show of it');
    expect(shortfall.sentence).not.toContain('its search is cut');
    expect(shortfall.sentence).toContain('set SOLVER_MAX_TIME_SECONDS on the engine to 235 or less');
  });

  it('offers no budget to lower to when the road leaves nothing for one', () => {
    const shortfall = pathShortfall(incident(), 60)!;

    expect(shortfall.fitsBudgetSeconds).toBeUndefined();
    expect(shortfall.sentence).not.toContain('SOLVER_MAX_TIME_SECONDS on the engine to');
    expect(shortfall.sentence).toContain('railway.internal');
  });
});

describe('closedByRoad (omgång 15: a call the road to the engine closed)', () => {
  /*
   * The two calls of 2026-11-23 ended 303 s after they began, with the edge's own 499 at 300 008 ms: a call that is
   * closed by the road is a 502 or 504 that is not the engine's, or a socket closed with nothing on it, near the limit the
   * road is known to hold a silent call to. Anything else is the engine's or the network's, and keeps the name it has.
   */
  const edge502 = { status: 502, bodyCode: 502, errorCode: undefined };
  const edge504 = { status: 504, bodyCode: undefined, errorCode: undefined };
  const reset = { status: undefined, bodyCode: undefined, errorCode: 'ECONNRESET' };

  it('is the edge’s 502 and 504 and a closed socket at the limit, as the incident’s calls were', () => {
    expect(PATH_CLOSE_BEFORE_SECONDS).toBe(20);
    expect(PATH_CLOSE_AFTER_SECONDS).toBe(30);
    expect(closedByRoad(edge502, 303_000, 300)).toBe(true);
    expect(closedByRoad(edge504, 300_008, 300)).toBe(true);
    expect(closedByRoad(reset, 300_000, 300)).toBe(true);
  });

  it.each(['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'UND_ERR_SOCKET'])('is a socket closed with no answer (%s)', (errorCode) => {
    expect(closedByRoad({ status: undefined, bodyCode: undefined, errorCode }, 301_000, 300)).toBe(true);
  });

  it('is not a refused connection, an unknown name, a timeout or an error with no code: they never reached anything, or are the API’s own wait', () => {
    for (const errorCode of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNABORTED', 'ETIMEDOUT', undefined]) {
      expect(closedByRoad({ status: undefined, bodyCode: undefined, errorCode }, 300_000, 300)).toBe(false);
    }
  });

  it('is only within the window around the limit: 20 s before it to 30 s after', () => {
    expect(closedByRoad(edge502, 280_000, 300)).toBe(true);
    expect(closedByRoad(edge502, 279_999, 300)).toBe(false);
    expect(closedByRoad(edge502, 330_000, 300)).toBe(true);
    expect(closedByRoad(edge502, 330_001, 300)).toBe(false);
    // An engine that crashes after five seconds, or a call that dies at three minutes, is not the road's.
    expect(closedByRoad(edge502, 5_000, 300)).toBe(false);
    expect(closedByRoad(reset, 180_000, 300)).toBe(false);
  });

  it('follows the limit it is given, and is never on a road with none', () => {
    expect(closedByRoad(edge502, 120_000, 120)).toBe(true);
    expect(closedByRoad(edge502, 300_000, 120)).toBe(false);
    expect(closedByRoad(edge502, 300_000, undefined)).toBe(false);
    expect(closedByRoad(reset, 300_000, undefined)).toBe(false);
  });

  it('is not the engine’s own answer: a body with a string code is the engine speaking, whatever the status and the time', () => {
    expect(closedByRoad({ status: 502, bodyCode: 'SOLVER_TIMEOUT', errorCode: undefined }, 300_000, 300)).toBe(false);
    expect(closedByRoad({ status: 504, bodyCode: 'HTTP_ERROR', errorCode: undefined }, 300_000, 300)).toBe(false);
  });

  it('is not any other status: the engine’s 500, its 503 at its ceiling and a 4xx are its own', () => {
    for (const status of [400, 404, 422, 429, 500, 501, 503]) {
      expect(closedByRoad({ status, bodyCode: undefined, errorCode: undefined }, 300_000, 300)).toBe(false);
    }
  });
});
