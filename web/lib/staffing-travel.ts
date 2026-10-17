/*
 * Restid (Skolområden och restid): a teacher's walks between the school's
 * sites, as GET /staffing/load's `travel` states them beside the report
 * (src/staffing/travel-load.ts). Its own module, without hooks, so a page
 * test that mocks the staffing queries still has it.
 */

/** One teacher's restid: per standardvecka, in the busiest week, and per läsår. */
export interface TeacherTravel {
  userId: string;
  minutesPerWeek: number;
  peakMinutesPerWeek: number;
  hoursPerYear: number;
}

/**
 * A teacher's restid as a card states it: null at a school with no travel
 * figure (the card then says nothing of it), zero for a teacher who walks
 * nowhere at a school that has one.
 */
export function travelOf(
  report: { travel?: { teachers: TeacherTravel[] } | null } | undefined,
  userId: string,
): TeacherTravel | null {
  if (!report?.travel) return null;
  return (
    report.travel.teachers.find((row) => row.userId === userId) ?? {
      userId,
      minutesPerWeek: 0,
      peakMinutesPerWeek: 0,
      hoursPerYear: 0,
    }
  );
}

