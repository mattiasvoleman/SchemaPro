/**
 * The react-query keys of Publicering, and what a publish or an avbokning
 * makes stale — the staffing-keys.ts pattern.
 *
 * The keys of lib/queries.ts's calendar reads and of the timplan and staffing
 * figures are repeated here as data, so the publication hooks can invalidate
 * them without importing those modules: lib/queries.ts is in every route's
 * chunk graph, and the timplan and staffing hooks are other pages'.
 *
 * Each is the PREFIX react-query matches on invalidation.
 */
export const PUBLICATION_KEYS = {
  settings: ["publicationSettings"],
  timeline: ["publicationTimeline"],
  state: ["publicationState"],
  preview: ["publicationPreview"],
  links: ["publicLinks"],
  hiddenTeachers: ["teacherPublicLabels"],
  batches: ["cancellationBatches"],
} as const;

/**
 * What a write to the calendar makes stale: every calendar read (the
 * teacher's, the pupil's, the day planner's, the absence page's), the meal
 * and rast rows publish dates, and the figures read off the calendar — P3's
 * delivered time and the staffing reconciliation.
 */
export const AFTER_CALENDAR_WRITE: readonly (readonly string[])[] = [
  ["calendarLessons"],
  ["calendar-lunches"],
  ["calendar-rasts"],
  ["dayLessons"],
  ["teacherLessons"],
  ["teacherAbsenceLessons"],
  ["timplanCoverage"],
  ["staffingLoad"],
];

/**
 * After a publish: the calendar, the publication's own reads, and — in DRAFT,
 * where discard rewrites the grundschema — the masters and their versions.
 */
export const AFTER_PUBLISH: readonly (readonly string[])[] = [
  ...AFTER_CALENDAR_WRITE,
  PUBLICATION_KEYS.timeline,
  PUBLICATION_KEYS.state,
  PUBLICATION_KEYS.preview,
  PUBLICATION_KEYS.batches,
];

/** After a bulk avbokning or its reversal: the calendar, the batches, the credits. */
export const AFTER_CANCELLATION: readonly (readonly string[])[] = [
  ...AFTER_CALENDAR_WRITE,
  PUBLICATION_KEYS.batches,
  ["timplanCredits"],
];
