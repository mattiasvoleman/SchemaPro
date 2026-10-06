/**
 * The react-query keys of the guardian dashboard's reads, and nothing else.
 *
 * The hooks that read under them live in lib/guardian-queries.ts, which only
 * the pages that call them import. But useGuardianLinkActions in
 * lib/queries.ts has to invalidate the children list too — linking a guardian
 * to a pupil changes what that guardian's dashboard shows — and importing the
 * hooks' module from there would put it back in every route's chunk graph,
 * which is the regression the split exists to undo. So the keys sit here, the
 * way lib/staffing-keys.ts holds tjänstefördelningens.
 *
 * Each is the PREFIX react-query matches on invalidation; the full key carries
 * the guardian, the date or the status after it.
 */
export const GUARDIAN_KEYS = {
  myChildren: ["myChildren"],
  absenceReports: ["absenceReports"],
  leaveRequests: ["leaveRequests"],
} as const;
