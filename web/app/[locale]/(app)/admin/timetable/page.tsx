"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  Download,
  History,
  Lock,
  LockOpen,
  FileText,
  Footprints,
  Plus,
  Printer,
  Redo2,
  Trash2,
  TriangleAlert,
  UtensilsCrossed,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  useConstraints,
  useCreateMasterLesson,
  useDeleteMasterLesson,
  useGroups,
  useMasterLessons,
  usePeople,
  useLunchSettings,
  usePublishSchedule,
  useRequirements,
  useRooms,
  useSubjects,
  useUpdateMasterLesson,
  type CreateMasterLessonInput,
  useGroupMemberships,
  useFrameTimes,
  useLunchSittings,
  useLunchSittingMutations,
  useRoomPreferences,
  useRasts,
} from "@/lib/queries";
/*
 * The two exports are imported where they are pressed, not here. Neither is
 * needed to SHOW the week — the school asks for a file — and between them they
 * are 264 lines this route pays for on load. lib/pdf.ts already reasons this
 * way about jspdf inside its own export function; this moves the wrapper the
 * same distance.
 */
import { useTimetableRealtime } from "@/lib/use-timetable-realtime";
import { usePlanningYear } from "@/lib/planning-year";
import { withProjectedHomes } from "@/lib/projected-rosters";
import {
  PlanningYearPicker,
  ProjectedRostersBanner,
} from "@/components/schedule/planning-year";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { refusalText, savedToast, staffingRefusal } from "@/lib/staffing-warnings";
import { FilterPicker } from "@/components/schedule/filter-picker";
/*
 * Fetched when the school asks to optimise rooms, not when the page loads.
 *
 * This page carries the most JavaScript in the app, and the dialog is the one
 * part of it a school opens rarely: a grundschema is set once a term, and the
 * rooms are redistributed after that. Its code took the route's own initial JS
 * from 190.1KB to 191.9KB gzipped, past the 190KB admin budget — the same
 * reasoning lib/pdf.ts already applies to jspdf, which it imports inside the
 * export function rather than at the top of the module.
 *
 * React's own lazy(), not next/dynamic — here and for the two splits below.
 * next/dynamic brings its loader runtime (BailoutToCSR, PreloadChunks,
 * loadable) into the route, 1.4KB gzipped, most of what the splits save; and
 * once the people page stopped sharing that runtime it sat in a chunk of its
 * own here and compressed worse, 190.0 -> 190.1KB, past the budget by the
 * decimal. React is in every route already, so lazy() costs nothing on top.
 * No lazy component is reachable during SSR: every *Used latch below
 * (confirm, edit, create, suggest, versions, rooms, publish) is false at first
 * render, and each lazy dialog is mounted only behind its latch.
 */
const RoomOptimizationDialog = lazy(() =>
  import("@/components/schedule/room-optimization-dialog").then((module) => ({
    default: module.RoomOptimizationDialog,
  })),
);
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
/*
 * Fetched the first time Versioner is pressed, like the room optimisation
 * dialog above and for its reason: the version diff is most of the dialog's
 * code, and nothing on the grid needs it (see versions-dialog.tsx).
 */
const VersionsDialog = lazy(() =>
  import("@/components/schedule/versions-dialog").then((module) => ({
    default: module.VersionsDialog,
  })),
);
/*
 * The lesson dialogs — Lägg till, Justera, Publicera and the shared-move and
 * placement questions after a drag — fetched as one chunk right after the page
 * mounts (see components/schedule/lesson-dialogs.ts for why one). Justera,
 * Publicera and the two questions used to be written out at the bottom of this
 * page; with them went the route's whole copy of @radix-ui/react-dialog, the
 * Switch and the date picker, none of which the grid draws on load. The two
 * draft types are imported as types only, which brings no code with them.
 */
const loadLessonDialogs = () => import("@/components/schedule/lesson-dialogs");
/*
 * Made by a function, and made again when one fails: lazy() keeps a rejected
 * fetch for good and rethrows it on every later render, so retrying a chunk
 * that did not arrive takes new lazy() wrappers (see lessonDialogsFailed in the
 * page). Kept at module level between failures so a later visit in the same
 * tab renders the already resolved ones without suspending.
 */
const lazyLessonDialogs = () => ({
  CreateLessonDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.CreateLessonDialog })),
  ),
  LessonEditDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.LessonEditDialog })),
  ),
  PublishDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.PublishDialog })),
  ),
  SharedMoveDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.SharedMoveDialog })),
  ),
  SuggestPlacementsDialog: lazy(() =>
    loadLessonDialogs().then((module) => ({ default: module.SuggestPlacementsDialog })),
  ),
});
let lessonDialogs = lazyLessonDialogs();
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import type { CreateDraft } from "@/components/schedule/create-lesson-dialog";
import type { LessonEditDraft } from "@/components/schedule/lesson-edit-dialog";
import type { LessonRecurrence, MasterLesson, StaffingWarning } from "@/lib/types";
import { cn, subjectColor, timeToMinutes } from "@/lib/utils";
import { rastWindows } from "@/lib/rasts";
import {
  audienceFor,
  buildRosterIndex,
  homeClassesReached,
  showsFraction,
  type Audience,
} from "@/lib/lesson-audience";
import {
  buildGroupConflictMap,
  buildPupilBufferMap,
  detectConflicts,
  pupilBufferOf,
  teacherIdsOf,
  toPlacement,
  validatePlacement,
  type Placement,
} from "@/lib/conflicts";
import type { OpenSlotMatch, PlacementSuggestion } from "@/lib/placement-search";
import { buildGradeSpans } from "@/lib/grade-span";
import { restorableInput } from "@/lib/lesson-restore";
import { breaksRoomLock } from "@/lib/room-locks";
import {
  useHistoryKeyboard,
  useScheduleHistory,
} from "@/lib/use-schedule-history";
import { PageHeader } from "@/components/layout/page-header";
import {
  TimetableGrid,
  type LessonChange,
  type TimetableLesson,
  type TimetableGridHandle,
} from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

/** Normalizes DB time values ("HH:MM:SS") to input-friendly "HH:MM". */
function toHHMM(time: string): string {
  return time.slice(0, 5);
}

function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** The editable fields of a lesson, as a gateway-ready patch. */
interface LessonSnapshot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
  teacherId: string | null;
  isLocked: boolean;
  isParked: boolean;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
}

function snapshotOf(lesson: MasterLesson): LessonSnapshot {
  return {
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMM(lesson.startTime),
    endTime: toHHMM(lesson.endTime),
    roomId: lesson.roomId,
    teacherId: lesson.teacherId,
    isLocked: lesson.isLocked,
    isParked: lesson.isParked,
    recurrence: lesson.recurrence,
    startDate: lesson.startDate,
    endDate: lesson.endDate,
  };
}


type GroupBy = "none" | "teacher" | "room" | "group";

