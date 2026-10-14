import type { OptimizationJob, RoomPreference, RoomProposal, Walk } from "../../../lib/queries";
import type {
  GallringRun,
  PurgedBefore,
  RetentionDataType,
  RetentionDecision,
  RetentionKind,
  RetentionOverview,
  RetentionPreview,
} from "../../../lib/retention-types";
import type { AcademicYear, LunchSettings, YearRosters } from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { addDays, stockholmInstant, TODAY } from "./calendar";
import { ADMIN, MASTER_LESSONS, NEXT_CLASSES, ROOM_LIST, ROOM_TYPES, ROOMS, SCHOOL, STUDENT_LIST, SUBJECTS, YEAR } from "./world";

/**
 * The school's own settings and the admin tools that read them: lunch rules,
 * solver runs, gallring, room rules, and the year tools' planners. Ids are
 * KIND.misc 9001–9399, clear of the other fixture files.
 */

/** An instant `days` before today, at a Stockholm wall-clock time: always in the past. */
export const ago = (days: number, time: string) => stockholmInstant(addDays(TODAY, -days), time);

/** The same day of the month, `months` away (the 31st becomes the 1st of the next, as Date does). */
export function addMonths(date: string, months: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCMonth(instant.getUTCMonth() + months);
  return instant.toISOString().slice(0, 10);
}

const ADMIN_NAME = `${ADMIN.firstName} ${ADMIN.lastName}`;

// --- Lunch -------------------------------------------------------------------

/** Wide enough for both servings in school-days.ts (11:40 and 12:10). */
export const LUNCH_SETTINGS: LunchSettings = {
  id: uid(KIND.misc, 9001),
  lunchEnabled: true,
  lunchStartTime: "11:00",
  lunchEndTime: "13:00",
  lunchMinutes: 30,
  diningSeats: 120,
  maxLessonsPerDayPerGroup: 6,
};

// --- Generation ----------------------------------------------------------------

/**
 * This year's runs, newest first: the one that laid today's grundschema, and
 * an earlier one the solver could not satisfy (a requirement too many for
 * 7A's week, since moved).
 */
const YEAR_JOBS: OptimizationJob[] = [
  {
    id: uid(KIND.misc, 9011),
    status: "SUCCEEDED",
    solverStatus: "OPTIMAL",
    lessonsGenerated: MASTER_LESSONS.length,
    conflictSummary: null,
    conflictSummaryCode: null,
    conflictSummaryParams: null,
    conflicts: [],
    error: null,
    errorCode: null,
    errorParams: null,
    createdAt: ago(9, "14:02"),
    finishedAt: ago(9, "14:03"),
  },
  {
    id: uid(KIND.misc, 9012),
    status: "SUCCEEDED",
    solverStatus: "INFEASIBLE",
    lessonsGenerated: 0,
    conflictSummary:
      "No timetable satisfies every rule. Start with the causes below: together they make the week impossible.",
    conflictSummaryCode: "CONFLICT_CORE_SUMMARY",
    conflictSummaryParams: {},
    conflicts: [
      {
        category: "REQUIREMENT_DEMAND",
        message: "The lessons of 6 requirements need 1560 minutes a week, and the week holds 1500.",
        code: "DEMAND_REQUIREMENTS_EXCEED_WEEK",
        params: { requirements: 6, demandMinutes: 1560, capacityMinutes: 1500 },
        resourceNames: ["7A"],
      },
    ],
    error: null,
    errorCode: null,
    errorParams: null,
    createdAt: ago(10, "10:15"),
    finishedAt: ago(10, "10:16"),
  },
];

/** Next year has never been generated. */
export const optimizationJobsFor = (academicYearId: string | null): OptimizationJob[] =>
  academicYearId === YEAR.id ? YEAR_JOBS : [];

export const OPTIMIZATION_JOBS = YEAR_JOBS;

// --- Dataskydd och gallring -------------------------------------------------------

const decision = (
  dataType: RetentionDataType,
  kind: RetentionDecision["decision"],
  months: number | null,
  decidedAt: string,
  reference: string | null,
): RetentionDecision => ({ dataType, decision: kind, months, reference, decidedAt, decidedBy: ADMIN_NAME });

