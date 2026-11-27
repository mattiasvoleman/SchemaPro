import type { PossibleTimes } from "@/lib/possible-times";

/*
 * What the gateway answers (src/calendar/possible-times.service.ts) for the lesson "a" of the board's tests, Monday 09:00–10:00, in a
 * week where Tuesday 08:00 is the best time and Monday afternoon is the class's lunch. Tests only.
 */
export const TIMES: PossibleTimes = {
  academicYearId: "year-1",
  subject: { lessonId: "a", className: "7A", subjectName: "Matematik", minutes: 60, lessonIds: ["a"], isLocked: false, unplaced: false, current: { dayOfWeek: 1, startMinutes: 540, endMinutes: 600 } },
  stepMinutes: 15,
  options: [
    { rank: 1, dayOfWeek: 2, startMinutes: 480, endMinutes: 540, lessons: [{ lessonId: "a", roomId: "r1", startMinutes: 480, endMinutes: 540 }], roomChanged: false, costs: [], wishes: { met: 0, avoided: 0 }, score: 1 },
    { rank: 2, dayOfWeek: 2, startMinutes: 510, endMinutes: 570, lessons: [{ lessonId: "a", roomId: "r1", startMinutes: 510, endMinutes: 570 }], roomChanged: false, costs: [], wishes: { met: 0, avoided: 0 }, score: 2 },
    { rank: 3, dayOfWeek: 3, startMinutes: 600, endMinutes: 660, lessons: [{ lessonId: "a", roomId: "r2", startMinutes: 600, endMinutes: 660 }], roomChanged: true, costs: [], wishes: { met: 0, avoided: 0 }, score: 3 },
  ],
  days: [
    {
      dayOfWeek: 1,
      runs: [
        { dayOfWeek: 1, fromMinutes: 420, toMinutes: 465, kind: "CLOSED", code: "FRAME", params: {} },
        { dayOfWeek: 1, fromMinutes: 480, toMinutes: 525, kind: "FREE" },
        { dayOfWeek: 1, fromMinutes: 540, toMinutes: 540, kind: "STANDS" },
        { dayOfWeek: 1, fromMinutes: 555, toMinutes: 600, kind: "IN_THE_WAY", blockerId: "b" },
        { dayOfWeek: 1, fromMinutes: 615, toMinutes: 660, kind: "CROWDED", units: 2, locked: false },
        { dayOfWeek: 1, fromMinutes: 675, toMinutes: 720, kind: "CLOSED", code: "LUNCH", params: {} },
      ],
    },
    {
      dayOfWeek: 2,
      runs: [
        { dayOfWeek: 2, fromMinutes: 480, toMinutes: 570, kind: "FREE" },
        { dayOfWeek: 2, fromMinutes: 585, toMinutes: 600, kind: "CLOSED", code: "OTHER_SCHOOL", params: { schools: "Norra skolan" } },
      ],
    },
    { dayOfWeek: 3, runs: [{ dayOfWeek: 3, fromMinutes: 600, toMinutes: 660, kind: "CHANGE" }] },
  ],
  blockers: { b: { lessonId: "b", className: "7B", subjectName: "Svenska", dayOfWeek: 1, startMinutes: 570, endMinutes: 630, isLocked: false } },
};
