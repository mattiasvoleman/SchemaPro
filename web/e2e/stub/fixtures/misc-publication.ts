import type { ScheduleVersion, VersionLesson } from "../../../lib/queries";
import type {
  BatchLesson,
  CancellationBatch,
  CancellationPreview,
  CancellationSelection,
  DraftLesson,
  DraftState,
  GateItem,
  PublicationPreview,
  PublicationRow,
  PublicationSettings,
  PublicationTimeline,
  PublicLink,
  ReversePreview,
  ValiditySegment,
} from "../../../lib/publication-types";
import type { AcademicYear, MasterLesson } from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { addDays, isoWeekday, mondayOf, NOW, stockholmInstant, THIS_MONDAY, TODAY } from "./calendar";
import { ago } from "./misc-school";
import {
  ADMIN,
  byId,
  CALENDAR_LESSONS,
  GROUP_LIST,
  GROUPS,
  GUARDIAN_LINKS,
  MASTER_LESSONS,
  ROOMS,
  STUDENT_LIST,
  SUBJECT_LIST,
  SUBJECTS,
  TEACHERS,
  YEAR,
} from "./world";

/**
 * Publicering for Exempelskolan: utkastläge, a timetable published before
 * the term, a starting point when the school switched to drafts, one refused
 * attempt and the publish that followed it. The grundschema in world.ts is
 * the draft, five changes ahead of what is published. Ids are KIND.misc
 * 9101–9199.
 */

export const PUBLICATION_SETTINGS: PublicationSettings = {
  publishMode: "DRAFT",
  stored: true,
  // Schemavisaren is on for classes and teachers, as gateway-public.ts's share link needs.
  publicViewerEnabled: true,
  publicGroups: true,
  publicTeachers: true,
  publicRooms: false,
  publicTeacherDisplay: "NAME",
  publicShowMeals: true,
  publicMinGroupSize: 5,
  // The school's website frames the classes' weeks (Utskrift och inbäddning); the teachers' stay off it.
  publicEmbedGroups: true,
  publicEmbedTeachers: false,
  publicEmbedRooms: false,
  publicEmbedOrigins: ["https://www.exempelskolan.example"],
  // Kalenderprenumeration: on for teachers and guardians, off for pupils (gateway-misc.ts answers the feeds).
  calendarFeedTeachers: true,
  calendarFeedStudents: false,
  calendarFeedGuardians: true,
  gateClashes: "REFUSE",
  gateParked: "WARN",
  gateUnplaced: "WARN",
  gateUnstaffed: "WARN",
  gateMissingTeacher: "WARN",
  gateMissingRoom: "WARN",
  gateStaffing: "WARN",
  gateTimplan: "WARN",
  gateOverlap: "WARN",
  gatePast: "REFUSE",
  gateLunch: "WARN",
  gateWeekSplit: "WARN",
  gateGap: "WARN",
  gateDayOpsLost: "WARN",
  gateEmptyHalf: "WARN",
  gateOtherSchool: "WARN",
};

// --- Lessons as the gateway names them ----------------------------------------------

const WEEKDAY = ["", "mån", "tis", "ons", "tors", "fre", "lör", "sön"];
const clock = (time: string) => time.slice(0, 5);
const master = (n: number) => MASTER_LESSONS.find((lesson) => lesson.id === uid(KIND.masterLesson, n))!;
const subjectName = (id: string) => byId(SUBJECT_LIST, id)?.name ?? "?";
const groupName = (id: string) => byId(GROUP_LIST, id)?.name ?? "?";

/** "Bild · 8A, fre 10:40–12:00", as publication-gates.reader.ts labels a lesson. */
const gateLabel = (lesson: MasterLesson) =>
  `${subjectName(lesson.subjectId)} · ${groupName(lesson.studentGroupId)}, ${WEEKDAY[lesson.dayOfWeek]} ${clock(lesson.startTime)}–${clock(lesson.endTime)}`;

/** 8A's Bild: parked, and without a teacher. */
const BILD_8A = master(13);

const gate = (code: GateItem["code"], severity: GateItem["severity"], lessons: MasterLesson[]): GateItem => ({
  code,
  severity,
  count: lessons.length,
  items: lessons.map((lesson) => ({ label: gateLabel(lesson), masterLessonId: lesson.id })),
  params: {},
});

