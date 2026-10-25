import type { SupervisionArea, SupervisionBreak, SupervisionRota, SupervisionShift } from "../../../lib/supervision";
import type { AcademicYear } from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { AUTUMN_YEAR } from "./calendar";
import { SITES } from "./misc-school";
import { TEACHERS } from "./world";

/**
 * Rastvaktsschema (GET /api/v1/supervision-areas and /supervision-rota,
 * 20261207090000): the yard on the main house, watched at the morning rast,
 * and the dining hall at lunch with two on duty. Bo watches the yard on
 * Mondays until the jullov, which is the Rastvakt uppdrag of 30 minutes
 * staffing-rows.ts gives him, now his ram; Cecilia the hall Monday to
 * Thursday; Anna, the teacher persona, the hall on Fridays, during her
 * Swedish with 7A (a lesson clash, as the gateway names it); the Tuesday
 * yard and Friday's lunch are short, so the gaps card, the grid's marked
 * cells, a dated pass, a pass in no break, a pass during a lesson and the
 * teachers' card are all on the page for the a11y gate, and Anna's own
 * tjänst and uppdragsbeskrivning carry a rastvakt line. The gateway resolves
 * the breaks; the stub states them as it would.
 *
 * Rastvakt i vardagen (20261210090000): Bo also clears the hall after lunch
 * on Wednesdays, in no break of its own. He is away all this week
 * (cover-world.ts), so the board has his passes — the Monday's taken by
 * Anna, the Wednesday entrance passed without a decision, and the Wednesday
 * hall still open at the suite's 10:00 — and Anna's week has her Friday
 * lunch and the Monday she takes for him (gateway-cover.ts).
 */

const garden = uid(KIND.misc, 9701);
const hall = uid(KIND.misc, 9702);

export const SUPERVISION_AREAS: SupervisionArea[] = [
  {
    id: hall,
    name: "Matsalen",
    siteId: null,
    minGradeLevel: null,
    maxGradeLevel: null,
    duringRasts: false,
    duringLunch: true,
    guardsNeeded: 2,
    countsAsTeaching: false,
    shiftCount: 6,
  },
  {
    id: garden,
    name: "Skolgården",
    siteId: SITES.sites[0]!.id,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    duringRasts: true,
    duringLunch: false,
    guardsNeeded: 1,
    countsAsTeaching: false,
    shiftCount: 2,
  },
];

const shift = (n: number, areaId: string, userId: string, dayOfWeek: number, startTime: string, endTime: string, rest: Partial<SupervisionShift> = {}) =>
  (yearId: string): SupervisionShift => ({
    id: uid(KIND.misc, 9710 + n),
    academicYearId: yearId,
    areaId,
    userId,
    dayOfWeek,
    startTime,
    endTime,
    validFrom: null,
    validTo: null,
    note: null,
    inactiveFrom: null,
    lessonClashes: [],
    ...rest,
  });

const SHIFTS = [
  // Until the jullov: the last Monday before it.
  shift(1, garden, TEACHERS.bo.id, 1, "09:10", "09:25", { validTo: `${AUTUMN_YEAR}-12-14` }),
  // The entrance before the day, in no break of the yard's.
  shift(2, garden, TEACHERS.bo.id, 3, "07:45", "08:00", { note: "Entrén" }),
  ...[1, 2, 3, 4].map((day) => shift(2 + day, hall, TEACHERS.cecilia.id, day, "11:30", "12:15")),
  shift(7, hall, TEACHERS.anna.id, 5, "11:30", "12:15", {
    lessonClashes: [{ subject: "Svenska", group: "7A", dayOfWeek: 5, startTime: "11:00", endTime: "12:00" }],
  }),
  // After the lunch, in no break of the hall's.
  shift(8, hall, TEACHERS.bo.id, 3, "12:30", "12:45"),
];

/** The year's passes, as the gateway holds them (Rastvakt i vardagen's board and week read them). */
export const supervisionShifts = (yearId: string): SupervisionShift[] => SHIFTS.map((make) => make(yearId));

/** An area's name, as GET /supervision-areas answers it. */
export const supervisionAreaName = (areaId: string): string =>
  SUPERVISION_AREAS.find((area) => area.id === areaId)?.name ?? "";

/** An area's skolområde's name, or null. */
export const supervisionSiteName = (areaId: string): string | null => {
  const siteId = SUPERVISION_AREAS.find((area) => area.id === areaId)?.siteId ?? null;
  return siteId ? (SITES.sites.find((site) => site.id === siteId)?.name ?? null) : null;
};

