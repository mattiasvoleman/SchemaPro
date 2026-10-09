/**
 * The react-query keys of tjänstefördelningen, and nothing else.
 *
 * The hooks that read under them live in lib/staffing-queries.ts, which only
 * the staffing surfaces import. But useImportCsv in lib/queries.ts has to
 * invalidate them too — a teachers file may carry a post, a behörighet file
 * rewrites the qualification list, and the load report reads both — and
 * lib/queries.ts is in every route's chunk graph. Importing the hooks' module
 * from there for three strings would put the hooks' code back on every page,
 * which is the regression the split exists to undo; Turbopack keeps a module
 * whole when two routes share it. So the keys sit here, where both modules
 * can reach them and neither drags the other along.
 *
 * Each is the PREFIX react-query matches on invalidation. The full key carries
 * the läsår or the teacher after it, so a prefix invalidation refetches every
 * year's and every teacher's copy — which is what an import, which does not
 * know which year it landed in, needs.
 */
export const STAFFING_KEYS = {
  policy: ["staffingPolicy"],
  employments: ["teacherEmployments"],
  qualifications: ["teacherQualifications"],
  load: ["staffingLoad"],
  unstaffed: ["staffingUnstaffed"],
  /** Uppdrag per läsår and teacher; the duties import invalidates these too. */
  duties: ["teacherDuties"],
  /** suggest-teachers per requirement: every staffing write makes them stale. */
  suggestions: ["staffingSuggestions"],
  /**
   * A teacher's versions (staffing Fas 3). Every write to a post or an
   * uppdrag adds one, so every writer below invalidates it.
   */
  history: ["teacherEmploymentHistory"],
} as const;