const draftLesson = (lesson: MasterLesson): DraftLesson => ({
  id: lesson.id,
  subjectId: lesson.subjectId,
  studentGroupId: lesson.studentGroupId,
  teacherId: lesson.teacherId,
  coTeacherId: lesson.coTeacherId,
  roomId: lesson.roomId,
  dayOfWeek: lesson.dayOfWeek,
  startTime: clock(lesson.startTime),
  endTime: clock(lesson.endTime),
  isParked: lesson.isParked,
});

// --- Which timetable is valid when ------------------------------------------------------

/**
 * The Monday the school switched to drafts: three weeks back, kept a fortnight
 * inside the läsår at either end so the three segments below always fit it.
 */
const SWITCH = (() => {
  const earliest = mondayOf(addDays(YEAR.startDate, 14));
  const latest = mondayOf(addDays(YEAR.endDate, -14));
  const wanted = addDays(THIS_MONDAY, -21);
  return wanted < earliest ? earliest : wanted > latest ? latest : wanted;
})();
/** The Monday after it, from which the draft's first publish is valid. */
const DRAFT_FROM = addDays(SWITCH, 7);

const publication = (n: number, extra: Partial<PublicationRow>): PublicationRow => ({
  id: uid(KIND.misc, n),
  kind: "PUBLISH",
  outcome: "PUBLISHED",
  publishMode: "DRAFT",
  validFrom: DRAFT_FROM,
  validTo: YEAR.endDate,
  publishedAt: "",
  publishedByUserId: ADMIN.id,
  created: 0,
  cancelled: 0,
  skipped: 0,
  moved: 0,
  removed: 0,
  adopted: 0,
  lessonCount: MASTER_LESSONS.length - 1,
  gates: [],
  acknowledgedWarnings: false,
  ...extra,
});

/** In the order they were laid down, as the timeline sends them. */
const PUBLICATIONS: PublicationRow[] = [
  publication(9101, {
    publishMode: "DIRECT",
    validFrom: YEAR.startDate,
    publishedAt: stockholmInstant(addDays(YEAR.startDate, -4), "15:20"),
    created: 431,
    gates: [gate("PUB_PARKED", "WARN", [BILD_8A])],
    acknowledgedWarnings: true,
  }),
  // The starting point utkastläge wrote: what was published, adopted as it stood.
  publication(9102, {
    kind: "BASELINE",
    validFrom: SWITCH,
    publishedAt: stockholmInstant(addDays(SWITCH, -3), "16:05"),
    adopted: MASTER_LESSONS.length - 1,
  }),
  publication(9103, {
    outcome: "REFUSED",
    publishedAt: stockholmInstant(addDays(SWITCH, 2), "10:30"),
    lessonCount: null,
    gates: [gate("PUB_CLASHES", "REFUSE", [master(12)]), gate("PUB_PARKED", "WARN", [BILD_8A])],
  }),
  publication(9104, {
    publishedAt: stockholmInstant(addDays(SWITCH, 3), "13:45"),
    created: 6,
    moved: 2,
    removed: 1,
    gates: [gate("PUB_PARKED", "WARN", [BILD_8A]), gate("PUB_NO_TEACHER", "WARN", [BILD_8A])],
    acknowledgedWarnings: true,
  }),
];

/** effectiveSegments of the three that published, worked out by hand. */
const SEGMENTS: ValiditySegment[] = [
  { publicationId: uid(KIND.misc, 9101), from: YEAR.startDate, to: addDays(SWITCH, -1) },
  { publicationId: uid(KIND.misc, 9102), from: SWITCH, to: addDays(DRAFT_FROM, -1) },
  { publicationId: uid(KIND.misc, 9104), from: DRAFT_FROM, to: YEAR.endDate },
];

/** Next year has never been published. */
export function publicationTimeline(year: AcademicYear): PublicationTimeline {
  const segments = year.id === YEAR.id ? SEGMENTS : [];
  return {
    academicYearId: year.id,
    today: TODAY,
    publications: year.id === YEAR.id ? PUBLICATIONS : [],
    segments,
    validNow: segments.find((segment) => segment.from <= TODAY && TODAY <= segment.to)?.publicationId ?? null,
  };
}

/**
 * The grundschema against what is published: 9A's co-taught Matematik and
 * Språkval åk 7's two lessons are new, 7B's Matematik moved from Thursday to
 * Tuesday, and a Friday Engelska for 7B is gone.
 */
