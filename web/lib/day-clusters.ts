import { layoutDay } from "@/lib/day-lanes";

/*
 * A module of its own, not a function in lib/day-lanes.ts, for the bundle:
 * the timetable's grid draws its days with layoutDay, and Turbopack keeps a
 * module whole, so the printed week's layout was on the grid's first load
 * although only components/timetable-sheet/week-sheet.tsx calls it.
 */

/**
 * Lanes per overlap CLUSTER, for Schemavisaren's printed week.
 *
 * The admin grid draws a day as narrow as its busiest hour (layoutDay, kept
 * as it is): a planner reads the day's structure. A family's door sheet does
 * not. A språkval of three groups at 10:50 squeezed every other lesson of the
 * day into a third of the column, clipping the room and the teacher, which
 * are what a pupil needs from the sheet. Here a lesson that overlaps nothing
 * is full width, and only the lessons that overlap one another, directly or
 * through a chain, share their cluster's lanes.
 */
export function layoutClusters<T extends { startMinutes: number; endMinutes: number }>(
  lessons: readonly T[],
): Array<T & { lane: number; laneCount: number }> {
  const sorted = [...lessons].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );
  const out: Array<T & { lane: number; laneCount: number }> = [];
  let cluster: T[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (cluster.length > 0) out.push(...layoutDay(cluster));
    cluster = [];
  };
  for (const lesson of sorted) {
    if (lesson.startMinutes >= clusterEnd) {
      flush();
      clusterEnd = lesson.endMinutes;
    } else {
      clusterEnd = Math.max(clusterEnd, lesson.endMinutes);
    }
    cluster.push(lesson);
  }
  flush();
  return out;
}