export default function TimetablePage() {
  const t = useTranslations("timetable");
  const tLunch = useTranslations("lunch");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const tDays = useTranslations("days");
  /*
   * The grundschema on screen: this year's, or next year's before its
   * activation (lib/planning-year.ts). Every year-keyed read and write below
   * follows it — the lessons, the timplan, the meals, the versions, the room
   * proposal, publishing.
   */
  const planning = usePlanningYear();
  const shownYear = planning.year;
  const { data: lessons, isLoading } = useMasterLessons(shownYear?.id ?? null);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  /*
   * Next year's classes have no home pupils before its activation, so the
   * people are read with the class the activation will give each pupil it
   * moves — the overlay the gateway checks a drag against, laid over the rows
   * as it comes (lib/projected-rosters.ts). Everything derived from a pupil's
   * class below — studentGroupOf, the clash map, the grade spans, the roster
   * index — then sees next year's 8A as the server does. For this year the
   * same array comes back.
   */
  const { data: storedPeople } = usePeople();
  const people = useMemo(
    () => withProjectedHomes(storedPeople, planning.rosters),
    [storedPeople, planning.rosters],
  );
  const { data: constraints } = useConstraints();
  const { data: requirements } = useRequirements(shownYear?.id ?? null);
  /**
   * What an edit actually did, including the part that is not reversible by
   * editing back.
   *
   * Narrowing a lesson's weeks or its date window removes the future calendar
   * rows the new window no longer covers. Widening it again does not put them
   * back — publishing does — so an admin who is not told simply loses lessons
   * from the calendar and finds out later.
   */
  const editSavedMessage = (result: {
    propagatedLessons: number;
    removedCalendarLessons?: number;
  }): string => {
    const saved = t("editSaved", { count: result.propagatedLessons });
    return result.removedCalendarLessons
      ? `${saved} ${t("editRemoved", { count: result.removedCalendarLessons })}`
      : saved;
  };
  /**
   * The saved toast, or — when a new teacher drew the staffing policy's WARN —
   * the same line as a warning with the policy's sentence under it, rendered
   * from the engine catalogue so an English reader gets English. Held longer
   * than a plain save: it names a behörighet the admin may want to undo.
   */
  const announceSaved = (result: {
    propagatedLessons: number;
    removedCalendarLessons?: number;
    warnings?: StaffingWarning[];
  }): void => savedToast(tEngine, editSavedMessage(result), result.warnings);

  const publish = usePublishSchedule();
  const { data: lunchSettings } = useLunchSettings();
  const updateLesson = useUpdateMasterLesson();
  const createLesson = useCreateMasterLesson();
  const deleteLesson = useDeleteMasterLesson();
  const history = useScheduleHistory();
  const { peers, setEditing: setRemoteEditing } = useTimetableRealtime();

  /**
   * A drag that lands on more than one class, held until it is confirmed.
   *
   * This page has no other confirmation, and deliberately so: every mutation is
   * undoable and toasted, so "drag freely, undo if wrong" is the whole idiom.
   * A drag of a shared lesson is the one case undo does not cover — the classes
   * it also moved were never on screen, so nothing tells you there was anything
   * to undo. The dialog's job is to NAME them, not to slow you down.
   */
  const [confirming, setConfirming] = useState<{
    lesson: MasterLesson;
    change: LessonChange;
    classes: string[];
  } | null>(null);

  /*
   * WHICH GROUPS THE GRID SHOWS — empty meaning all of them.
   *
   * A set rather than one id: a rektor comparing 4.1 with 4.2, or reading the
   * three teaching groups a class is cut into, had to choose between one of
   * them and the whole school. See components/schedule/group-filter.tsx for
   * why empty is "all" rather than a sentinel beside the ids.
   */
  const [groupFilters, setGroupFilters] = useState<string[]>([]);
  /*
   * THE ONE GROUP IN VIEW, or null when that is not a question with an answer.
   *
   * Several things here are about a single class and cannot be about four: the
   * lunch and rast stripes behind the grid, the "2/4" share badge, the group a
   * new lesson is created for, and the warning that a class has no sitting.
   * Each already declined to answer for "all groups"; this is the same rule,
   * derived once so the four cannot drift apart.
   */
  const onlyGroup = groupFilters.length === 1 ? groupFilters[0]! : null;
  /*
   * The same set-shaped filter as the groups, for the same reason: a rektor
   * comparing two teachers' weeks, or looking at what the two slöjd rooms hold
   * between them, had to choose between one of them and the whole school.
   */
  const [teacherFilters, setTeacherFilters] = useState<string[]>([]);
  const [roomFilters, setRoomFilters] = useState<string[]>([]);
  /** The one teacher in view, or null — see onlyGroup. */
  const onlyTeacher = teacherFilters.length === 1 ? teacherFilters[0]! : null;
  const [publishOpen, setPublishOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [editing, setEditing] = useState<MasterLesson | null>(null);
  const [editDraft, setEditDraft] = useState<LessonEditDraft>({
    dayOfWeek: "1",
    startTime: "",
    endTime: "",
    roomId: NONE,
    teacherId: NONE,
    isLocked: false,
    recurrence: "ALL_WEEKS",
    startDate: "",
    endDate: "",
  });

  const [creating, setCreating] = useState<CreateDraft | null>(null);
  // Whether a lesson has been added this visit, which is what decides that the
  // dialog's code is fetched — set during render, React's pattern for state
  // derived from an earlier render, so it holds from the first open onward.
  const [createUsed, setCreateUsed] = useState(false);
  if (creating !== null && !createUsed) setCreateUsed(true);
  const [slotMatches, setSlotMatches] = useState<OpenSlotMatch[] | null>(null);
  const [suggesting, setSuggesting] = useState<{
    lesson: MasterLesson;
    options: PlacementSuggestion[];
  } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Whether Versioner has been pressed this visit, which is what decides that
  // the dialog's code is fetched — the same rule as roomsUsed below.
  const [versionsUsed, setVersionsUsed] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  // Whether the room dialog has been asked for at all this visit, which is what
  // decides that its code is fetched — see where it is rendered.
  const [roomsUsed, setRoomsUsed] = useState(false);
  /*
   * Whether each of the four lifted dialogs has been opened this visit, which
   * is what mounts it and so fetches its code — set during render, as
   * createUsed is, so each holds from its first open onward. All four are
   * false at first render, so none of them is reached during SSR.
   */
  const [confirmUsed, setConfirmUsed] = useState(false);
  if (confirming !== null && !confirmUsed) setConfirmUsed(true);
  const [editUsed, setEditUsed] = useState(false);
  if (editing !== null && !editUsed) setEditUsed(true);
  const [suggestUsed, setSuggestUsed] = useState(false);
  if (suggesting !== null && !suggestUsed) setSuggestUsed(true);
  const [publishUsed, setPublishUsed] = useState(false);
  if (publishOpen && !publishUsed) setPublishUsed(true);
  // Justera and Lägg till are opened all day, so the lesson dialogs' chunk is
  // fetched as soon as the page has mounted rather than on the first click;
  // the click then rarely waits. A failed fetch here is left for the click to
  // retry, and a click whose fetch fails too is reported by the boundary
  // around the dialogs (see lessonDialogsFailed).
  useEffect(() => {
    loadLessonDialogs().catch(() => {});
  }, []);
  // The lazy() wrappers this page renders, and the key of the boundaries that
  // catch them; both are replaced when a dialog fails to load or draw.
  const [{ dialogs: lazyDialogs, attempt: dialogsAttempt }, setLessonDialogs] = useState(
    () => ({ dialogs: lessonDialogs, attempt: 0 }),
  );
  const {
    CreateLessonDialog,
    LessonEditDialog,
    PublishDialog,
    SharedMoveDialog,
    SuggestPlacementsDialog,
  } = lazyDialogs;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  /**
   * Change what is on screen and the selection goes with it.
   *
   * A selection is made by clicking cards, so it means "these ones, here". It
   * survived a filter change, and the bulk actions never re-check visibility —
   * so ticking three lessons under 4.1, switching to 4.2 and pressing delete
   * removed three lessons the admin could no longer see, with the undo toast
   * naming a count and nothing else.
   */
  /*
   * Changing what is on screen drops the bulk selection. Keeping it would
   * leave lessons ticked that the filter has just hidden, and the next Ta bort
   * would take them with it.
   */
  const pickFilter = (set: (value: string[]) => void) => (value: string[]) => {
    set(value);
    setSelectedIds(new Set());
  };
  const [groupBy, setGroupBy] = useState<GroupBy>("none");


  /*
   * The groups, split by kind. A school has a couple of dozen classes and can
   * have hundreds of teaching groups — Kunskapsskolan has 24 and 300 — so one
   * flat list buries the class a rektor is looking for.
   */
  /** The groups of the year on screen: a lesson added here belongs to it. */
  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === shownYear?.id),
    [groups, shownYear?.id],
  );
  const groupSections = useMemo(() => {
    const named = (group: { id: string; name: string }) => ({ id: group.id, name: group.name });
    // The schedule on screen is one year's, so its groups are the filter's:
    // another year's 8A (next year's, after a rollover) has no lesson here
    // and would only stand beside this year's under one name.
    const shown = yearGroups;
    return [
      {
        label: t("filterKindClasses"),
        options: shown.filter((group) => group.kind === "CLASS").map(named),
      },
      {
        label: t("filterKindTeachingGroups"),
        options: shown.filter((group) => group.kind !== "CLASS").map(named),
      },
    ];
  }, [yearGroups, t]);

  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER"),
    [people],
  );
  const students = useMemo(
    () => (people ?? []).filter((person) => person.role === "STUDENT" && person.isActive),
    [people],
  );
  /** studentId → their class id (participant-aware conflict checks). */
  const studentGroupOf = useMemo(
    () => new Map(students.map((student) => [student.id, student.studentGroupId])),
    [students],
  );
  const { data: memberships } = useGroupMemberships();
  const { data: frameTimes } = useFrameTimes();
  const { data: lunchSittings } = useLunchSittings(shownYear?.id ?? null);
  const lunchMutations = useLunchSittingMutations();
  /*
   * Placing a lunch by hand. A mode rather than a new gesture: a click on empty
   * time already means "put something here", and in this mode the something is
   * the class's meal instead of a lesson. Only with ONE class in view, for the
   * reason the bands give — a meal belongs to a class, and on a grid of several
   * there is no answer to "whose". Derived rather than reset on a filter
   * change, so picking a second class simply takes the mode away.
   */
  const [placingLunch, setPlacingLunch] = useState(false);
  const canPlaceLunch =
    onlyGroup !== null && lunchSettings?.lunchEnabled === true && shownYear != null;
  const lunchMode = placingLunch && canPlaceLunch;
  const { data: roomRules } = useRoomPreferences();
  const { data: rasts } = useRasts();
  /**
   * groupId -> the years it holds, so a GRADE_LEVEL rule can reach it.
   *
   * A teaching group has no year of its own, so it is derived from its members'
   * home classes — the same derivation the server does for the solver payload.
   * Without this the rule matches nothing and is ignored in silence; see
   * lib/grade-span.ts.
   */
  const gradeSpanOf = useMemo(
    () =>
      buildGradeSpans({
        groups: groups ?? [],
        membersByGroup: (memberships ?? []).reduce((map, row) => {
          const list = map.get(row.studentGroupId);
          if (list) list.push(row.studentId);
          else map.set(row.studentGroupId, [row.studentId]);
          return map;
        }, new Map<string, string[]>()),
        homeClassOf: studentGroupOf,
      }),
    [groups, memberships, studentGroupOf],
  );

  /** Groups sharing students — the manual-edit twin of the engine's pairs. */
  const groupConflictMap = useMemo(
    () => buildGroupConflictMap(studentGroupOf, memberships ?? []),
    [studentGroupOf, memberships],
  );

  /** The groups that are somebody's home. A teaching group is not one. */
  const homeClassIds = useMemo(
    () => (groups ?? []).filter((g) => g.kind === "CLASS").map((g) => g.id),
    [groups],
  );

  /**
   * The same pupils, counted rather than merely paired.
   *
   * Deliberately not built on groupConflictMap above: that is a BOOLEAN "these
   * two groups share at least one pupil", which cannot tell a two-pupil choir
   * from a fourteen-pupil maths half and never reads a lesson's individually
   * named studentIds at all. Both indexes are wanted — one answers "may these
   * collide", this one answers "how much of this class is in the room".
   */
  const rosterIndex = useMemo(
    () => buildRosterIndex(studentGroupOf, memberships),
    [studentGroupOf, memberships],
  );

  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject])),
    [subjects],
  );
  const groupById = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group])),
    [groups],
  );
  const roomById = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, room])),
    [rooms],
  );
  const teacherById = useMemo(
    () => new Map(teachers.map((teacher) => [teacher.id, teacher])),
    [teachers],
  );
  /** Everyone, pupils who have left included: a saved version still names them. */
  const personById = useMemo(
    () => new Map((people ?? []).map((person) => [person.id, person])),
    [people],
  );
  const lessonById = useMemo(
    () => new Map((lessons ?? []).map((lesson) => [lesson.id, lesson])),
    [lessons],
  );

  // -------------------------------------------------------------------
  // Live conflict engine: highlight existing clashes, validate drags.
  // Validation always runs against ALL lessons, not just the filtered view.
  // -------------------------------------------------------------------

  /**
   * Each group's meal, keyed `groupId:weekday` for the conflict check.
   *
   * Built from every sitting, not only the filtered group's: the check runs on
   * the lesson's own groups, and a lesson for a class that is not the one being
   * looked at is still a lesson on that class's meal.
   */
  const lunchOf = useMemo(() => {
    if (!lunchSittings) return undefined;
    return new Map(
      lunchSittings.map((sitting) => [
        `${sitting.studentGroupId}:${sitting.dayOfWeek}`,
        {
          startMinutes: timeToMinutes(sitting.startTime),
          endMinutes: timeToMinutes(sitting.endTime),
        },
      ]),
    );
  }, [lunchSittings]);

  /**
   * The pupils' ombyte and dusch, per (class, subject).
   *
   * `undefined` while the timplan has not answered, which is the file's own
   * convention for "not checked" — and the honest reading: a buffer nobody has
   * loaded yet must not be reported as 0 and let a drag through that the API
   * then refuses with a 409. `useRequirements` is keyed on the läsår, so this
   * follows the year the grid is showing.
   */
  const pupilBuffers = useMemo(
    () => (requirements ? buildPupilBufferMap(requirements) : undefined),
    [requirements],
  );

  /**
   * Whether a placement sits in a room its subject's locks forbid.
   *
   * The subject comes off the lesson and the stage off its group, so this is a
   * closure over the page's own maps rather than another argument list.
   */
  const roomLock = useMemo(() => {
    const locks = (roomRules ?? []).filter((rule) => rule.kind === "LOCK");
    if (locks.length === 0) return undefined;
    return (placement: Placement) => {
      const lesson = placement.id ? lessonById.get(placement.id) : undefined;
      if (!lesson) return false;
      return breaksRoomLock(
        locks,
        lesson.subjectId,
        gradeSpanOf.get(lesson.studentGroupId),
        placement.roomId,
      );
    };
  }, [roomRules, lessonById, gradeSpanOf]);

  const conflictMap = useMemo(
    () =>
      detectConflicts(
        lessons ?? [],
        constraints ?? [],
        studentGroupOf,
        groupConflictMap,
        gradeSpanOf,
        frameTimes,
        lunchOf,
        roomLock,
        pupilBuffers,
      ),
    [
      lessons,
      constraints,
      studentGroupOf,
      groupConflictMap,
      gradeSpanOf,
      frameTimes,
      lunchOf,
      roomLock,
      pupilBuffers,
    ],
  );

  /** lessonId → collaborator label (soft edit-locks from presence). */
  const remoteEditors = useMemo(() => {
    const map = new Map<string, string>();
    for (const peer of peers) {
      if (peer.editingLessonId && (!editing || peer.editingLessonId !== editing.id)) {
        map.set(peer.editingLessonId, peer.label);
      }
    }
    return map;
  }, [peers, editing]);

  /**
   * Everything that OCCUPIES a slot. A parked lesson does not: it is on the
   * tray, and its remembered day and time are not a placement. Reading them
   * as one would refuse B the very slot A was lifted out of.
   */
  const placements = useMemo(
    () =>
      (lessons ?? [])
        .filter((lesson) => !lesson.isParked)
        .map((lesson) => toPlacement(lesson, pupilBuffers)),
    [lessons, pupilBuffers],
  );

  const validateChange = useCallback(
    (id: string, change: LessonChange): boolean => {
      const lesson = lessonById.get(id);
      if (!lesson) return false;
      return (
        validatePlacement(
          {
            id,
            dayOfWeek: change.dayOfWeek,
            startMinutes: change.startMinutes,
            endMinutes: change.endMinutes,
            teacherId: lesson.teacherId,
            coTeacherId: lesson.coTeacherId,
            roomId: lesson.roomId,
            studentGroupId: lesson.studentGroupId,
            extraGroupIds: lesson.extraGroupIds,
            studentIds: lesson.studentIds,
            // The dragged lesson's OWN ombyte and dusch. Left off, the
            // candidate would be checked without the minutes every other
            // placement on the grid is carrying: the drag would be let into a
            // slot the API then refuses with a 409, and only after the move
            // has visibly happened.
            ...pupilBufferOf(pupilBuffers, lesson),
          },
          placements,
          constraints ?? [],
          studentGroupOf,
          groupConflictMap,
          gradeSpanOf,
          frameTimes,
          lunchOf,
          // NO room lock here, and the omission is the design. This predicate
          // BLOCKS a drag, and it builds its candidate with the lesson's
          // current room because a drag moves time and not place. Pass the lock
          // in and the day a school writes one, every lesson of that subject
          // already sitting elsewhere becomes undraggable in time — silently,
          // for a reason that has nothing to do with the move. The violation
          // shows as a conflict on the grid instead.
        ).length === 0
      );
    },
    [
      lessonById,
      placements,
      constraints,
      studentGroupOf,
      groupConflictMap,
      gradeSpanOf,
      frameTimes,
      lunchOf,
      pupilBuffers,
    ],
  );

  /**
   * The lunch drawn behind the lessons — but ONLY when one class is in view.
   *
   * A sitting belongs to a group. The default view is every group at once, and
   * a stripe across that grid would say "everyone eats at 11:40" when the whole
   * point of the flow is that they do not. Shown for a single group and hidden
   * otherwise is the honest reading; the flow as a whole is on its own page.
   */
  const lunchBands = useMemo(() => {
    if (onlyGroup === null) return undefined;
    const meals = (lunchSittings ?? [])
      .filter((sitting) => sitting.studentGroupId === onlyGroup)
      .map((sitting) => ({
        id: sitting.id,
        dayOfWeek: sitting.dayOfWeek,
        startMinutes: timeToMinutes(sitting.startTime),
        endMinutes: timeToMinutes(sitting.endTime),
        label: tLunch("bandLabel"),
        // Every meal can be moved — touching one makes it the school's — and
        // only one the school placed can be removed: the solver's own is
        // replaced by the next run, and removing it would leave the day blank.
        movable: true,
        handPlaced: !sitting.isGenerated,
        moveLabel: t("lunchMove"),
        removeLabel: sitting.isGenerated ? undefined : t("lunchRemove"),
      }));

    /*
     * The class's rasts, drawn the same way and for a sharper reason.
     *
     * This lands one commit BEFORE the engine obeys them, and that order is the
     * safety mechanism: a school declaring rasts across its existing
     * hand-placed lessons sees the collisions here, while they are still
     * something to look at, rather than as an INFEASIBLE on the next
     * generation run.
     *
     * Resolved through lib/rasts.ts rather than by filtering rows, because an
     * every-day row and a weekday row that overlaps it are two rows and one
     * day: the band has to show what the pair MEANS.
     */
    const span = gradeSpanOf.get(onlyGroup);
    const breaks = [1, 2, 3, 4, 5].flatMap((dayOfWeek) =>
      rastWindows(rasts ?? [], span, dayOfWeek).map((window) => ({
        id: `${window.id}:${dayOfWeek}`,
        dayOfWeek,
        startMinutes: window.startMinutes,
        endMinutes: window.endMinutes,
        label: window.name,
      })),
    );

    return [...meals, ...breaks];
  }, [lunchSittings, rasts, gradeSpanOf, onlyGroup, tLunch, t]);

  /**
   * lessonId → what this lesson means for the class in view. Empty for "all".
   *
   * Resolved ONCE here rather than inside toGridLesson, which runs for every
   * card on every frame of a drag; the cards only ever read this map.
   */
  const audienceByLesson = useMemo(() => {
    const map = new Map<string, Audience>();
    if (onlyGroup === null) return map;
    for (const lesson of lessons ?? []) {
      const audience = audienceFor(lesson, onlyGroup, rosterIndex);
      if (audience) map.set(lesson.id, audience);
    }
    return map;
  }, [lessons, onlyGroup, rosterIndex]);

  /**
   * The lessons that reach ANY of the chosen groups, by id.
   *
   * The same reach `audienceByLesson` works out for one class — a lesson filed
   * under 4ma1 holds 4.1's pupils — asked of each chosen group in turn. Its
   * own memo rather than a widening of that one, because the two answer
   * different questions: this one is "is it shown", which four classes can
   * answer together, and that one is "what does it MEAN for the class in
   * view", which they cannot.
   */
  const shownGroups = useMemo(() => {
    const shown = new Set<string>();
    if (groupFilters.length === 0) return shown;
    for (const lesson of lessons ?? []) {
      if (groupFilters.some((groupId) => audienceFor(lesson, groupId, rosterIndex))) {
        shown.add(lesson.id);
      }
    }
    return shown;
  }, [lessons, groupFilters, rosterIndex]);

  const filtered = useMemo(
    () =>
      (lessons ?? []).filter(
        (lesson) =>
          // Not the tray. `filtered` feeds the grid, the boards and both
          // exports, and a parked lesson belongs on none of them.
          !lesson.isParked &&
          // Every lesson holding one of this class's pupils, not only the ones
          // filed under its name: 4.1's maths is filed under 4ma1, and the
          // pupils in it already saw it on their own phones — the RLS policy
          // calendar_lessons_teaching_group_select grants exactly that — while
          // the administrator filtering to 4.1 did not.
          (groupFilters.length === 0 || shownGroups.has(lesson.id)) &&
          // Both teachers. A lesson somebody only CO-taught was missing from
          // their own view — the filter asked a name question where the data
          // is a set.
          (teacherFilters.length === 0 ||
            teacherIdsOf(toPlacement(lesson)).some((id) => teacherFilters.includes(id))) &&
          // A lesson with no room is in none of the rooms picked, which is the
          // honest reading of "show me what is in the slöjd rooms".
          (roomFilters.length === 0 ||
            (lesson.roomId !== null && roomFilters.includes(lesson.roomId))),
      ),
    [lessons, groupFilters, teacherFilters, roomFilters, shownGroups],
  );

  /**
   * Every class in the room, by name — "4.2 + 4.1".
   *
   * Shared by the card, the ICS and the PDF because they were three copies of
   * one sentence and only the card's was ever corrected. A subscriber to 4.1's
   * calendar got "Idrott — 4.2" with nothing saying 4.1 was in the hall too.
   */
  const groupLabel = useCallback(
    (lesson: Pick<MasterLesson, "studentGroupId" | "extraGroupIds">) =>
      [
        groupById.get(lesson.studentGroupId)?.name,
        ...lesson.extraGroupIds.map((id) => groupById.get(id)?.name),
      ]
        .filter(Boolean)
        .join(" + "),
    [groupById],
  );

  /** "2/4" when the class in view is only partly here, else nothing. */
  const shareLabelOf = useCallback(
    (lesson: MasterLesson) => {
      const audience = audienceByLesson.get(lesson.id);
      if (!audience || !showsFraction(audience)) return null;
      return `${audience.attending}/${audience.cohortSize}`;
    },
    [audienceByLesson],
  );

  /**
   * "Eleverna upptagna 07:50–09:20: 10 min ombyte före, 20 min dusch och ombyte
   * efter" — or nothing at all, which is every lesson at nearly every school.
   *
   * The wording is the API's own (master-lessons.service.ts, ombyteOf), because
   * the 409 an admin may read next says the same thing about the same minutes
   * and two spellings of one rule is one too many. The SPAN is here and not
   * there: the grid's reader is looking at a rectangle and needs to know how far
   * past it the class is gone, which is exactly what the rectangle cannot show.
   */
  const pupilTimeNoteOf = useCallback(
    (lesson: MasterLesson): string | undefined => {
      const buffer = pupilBufferOf(pupilBuffers, lesson);
      if (!buffer) return undefined;
      const sides = [
        buffer.minutesBefore > 0
          ? t("pupilTimeBefore", { minutes: buffer.minutesBefore })
          : null,
        buffer.minutesAfter > 0
          ? t("pupilTimeAfter", { minutes: buffer.minutesAfter })
          : null,
      ].filter((side): side is string => side !== null);
      if (sides.length === 0) return undefined;
      return t("pupilTime", {
        start: minutesToHHMM(timeToMinutes(lesson.startTime) - buffer.minutesBefore),
        end: minutesToHHMM(timeToMinutes(lesson.endTime) + buffer.minutesAfter),
        detail: sides.join(", "),
      });
    },
    [pupilBuffers, t],
  );

  const toGridLesson = useCallback(
    (lesson: MasterLesson): TimetableLesson => {
      const subject = subjectById.get(lesson.subjectId);
      const group = groupById.get(lesson.studentGroupId);
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
      const audience = audienceByLesson.get(lesson.id);
      return {
        id: lesson.id,
        dayOfWeek: lesson.dayOfWeek,
        startMinutes: timeToMinutes(lesson.startTime),
        endMinutes: timeToMinutes(lesson.endTime),
        title: subject?.name ?? "",
        subtitle: [
          [
            // The classes by NAME. "+1" told a reader that some other class was
            // in the room without telling them which, and the one thing worth
            // knowing about a shared lesson is who you are sharing it with.
            groupLabel(lesson),
            lesson.studentIds.length > 0 ? `⊕${lesson.studentIds.length}` : null,
          ]
            .filter(Boolean)
            .join(" "),
          teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        room: room?.name,
        color: subjectColor(lesson.subjectId, subject?.color),
        locked: lesson.isLocked,
        recurrenceNote: recurrenceBadge(lesson, t) ?? undefined,
        conflicted: conflictMap.has(lesson.id),
        // Hover text only — the rectangle keeps showing the teaching time. A
        // buffer the grid shows nowhere makes the refusal of the next slot look
        // like a bug in the grid.
        pupilTimeNote: pupilTimeNoteOf(lesson),
        remoteEditor: remoteEditors.get(lesson.id),
        // Only when the class is PARTLY here. "28/28" on every one of a class's
        // own lessons is noise on the common case, and a lesson that names the
        // class always holds all of it — showsFraction is the same rule the
        // library states as an invariant.
        ...(audience && showsFraction(audience)
          ? {
              share: `${audience.attending}/${audience.cohortSize}`,
              shareLabel: t("sharePupils", {
                attending: audience.attending,
                total: audience.cohortSize,
                group: onlyGroup ? (groupById.get(onlyGroup)?.name ?? "") : "",
              }),
            }
          : {}),
      };
    },
    [
      subjectById,
      groupById,
      teacherById,
      roomById,
      conflictMap,
      remoteEditors,
      audienceByLesson,
      onlyGroup,
      groupLabel,
      pupilTimeNoteOf,
      t,
    ],
  );

  const gridLessons: TimetableLesson[] = useMemo(
    () => filtered.map(toGridLesson),
    [filtered, toGridLesson],
  );

  /** The tray: lessons set aside, in the order they were lifted. */
  const parked = useMemo(() => (lessons ?? []).filter((lesson) => lesson.isParked), [lessons]);
  const trayRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<TimetableGridHandle>(null);

  /**
   * A lesson as a reader names it — "Matematik · 4.1 · K. Ek · A12".
   *
   * The edit dialog used to open on "Justera lektion" and nothing else, so
   * an administrator with three maths lessons on Tuesday had to remember which
   * one they had clicked. The same line names a card on the tray.
   */
  const lessonName = useCallback(
    (lesson: MasterLesson): string => {
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
      return [
        subjectById.get(lesson.subjectId)?.name,
        groupLabel(lesson),
        teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
        room?.name,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    [subjectById, groupLabel, teacherById, roomById],
  );

  /** Resource lanes when the "group by" view is active. */
  const resourceBoards = useMemo(() => {
    if (groupBy === "none") return null;
    const boards: Array<{ key: string; label: string; lessons: TimetableLesson[] }> = [];
    const push = (key: string, label: string, match: (l: MasterLesson) => boolean) => {
      const matching = filtered.filter(match);
      if (matching.length > 0) {
        boards.push({ key, label, lessons: matching.map(toGridLesson) });
      }
    };
    if (groupBy === "teacher") {
      for (const teacher of teachers) {
        push(
          teacher.id,
          `${teacher.firstName} ${teacher.lastName}`,
          (l) => teacherIdsOf(toPlacement(l)).includes(teacher.id),
        );
      }
      // "No teacher at all", which is not the same as "no primary teacher".
      // This lane used to catch a lesson carrying only a coTeacherId and file
      // it here — actively mis-filed, not merely absent from its own lane.
      push(
        "__none__",
        t("noTeacher"),
        (l) => teacherIdsOf(toPlacement(l)).length === 0,
      );
    } else if (groupBy === "room") {
      for (const room of rooms ?? []) {
        push(room.id, room.name, (l) => l.roomId === room.id);
      }
      push("__none__", t("noRoom"), (l) => l.roomId === null);
    } else {
      for (const group of groups ?? []) {
        push(group.id, group.name, (l) => l.studentGroupId === group.id);
      }
    }
    return boards;
  }, [groupBy, filtered, toGridLesson, teachers, rooms, groups, t]);

  // -------------------------------------------------------------------
  // Undoable mutations
  // -------------------------------------------------------------------

  const showError = useCallback(
    (error: unknown) => {
      // The staffing policy's REFUSE is a 409 too, but no clash: its own
      // sentence, from the catalogue, without "Schemakonflikt" in front.
      const refusal = staffingRefusal(error);
      if (refusal) {
        toast.error(refusalText(tEngine, refusal));
      } else if (error instanceof ApiError && error.status === 409) {
        toast.error(`${t("editConflict")}: ${error.message}`);
      } else {
        toast.error(error instanceof Error ? error.message : tCommon("error"));
      }
    },
    [t, tCommon, tEngine],
  );

  /*
   * A lesson dialog that could not be fetched (or threw while it drew) says so
   * in a toast instead of taking the page down. Every dialog from the chunk is
   * closed and unmounted again — none of them can be showing, since they
   * arrive together — and gets fresh lazy() wrappers, so the next open fetches
   * again rather than rethrowing the old failure. Resetting the latches is what
   * keeps a chunk that keeps failing from being retried in a loop: the next
   * attempt waits for somebody to open a dialog.
   */
  const lessonDialogsFailed = useCallback(
    (error: unknown) => {
      showError(error);
      lessonDialogs = lazyLessonDialogs();
      setLessonDialogs((previous) => ({
        dialogs: lessonDialogs,
        attempt: previous.attempt + 1,
      }));
      setConfirming(null);
      setEditing(null);
      setRemoteEditing(null);
      setCreating(null);
      setSlotMatches(null);
      setSuggesting(null);
      setPublishOpen(false);
      setConfirmUsed(false);
      setEditUsed(false);
      setCreateUsed(false);
      setSuggestUsed(false);
      setPublishUsed(false);
    },
    [showError, setRemoteEditing],
  );

  /** Applies a patch and registers the inverse operation in history. */
  const undoableUpdate = useCallback(
    async (lesson: MasterLesson, patch: Partial<LessonSnapshot>) => {
      const before = snapshotOf(lesson);
      const result = await updateLesson.mutateAsync({ id: lesson.id, ...patch });
      const after = { ...before, ...patch };
      history.push({
        label: "update",
        undo: async () => {
          await updateLesson.mutateAsync({ id: lesson.id, ...before });
        },
        redo: async () => {
          await updateLesson.mutateAsync({ id: lesson.id, ...after });
        },
      });
      return result;
    },
    [updateLesson, history],
  );

  const undoableCreate = useCallback(
    async (input: CreateMasterLessonInput) => {
      const created = await createLesson.mutateAsync(input);
      const ref = { id: created.id };
      history.push({
        label: "create",
        undo: async () => {
          await deleteLesson.mutateAsync(ref.id);
        },
        redo: async () => {
          const again = await createLesson.mutateAsync(input);
          ref.id = again.id;
        },
      });
      return created;
    },
    [createLesson, deleteLesson, history],
  );

  const undoableDelete = useCallback(
    async (lesson: MasterLesson) => {
      const input: CreateMasterLessonInput = restorableInput(lesson);
      const result = await deleteLesson.mutateAsync(lesson.id);
      const ref = { id: lesson.id };
      history.push({
        label: "delete",
        undo: async () => {
          const again = await createLesson.mutateAsync(input);
          ref.id = again.id;
        },
        redo: async () => {
          await deleteLesson.mutateAsync(ref.id);
        },
      });
      return result;
    },
    [deleteLesson, createLesson, history],
  );

  useHistoryKeyboard(
    history,
    (kind, entry) => {
      if (entry) toast.info(kind === "undo" ? t("undone") : t("redone"));
    },
    // The same report doUndo/doRedo give below: Ctrl+Z is not a quieter way
    // to hit a 409 than the toolbar button.
    (_kind, error) => showError(error),
  );

  const doUndo = async () => {
    try {
      const entry = await history.undo();
      if (entry) toast.info(t("undone"));
    } catch (error) {
      showError(error);
    }
  };
  const doRedo = async () => {
    try {
      const entry = await history.redo();
      if (entry) toast.info(t("redone"));
    } catch (error) {
      showError(error);
    }
  };

  // -------------------------------------------------------------------
  // Grid interactions
  // -------------------------------------------------------------------

  /** Applies a drop. Separated so the confirmation can reach it too. */
  const applyGridChange = useCallback(
    (lesson: MasterLesson, change: LessonChange) => {
      void undoableUpdate(lesson, {
        dayOfWeek: change.dayOfWeek,
        startTime: minutesToHHMM(change.startMinutes),
        endTime: minutesToHHMM(change.endMinutes),
        // A lesson dragged in from the tray arrives placed. Sent only then,
        // so an ordinary move's patch is exactly what it was — and undo of an
        // arrival, which restores the snapshot, parks it again.
        ...(lesson.isParked ? { isParked: false } : {}),
      })
        .then((result) =>
          announceSaved(result),
        )
        .catch(showError);
    },
    [undoableUpdate, showError, t],
  );

  const handleGridChange = useCallback(
    (id: string, change: LessonChange) => {
      const lesson = lessonById.get(id);
      if (!lesson) return;
      // Asked of the LESSON, not of the filter: which class you are looking at
      // has no bearing on whose week just moved.
      const classes = homeClassesReached(lesson, homeClassIds, rosterIndex);
      if (classes.length > 1) {
        setConfirming({ lesson, change, classes });
        return;
      }
      applyGridChange(lesson, change);
    },
    [lessonById, homeClassIds, rosterIndex, applyGridChange],
  );

  /**
   * Set a lesson aside. No clash check anywhere — the whole point is that A
   * may leave slot X while B still stands there. Undoable: the snapshot holds
   * the slot it left, and restoring that IS a placement, checked as one.
   */
  const park = useCallback(
    (lesson: MasterLesson) => {
      void undoableUpdate(lesson, { isParked: true })
        .then(() => toast.success(t("parked", { lesson: lessonName(lesson) })))
        .catch(showError);
    },
    [undoableUpdate, showError, t, lessonName],
  );

  /** Put a parked lesson back where it was. The remembered slot may be taken. */
  const putBack = useCallback(
    (lesson: MasterLesson) => {
      void undoableUpdate(lesson, { isParked: false })
        .then(() => toast.success(t("putBackDone", { lesson: lessonName(lesson) })))
        .catch(showError);
    },
    [undoableUpdate, showError, t, lessonName],
  );

  /** A drag that let go off the grid: on the tray, it parks; elsewhere, nothing. */
  const handleDropOutside = useCallback(
    (id: string, point: { clientX: number; clientY: number }) => {
      const lesson = lessonById.get(id);
      const tray = trayRef.current;
      if (!lesson || !tray) return;
      const rect = tray.getBoundingClientRect();
      const onTray =
        point.clientX >= rect.left &&
        point.clientX <= rect.right &&
        point.clientY >= rect.top &&
        point.clientY <= rect.bottom;
      if (onTray) park(lesson);
    },
    [lessonById, park],
  );

  /** Lift a card off the tray and hand it to the grid as a live drag. */
  const beginTrayDrag = useCallback(
    (lesson: MasterLesson, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      gridRef.current?.beginExternalDrag(toGridLesson(lesson), {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    [toGridLesson],
  );

  /** Invalid drop → rank the nearest conflict-free slots and offer them. */
  const handleInvalidDrop = useCallback(
    (id: string, change: LessonChange) => {
      const lesson = lessonById.get(id);
      if (!lesson) return;
      const candidate: Placement = {
        id,
        dayOfWeek: change.dayOfWeek,
        startMinutes: change.startMinutes,
        endMinutes: change.endMinutes,
        teacherId: lesson.teacherId,
        coTeacherId: lesson.coTeacherId,
        roomId: lesson.roomId,
        studentGroupId: lesson.studentGroupId,
        extraGroupIds: lesson.extraGroupIds,
        studentIds: lesson.studentIds,
        // The same buffer validateChange checks with. Without it the search
        // would rank slots by a rule the editor does not use and offer one it
        // then refuses — the worst kind of suggestion, since the admin has
        // already accepted it by clicking.
        ...pupilBufferOf(pupilBuffers, lesson),
      };
      /*
       * WHY the slot was refused, when the grid shows no reason at all.
       *
       * "Platsen är upptagen — här är närmaste lediga" over two lessons that
       * visibly do not touch reads as a bug in the grid. It is not: the class is
       * changing or showering in between, which the school itself configured on
       * the timplan. So the refusal names that, and only when the buffer is the
       * WHOLE reason — a slot that is also double-booked on the clock has a
       * plainer explanation, and offering the subtler one first would send an
       * admin to admin/requirements to lower a number that was never the
       * problem.
       */
      const hits = validatePlacement(
        candidate,
        placements,
        constraints ?? [],
        studentGroupOf,
        groupConflictMap,
        gradeSpanOf,
        frameTimes,
        lunchOf,
      );
      if (hits.length > 0 && hits.every((hit) => hit.pupilBufferOnly)) {
        toast.info(t("pupilTimeRefused"));
      }
      const hasWeekend = (lessons ?? []).some((l) => l.dayOfWeek > 5);
      // The search lives in the lesson dialogs' chunk, fetched when the page
      // mounted, so this await is normally a resolved promise.
      loadLessonDialogs().then(({ suggestPlacements }) => {
        const options = suggestPlacements(candidate, placements, constraints ?? [], {
          days: hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
          studentGroupOf,
        });
        setSuggesting({ lesson, options });
      }, showError);
    },
    [
      lessonById,
      lessons,
      placements,
      constraints,
      studentGroupOf,
      groupConflictMap,
      gradeSpanOf,
      frameTimes,
      lunchOf,
      pupilBuffers,
      showError,
      t,
    ],
  );

  const applySuggestion = async (suggestion: PlacementSuggestion) => {
    if (!suggesting) return;
    try {
      const result = await undoableUpdate(suggesting.lesson, {
        dayOfWeek: suggestion.dayOfWeek,
        startTime: minutesToHHMM(suggestion.startMinutes),
        endTime: minutesToHHMM(suggestion.endMinutes),
      });
      announceSaved(result);
      setSuggesting(null);
    } catch (error) {
      showError(error);
    }
  };

  // -------------------------------------------------------------------
  // Bulk operations (shift+click selection)
  // -------------------------------------------------------------------

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedLessons = useMemo(
    () =>
      [...selectedIds]
        .map((id) => lessonById.get(id))
        .filter((lesson): lesson is MasterLesson => Boolean(lesson)),
    [selectedIds, lessonById],
  );

  const bulkSetLock = async (isLocked: boolean) => {
    const targets = selectedLessons.filter((lesson) => lesson.isLocked !== isLocked);
    if (targets.length === 0) return;
    try {
      for (const lesson of targets) {
        await updateLesson.mutateAsync({ id: lesson.id, isLocked, propagate: false });
      }
      history.push({
        label: "bulk-lock",
        undo: async () => {
          for (const lesson of targets) {
            await updateLesson.mutateAsync({
              id: lesson.id,
              isLocked: !isLocked,
              propagate: false,
            });
          }
        },
        redo: async () => {
          for (const lesson of targets) {
            await updateLesson.mutateAsync({ id: lesson.id, isLocked, propagate: false });
          }
        },
      });
      toast.success(t("bulkDone", { count: targets.length }));
    } catch (error) {
      showError(error);
    }
  };

  const bulkDelete = async () => {
    const targets = [...selectedLessons];
    if (targets.length === 0) return;
    try {
      // The SAME fields undoableDelete restores, and for the reason its own
      // comment gives twelve lines up: without them undo quietly turns an
      // odd-week lesson into a weekly one. This path carried nine of the
      // fourteen, so a bulk undo also dropped the extra classes and the
      // individually named pupils — silently, on the lessons most likely to
      // have them.
      const inputs: CreateMasterLessonInput[] = targets.map(restorableInput);
      const refs = targets.map((lesson) => ({ id: lesson.id }));
      for (const lesson of targets) {
        await deleteLesson.mutateAsync(lesson.id);
      }
      history.push({
        label: "bulk-delete",
        undo: async () => {
          for (let i = 0; i < inputs.length; i++) {
            const again = await createLesson.mutateAsync(inputs[i]);
            refs[i].id = again.id;
          }
        },
        redo: async () => {
          for (const ref of refs) {
            await deleteLesson.mutateAsync(ref.id);
          }
        },
      });
      setSelectedIds(new Set());
      toast.success(t("bulkDeleted", { count: targets.length }));
    } catch (error) {
      showError(error);
    }
  };

  // -------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------

  /** After a restore, which recreated every lesson under a new id. */
  const afterRestore = useCallback(() => {
    history.clear(); // full replace — the local command stack no longer applies
    setSelectedIds(new Set());
  }, [history]);

  /*
   * After a room optimisation is applied — or its Ångra — the page's own undo
   * stack is cleared, exactly as a version restore clears it. Both rewrite
   * lessons underneath the stack, and every entry in it holds a snapshot of a
   * lesson as it was, room included. Undoing an earlier drag would then put
   * that one lesson back in its pre-optimisation room: a piece of the proposal
   * reversed with no toast saying so, into a room another moved lesson may
   * now hold. The apply's own Ångra is the way back, and after it the entries
   * made in between carry the optimised rooms, so the stack goes again.
   *
   * The selection stays, unlike after a restore: a restore recreates lessons
   * under new ids, while here the ids are the same lessons in other rooms.
   */
  const afterRoomOptimization = useCallback(() => history.clear(), [history]);

  const lunchError = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : tCommon("error"));

  const sittingOn = (dayOfWeek: number) =>
    (lunchSittings ?? []).find(
      (sitting) => sitting.studentGroupId === onlyGroup && sitting.dayOfWeek === dayOfWeek,
    );

  /**
   * The class's meal on that day, placed where the school clicked.
   *
   * Undone to what the day MEANT before, not merely to where the band was. A
   * day with a meal the school had placed goes back to that start. A day the
   * solver had fed goes back to the solver: the hand row is removed and the
   * next run places the meal again. A day with no meal goes back to none.
   */
  const placeLunch = async (dayOfWeek: number, startMinutes: number) => {
    if (!onlyGroup || !shownYear) return;
    const before = sittingOn(dayOfWeek);
    const body = {
      academicYearId: shownYear.id,
      studentGroupId: onlyGroup,
      dayOfWeek,
      startTime: minutesToHHMM(startMinutes),
    };
    try {
      const placed = (await lunchMutations.create.mutateAsync(body)) as { id: string };
      const ref = { id: placed.id };
      history.push({
        label: "lunch",
        undo: async () => {
          if (before && !before.isGenerated) {
            await lunchMutations.update.mutateAsync({
              id: ref.id,
              startTime: before.startTime.slice(0, 5),
            });
          } else {
            await lunchMutations.remove.mutateAsync(ref.id);
          }
        },
        redo: async () => {
          const again = (await lunchMutations.create.mutateAsync(body)) as { id: string };
          ref.id = again.id;
        },
      });
    } catch (error) {
      lunchError(error);
    }
  };

  /**
   * A meal dragged to another day or time.
   *
   * Onto a day that already has a meal for this class it is refused HERE, not
   * left to the server — which would replace the other meal, and a drag that
   * silently deleted Wednesday's lunch is the worst thing this gesture could do.
   */
  const moveLunch = async (id: string, dayOfWeek: number, startMinutes: number) => {
    const sitting = (lunchSittings ?? []).find((row) => row.id === id);
    if (!sitting) return;
    if (dayOfWeek !== sitting.dayOfWeek && sittingOn(dayOfWeek)) {
      toast.error(t("lunchDayTaken"));
      return;
    }
    const before = { dayOfWeek: sitting.dayOfWeek, startTime: sitting.startTime.slice(0, 5) };
    const after = { dayOfWeek, startTime: minutesToHHMM(startMinutes) };
    try {
      await lunchMutations.update.mutateAsync({ id, ...after });
      history.push({
        label: "lunch",
        undo: async () => {
          await lunchMutations.update.mutateAsync({ id, ...before });
        },
        redo: async () => {
          await lunchMutations.update.mutateAsync({ id, ...after });
        },
      });
    } catch (error) {
      lunchError(error);
    }
  };

  const removeLunch = async (id: string) => {
    const sitting = (lunchSittings ?? []).find((row) => row.id === id);
    if (!sitting || !shownYear) return;
    const body = {
      academicYearId: shownYear.id,
      studentGroupId: sitting.studentGroupId,
      dayOfWeek: sitting.dayOfWeek,
      startTime: sitting.startTime.slice(0, 5),
    };
    const ref = { id };
    try {
      await lunchMutations.remove.mutateAsync(id);
      history.push({
        label: "lunch",
        undo: async () => {
          const again = (await lunchMutations.create.mutateAsync(body)) as { id: string };
          ref.id = again.id;
        },
        redo: async () => {
          await lunchMutations.remove.mutateAsync(ref.id);
        },
      });
    } catch (error) {
      lunchError(error);
    }
  };

  const openCreate = (dayOfWeek: number, startMinutes: number) => {
    setSlotMatches(null);
    setCreating({
      subjectId: "",
      studentGroupId: onlyGroup ?? "",
      extraGroupIds: [],
      studentIds: [],
      dayOfWeek: String(dayOfWeek),
      recurrence: "ALL_WEEKS",
      startDate: "",
      endDate: "",
      startTime: minutesToHHMM(startMinutes),
      endTime: minutesToHHMM(Math.min(startMinutes + 60, 23 * 60 + 45)),
      roomId: NONE,
      teacherId: onlyTeacher ?? NONE,
      isLocked: true,
    });
  };

  const openEditor = (lessonId: string) => {
    const lesson = lessonById.get(lessonId);
    if (!lesson) return;
    const remoteEditor = remoteEditors.get(lessonId);
    if (remoteEditor) {
      toast.warning(t("remoteEditingWarning", { name: remoteEditor }));
    }
    setRemoteEditing(lessonId);
    setEditing(lesson);
    setEditDraft({
      dayOfWeek: String(lesson.dayOfWeek),
      startTime: toHHMM(lesson.startTime),
      endTime: toHHMM(lesson.endTime),
      roomId: lesson.roomId ?? NONE,
      teacherId: lesson.teacherId ?? NONE,
      isLocked: lesson.isLocked,
      recurrence: lesson.recurrence,
      startDate: lesson.startDate ?? "",
      endDate: lesson.endDate ?? "",
    });
  };

  const doSaveEdit = async () => {
    if (!editing) return;
    try {
      const result = await undoableUpdate(editing, {
        dayOfWeek: Number(editDraft.dayOfWeek),
        startTime: editDraft.startTime,
        endTime: editDraft.endTime,
        roomId: editDraft.roomId === NONE ? null : editDraft.roomId,
        teacherId: editDraft.teacherId === NONE ? null : editDraft.teacherId,
        isLocked: editDraft.isLocked,
        recurrence: editDraft.recurrence,
        // An empty field means "the academic year's own boundary", which the
        // API stores as null — not as an empty string.
        startDate: editDraft.startDate === "" ? null : editDraft.startDate,
        endDate: editDraft.endDate === "" ? null : editDraft.endDate,
      });
      announceSaved(result);
      setEditing(null);
      setRemoteEditing(null);
    } catch (error) {
      showError(error);
    }
  };

  const doDelete = async () => {
    if (!editing) return;
    try {
      const result = await undoableDelete(editing);
      toast.success(t("deleted", { count: result.removedCalendarLessons }));
      setEditing(null);
      setRemoteEditing(null);
    } catch (error) {
      showError(error);
    }
  };

  const doDuplicate = () => {
    if (!editing) return;
    const lesson = editing;
    setEditing(null);
    setSlotMatches(null);
    setCreating({
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      extraGroupIds: lesson.extraGroupIds,
      studentIds: lesson.studentIds,
      dayOfWeek: String(lesson.dayOfWeek),
      // Duplicating a lesson keeps the weeks it runs — the common case is a
      // second slöjd group on the same alternating schedule.
      recurrence: lesson.recurrence,
      startDate: lesson.startDate ?? "",
      endDate: lesson.endDate ?? "",
      startTime: toHHMM(lesson.startTime),
      endTime: toHHMM(lesson.endTime),
      roomId: lesson.roomId ?? NONE,
      teacherId: lesson.teacherId ?? NONE,
      isLocked: lesson.isLocked,
    });
  };

  /**
   * Open-slot search: finds slots where the chosen class(es) are all free,
   * paired first with the class's assigned teacher for the subject and, when
   * no assigned teacher is free, with a fallback teacher of the subject.
   */
  const runSlotSearch = () => {
    if (!creating || !creating.subjectId || !creating.studentGroupId) return;
    const groupIds = [creating.studentGroupId, ...creating.extraGroupIds];

    const subjectRequirements = (requirements ?? []).filter(
      (requirement) => requirement.subjectId === creating.subjectId,
    );
    const primaryTeacherIds = subjectRequirements
      .filter((requirement) => groupIds.includes(requirement.studentGroupId))
      .flatMap((requirement) => [requirement.teacherId, requirement.coTeacherId])
      .filter((id): id is string => Boolean(id));
    const fallbackTeacherIds = subjectRequirements
      .flatMap((requirement) => [requirement.teacherId, requirement.coTeacherId])
      .filter((id): id is string => Boolean(id));

    const startMin = creating.startTime ? timeToMinutes(creating.startTime) : 0;
    const endMin = creating.endTime ? timeToMinutes(creating.endTime) : 0;
    const duration = endMin > startMin ? endMin - startMin : 60;
    const hasWeekend = (lessons ?? []).some((lesson) => lesson.dayOfWeek > 5);

    // Pressed inside Lägg till, whose chunk carries the search: loaded by now.
    loadLessonDialogs().then(({ findOpenSlots }) => {
      setSlotMatches(
        findOpenSlots({
          studentGroupIds: groupIds,
          participantStudentIds: creating.studentIds,
          studentGroupOf,
          durationMinutes: duration,
          primaryTeacherIds,
          fallbackTeacherIds,
          placements,
          constraints: constraints ?? [],
          days: hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
        }),
      );
    }, showError);
  };

  const doCreate = async () => {
    if (!creating || !shownYear) return;
    try {
      await undoableCreate({
        academicYearId: shownYear.id,
        subjectId: creating.subjectId,
        studentGroupId: creating.studentGroupId,
        teacherId: creating.teacherId === NONE ? null : creating.teacherId,
        roomId: creating.roomId === NONE ? null : creating.roomId,
        dayOfWeek: Number(creating.dayOfWeek),
        startTime: creating.startTime,
        endTime: creating.endTime,
        isLocked: creating.isLocked,
        recurrence: creating.recurrence,
        startDate: creating.startDate === "" ? null : creating.startDate,
        endDate: creating.endDate === "" ? null : creating.endDate,
        extraGroupIds: creating.extraGroupIds,
        studentIds: creating.studentIds,
      });
      toast.success(t("created"));
      setCreating(null);
    } catch (error) {
      showError(error);
    }
  };

  // -------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------


  const doExportIcs = async () => {
    if (!shownYear) return;
    const { buildIcs, downloadIcs } = await import("@/lib/ics");
    const ics = buildIcs(
      filtered.map((lesson) => {
        const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : null;
        return {
          id: lesson.id,
          dayOfWeek: lesson.dayOfWeek,
          startTime: toHHMM(lesson.startTime),
          endTime: toHHMM(lesson.endTime),
          summary: [
            subjectById.get(lesson.subjectId)?.name ?? "",
            groupLabel(lesson),
          ]
            .filter(Boolean)
            .join(" — "),
          location: lesson.roomId
            ? (roomById.get(lesson.roomId)?.name ?? undefined)
            : undefined,
          // The fraction belongs here too. A calendar entry is one block on a
          // phone whether four pupils or fourteen are in it, and the subscriber
          // cannot see the grid's badge.
          description:
            [
              teacher ? `${teacher.firstName} ${teacher.lastName}` : null,
              shareLabelOf(lesson)
                ? t("sharePupils", {
                    attending: audienceByLesson.get(lesson.id)!.attending,
                    total: audienceByLesson.get(lesson.id)!.cohortSize,
                    group: onlyGroup ? (groupById.get(onlyGroup)?.name ?? "") : "",
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
          // Without these a subscriber sees slöjd every week when it runs
          // every other, and a spring course all through the autumn.
          recurrence: lesson.recurrence,
          startDate: lesson.startDate,
          endDate: lesson.endDate,
        };
      }),
      {
        calendarName: t("title"),
        yearStart: shownYear.startDate,
        yearEnd: shownYear.endDate,
      },
    );
    downloadIcs("timetable.ics", ics);
    toast.success(t("icsExported", { count: filtered.length }));
  };

  const doExportPdf = async () => {
    const { exportTimetablePdf } = await import("@/lib/pdf");
    await exportTimetablePdf({
      title: t("title"),
      subtitle: shownYear?.name,
      dayNames: [1, 2, 3, 4, 5, 6, 7].map((day) => tDays(String(day))),
      columnLabels: {
        time: t("editStart"),
        subject: t("addSubject"),
        group: t("addGroup"),
        teacher: t("editTeacher"),
        room: t("editRoom"),
      },
      lessons: filtered.map((lesson) => {
        const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : null;
        const coTeacher = lesson.coTeacherId
          ? teacherById.get(lesson.coTeacherId)
          : null;
        return {
          dayOfWeek: lesson.dayOfWeek,
          startTime: toHHMM(lesson.startTime),
          endTime: toHHMM(lesson.endTime),
          subject: subjectById.get(lesson.subjectId)?.name ?? "",
          group: [groupLabel(lesson), shareLabelOf(lesson)]
            .filter(Boolean)
            .join(" "),
          teacher: [
            teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
            coTeacher ? `${coTeacher.firstName[0]}. ${coTeacher.lastName}` : null,
          ]
            .filter(Boolean)
            .join(" + "),
          room: lesson.roomId ? (roomById.get(lesson.roomId)?.name ?? "") : "",
        };
      }),
    });
  };

  const doPublish = async () => {
    if (!shownYear) return;
    try {
      const result = await publish.mutateAsync({
        academicYearId: shownYear.id,
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      });
      toast.success(t("published", { count: result.created }));
      setPublishOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const conflictCount = conflictMap.size;

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={doUndo}
              disabled={!history.canUndo}
              title={`${t("undo")} (Ctrl+Z)`}
            >
              <Undo2 />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={doRedo}
              disabled={!history.canRedo}
              title={`${t("redo")} (Ctrl+Shift+Z)`}
            >
              <Redo2 />
            </Button>
            <Button
              variant="outline"
              onClick={() => openCreate(1, 8 * 60)}
              disabled={!shownYear}
            >
              <Plus />
              {t("addLesson")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setVersionsUsed(true);
                setVersionsOpen(true);
              }}
              disabled={!shownYear}
            >
              <History />
              {t("versions")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setRoomsUsed(true);
                setRoomsOpen(true);
              }}
              disabled={!shownYear || !lessons || lessons.length === 0}
            >
              <Footprints />
              {t("optimizeRooms")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={doExportIcs}
              disabled={!shownYear || filtered.length === 0}
              title={t("exportIcs")}
            >
              <Download />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={doExportPdf}
              disabled={!shownYear || filtered.length === 0}
              title={t("exportPdf")}
            >
              <FileText />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => window.print()}
              title={t("print")}
            >
              <Printer />
            </Button>
            <Button
              onClick={() => {
                setFromDate(shownYear?.startDate ?? "");
                setToDate(shownYear?.endDate ?? "");
                setPublishOpen(true);
              }}
              disabled={!lessons || lessons.length === 0}
            >
              <Upload />
              {t("publish")}
            </Button>
          </div>
        }
      />
      {/* In a row of its own, above the banner it explains, and not in the
          header's actions: that row is nine buttons already, and with the
          choice beside them it ran past a 1440 px screen and put Publicera
          out of sight for the whole planning window. */}
      <PlanningYearPicker
        {...planning}
        className="mb-4"
        onChoose={(yearId) => {
          // What was picked, ticked and undoable belongs to the other
          // year's grid: its group ids are not this year's, and an undo
          // would move a lesson nobody can see.
          setGroupFilters([]);
          setSelectedIds(new Set());
          setPlacingLunch(false);
          history.clear();
          planning.choose(yearId);
        }}
      />
      <ProjectedRostersBanner
        year={shownYear}
        active={planning.active}
        rosters={planning.rosters}
        failed={planning.rostersFailed}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Labelled inside, because it sits beside the teacher combobox and a
            screen reader read both as "Alla …" with nothing to tell them
            apart. */}
        <FilterPicker
          sections={groupSections}
          value={groupFilters}
          onChange={pickFilter(setGroupFilters)}
          label={t("filterGroup")}
          allLabel={t("allGroups")}
          countLabel={(count) => t("groupsSelected", { count })}
        />
        <FilterPicker
          sections={[
            {
              options: teachers.map((teacher) => ({
                id: teacher.id,
                name: `${teacher.firstName} ${teacher.lastName}`,
              })),
            },
          ]}
          value={teacherFilters}
          onChange={pickFilter(setTeacherFilters)}
          label={t("filterTeacher")}
          allLabel={t("allTeachers")}
          countLabel={(count) => t("teachersSelected", { count })}
        />
        <FilterPicker
          sections={[
            { options: (rooms ?? []).map((room) => ({ id: room.id, name: room.name })) },
          ]}
          value={roomFilters}
          onChange={pickFilter(setRoomFilters)}
          label={t("filterRoom")}
          allLabel={t("allRooms")}
          countLabel={(count) => t("roomsSelected", { count })}
        />
        <Select value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("viewCombined")}</SelectItem>
            <SelectItem value="teacher">{t("viewByTeacher")}</SelectItem>
            <SelectItem value="room">{t("viewByRoom")}</SelectItem>
            <SelectItem value="group">{t("viewByGroup")}</SelectItem>
          </SelectContent>
        </Select>
        {canPlaceLunch ? (
          <Button
            size="sm"
            variant={lunchMode ? "default" : "outline"}
            aria-pressed={lunchMode}
            onClick={() => setPlacingLunch((on) => !on)}
          >
            <UtensilsCrossed />
            {lunchMode ? t("placeLunchOn") : t("placeLunch")}
          </Button>
        ) : null}
        {filtered.length > 0 ? (
          <span className="text-sm text-muted-foreground">
            {t("lessonCount", { count: filtered.length })}
          </span>
        ) : null}
        {conflictCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-1 text-sm font-medium text-red-700">
            <TriangleAlert className="h-4 w-4" />
            {t("conflictCount", { count: conflictCount })}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">{t("dragHint")}</span>
        {peers.length > 1 ? (
          <span className="ml-auto inline-flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t("online")}</span>
            {peers.map((peer) => (
              <span
                key={peer.userId}
                title={peer.label}
                className="inline-flex h-6 items-center rounded-full bg-primary/10 px-2 text-xs font-medium text-primary"
              >
                {peer.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {/*
        WHY THERE IS NO LUNCH BAND, said where the band would be.

        Rasts are declared and drawn at once; the meal is placed by the solver
        and exists only after a generation run. A school that has just declared
        its rasts sees them appear and its lunch not, and the grid used to say
        nothing about the difference — which reads as a bug in the product
        rather than a run not yet made. Two states, two sentences: none placed
        for the year (generate), or none for THIS class (the engine places a
        meal only for a class with lessons of its own to place it around).
      */}
      {onlyGroup !== null &&
      lunchSettings?.lunchEnabled &&
      lunchSittings !== undefined &&
      !lunchSittings.some((sitting) => sitting.studentGroupId === onlyGroup) ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          {lunchSittings.length === 0 ? (
            <div className="space-y-1">
              <p>{t("noSittingsYear")}</p>
              <Link
                href={
                  shownYear && !shownYear.isActive
                    ? `/admin/generate?year=${shownYear.id}`
                    : "/admin/generate"
                }
                className="font-medium underline underline-offset-4"
              >
                {t("noSittingsYearLink")}
              </Link>
              {canPlaceLunch ? (
                <Button size="sm" variant="outline" onClick={() => setPlacingLunch(true)}>
                  <UtensilsCrossed />
                  {t("noSittingsPlace")}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1">
              <p>
                {t("noSittingsGroup", {
                  group: onlyGroup ? (groupById.get(onlyGroup)?.name ?? "") : "",
                })}
              </p>
              {canPlaceLunch ? (
                <Button size="sm" variant="outline" onClick={() => setPlacingLunch(true)}>
                  <UtensilsCrossed />
                  {t("noSittingsPlace")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {lunchMode ? (
        <p
          role="status"
          className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {t("placeLunchHint", { minutes: lunchSettings?.lunchMinutes ?? 0 })}
        </p>
      ) : null}

      {selectedIds.size > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-accent/40 px-3 py-2">
          <span className="text-sm font-medium">
            {t("bulkSelected", { count: selectedIds.size })}
          </span>
          <Button size="sm" variant="outline" onClick={() => void bulkSetLock(true)}>
            <Lock />
            {t("bulkLock")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void bulkSetLock(false)}>
            <LockOpen />
            {t("bulkUnlock")}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => void bulkDelete()}>
            <Trash2 />
            {t("bulkDelete")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            <X />
            {t("bulkClear")}
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={CalendarDays} title={tCommon("noResults")} description={t("empty")} />
      ) : resourceBoards ? (
        <div className="space-y-6">
          {resourceBoards.map((board) => (
            <div key={board.key}>
              <h3 className="mb-2 text-sm font-semibold">
                {board.label}
                <span className="ml-2 font-normal text-muted-foreground">
                  {t("lessonCount", { count: board.lessons.length })}
                </span>
              </h3>
              <TimetableGrid
                lessons={board.lessons}
                editable
                onLessonClick={(lesson) => openEditor(lesson.id)}
                onLessonChange={handleGridChange}
                validateChange={validateChange}
                onInvalidDrop={handleInvalidDrop}
                onDropOutside={handleDropOutside}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSlotClick={
                  lunchMode ? (day, minute) => void placeLunch(day, minute) : openCreate
                }
                bands={lunchBands}
                onBandMove={(id, day, minute) => void moveLunch(id, day, minute)}
                onBandRemove={(id) => void removeLunch(id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <TimetableGrid
          ref={gridRef}
          lessons={gridLessons}
          editable
          onLessonClick={(lesson) => openEditor(lesson.id)}
          onLessonChange={handleGridChange}
          validateChange={validateChange}
          onInvalidDrop={handleInvalidDrop}
          onDropOutside={handleDropOutside}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSlotClick={lunchMode ? (day, minute) => void placeLunch(day, minute) : openCreate}
          bands={lunchBands}
          onBandMove={(id, day, minute) => void moveLunch(id, day, minute)}
          onBandRemove={(id) => void removeLunch(id)}
        />
      )}

      {/*
        The tray. Always rendered, even empty, because it is a DROP TARGET: a
        lesson dragged off the grid has to have somewhere to land, and a zone
        that appears only once something is in it cannot receive the first one.
        Dragging a card back onto the grid works in the combined view, which is
        the one grid the ref can reach; in the board views the card offers
        "sätt tillbaka" instead.
      */}
      <section
        ref={trayRef}
        data-testid="lesson-tray"
        aria-labelledby="lesson-tray-title"
        className={cn(
          "mt-4 rounded-lg border border-dashed p-3",
          parked.length === 0 ? "text-muted-foreground" : "bg-card",
        )}
      >
        <h2 id="lesson-tray-title" className="mb-1 text-sm font-semibold">
          {t("trayTitle")}
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">{t("trayHint")}</p>
        {parked.length === 0 ? (
          <p className="text-sm">{t("trayEmpty")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {parked.map((lesson) => (
              <li
                key={lesson.id}
                className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-sm"
              >
                <button
                  type="button"
                  aria-label={t("dragToPlace", { lesson: lessonName(lesson) })}
                  className={cn(
                    "text-left",
                    groupBy === "none" ? "cursor-grab" : "cursor-default",
                  )}
                  onPointerDown={(event) => {
                    if (groupBy === "none") beginTrayDrag(lesson, event);
                  }}
                >
                  <span className="font-medium">{lessonName(lesson)}</span>
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                    {t("parkedFrom", {
                      day: tDays(String(lesson.dayOfWeek)),
                      start: toHHMM(lesson.startTime),
                      end: toHHMM(lesson.endTime),
                    })}
                  </span>
                </button>
                <Button variant="ghost" size="sm" onClick={() => putBack(lesson)}>
                  {t("putBack")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Edit dialog ---------------- */}
      {/*
        Each of the four dialogs below is mounted from its first open onward and
        never unmounted again, like the create, versions and room dialogs:
        closing keeps it in the tree so it animates out as before, and nothing
        is mounted for a dialog nobody opens. Their code is fetched right
        after the page mounts (see loadLessonDialogs), and a fetch that fails
        is caught here and reported (see lessonDialogsFailed).
      */}
      <DialogLoadBoundary key={`lessons-${dialogsAttempt}`} onError={lessonDialogsFailed}>
        {confirmUsed && (
          <Suspense fallback={null}>
            <SharedMoveDialog
              open={confirming !== null}
              classNames={(confirming?.classes ?? [])
                .map((id) => groupById.get(id)?.name ?? id)
                .join(", ")}
              onCancel={() => setConfirming(null)}
              onConfirm={() => {
                if (!confirming) return;
                applyGridChange(confirming.lesson, confirming.change);
                setConfirming(null);
              }}
            />
          </Suspense>
        )}

        {editUsed && (
          <Suspense fallback={null}>
            <LessonEditDialog
              open={editing !== null}
              onOpenChange={(open) => {
                if (!open) {
                  setEditing(null);
                  setRemoteEditing(null);
                }
              }}
              lessonName={editing ? lessonName(editing) : null}
              draft={editDraft}
              onDraftChange={setEditDraft}
              rooms={rooms ?? []}
              teachers={teachers}
              onDelete={doDelete}
              deletePending={deleteLesson.isPending}
              onDuplicate={doDuplicate}
              onPark={() => {
                if (!editing) return;
                park(editing);
                setEditing(null);
                setRemoteEditing(null);
              }}
              onCancel={() => setEditing(null)}
              onSave={doSaveEdit}
              savePending={updateLesson.isPending}
              none={NONE}
            />
          </Suspense>
        )}

        {/* ---------------- Create dialog ---------------- */}
        {/*
          Mounted from the first lesson added onward, and never unmounted
          again: closing keeps it in the tree so it animates out as before.
        */}
        {createUsed && (
          <Suspense fallback={null}>
            <CreateLessonDialog
              draft={creating}
              onDraftChange={setCreating}
              onClose={() => {
                setCreating(null);
                setSlotMatches(null);
              }}
              subjects={subjects ?? []}
              groups={yearGroups}
              rooms={rooms ?? []}
              teachers={teachers}
              students={students}
              groupById={groupById}
              teacherById={teacherById}
              slotMatches={slotMatches}
              onSlotMatchesChange={setSlotMatches}
              onSearchSlots={runSlotSearch}
              onCreate={() => void doCreate()}
              pending={createLesson.isPending}
              none={NONE}
            />
          </Suspense>
        )}

        {/* ---------------- Smart placement suggestions ---------------- */}
        {suggestUsed && (
          <Suspense fallback={null}>
            <SuggestPlacementsDialog
              open={suggesting !== null}
              options={suggesting?.options ?? []}
              onPick={(option) => void applySuggestion(option)}
              onClose={() => setSuggesting(null)}
            />
          </Suspense>
        )}
      </DialogLoadBoundary>

      {/* ---------------- Versions dialog ---------------- */}
      {versionsUsed && (
        <Suspense fallback={null}>
          <VersionsDialog
            open={versionsOpen}
            onOpenChange={setVersionsOpen}
            academicYearId={shownYear?.id ?? null}
            lessons={lessons}
            subjectById={subjectById}
            teacherById={teacherById}
            roomById={roomById}
            personById={personById}
            groupLabel={groupLabel}
            onRestored={afterRestore}
            showError={showError}
          />
        </Suspense>
      )}

      {/* ---------------- Room optimisation dialog ---------------- */}
      {/*
        Mounted from the first press onward and never unmounted again, which is
        what makes the import above cost nothing until then. Not `roomsOpen`:
        the dialog abandons an ask in flight when it is closed and relies on
        outliving that close to ignore the answer when it lands (see its `ask`
        ref) — unmounting it would drop the guard the dialog documents.
      */}
      {roomsUsed && (
        <Suspense fallback={null}>
          <RoomOptimizationDialog
            open={roomsOpen}
            onOpenChange={setRoomsOpen}
            academicYearId={shownYear?.id ?? null}
            rooms={rooms ?? []}
            teachers={teachers}
            groups={groups ?? []}
            onApplied={afterRoomOptimization}
          />
        </Suspense>
      )}

      {/* ---------------- Publish dialog ---------------- */}
      <DialogLoadBoundary key={`publish-${dialogsAttempt}`} onError={lessonDialogsFailed}>
        {publishUsed && (
          <Suspense fallback={null}>
            <PublishDialog
              open={publishOpen}
              onOpenChange={setPublishOpen}
              lunchEnabled={lunchSettings?.lunchEnabled === true}
              fromDate={fromDate}
              onFromDateChange={setFromDate}
              toDate={toDate}
              onToDateChange={setToDate}
              onPublish={doPublish}
              pending={publish.isPending}
            />
          </Suspense>
        )}
      </DialogLoadBoundary>
    </div>
  );
}
