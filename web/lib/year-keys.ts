import { TIMPLAN_COVERAGE_KEYS, YEAR_TIMPLAN_KEYS } from "./year-timplan-keys";

/**
 * The react-query keys the läsår pages read under and invalidate, and nothing
 * else — the staffing-keys.ts pattern.
 *
 * The hooks live beside the two pages that use them
 * (app/[locale]/(app)/admin/years/use-year-activation.ts and
 * years/rollover/use-year-rollover.ts), not in lib/queries.ts: that module is
 * in every route's chunk graph, and two pages' worth of hooks there would be
 * paid for by the guardian dashboard and the timetable, which sit on their
 * budgets to the decimal. The keys of lib/queries.ts's own reads are repeated
 * here as data, so the hooks can invalidate them without importing that file.
 *
 * Each is the PREFIX react-query matches on invalidation.
 */
export const YEAR_KEYS = {
  /** useAcademicYears, lib/queries.ts. */
  years: ["academicYears"],
  /** useGroups — every year's groups; a rollover adds next year's. */
  groups: ["groups"],
  /** usePeople — a pupil's home class is studentGroupId on the person. */
  people: ["people"],
  /** useGroupMemberships and useGroupMembers: teaching-group members. */
  memberships: ["groupMemberships"],
  members: ["groupMembers"],
  /** Per year: the rollover writes the new year's copies. */
  requirements: ["requirements"],
  breaks: ["schoolBreaks"],
  constraints: ["constraints"],
  /** Rosters attendance reads from a home class (lib/queries.ts). */
  lessonRoster: ["lessonRoster"],
  groupStudents: ["groupStudents"],
  /** POST …/rollover/preview, per source year and options. */
  rolloverPreview: ["yearRolloverPreview"],
  /** POST …/activation/preview, per year. */
  activationPreview: ["yearActivationPreview"],
  /**
   * Timplan per årskurs (lib/year-timplan-keys.ts): the rollover writes the
   * new year's, carried by cohort; the coverage measures the classes and
   * pupils that the rollover creates and the activation moves.
   */
  yearTimplans: YEAR_TIMPLAN_KEYS.all,
  timplanCoverage: TIMPLAN_COVERAGE_KEYS.all,
} as const;

/** What a rollover writes: a year, its groups, members, rows, lov, rules and timplan per årskurs. */
export const AFTER_ROLLOVER = [
  YEAR_KEYS.years,
  YEAR_KEYS.groups,
  YEAR_KEYS.memberships,
  YEAR_KEYS.members,
  YEAR_KEYS.requirements,
  YEAR_KEYS.breaks,
  YEAR_KEYS.constraints,
  YEAR_KEYS.yearTimplans,
  YEAR_KEYS.timplanCoverage,
  YEAR_KEYS.rolloverPreview,
  YEAR_KEYS.activationPreview,
] as const;

/** What an activation changes: the active flag and every moved pupil's class. */
export const AFTER_ACTIVATION = [
  YEAR_KEYS.years,
  YEAR_KEYS.people,
  YEAR_KEYS.groups,
  YEAR_KEYS.memberships,
  YEAR_KEYS.members,
  YEAR_KEYS.lessonRoster,
  YEAR_KEYS.groupStudents,
  YEAR_KEYS.yearTimplans,
  YEAR_KEYS.timplanCoverage,
  YEAR_KEYS.rolloverPreview,
  YEAR_KEYS.activationPreview,
] as const;
