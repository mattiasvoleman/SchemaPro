import type {
  ClassesView,
  ClassPupilsView,
  ClassStatsView,
  Figures,
  PatternCell,
  PatternsView,
  PupilMonthView,
  PupilStatsView,
  Reporting,
  SchoolStatsView,
  SeriesMonthView,
  WindowView,
} from "../../../lib/absence-stats";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { HUVUDMAN_MEMBER } from "../sessions";
import { addDays, AUTUMN_YEAR, TODAY, YEAR_END, YEAR_NAME, YEAR_START } from "./calendar";
import { DUTIES } from "./staffing-rows";
import { byId, GROUPS, STUDENT_LIST, SUBJECTS } from "./world";

/**
 * Frånvarostatistik över tid as the gateway answers it (src/absence-stats/):
 * the school's months over three läsår, the classes with their sums, a class
 * month by month with its patterns, its pupils, and one pupil's card.
 *
 * The figures are made up, and shaped so every state of the pages is on
 * screen: the first two months of the window have no figure (fewer than five
 * pupils had a mark), the month that is going on is "hittills", and from the
 * thirteenth month on every month has the same month a year before. 7B is too
 * small to count, so it has no figure and no pattern. A pupil's first
 * months are "ingen registrering": the marks are kept from October of the
 * first year (marksFrom).
 *
 * Who reads what is the database's say, and the stub keeps to it: the school
 * is the administrators' (the huvudman's reader too), a mentor gets the
 * classes and pupils they hold MENTORSKAP for, the huvudman's reader gets no
 * pupil (403 with the code the page reads), and a pupil, a guardian and the
 * integrations get nothing.
 */

const MIN_GROUP = 5;

// --- dates, in the school's calendar days ----------------------------------

const DAY_MS = 86_400_000;
const asIso = (date: Date) => date.toISOString().slice(0, 10);
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
function shiftMonth(iso: string, delta: number): string {
  const [year, month] = iso.split("-").map(Number) as [number, number];
  return asIso(new Date(Date.UTC(year, month - 1 + delta, 1)));
}
const monthEnd = (iso: string) => asIso(new Date(new Date(`${shiftMonth(iso, 1)}T00:00:00Z`).getTime() - DAY_MS));

const FIRST_MONTH = `${AUTUMN_YEAR - 2}-08-01`;
const YESTERDAY = addDays(TODAY, -1);

/** Every school month of the window up to the one holding yesterday (no school in July). */
const MONTHS: string[] = [];
for (let month = FIRST_MONTH; month <= monthStart(YESTERDAY); month = shiftMonth(month, 1)) {
  if (month.slice(5, 7) !== "07") MONTHS.push(month);
}

const WINDOW: WindowView = {
  firstMonth: FIRST_MONTH,
  today: TODAY,
  year: { name: YEAR_NAME, from: YEAR_START, to: YEAR_END },
  minGroup: MIN_GROUP,
};

// --- figures ---------------------------------------------------------------

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);

function figures(recorded: number, valid: number, absent: number, late: number, lateCount: number): Figures {
  const invalid = absent + late;
  return {
    recordedMinutes: recorded,
    validMinutes: valid,
    absentMinutes: absent,
    lateMinutes: late,
    lateCount,
    invalidMinutes: invalid,
    validPct: pct(valid, recorded),
    invalidPct: pct(invalid, recorded),
    totalPct: pct(valid + invalid, recorded),
  };
}

const reporting = (held: number, reported: number): Reporting => ({ held, reported, ratePct: pct(reported, held) });

/** A month of a school or a class: `size` scales the minutes, and the first `blank` months have too few pupils. */
function series(size: number, blank: number, classNames: string[], pupils: number): SeriesMonthView[] {
  const rows = MONTHS.map((month, index) => {
    const recorded = Math.round((9000 + (index % 5) * 500) * size);
    const held = Math.round(380 * size);
    return {
      month,
      figures: index < blank ? null : figures(recorded, Math.round(recorded * (0.02 + (index % 4) * 0.004)), Math.round(recorded * (0.01 + (index % 3) * 0.004)), Math.round(recorded * 0.002), (index % 5) + 1),
      reporting: reporting(held, held - (index % 6) * Math.round(8 * size)),
    };
  });
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  return rows.map((row) => {
    const before = byMonth.get(shiftMonth(row.month, -12));
    // The month holding yesterday is not over; every earlier one is counted to its last day.
    const throughDay = row.month === monthStart(YESTERDAY) ? YESTERDAY : monthEnd(row.month);
    return {
      month: row.month,
      throughDay,
      partial: throughDay < monthEnd(row.month),
      classNames,
      pupils,
      pupilsRegistered: row.figures ? pupils : Math.min(pupils, MIN_GROUP - 2),
      figures: row.figures,
      reporting: row.reporting,
      previousYear: before ? { month: before.month, figures: before.figures, reporting: before.reporting } : null,
    };
  });
}

