/**
 * Vad kom in, as the page sees it: the gateway's answer (src/intake/intake.ts) and the one thing the page adds, where each gap is
 * mended. The rules (what is a gap and how hard) are the gateway's; the web gives each its words (messages: intake) and the page that
 * owns it. A code the gateway has that this table has not is shown with no link rather than dropped (see `ownerOf`).
 *
 * A module of its own and not lib/queries.ts, which is in every route's chunk (bundle-gate-measurement): the page alone loads it.
 */

export type IntakeLevel = "HARD" | "SOFT" | "INFO";

export interface IntakeGap {
  code: string;
  level: IntakeLevel;
  /** How many there are; 0 when the gap is not there. A presence gap (no rooms) is 1 or 0. */
  count: number;
  /** The first of them by name (a class, a subject) or as a number (an årskurs), at most eight. */
  items: string[];
  /** How many more than `items` lists. */
  more: number;
}

export interface IntakeArea {
  area: string;
  found: Record<string, number>;
  /** True for a year-bound area of a school with no active läsår: nothing is counted for it, so the page says it waits, not that nothing is missing. */
  waitsForYear: boolean;
  gaps: IntakeGap[];
}

export interface IntakeView {
  year: { id: string; name: string; isActive: boolean } | null;
  areas: IntakeArea[];
  /** The gaps there are, by level. `hard` is what stops Generera. */
  hard: number;
  soft: number;
  info: number;
}

/** The gaps whose items are årskurser as numbers, written "åk 9"; every other gap's items are names. */
export const GRADE_GAPS: ReadonlySet<string> = new Set(["FRAME_TIMES_MISSING", "TIMPLAN_MISSING", "TIMPLAN_NOT_DECIDED"]);

/** The page that owns a gap, and the menu row's key in messages `nav` that names it. */
export interface GapOwner {
  href: string;
  navKey: string;
}

const OWNER = {
  setup: { href: "/admin/setup", navKey: "setup" },
  subjects: { href: "/admin/subjects", navKey: "subjects" },
  rooms: { href: "/admin/rooms", navKey: "rooms" },
  frameTimes: { href: "/admin/frame-times", navKey: "frameTimes" },
  rasts: { href: "/admin/rasts", navKey: "rasts" },
  groups: { href: "/admin/groups", navKey: "groups" },
  people: { href: "/admin/people", navKey: "people" },
  timplan: { href: "/admin/timplan", navKey: "timplan" },
  requirements: { href: "/admin/requirements", navKey: "requirements" },
  staffing: { href: "/admin/staffing", navKey: "staffing" },
  breaks: { href: "/admin/breaks", navKey: "breaks" },
  // The lunch card stays on tillgänglighet: the hall's size and the break's length, one row for the school.
  lunch: { href: "/admin/constraints", navKey: "constraints" },
  supervision: { href: "/admin/supervision", navKey: "supervision" },
  absenceWatch: { href: "/admin/absence-watch", navKey: "absenceWatch" },
  acknowledgements: { href: "/admin/acknowledgements", navKey: "acknowledgements" },
  schemavisaren: { href: "/admin/schemavisaren", navKey: "schemavisaren" },
  // Sjukanmälan by a teacher themselves is a switch of the cover settings, which the absence page opens.
  teacherAbsence: { href: "/admin/teacher-absence", navKey: "teacherAbsence" },
} as const satisfies Record<string, GapOwner>;

const OWNER_OF_GAP: Readonly<Record<string, GapOwner>> = {
  NO_YEAR: OWNER.setup,
  NO_SUBJECTS: OWNER.subjects,
  SUBJECTS_WITHOUT_POSTS: OWNER.requirements,
  // The room type is a room's, and the subject names it: the rooms are where it is mended first.
  ROOM_TYPE_WITHOUT_ROOM: OWNER.rooms,
  NO_ROOMS: OWNER.rooms,
  NO_ROOM_TYPES: OWNER.rooms,
  FRAME_TIMES_MISSING: OWNER.frameTimes,
  NO_RASTS: OWNER.rasts,
  NO_BREAKS: OWNER.breaks,
  LUNCH_OFF: OWNER.lunch,
  NO_SUPERVISION: OWNER.supervision,
  NO_CLASSES: OWNER.groups,
  CLASSES_WITHOUT_GRADE: OWNER.groups,
  CLASSES_WITHOUT_POSTS: OWNER.requirements,
  TEACHING_GROUPS_WITHOUT_MEMBERS: OWNER.groups,
  NO_TEACHERS: OWNER.people,
  NO_STUDENTS: OWNER.people,
  STUDENTS_WITHOUT_CLASS: OWNER.people,
  TIMPLAN_MISSING: OWNER.timplan,
  TIMPLAN_NOT_DECIDED: OWNER.timplan,
  NO_REQUIREMENTS: OWNER.requirements,
  UNSTAFFED_POSTS: OWNER.staffing,
  TEACHERS_WITHOUT_POST: OWNER.staffing,
  POSTS_WITHOUT_SIGNATURE: OWNER.staffing,
  ABSENCE_WATCH_OFF: OWNER.absenceWatch,
  ACK_OFF: OWNER.acknowledgements,
  VIEWER_OFF: OWNER.schemavisaren,
  SICK_REPORT_OFF: OWNER.teacherAbsence,
};

/** The page that owns the gap, or null for a code this table does not know (a newer gateway). */
export function ownerOf(code: string): GapOwner | null {
  return OWNER_OF_GAP[code] ?? null;
}

/** The gap codes this table knows, for the test that holds it to the gateway's definitions. */
export const KNOWN_GAP_CODES: readonly string[] = Object.keys(OWNER_OF_GAP);