export function draftState(year: AcademicYear): DraftState {
  if (year.id !== YEAR.id) {
    return { academicYearId: year.id, publishMode: "DRAFT", publicationId: null, added: [], changed: [], removed: [], pendingRemovals: 0 };
  }
  const moved = draftLesson(master(10));
  return {
    academicYearId: year.id,
    publishMode: "DRAFT",
    publicationId: uid(KIND.misc, 9104),
    added: [draftLesson(master(12)), draftLesson(master(14)), draftLesson(master(15))],
    changed: [{ before: { ...moved, dayOfWeek: 4, startTime: "10:40", endTime: "11:40" }, after: moved }],
    removed: [
      {
        id: uid(KIND.masterLesson, 90),
        subjectId: SUBJECTS.en.id,
        studentGroupId: GROUPS.g7B.id,
        teacherId: TEACHERS.anna.id,
        coTeacherId: null,
        roomId: ROOMS.r102.id,
        dayOfWeek: 5,
        startTime: "08:10",
        endTime: "09:10",
        isParked: false,
      },
    ],
    pendingRemovals: 0,
  };
}

const weeksIn = (from: string, to: string) =>
  Math.max(0, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000)) + 1);

/** The dry run of a publish: the draft's five changes, week after week, and the two warnings on 8A's Bild. */
export function publicationPreview(window: { academicYearId: string; validFrom: string; validTo: string }): PublicationPreview {
  const digest = `stub-${window.academicYearId}-${window.validFrom}-${window.validTo}`;
  const base = { academicYearId: window.academicYearId, publishMode: "DRAFT" as const, validFrom: window.validFrom, validTo: window.validTo, digest };
  if (window.academicYearId !== YEAR.id) {
    return {
      ...base,
      result: { created: 0, cancelled: 0, skipped: 0, fromDate: window.validFrom, toDate: window.validTo },
      gates: [{ code: "PUB_NOTHING_TO_PUBLISH", severity: "REFUSE", count: 1, items: [], params: {} }],
      refused: true,
      needsAcknowledgement: false,
    };
  }
  const weeks = weeksIn(window.validFrom, window.validTo);
  const fromInPast = window.validFrom < TODAY;
  return {
    ...base,
    result: { created: 4 * weeks, cancelled: 0, skipped: 0, fromDate: window.validFrom, toDate: window.validTo },
    draft: { moved: weeks, removed: weeks, adopted: 0, cancelledByMove: 0, cancelledByBatch: 0 },
    gates: [
      gate("PUB_PARKED", "WARN", [BILD_8A]),
      gate("PUB_NO_TEACHER", "WARN", [BILD_8A]),
      ...(isoWeekday(window.validFrom) !== 1 ? [gate("PUB_WEEK_SPLIT", "WARN", [master(10)])] : []),
      ...(fromInPast ? [{ code: "PUB_FROM_IN_PAST" as const, severity: "REFUSE" as const, count: 1, items: [], params: {} }] : []),
    ],
    refused: fromInPast,
    needsAcknowledgement: !fromInPast,
  };
}

// --- Schemavisaren ------------------------------------------------------------------------

const link = (n: number, extra: Partial<PublicLink> & Pick<PublicLink, "kind">): PublicLink => ({
  id: uid(KIND.misc, n),
  academicYearId: YEAR.id,
  targetId: null,
  label: null,
  createdAt: ago(40, "09:12"),
  revokedAt: null,
  lastUsedAt: null,
  notShownBecause: null,
  // A class link may be framed on the school's website (PUBLICATION_SETTINGS), a teacher's and a room's not.
  embeddable: extra.kind === "GROUP" && !extra.revokedAt && !extra.notShownBecause,
  ...extra,
});

export const PUBLIC_LINKS: PublicLink[] = [
  // The one gateway-public.ts serves: every class, for the guardians.
  link(9111, { kind: "GROUP", label: "Klasserna, för vårdnadshavare", lastUsedAt: ago(1, "19:40") }),
  link(9112, { kind: "GROUP", targetId: GROUPS.g7A.id, label: "7A på klassens sida", createdAt: ago(30, "08:05"), lastUsedAt: ago(2, "07:15") }),
  // David asked not to be named outside SchemaPro, so his link answers nothing.
  link(9113, { kind: "TEACHER", targetId: TEACHERS.david.id, label: "Idrottsschemat", createdAt: ago(25, "13:30"), notShownBecause: "TEACHER_HIDDEN" }),
  link(9114, { kind: "ROOM", label: "Skärmen i entrén", createdAt: ago(60, "11:00"), revokedAt: ago(20, "15:45"), lastUsedAt: ago(21, "12:02") }),
];

