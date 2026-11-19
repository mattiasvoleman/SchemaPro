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
