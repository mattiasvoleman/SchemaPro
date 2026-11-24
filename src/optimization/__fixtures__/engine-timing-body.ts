/**
 * What GET /api/v1/timing answers, byte for byte, for the engine at the production settings:
 * a 180 s budget, a 20 s probe and 30 s of headroom, a ceiling of 230 s. The numbers
 * optimization-engine/tests/test_timing.py pins (test_timing_says_what_each_route_may_take
 * pins the shape; this is the same body with the production figures).
 */
export const PRODUCTION_BODY = {
  version: 1,
  capabilities: ['deadlineSeconds'],
  transferMarginSeconds: 5,
  routes: {
    optimize: { budgetSeconds: 180, probeSeconds: 20, headroomSeconds: 30, ceilingSeconds: 230 },
    'optimize-rooms': { budgetSeconds: 10, probeSeconds: 0, headroomSeconds: 30, ceilingSeconds: 40 },
    staff: { budgetSeconds: 10, probeSeconds: 0, headroomSeconds: 30, ceilingSeconds: 40 },
    'plan-exams': { budgetSeconds: 20, probeSeconds: 0, headroomSeconds: 30, ceilingSeconds: 50 },
  },
};

/**
 * The same body at the settings the engine ran with on 2026-11-23: a 540 s budget, a 20 s probe and 30 s of headroom, a
 * ceiling of 590 s. Longer than the five minutes Railway's edge holds a request that sends nothing: the two Generera
 * runs of the only real school were closed at 300 s, and the engine answered, 240 s later, to nobody.
 */
export const INCIDENT_BODY = {
  ...PRODUCTION_BODY,
  routes: {
    ...PRODUCTION_BODY.routes,
    optimize: { budgetSeconds: 540, probeSeconds: 20, headroomSeconds: 30, ceilingSeconds: 590 },
  },
};

/** The incident's engine as one older than `deadlineSeconds` says it: its times, and no capability to answer inside a deadline. */
export const INCIDENT_BODY_WITHOUT_DEADLINE = { ...INCIDENT_BODY, capabilities: [] as string[] };