/** Teachers the viewer never names (TeacherPublicLabels.hidden). */
export const HIDDEN_TEACHERS: string[] = [TEACHERS.david.id];

// --- Versioner ------------------------------------------------------------------------------

const versionLesson = (lesson: MasterLesson): VersionLesson => ({
  subjectId: lesson.subjectId,
  studentGroupId: lesson.studentGroupId,
  teacherId: lesson.teacherId,
  coTeacherId: lesson.coTeacherId,
  roomId: lesson.roomId,
  dayOfWeek: lesson.dayOfWeek,
  startTime: lesson.startTime,
  endTime: lesson.endTime,
  isLocked: lesson.isLocked,
  isParked: lesson.isParked,
  extraGroupIds: lesson.extraGroupIds,
  studentIds: lesson.studentIds,
  recurrence: lesson.recurrence,
  startDate: lesson.startDate,
  endDate: lesson.endDate,
});

/** Newest first: one the gateway saved on its own, one an admin named. */
export const SCHEDULE_VERSIONS: Array<ScheduleVersion & { lessons: VersionLesson[] }> = [
  {
    id: uid(KIND.misc, 9121),
    academicYearId: YEAR.id,
    name: "Före salsoptimering",
    lessonCount: MASTER_LESSONS.length,
    createdAt: ago(8, "09:40"),
    lessons: MASTER_LESSONS.map(versionLesson),
  },
  {
    // Before 7B's Matematik moved to Tuesday.
    id: uid(KIND.misc, 9122),
    academicYearId: YEAR.id,
    name: "Inför höstterminen",
    lessonCount: MASTER_LESSONS.length,
    createdAt: ago(45, "16:20"),
    lessons: MASTER_LESSONS.map((lesson) =>
      lesson.id === master(10).id
        ? { ...versionLesson(lesson), dayOfWeek: 4, startTime: "10:40:00", endTime: "11:40:00" }
        : versionLesson(lesson),
    ),
  },
];

// --- Bulk avbokning ---------------------------------------------------------------------------

const inYear = (date: string) => (date < YEAR.startDate ? YEAR.startDate : date > YEAR.endDate ? YEAR.endDate : date);

const batch = (n: number, extra: Partial<CancellationBatch> & Pick<CancellationBatch, "name" | "fromDate">): CancellationBatch => ({
  id: uid(KIND.misc, n),
  cause: "EVENT",
  toDate: extra.fromDate,
  startTime: null,
  endTime: null,
  scope: "SCHOOL",
  minGradeLevel: null,
  maxGradeLevel: null,
  groupIds: [],
  cancelled: 0,
  createdAt: ago(10, "10:00"),
  createdByUserId: ADMIN.id,
  reversedAt: null,
  reinstated: 0,
  skippedRoomTaken: 0,
  credits: 0,
  addedSince: 0,
  notifies: false,
  ...extra,
});

const PRAO_FROM = inYear(addDays(THIS_MONDAY, 14));
const FRILUFTSDAG = inYear(addDays(THIS_MONDAY, -12));
const BRANDOVNING = inYear(addDays(THIS_MONDAY, -26));

/** Newest first. 8A's prao week is ahead; the friluftsdag and the fire drill are behind. */
export const CANCELLATION_BATCHES: CancellationBatch[] = [
  batch(9131, {
    name: "Prao 8A",
    fromDate: PRAO_FROM,
    toDate: inYear(addDays(PRAO_FROM, 4)),
    scope: "GROUPS",
    groupIds: [GROUPS.g8A.id],
    cancelled: 1,
    createdAt: ago(3, "14:10"),
    notifies: true,
  }),
  batch(9132, {
    name: "Friluftsdag åk 7",
    fromDate: FRILUFTSDAG,
    startTime: "08:10",
    endTime: "13:00",
    scope: "GRADES",
    minGradeLevel: 7,
    maxGradeLevel: 7,
    cancelled: 6,
    credits: 2,
    createdAt: stockholmInstant(addDays(FRILUFTSDAG, -7), "11:25"),
    notifies: true,
  }),
  batch(9133, {
    name: "Brandövning",
    cause: "MANUAL",
    fromDate: BRANDOVNING,
    startTime: "10:40",
    endTime: "11:40",
    cancelled: 4,
    createdAt: stockholmInstant(addDays(BRANDOVNING, -3), "08:30"),
    // Taken back the same day it was made: the drill was moved to a rast.
    reversedAt: stockholmInstant(addDays(BRANDOVNING, -3), "12:15"),
    reinstated: 3,
    skippedRoomTaken: 1,
  }),
];