const cell = (key: string, label: string, recorded: number, valid: number, absent: number): PatternCell => ({
  key,
  label,
  figures: figures(recorded, valid, absent, 0, 0),
});

const PATTERNS: PatternsView = {
  groupSize: 22,
  suppressed: false,
  weekdays: [
    cell("1", "1", 2400, 60, 120),
    cell("2", "2", 2300, 50, 70),
    cell("3", "3", 2400, 40, 60),
    cell("4", "4", 2300, 45, 55),
    cell("5", "5", 2100, 70, 150),
  ],
  slots: [cell("08:10", "08:10", 3000, 80, 140), cell("09:25", "09:25", 3000, 60, 90), cell("13:00", "13:00", 2500, 40, 110)],
  subjects: [
    cell(SUBJECTS.idh.id, SUBJECTS.idh.name, 1200, 30, 100),
    cell(SUBJECTS.ma.id, SUBJECTS.ma.name, 1800, 50, 90),
    cell(SUBJECTS.sv.id, SUBJECTS.sv.name, 2000, 55, 40),
  ],
};
const SUPPRESSED: PatternsView = { groupSize: 4, suppressed: true, weekdays: [], slots: [], subjects: [] };

// --- who reads what --------------------------------------------------------

const CLASSES = [GROUPS.g7A, GROUPS.g7B, GROUPS.g8A, GROUPS.g9A];
const SMALL_CLASS = GROUPS.g7B.id;

/** A teacher's: the classes they hold MENTORSKAP for. */
function mentored(userId: string): Set<string> {
  return new Set(DUTIES.filter((duty) => duty.kind === "MENTORSKAP" && duty.userId === userId).map((duty) => duty.studentGroupId ?? ""));
}

type Reader = { classes: Set<string> | null };

/** The classes the caller reads (null: every one), or the Reply that refuses. */
function reader(context: GatewayContext): Reader | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  if (context.person.persona === "admin") return { classes: null };
  if (context.person.persona === "teacher") return { classes: mentored(context.person.userId) };
  return new Reply(403, { message: "Forbidden.", code: "ABSENCE_STATS_NOT_YOURS" });
}

const mayRead = (who: Reader, classId: string) => who.classes === null || who.classes.has(classId);

const isDate = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The period asked for, or the läsår so far; the gateway's 400 for one that is not a period. */
function period(context: GatewayContext): { from: string; to: string } | Reply {
  const from = context.query.get("from");
  const to = context.query.get("to");
  if ((from !== null && !isDate(from)) || (to !== null && !isDate(to))) {
    return new Reply(400, { message: "Perioden är fel.", code: "ABSENCE_STATS_BAD_PERIOD" });
  }
  const end = to ?? YESTERDAY;
  return { from: from ?? (YEAR_START <= end ? YEAR_START : FIRST_MONTH), to: end };
}

function schoolView(context: GatewayContext): SchoolStatsView | Reply {
  const who = reader(context);
  if (who instanceof Reply) return who;
  // The school is the administrators' alone: a mentor's database arm refuses it.
  if (who.classes !== null) return new Reply(403, { message: "Forbidden.", code: "ABSENCE_STATS_NOT_YOURS" });
  return { window: WINDOW, series: series(1, 2, [], 640) };
}

function classesView(context: GatewayContext): ClassesView | Reply {
  const who = reader(context);
  if (who instanceof Reply) return who;
  const asked = period(context);
  if (asked instanceof Reply) return asked;
  return {
    window: WINDOW,
    period: asked,
    classes: CLASSES.filter((one) => mayRead(who, one.id)).map((one) => {
      const small = one.id === SMALL_CLASS;
      return {
        classId: one.id,
        className: one.name,
        yearName: YEAR_NAME,
        monthsCounted: small ? 0 : 3,
        pupils: small ? 4 : 24,
        pupilsRegistered: small ? 4 : 23,
        figures: small ? null : figures(9000, 270, 180, 15, 3),
        reporting: reporting(300, small ? 120 : 270),
      };
    }),
  };
}

function classView(context: GatewayContext): ClassStatsView | Reply {
  const who = reader(context);
  if (who instanceof Reply) return who;
  const classId = context.params.classId!;
  const found = byId(CLASSES, classId);
  if (!found) return new Reply(404, { message: "Klassen finns inte på skolan.", code: "ABSENCE_STATS_NO_SUCH_CLASS" });
  if (!mayRead(who, classId)) return new Reply(403, { message: "Forbidden.", code: "ABSENCE_STATS_NOT_YOURS" });
  const asked = period(context);
  if (asked instanceof Reply) return asked;
  const small = classId === SMALL_CLASS;
  return {
    window: WINDOW,
    classId,
    series: series(small ? 0.2 : 0.04, small ? MONTHS.length : 2, [found.name], small ? 4 : 24),
    period: asked,
    patterns: small ? SUPPRESSED : PATTERNS,
  };
}

