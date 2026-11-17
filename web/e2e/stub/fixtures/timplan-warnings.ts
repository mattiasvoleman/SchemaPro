import { uid, KIND } from "../sessions";
import { ROOMS, TEACHERS } from "./world";

/**
 * Varningar medan man lägger (D1), as the gateway answers them, for the week that has rows (timplan-board.ts).
 *
 * A scenario that starts with PLACEMENT_WARNINGS_SCENARIO is the write scenario (it remembers what is written to it, per scenario name: give every
 * test its own, `placement-write-warnings:<id>`) with a third row, and with warnings of every kind on the rows, on the board and in the answer of a
 * save, and with other schools' holds on a teacher and a room. The warnings follow the POST, not the row's id: a save gives the rows new ids and the
 * answer names the new ones, as the gateway's does (a warning belongs to the row of the answer it came in).
 *
 *   Svenska 7A    Anna    Tuesday 10:00–11:00 in NO-salen      the day too long                          does not refuse
 *                                                              teaching in a row too long                does not refuse
 *   Matematik 7A  Bo      Thursday 13:15–14:15 (does NOT hold) the class has no lunch                    refuses
 *                                                              too many teaching days (the limit told)   refuses
 *   Idrott 7A     David   Friday 17:00–18:00, odd weeks        no room of the type free                  refuses
 *                                                              too many teaching days (limit hidden)     refuses
 *                                                              teaching in a row too long (limit hidden) does not refuse
 *
 * The holds: Anna is busy at Östra skolan on Wednesday 13:00–14:30; Bo at Södra skolan on Monday 08:00–09:30; NO-salen is lent to Norra skolan and
 * Östra skolan on Thursday 09:00–10:00. A band is drawn only for the teacher or the room that is picked.
 */

export const PLACEMENT_WARNINGS_SCENARIO = "placement-write-warnings";

export const isWarningsScenario = (scenario: string | null): scenario is string => scenario !== null && scenario.startsWith(PLACEMENT_WARNINGS_SCENARIO);

interface Warned {
  code: string;
  refuses: boolean;
  params?: Record<string, string | number>;
}

const post = (n: number) => uid(KIND.requirement, n);

const OF_POST = new Map<string, Warned[]>([
  [
    post(1),
    [
      { code: "TEACHER_DAY_TOO_LONG", refuses: false, params: { day: 2, minutes: 470, cap: 420 } },
      { code: "TEACHER_STRETCH_TOO_LONG", refuses: false, params: { day: 2, minutes: 240, max: 180, breakMinutes: 20 } },
    ],
  ],
  [
    post(2),
    [
      { code: "CLASS_HAS_NO_LUNCH", refuses: true, params: { day: 4, windowStart: "10:30", windowEnd: "13:00", minutes: 30 } },
      { code: "TEACHER_WEEK_TOO_MANY_DAYS", refuses: true, params: { days: 5, max: 4 } },
    ],
  ],
  [
    post(4),
    [
      { code: "NO_ROOM_FREE", refuses: true, params: { day: 5, start: "17:00", end: "18:00", roomType: "Idrottssal" } },
      { code: "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN", refuses: true },
      { code: "TEACHER_STRETCH_TOO_LONG_HIDDEN", refuses: false },
    ],
  ],
]);

/** The warnings on these rows, each named by its row's id and its post's: the board's, and the answer of a save's (the ids it has just written). */
export function warningsOfRows(rows: ReadonlyArray<{ id: string; requirementId: string }>) {
  return rows.flatMap((row) => (OF_POST.get(row.requirementId) ?? []).map((warning) => ({ ...warning, rowId: row.id, requirementId: row.requirementId })));
}

/** Other schools' hold on this school's teachers and rooms (the gateway's BoardHoldView). */
export const HOLDS = [
  { kind: "TEACHER_BUSY", resourceKind: "TEACHER", resourceId: TEACHERS.anna.id, dayOfWeek: 3, startTime: "13:00", endTime: "14:30", schools: ["Östra skolan"] },
  { kind: "TEACHER_BUSY", resourceKind: "TEACHER", resourceId: TEACHERS.bo.id, dayOfWeek: 1, startTime: "08:00", endTime: "09:30", schools: ["Södra skolan"] },
  { kind: "ROOM_LENT", resourceKind: "ROOM", resourceId: ROOMS.lab.id, dayOfWeek: 4, startTime: "09:00", endTime: "10:00", schools: ["Norra skolan", "Östra skolan"] },
];