const PLAN = "Dokumenthanteringsplan 2026, avsnitt 4";

const ATTENDANCE_24 = decision("ATTENDANCE", "PURGE_AFTER", 24, ago(41, "10:12"), PLAN);
const LEAVE_KEEP = decision("LEAVE_REQUESTS", "KEEP", null, ago(41, "10:15"), PLAN);
const DEPARTED_36 = decision("DEPARTED_PEOPLE", "PURGE_AFTER", 36, ago(41, "10:20"), PLAN);
/** Decided yesterday afternoon, and it takes more than "ej beslutat": no night takes anything until it is a day old. */
const ABSENCE_12 = decision("ABSENCE_REPORTS", "PURGE_AFTER", 12, ago(1, "15:30"), PLAN);

/** What last night's run left behind for attendance: everything before its cutoff. */
const ATTENDANCE_PURGED = addMonths(addDays(TODAY, -1), -24);

const kind = (dataType: RetentionDataType, extra: Partial<RetentionKind> = {}): RetentionKind => ({
  dataType,
  current: null,
  waitsUntil: null,
  preview: null,
  purgedBefore: null,
  ...extra,
});

const RETENTION_KINDS: RetentionKind[] = [
  kind("ATTENDANCE", {
    current: ATTENDANCE_24,
    preview: { cutoff: addMonths(TODAY, -24), due: 18, held: 0 },
    purgedBefore: ATTENDANCE_PURGED,
  }),
  kind("ABSENCE_REPORTS", {
    current: ABSENCE_12,
    // The first night ("natten mot") a day after the decision.
    waitsUntil: addDays(TODAY, 1),
    preview: { cutoff: addMonths(TODAY, -12), due: 143, held: 0 },
  }),
  kind("LEAVE_REQUESTS", { current: LEAVE_KEEP }),
  kind("NOTIFICATIONS"),
  kind("CHANGE_LOGS"),
  kind("ABSENCE_REASONS"),
  kind("DEPARTED_PEOPLE", {
    current: DEPARTED_36,
    preview: { cutoff: addMonths(TODAY, -36), due: 0, held: 1 },
  }),
];

const nightly = (daysAgo: number, attendance: number): GallringRun => ({
  startedAt: ago(daysAgo, "03:00"),
  finishedAt: ago(daysAgo, "03:01"),
  status: "DONE",
  periods: { ATTENDANCE: 24, DEPARTED_PEOPLE: 36 },
  cutoffs: {
    ATTENDANCE: addMonths(addDays(TODAY, -daysAgo), -24),
    DEPARTED_PEOPLE: addMonths(addDays(TODAY, -daysAgo), -36),
  },
  counts: { ATTENDANCE: attendance, DEPARTED_PEOPLE: 0 },
  complete: { ATTENDANCE: true, DEPARTED_PEOPLE: true },
  // A pupil who left is kept until SCB's underlag has been taken.
  waiting: { DEPARTED_PEOPLE_SCB: 1 },
});

export const RETENTION_OVERVIEW: RetentionOverview = {
  timezone: SCHOOL.timezone,
  nightlyHour: 3,
  kinds: RETENTION_KINDS,
  runs: [nightly(1, 21), nightly(2, 17)],
  // Newest first, the earlier attendance period included: the table is append-only.
  history: [
    ABSENCE_12,
    DEPARTED_36,
    LEAVE_KEEP,
    ATTENDANCE_24,
    decision("ATTENDANCE", "PURGE_AFTER", 36, ago(120, "13:40"), "Dokumenthanteringsplan 2024, avsnitt 4"),
  ],
};

export const PURGED_BEFORE: PurgedBefore[] = RETENTION_KINDS.flatMap((row) =>
  row.purgedBefore ? [{ dataType: row.dataType, purgedBefore: row.purgedBefore }] : [],
);