export const reversePreview = (batch: CancellationBatch): ReversePreview => ({
  reinstate: batch.cancelled,
  notify: batch.notifies ? 14 : 0,
  skippedRoomTaken: [],
  removedTemplateMoved: [],
  notReinstatable: 0,
  creditsDeleted: batch.credits,
});

/**
 * What a selection would cancel among this week's published lessons (the
 * only dated ones world.ts has), counted the way the gateway counts: started
 * lessons and ones already cancelled are left and said so.
 */
export function cancellationPreview(selection: CancellationSelection): CancellationPreview {
  const groups = GROUP_LIST.filter((group) => group.academicYearId === selection.academicYearId);
  const inScope = (groupId: string) => {
    if (selection.scope === "GROUPS") return (selection.groupIds ?? []).includes(groupId);
    if (selection.scope === "SCHOOL") return true;
    const grade = byId(groups, groupId)?.gradeLevel ?? null;
    return grade !== null && grade >= (selection.minGradeLevel ?? 0) && grade <= (selection.maxGradeLevel ?? 99);
  };
  const inWindow = (masterLessonId: string) => {
    if (!selection.startTime || !selection.endTime) return true;
    const lesson = byId(MASTER_LESSONS, masterLessonId);
    return lesson !== null && clock(lesson.startTime) < selection.endTime && clock(lesson.endTime) > selection.startTime;
  };
  const touched = CALENDAR_LESSONS.filter(
    (lesson) =>
      lesson.academicYearId === selection.academicYearId &&
      lesson.date >= selection.fromDate &&
      lesson.date <= selection.toDate &&
      inScope(lesson.studentGroupId) &&
      inWindow(lesson.masterLessonId),
  );
  const now = NOW;
  const started = touched.filter((lesson) => lesson.status === "SCHEDULED" && lesson.startsAt <= now);
  const matched = touched.filter((lesson) => lesson.status === "SCHEDULED" && lesson.startsAt > now);
  const lessons: BatchLesson[] = matched.slice(0, 50).map((lesson) => ({
    id: lesson.id,
    date: lesson.date,
    startsAt: lesson.startsAt,
    endsAt: lesson.endsAt,
    subjectName: subjectName(lesson.subjectId),
    groupName: groupName(lesson.studentGroupId),
  }));
  // Whole school days ahead of today, and only for a selection without a time window.
  const creditDates: string[] = [];
  if (!selection.startTime) {
    for (let date = selection.fromDate; date <= selection.toDate && creditDates.length < 31; date = addDays(date, 1)) {
      if (date > TODAY && isoWeekday(date) <= 5) creditDates.push(date);
    }
  }
  const groupIds = new Set(matched.map((lesson) => lesson.studentGroupId));
  const pupils = STUDENT_LIST.filter((pupil) => pupil.studentGroupId !== null && groupIds.has(pupil.studentGroupId));
  const teachers = new Set(
    matched.flatMap((lesson) => {
      const source = byId(MASTER_LESSONS, lesson.masterLessonId);
      return [source?.teacherId, source?.coTeacherId].filter((id): id is string => Boolean(id));
    }),
  );
  return {
    matched: matched.length,
    lessons,
    excluded: {
      started: started.length,
      notScheduled: touched.filter((lesson) => lesson.status !== "SCHEDULED").length,
      attendance: 0,
    },
    ungradedGroups:
      selection.scope === "GRADES" ? groups.filter((group) => group.gradeLevel === null).map((group) => group.name) : [],
    creditDates,
    digest: `stub-${selection.academicYearId}-${selection.scope}-${selection.fromDate}-${selection.toDate}`,
    audience: {
      pupils: pupils.length,
      guardians: new Set(GUARDIAN_LINKS.filter((row) => pupils.some((pupil) => pupil.id === row.studentId)).map((row) => row.guardianId)).size,
      teachers: teachers.size,
    },
  };
}
