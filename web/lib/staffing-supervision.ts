/*
 * Rastvakt in the load (Rastvaktsschema): a teacher's passes in the
 * rastvaktsschema, as GET /staffing/load's `supervision` states them beside
 * the report (src/supervision/supervision-load.ts). The passes are already in
 * the report's uppdrag; this is their own line. Its own module, without
 * hooks, so the staffing cards carry it and not the schedule page's code.
 */

/** One teacher's rastvakt beside their ram, as the gateway counts it. */
export interface TeacherSupervision {
  userId: string;
  shiftCount: number;
  /** The passes' standardvecka, whole minutes. */
  minutesPerWeek: number;
  /** The part counted against the target (areas that count as teaching). */
  countedMinutesPerWeek: number;
  peakMinutesPerWeek: number;
  hoursPerYear: number;
  /** The teacher's RASTVAKT uppdrag over the year; null without one. */
  ramMinutesPerWeek: number | null;
  /** The part of the ram still counted: the weeks no pass runs in. */
  ramCountedMinutesPerWeek: number;
}

/**
 * A teacher's line on the load's cards: null when the year has no pass, or
 * the teacher none.
 */
export function supervisionOf(
  report: { supervision?: { teachers: TeacherSupervision[] } | null } | undefined,
  userId: string,
): TeacherSupervision | null {
  return report?.supervision?.teachers.find((row) => row.userId === userId) ?? null;
}