const STUDENTS_OF = (classId: string) => STUDENT_LIST.filter((one) => one.studentGroupId === classId);

/** The huvudman's reader reads sums and never a pupil; the gateway says so before the database is asked. */
function refusesPupils(context: GatewayContext): Reply | null {
  return context.person?.authId === HUVUDMAN_MEMBER.authId
    ? new Reply(403, {
        message: "Huvudmannens läsare ser skolans och klassernas summor, aldrig en enskild elev.",
        code: "ABSENCE_STATS_NO_PUPILS_FOR_THE_READER",
      })
    : null;
}

function classPupils(context: GatewayContext): ClassPupilsView | Reply {
  const refused = refusesPupils(context);
  if (refused) return refused;
  const who = reader(context);
  if (who instanceof Reply) return who;
  const classId = context.params.classId!;
  if (!byId(CLASSES, classId)) return new Reply(404, { message: "Klassen finns inte på skolan.", code: "ABSENCE_STATS_NO_SUCH_CLASS" });
  if (!mayRead(who, classId)) return new Reply(403, { message: "Forbidden.", code: "ABSENCE_STATS_NOT_YOURS" });
  const asked = period(context);
  if (asked instanceof Reply) return asked;
  return {
    window: WINDOW,
    classId,
    period: asked,
    pupils: STUDENTS_OF(classId).map((one, index) => ({
      studentId: one.id,
      firstName: one.firstName,
      lastName: one.lastName,
      // The last pupil of a class has no mark in the period: "ingen registrering", not 0.
      figures: index === STUDENTS_OF(classId).length - 1 ? figures(0, 0, 0, 0, 0) : figures(1000 + index * 100, 50 + index * 10, 100 - index * 20, 15, 1),
    })),
    // An administrator is told how many are left out; a mentor is not.
    heldOut: context.person!.persona === "admin" ? 0 : null,
  };
}

function pupilView(context: GatewayContext): PupilStatsView | Reply {
  const refused = refusesPupils(context);
  if (refused) return refused;
  const who = reader(context);
  if (who instanceof Reply) return who;
  const found = byId(STUDENT_LIST, context.params.studentId!);
  const home = found ? byId(CLASSES, found.studentGroupId ?? "") : undefined;
  if (!found || !home) return new Reply(404, { message: "Eleven finns inte på skolan.", code: "ABSENCE_STATS_NO_SUCH_PUPIL" });
  if (!mayRead(who, home.id)) return new Reply(403, { message: "Forbidden.", code: "ABSENCE_STATS_NOT_YOURS" });
  const asked = period(context);
  if (asked instanceof Reply) return asked;
  // The marks stand from the October of the first year: the months before are "ingen registrering".
  const marksFrom = `${AUTUMN_YEAR - 2}-10-05`;
  const own = MONTHS.map((first, index): PupilMonthView => ({
    month: first,
    figures: first < monthStart(marksFrom) || index % 7 === 6 ? null : figures(1000, 40 + (index % 4) * 10, 20 + (index % 3) * 10, 15, index % 2),
    lessons: first < monthStart(marksFrom) || index % 7 === 6 ? 0 : 30,
    previousYear: null,
  }));
  const months = own.map((row): PupilMonthView => {
    const before = own.find((one) => one.month === shiftMonth(row.month, -12));
    return { ...row, previousYear: before ? { month: before.month, figures: before.figures } : null };
  });
  const rows = months.filter((row) => row.figures !== null);
  const sum = (pick: (one: Figures) => number) => rows.reduce((total, row) => total + pick(row.figures!), 0);
  return {
    window: WINDOW,
    student: {
      id: found.id,
      firstName: found.firstName,
      lastName: found.lastName,
      classId: home.id,
      className: home.name,
      isProtected: false,
    },
    marksFrom,
    marksTo: YESTERDAY,
    months,
    total: figures(
      sum((one) => one.recordedMinutes),
      sum((one) => one.validMinutes),
      sum((one) => one.absentMinutes),
      sum((one) => one.lateMinutes),
      sum((one) => one.lateCount),
    ),
    classSeries: series(0.04, 2, [home.name], 24),
    period: asked,
    patterns: { ...PATTERNS, groupSize: 1 },
  };
}

const windowView = (context: GatewayContext): WindowView | Reply => {
  const who = reader(context);
  return who instanceof Reply ? who : WINDOW;
};

export const absenceStatsRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/absence-stats/window", windowView),
  route("GET", "/api/v1/absence-stats/school", schoolView),
  route("GET", "/api/v1/absence-stats/classes", classesView),
  route("GET", "/api/v1/absence-stats/classes/:classId", classView),
  route("GET", "/api/v1/absence-stats/classes/:classId/pupils", classPupils),
  route("GET", "/api/v1/absence-stats/pupils/:studentId", pupilView),
];
