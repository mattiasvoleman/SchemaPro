/**
 * The react-query key of "Timplan per årskurs", and nothing else.
 *
 * Read by the Timplansposter matrix's Mål mode (lazily, through
 * lib/year-timplan-queries.ts) and written by the academic-year dialog's PUT.
 * The year dialog lives behind lib/queries.ts, which is in every route's
 * chunk graph, so the key sits in a file of its own that both can reach
 * without dragging the hooks along — the argument lib/staffing-keys.ts makes.
 *
 * The prefix is what invalidation matches on; the full key carries the läsår.
 */
export const YEAR_TIMPLAN_KEYS = {
  all: ["yearTimplans"],
  year: (academicYearId: string) => ["yearTimplans", academicYearId] as const,
} as const;