/** What a period would take tonight: fewer rows the longer it is, never a guess at zero. */
export const retentionPreview = (months: number): RetentionPreview => ({
  cutoff: addMonths(TODAY, -months),
  due: Math.max(3, Math.round(480 / months)),
  held: 0,
});

// --- Room rules ------------------------------------------------------------------

/** They agree with the grundschema in world.ts, so the timetable shows no broken lock. */
export const ROOM_PREFERENCES: RoomPreference[] = [
  {
    id: uid(KIND.misc, 9031),
    subjectId: SUBJECTS.idh.id,
    kind: "LOCK",
    minGradeLevel: null,
    maxGradeLevel: null,
    roomTypeId: null,
    // A lock never reaches the objective; this is the column default.
    weight: 5,
    rooms: [{ roomId: ROOMS.gym.id }],
  },
  {
    id: uid(KIND.misc, 9032),
    subjectId: SUBJECTS.sv.id,
    kind: "WISH",
    minGradeLevel: 7,
    maxGradeLevel: 7,
    roomTypeId: null,
    weight: 3,
    rooms: [{ roomId: ROOMS.r101.id }, { roomId: ROOMS.r102.id }],
  },
  {
    id: uid(KIND.misc, 9033),
    subjectId: SUBJECTS.ma.id,
    kind: "WISH",
    minGradeLevel: 9,
    maxGradeLevel: 9,
    roomTypeId: ROOM_TYPES[0]!.id,
    weight: 8,
    rooms: [],
  },
];

/**
 * "Optimera salar", asked for with a button: the grundschema in world.ts
 * already keeps each class in its own room, so the solver finds nothing to
 * move and says how much walking there is.
 */
export function roomProposal(academicYearId: string): RoomProposal {
  const teachers: Walk = { roomChanges: 5, floorChanges: 2, buildingChanges: 1 };
  const groups: Walk = { roomChanges: 4, floorChanges: 1, buildingChanges: 1 };
  return {
    status: "OPTIMAL",
    basis: `stub-rooms-${academicYearId}`,
    changes: [],
    teachers: { before: teachers, after: teachers },
    groups: { before: groups, after: groups },
    missedWishes: { before: 0, after: 0 },
    walkers: [],
    frozenLessonIds: [],
    roomsTotal: ROOM_LIST.length,
    roomsWithoutFloor: ROOM_LIST.filter((room) => room.floor === null).length,
  };
}

// --- The year tools ----------------------------------------------------------------

/**
 * Next year's classes, as gateway-family.ts's activation preview names them:
 * each class promoted a grade, 9A graduating. Not PostgREST rows yet.
 */
const NEXT_CLASS_OF: Record<string, string> = Object.fromEntries(
  Object.entries(NEXT_CLASSES).map(([from, to]) => [from, to.id]),
);

/**
 * GET /academic-years/:id/rosters. Next year is rolled from the active one and
 * its activation moves every pupil, so its rosters are PROJECTED: the class
 * each pupil gets, null for 9A, who graduate. The active year's rows are its
 * rosters (the pages never ask for it; answered anyway).
 */
export function yearRosters(year: AcademicYear): YearRosters {
  if (year.isActive) {
    return {
      academicYearId: year.id,
      basis: "CURRENT",
      homeClasses: [],
      counts: { moved: 0, graduates: 0, unplaced: 0 },
      membershipsOutOfDate: { missing: 0, stale: 0 },
    };
  }
  const homeClasses = STUDENT_LIST.filter((pupil) => pupil.isActive && pupil.studentGroupId !== null)
    .map((pupil) => ({ studentId: pupil.id, studentGroupId: NEXT_CLASS_OF[pupil.studentGroupId!] ?? null }))
    .sort((a, b) => a.studentId.localeCompare(b.studentId));
  const graduates = homeClasses.filter((row) => row.studentGroupId === null).length;
  return {
    academicYearId: year.id,
    basis: "PROJECTED",
    homeClasses,
    counts: { moved: homeClasses.length - graduates, graduates, unplaced: 0 },
    // The same notice the activation preview gives: one pupil's teaching groups were set before they changed class.
    membershipsOutOfDate: { missing: 1, stale: 0 },
  };
}
