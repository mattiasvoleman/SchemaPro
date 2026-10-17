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
import type { SchoolUnit } from "../../../lib/school-units";
import type { AcademicYear, LunchSettings, YearRosters } from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { addDays, stockholmInstant, TODAY } from "./calendar";
import { ADMIN, MASTER_LESSONS, NEXT_CLASSES, ROOM_LIST, ROOM_TYPES, ROOMS, SCHOOL, STUDENT_LIST, SUBJECTS, TEACHERS, YEAR } from "./world";

/**
 * The school's own settings and the admin tools that read them: lunch rules,
 * solver runs, gallring, room rules, the year tools' planners and the
 * school's skolenheter. Ids are KIND.misc 9001–9399 and 9501–9599, clear of
 * the other fixture files.
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
 * 7A's week, since moved). The run that laid the grundschema gave up Bo's
 * wish to have Wednesdays free (school-days.ts), which it says in its notes
 * (Lärarens dag, 20261123090100), naming Bo under the sentence as the gateway
 * does at read time for every reader — the sentence itself names only the
 * weekday. The refused runs never laid a week and say none, as the gateway
 * answers them. None is about a post's days, so none names a teacher
 * (conflictSummaryNames, errorNames).
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
    conflictSummaryNames: [],
    conflicts: [],
    notes: [
      {
        category: "AVAILABILITY",
        // The catalogue's English as the gateway stores it: the weekday and
        // nobody's id. Whose wish it was is the name below.
        message:
          "A teacher wishes Wednesdays free, and the new timetable gives them lessons that day. A wish is weighed against the rest of the week and gives way where keeping it would cost more.",
        code: "TEACHER_FREE_DAY_WISH_NOT_KEPT",
        params: { day: 3 },
        resourceNames: [`${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}`],
      },
    ],
    error: null,
    errorCode: null,
    errorParams: null,
    errorNames: [],
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
    conflictSummaryNames: [],
    conflicts: [
      {
        category: "REQUIREMENT_DEMAND",
        message: "The lessons of 6 requirements need 1560 minutes a week, and the week holds 1500.",
        code: "DEMAND_REQUIREMENTS_EXCEED_WEEK",
        params: { requirements: 6, demandMinutes: 1560, capacityMinutes: 1500 },
        resourceNames: ["7A"],
      },
    ],
    notes: [],
    error: null,
    errorCode: null,
    errorParams: null,
    errorNames: [],
    createdAt: ago(10, "10:15"),
    finishedAt: ago(10, "10:16"),
  },
  // Refused before the engine was asked (#144): one of Språkval åk 7's
  // lessons was locked while the rest of the block was still to be placed.
  {
    id: uid(KIND.misc, 9013),
    status: "SUCCEEDED",
    solverStatus: "INFEASIBLE",
    lessonsGenerated: 0,
    conflictSummary:
      "1 block has lessons locked or placed by hand while the rest of the block is still to be placed, and a block's lessons are placed together.",
    conflictSummaryCode: "BLOCK_PARTLY_LOCKED_SUMMARY",
    conflictSummaryParams: { count: 1 },
    conflictSummaryNames: [],
    conflicts: [
      {
        category: "TEACHING_BLOCK",
        message: "Språkval åk 7 has 1 lesson locked or placed by hand while the rest of it is still to be placed.",
        code: "BLOCK_PARTLY_LOCKED",
        params: { block: "Språkval åk 7", locked: 1 },
        resourceNames: ["Språkval åk 7"],
      },
    ],
    notes: [],
    error: null,
    errorCode: null,
    errorParams: null,
    errorNames: [],
    createdAt: ago(11, "08:40"),
    finishedAt: ago(11, "08:40"),
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

/**
 * The school's skolområden (GET /api/v1/sites, 20261124090000): the main
 * house and the sports hall a walk away, ten minutes apart. No room stands on
 * either yet, so the rooms read as they always did and the card says so; the
 * card's travel form is on the page for the a11y gate.
 */
export const SITES = {
  sites: [
    { id: uid(KIND.misc, 9601), name: "Huvudbyggnaden", roomCount: 0 },
    { id: uid(KIND.misc, 9602), name: "Idrottshallen", roomCount: 0 },
  ],
  travelTimes: [{ siteAId: uid(KIND.misc, 9601), siteBId: uid(KIND.misc, 9602), minutes: 10 }],
  roomsWithoutSite: ROOM_LIST.length,
};

/**
 * The school's skolenheter (GET /api/v1/school-units, 20261031090000): one,
 * 7–9, as a högstadieskola is, so every class of the year is in it.
 */
export const SCHOOL_UNITS: SchoolUnit[] = [
  {
    id: uid(KIND.misc, 9501),
    name: "Exempelskolan 7–9",
    code: "12345678",
    schoolTypes: ["GR"],
    gradeFrom: 7,
    gradeTo: 9,
    fromSource: false,
  },
];
