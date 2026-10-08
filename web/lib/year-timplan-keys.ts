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

/**
 * GET /timplan-coverage, per läsår. Beside the year's attachments because
 * everything that changes one changes the other: the year dialog's PUT, a new
 * year's defaults and "Skapa timplansposter" all invalidate this prefix, and
 * none of them should have to import the coverage page's hooks to do it.
 */
export const TIMPLAN_COVERAGE_KEYS = {
  all: ["timplanCoverage"],
  year: (academicYearId: string) => ["timplanCoverage", academicYearId] as const,
  /*
   * Layers 2 and 3 under the year's key, so everything that invalidates the
   * year — or the whole prefix, as a saved credit does — reaches them too.
   * The group is the drill-down; "" is the overview.
   */
  scheduled: (academicYearId: string, studentGroupId: string | null) =>
    ["timplanCoverage", academicYearId, "scheduled", studentGroupId ?? ""] as const,
  delivered: (academicYearId: string, studentGroupId: string | null) =>
    ["timplanCoverage", academicYearId, "delivered", studentGroupId ?? ""] as const,
} as const;
