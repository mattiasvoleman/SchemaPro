import type {
  ClassesView,
  ClassPupilsView,
  ClassStatsView,
  Figures,
  PatternsView,
  PupilStatsView,
  Reporting,
  SeriesMonthView,
  WindowView,
} from "@/lib/absence-stats";

/*
 * The gateway's answers (src/absence-stats/), made up for the tests. The
 * shares are written out the way the gateway sends them: one decimal, of the
 * recorded minutes. No name here is anybody's.
 */

export const WINDOW: WindowView = {
  firstMonth: "2024-08-01",
  today: "2026-11-07",
  year: { name: "2026/2027", from: "2026-08-17", to: "2027-06-11" },
  minGroup: 5,
};

/** Minutes of each kind out of `recorded`, with the shares the gateway would send. */
export function figures(recorded: number, valid: number, absent: number, late = 0, lateCount = 0): Figures {
  const pct = (part: number): number | null => (recorded > 0 ? Math.round((part * 1000) / recorded) / 10 : null);
  const invalid = absent + late;
  return {
    recordedMinutes: recorded,
    validMinutes: valid,
    absentMinutes: absent,
    lateMinutes: late,
    lateCount,
    invalidMinutes: invalid,
    validPct: pct(valid),
    invalidPct: pct(invalid),
    totalPct: pct(valid + invalid),
  };
}

export const reporting = (held: number, reported: number): Reporting => ({
  held,
  reported,
  ratePct: held > 0 ? Math.round((reported * 1000) / held) / 10 : null,
});

export function month(first: string, over: Partial<SeriesMonthView> = {}): SeriesMonthView {
  return {
    month: first,
    throughDay: `${first.slice(0, 7)}-28`,
    partial: false,
    classNames: [],
    pupils: 24,
    pupilsRegistered: 24,
    figures: figures(10000, 300, 200, 30, 6),
    reporting: reporting(400, 380),
    previousYear: null,
    ...over,
  };
}

/** October and the month that is going on, with October of the year before; September has no figure. */
export const SCHOOL_SERIES: SeriesMonthView[] = [
  month("2025-10-01", { figures: figures(10000, 250, 150, 0, 0), reporting: reporting(400, 360) }),
  month("2026-09-01", { pupilsRegistered: 3, pupils: 24, figures: null, reporting: reporting(100, 12) }),
  month("2026-10-01", {
    figures: figures(12000, 480, 240, 30, 6),
    reporting: reporting(420, 399),
    previousYear: {
      month: "2025-10-01",
      figures: figures(10000, 250, 150, 0, 0),
      reporting: reporting(400, 360),
    },
  }),
  month("2026-11-01", {
    partial: true,
    throughDay: "2026-11-06",
    figures: figures(2000, 40, 20, 0, 0),
    reporting: reporting(60, 30),
    previousYear: { month: "2025-11-01", figures: null, reporting: reporting(0, 0) },
  }),
];

export const PATTERNS: PatternsView = {
  groupSize: 22,
  suppressed: false,
  weekdays: [
    { key: "1", label: "1", figures: figures(2000, 80, 60) },
    { key: "5", label: "5", figures: figures(1800, 40, 120) },
  ],
  slots: [
    { key: "08:10", label: "08:10", figures: figures(1500, 30, 90) },
    { key: "13:00", label: "13:00", figures: figures(0, 0, 0) },
  ],
  subjects: [
    { key: "sub-1", label: "Idrott och hälsa", figures: figures(900, 20, 100) },
    { key: "sub-2", label: "Matematik", figures: figures(1200, 40, 30) },
  ],
};

export const SUPPRESSED: PatternsView = { groupSize: 3, suppressed: true, weekdays: [], slots: [], subjects: [] };

export const CLASS_ID = "c0000000-0000-4000-8000-000000000001";
export const OTHER_CLASS_ID = "c0000000-0000-4000-8000-000000000002";

export const CLASSES: ClassesView = {
  window: WINDOW,
  period: { from: "2026-08-17", to: "2026-11-06" },
  classes: [
    {
      classId: CLASS_ID,
      className: "7A",
      yearName: "2026/2027",
      monthsCounted: 3,
      pupils: 24,
      pupilsRegistered: 23,
      figures: figures(9000, 270, 180, 15, 3),
      reporting: reporting(300, 270),
    },
    {
      classId: OTHER_CLASS_ID,
      className: "7B",
      yearName: null,
      monthsCounted: 0,
      pupils: 4,
      pupilsRegistered: 4,
      figures: null,
      reporting: reporting(0, 0),
    },
  ],
};

export const CLASS_VIEW: ClassStatsView = {
  window: WINDOW,
  classId: CLASS_ID,
  series: SCHOOL_SERIES,
  period: CLASSES.period,
  patterns: PATTERNS,
};

export const STUDENT_ID = "50000000-0000-4000-8000-000000000001";
export const OTHER_STUDENT_ID = "50000000-0000-4000-8000-000000000002";
export const NO_MARKS_STUDENT_ID = "50000000-0000-4000-8000-000000000003";

export const PUPILS: ClassPupilsView = {
  window: WINDOW,
  classId: CLASS_ID,
  period: CLASSES.period,
  heldOut: 2,
  pupils: [
    { studentId: OTHER_STUDENT_ID, firstName: "Siri", lastName: "Öberg", figures: figures(900, 18, 9, 0, 0) },
    { studentId: STUDENT_ID, firstName: "Ola", lastName: "Berg", figures: figures(1000, 50, 100, 15, 1) },
    { studentId: NO_MARKS_STUDENT_ID, firstName: "Eli", lastName: "Dal", figures: figures(0, 0, 0) },
  ],
};

export function pupilView(over: Partial<PupilStatsView> = {}): PupilStatsView {
  return {
    window: WINDOW,
    student: {
      id: STUDENT_ID,
      firstName: "Ola",
      lastName: "Berg",
      classId: CLASS_ID,
      className: "7A",
      isProtected: false,
    },
    marksFrom: "2025-10-06",
    marksTo: "2026-11-06",
    months: [
      { month: "2025-09-01", figures: null, lessons: 0, previousYear: null },
      {
        month: "2025-10-01",
        figures: figures(1000, 40, 20, 0, 0),
        lessons: 30,
        previousYear: null,
      },
      {
        month: "2026-10-01",
        figures: figures(1200, 60, 30, 15, 1),
        lessons: 36,
        previousYear: { month: "2025-10-01", figures: figures(1000, 40, 20, 0, 0) },
      },
      {
        month: "2026-11-01",
        figures: null,
        lessons: 0,
        previousYear: { month: "2025-11-01", figures: null },
      },
    ],
    total: figures(2200, 100, 50, 15, 1),
    classSeries: SCHOOL_SERIES,
    period: CLASSES.period,
    patterns: { ...PATTERNS, groupSize: 1 },
    ...over,
  };
}