const brk = (areaId: string, dayOfWeek: number, startTime: string, endTime: string, names: string[], needed: number, shiftIds: string[]): SupervisionBreak => ({
  areaId,
  dayOfWeek,
  startTime,
  endTime,
  names,
  lunch: names.includes("Lunch"),
  needed,
  shiftIds,
});

/** The nearest date of ISO `day` on or after (1) or on or before (-1) `date`. */
function weekdayFrom(date: string, day: number, direction: 1 | -1): string {
  let at = new Date(`${date}T00:00:00Z`);
  while ((at.getUTCDay() || 7) !== day) at = new Date(at.getTime() + direction * 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** The year's schedule; NEXT_YEAR, rolled and not activated, has none yet. */
export function supervisionRota(year: AcademicYear, current: boolean): SupervisionRota {
  const shifts = current ? SHIFTS.map((make) => make(year.id)) : [];
  const idOf = (areaId: string, day: number) =>
    shifts
      .filter((row) => row.areaId === areaId && row.dayOfWeek === day && row.startTime !== "07:45" && row.startTime !== "12:30")
      .map((row) => row.id);
  const days = [1, 2, 3, 4, 5];
  const breaks = [
    ...days.map((day) => brk(garden, day, "09:10", "09:25", ["Förmiddagsrast"], 1, idOf(garden, day))),
    ...days.map((day) => brk(hall, day, "11:30", "12:15", ["Lunch"], 2, idOf(hall, day))),
  ];
  // Dates as the gateway states them: the first and the last date of the
  // weekday, and whether the gap reaches the year's bounds.
  const gap = (areaId: string, day: number, start: string, end: string, names: string[], needed: number, fewest: number, from: string) => ({
    ...brk(areaId, day, start, end, names, needed, []),
    fewest,
    shortFrom: start,
    shortTo: end,
    from: weekdayFrom(from, day, 1),
    to: weekdayFrom(year.endDate, day, -1),
    fromYearStart: from === year.startDate,
    toYearEnd: true,
  });
  const gaps = current
    ? [
        gap(garden, 1, "09:10", "09:25", ["Förmiddagsrast"], 1, 0, `${AUTUMN_YEAR}-12-19`),
        ...[2, 3, 4, 5].map((day) => gap(garden, day, "09:10", "09:25", ["Förmiddagsrast"], 1, 0, year.startDate)),
        ...[1, 2, 3, 4, 5].map((day) => gap(hall, day, "11:30", "12:15", ["Lunch"], 2, 1, year.startDate)),
      ]
    : breaks.map((row) => ({
        ...row,
        fewest: 0,
        shortFrom: row.startTime,
        shortTo: row.endTime,
        from: year.startDate,
        to: year.endDate,
        fromYearStart: true,
        toYearEnd: true,
      }));
  return {
    academicYearId: year.id,
    year: { startDate: year.startDate, endDate: year.endDate },
    areas: SUPERVISION_AREAS,
    shifts,
    breaks,
    gaps,
    teachers: current
      ? [
          { userId: TEACHERS.bo.id, shiftCount: 3, minutesPerWeek: 37, countedMinutesPerWeek: 0, peakMinutesPerWeek: 45, hoursPerYear: 18.8, ramMinutesPerWeek: 12, ramCountedMinutesPerWeek: 0 },
          { userId: TEACHERS.cecilia.id, shiftCount: 4, minutesPerWeek: 180, countedMinutesPerWeek: 0, peakMinutesPerWeek: 180, hoursPerYear: 114, ramMinutesPerWeek: null, ramCountedMinutesPerWeek: 0 },
          ANNA_LINE,
        ]
      : [],
  };
}

/** Anna's Friday lunch, all year and no ram: her own tjänst and uppdragsbeskrivning show it. */
const ANNA_LINE = {
  userId: TEACHERS.anna.id,
  shiftCount: 1,
  minutesPerWeek: 45,
  countedMinutesPerWeek: 0,
  peakMinutesPerWeek: 45,
  hoursPerYear: 28.5,
  ramMinutesPerWeek: null,
  ramCountedMinutesPerWeek: 0,
};

/** Bo's and Anna's lines in the load: the rastvaktsschema's part of their uppdrag. */
export const SUPERVISION_LOAD = {
  teachers: [
    { userId: TEACHERS.bo.id, shiftCount: 3, minutesPerWeek: 37, countedMinutesPerWeek: 0, peakMinutesPerWeek: 45, hoursPerYear: 18.8, ramMinutesPerWeek: 12, ramCountedMinutesPerWeek: 0 },
    ANNA_LINE,
  ],
};
