"use client";

import { Suspense, lazy, useCallback, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  Copy,
  Download,
  GitCompareArrows,
  History,
  Loader2,
  Lock,
  LockOpen,
  ParkingSquare,
  FileText,
  Footprints,
  Plus,
  Printer,
  Redo2,
  Sparkles,
  Trash2,
  TriangleAlert,
  UtensilsCrossed,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  useActiveYear,
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
  useScheduleVersionActions,
  useScheduleVersionDetail,
  useScheduleVersions,
  useSubjects,
  useUpdateMasterLesson,
  type CreateMasterLessonInput,
  type VersionLesson,
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
import { ApiError } from "@/lib/api";
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
 * decimal. With all three splits on lazy() the route measures 188.8KB
 * (2026-10-06). React is in every route already, so lazy() costs nothing on
 * top.
 * No lazy component is reachable during SSR: editing, creating, publishOpen
 * and roomsUsed are all falsy at first render, and Radix Dialog does not
 * mount its content while closed.
 */
const RoomOptimizationDialog = lazy(() =>
  import("@/components/schedule/room-optimization-dialog").then((module) => ({
    default: module.RoomOptimizationDialog,
  })),
);
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
/*
 * Fetched with the dialog that shows them. The grid needs the badge above on
 * every card, but the fields themselves are only ever edited inside Justera or
 * Lägg till — and they carry components/ui/date-field.tsx, 546 lines of date
 * picker, which the page otherwise paid for to draw a week.
 */
const RecurrenceFields = lazy(() =>
  import("@/components/schedule/recurrence-fields").then((module) => ({
    default: module.RecurrenceFields,
  })),
);
/** Holds the recurrence box's place in a dialog's grid while its code arrives. */
function RecurrenceFieldsFallback() {
  return (
    <div className="col-span-2 space-y-3 rounded-md border p-3">
      <Skeleton className="h-14" />
      <Skeleton className="h-14" />
    </div>
  );
}
import type { LessonRecurrence, MasterLesson } from "@/lib/types";
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
  findOpenSlots,
  pupilBufferOf,
  suggestPlacements,
  teacherIdsOf,
  toPlacement,
  validatePlacement,
  type OpenSlotMatch,
  type Placement,
  type PlacementSuggestion,
} from "@/lib/conflicts";
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
import { Input } from "@/components/ui/input";
// The page's own two date fields are the publishing dates, inside that dialog.
const DateField = lazy(() =>
  import("@/components/ui/date-field").then((module) => ({
    default: module.DateField,
  })),
);
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/**
 * Whether a lesson is on the tray. A snapshot stored before the gateway
 * carried the flag has no key, read as false: restore gives an absent key the
 * same reading, so a diff against such a snapshot still says what restoring it
 * would do.
 */
function isOnTray(lesson: { isParked?: boolean }): boolean {
  return lesson.isParked ?? false;
}

/** A lesson on either side of the version diff. */
type DiffLesson = VersionLesson | MasterLesson;

/**
 * Which weeks a lesson runs. A snapshot stored before the gateway carried it
 * has no key, and restore writes ALL_WEEKS for that — so the diff reads it so.
 */
function weeksOf(lesson: { recurrence?: LessonRecurrence }): LessonRecurrence {
  return lesson.recurrence ?? "ALL_WEEKS";
}

/**
 * One end of a lesson's date window, read the way restore reads it: the first
 * ten characters, and null for an absent or empty value. Both sides send
 * YYYY-MM-DD, but restore takes a full timestamp too, and the diff must not
 * call a snapshot different for how it spelled a date restore reads the same.
 */
function dayOf(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
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

interface CreateDraft {
  subjectId: string;
  studentGroupId: string;
  /** Additional classes attending the lesson (must also be free). */
  extraGroupIds: string[];
  /** Individual participating students from any class. */
  studentIds: string[];
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  roomId: string;
  teacherId: string;
  isLocked: boolean;
  recurrence: LessonRecurrence;
  startDate: string;
  endDate: string;
}

type GroupBy = "none" | "teacher" | "room" | "group";

export default function TimetablePage() {
  const t = useTranslations("timetable");
  const tLunch = useTranslations("lunch");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const { activeYear } = useActiveYear();
  const { data: lessons, isLoading } = useMasterLessons(activeYear?.id ?? null);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();
  const { data: constraints } = useConstraints();
  const { data: requirements } = useRequirements(activeYear?.id ?? null);
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
  const [editDay, setEditDay] = useState("1");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editRoom, setEditRoom] = useState(NONE);
  const [editTeacher, setEditTeacher] = useState(NONE);
  const [editLocked, setEditLocked] = useState(false);
  const [editRecurrence, setEditRecurrence] = useState<LessonRecurrence>("ALL_WEEKS");
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");

  const [creating, setCreating] = useState<CreateDraft | null>(null);
  const [slotMatches, setSlotMatches] = useState<OpenSlotMatch[] | null>(null);
  const [studentFilter, setStudentFilter] = useState("");
  const [suggesting, setSuggesting] = useState<{
    lesson: MasterLesson;
    options: PlacementSuggestion[];
  } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionName, setVersionName] = useState("");
  const [roomsOpen, setRoomsOpen] = useState(false);
  // Whether the room dialog has been asked for at all this visit, which is what
  // decides that its code is fetched — see where it is rendered.
  const [roomsUsed, setRoomsUsed] = useState(false);
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

  const { data: versions } = useScheduleVersions(
    versionsOpen ? (activeYear?.id ?? null) : null,
  );
  const versionActions = useScheduleVersionActions();
  const [comparingId, setComparingId] = useState<string | null>(null);
  const { data: comparing } = useScheduleVersionDetail(comparingId);

  /*
   * The groups, split by kind. A school has a couple of dozen classes and can
   * have hundreds of teaching groups — Kunskapsskolan has 24 and 300 — so one
   * flat list buries the class a rektor is looking for.
   */
  const groupSections = useMemo(() => {
    const named = (group: { id: string; name: string }) => ({ id: group.id, name: group.name });
    return [
      {
        label: t("filterKindClasses"),
        options: (groups ?? []).filter((group) => group.kind === "CLASS").map(named),
      },
      {
        label: t("filterKindTeachingGroups"),
        options: (groups ?? []).filter((group) => group.kind !== "CLASS").map(named),
      },
    ];
  }, [groups, t]);

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
  const { data: lunchSittings } = useLunchSittings(activeYear?.id ?? null);
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
    onlyGroup !== null && lunchSettings?.lunchEnabled === true && activeYear != null;
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
      if (error instanceof ApiError && error.status === 409) {
        toast.error(`${t("editConflict")}: ${error.message}`);
      } else {
        toast.error(error instanceof Error ? error.message : tCommon("error"));
      }
    },
    [t, tCommon],
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
          toast.success(editSavedMessage(result)),
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
      const options = suggestPlacements(candidate, placements, constraints ?? [], {
        days: hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
        studentGroupOf,
      });
      setSuggesting({ lesson, options });
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
      toast.success(editSavedMessage(result));
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

  const doSaveVersion = async () => {
    if (!activeYear || !versionName.trim()) return;
    try {
      await versionActions.save.mutateAsync({
        academicYearId: activeYear.id,
        name: versionName.trim(),
      });
      setVersionName("");
      toast.success(t("versionSaved"));
    } catch (error) {
      showError(error);
    }
  };

  const doRestoreVersion = async (id: string) => {
    try {
      const result = await versionActions.restore.mutateAsync(id);
      history.clear(); // full replace — the local command stack no longer applies
      setSelectedIds(new Set());
      toast.success(t("versionRestored", { count: result.restoredLessons }));
    } catch (error) {
      showError(error);
    }
  };

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
    if (!onlyGroup || !activeYear) return;
    const before = sittingOn(dayOfWeek);
    const body = {
      academicYearId: activeYear.id,
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
    if (!sitting || !activeYear) return;
    const body = {
      academicYearId: activeYear.id,
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
    setEditDay(String(lesson.dayOfWeek));
    setEditStart(toHHMM(lesson.startTime));
    setEditEnd(toHHMM(lesson.endTime));
    setEditRoom(lesson.roomId ?? NONE);
    setEditTeacher(lesson.teacherId ?? NONE);
    setEditLocked(lesson.isLocked);
    setEditRecurrence(lesson.recurrence);
    setEditStartDate(lesson.startDate ?? "");
    setEditEndDate(lesson.endDate ?? "");
  };

  const doSaveEdit = async () => {
    if (!editing) return;
    try {
      const result = await undoableUpdate(editing, {
        dayOfWeek: Number(editDay),
        startTime: editStart,
        endTime: editEnd,
        roomId: editRoom === NONE ? null : editRoom,
        teacherId: editTeacher === NONE ? null : editTeacher,
        isLocked: editLocked,
        recurrence: editRecurrence,
        // An empty field means "the academic year's own boundary", which the
        // API stores as null — not as an empty string.
        startDate: editStartDate === "" ? null : editStartDate,
        endDate: editEndDate === "" ? null : editEndDate,
      });
      toast.success(editSavedMessage(result));
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
  };

  const applySlot = (match: OpenSlotMatch) => {
    if (!creating) return;
    setCreating({
      ...creating,
      dayOfWeek: String(match.dayOfWeek),
      startTime: minutesToHHMM(match.startMinutes),
      endTime: minutesToHHMM(match.endMinutes),
      teacherId: match.teacherId,
    });
  };

  const toggleExtraGroup = (groupId: string) => {
    if (!creating) return;
    setSlotMatches(null);
    setCreating({
      ...creating,
      extraGroupIds: creating.extraGroupIds.includes(groupId)
        ? creating.extraGroupIds.filter((id) => id !== groupId)
        : [...creating.extraGroupIds, groupId],
    });
  };

  const doCreate = async () => {
    if (!creating || !activeYear) return;
    try {
      await undoableCreate({
        academicYearId: activeYear.id,
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
  // Export & diff
  // -------------------------------------------------------------------

  /**
   * One line of the version diff. Every part of the diff's key shows here:
   * a part the key holds and the line leaves out turns a teacher swap into a
   * + and a − that read the same, a difference reported and then hidden.
   *
   * The pupils are counted unless `namePupils`. A list of them is too long for
   * every line, so they are named only where they are what differs.
   */
  const lessonLabel = useCallback(
    (l: DiffLesson, namePupils: boolean) => {
      const nameOf = (id: string) => {
        const teacher = teacherById.get(id);
        return teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : "?";
      };
      const startDate = dayOf(l.startDate);
      const endDate = dayOf(l.endDate);
      const period =
        startDate && endDate
          ? `${startDate}–${endDate}`
          : startDate
            ? t("diffFrom", { date: startDate })
            : endDate
              ? t("diffUntil", { date: endDate })
              : null;
      const pupils = l.studentIds ?? [];
      const pupilNames = () =>
        pupils
          .map((id) => {
            const pupil = personById.get(id);
            return pupil ? `${pupil.firstName} ${pupil.lastName}` : "?";
          })
          .sort()
          .join(", ");
      return [
        subjectById.get(l.subjectId)?.name ?? "?",
        groupLabel({
          studentGroupId: l.studentGroupId,
          extraGroupIds: l.extraGroupIds ?? [],
        }) || "?",
        // Where a parked lesson was is not where it is: the tray is.
        isOnTray(l)
          ? t("diffOnTray")
          : `${tDays(String(l.dayOfWeek))} ${toHHMM(l.startTime)}–${toHHMM(l.endTime)}`,
        l.teacherId ? nameOf(l.teacherId) : null,
        l.coTeacherId ? t("diffCoTeacher", { name: nameOf(l.coTeacherId) }) : null,
        l.roomId ? t("diffRoom", { name: roomById.get(l.roomId)?.name ?? "?" }) : null,
        recurrenceBadge({ recurrence: weeksOf(l), startDate, endDate }, t),
        period,
        pupils.length === 0
          ? null
          : namePupils
            ? `⊕ ${pupilNames()}`
            : `⊕${pupils.length}`,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    [subjectById, groupLabel, teacherById, roomById, personById, t, tDays],
  );

  const versionDiff = useMemo(() => {
    if (!comparing || !lessons) return null;
    // A slot is part of a lesson's identity only on the grid. On the tray it
    // is a memory, so two versions whose parked lessons remember different
    // hours hold the same timetable — while a lesson parked in one and placed
    // at its remembered hour in the other is a change, the one a restore makes.
    //
    // Everything else a restore writes that says who is in the room, and in
    // which weeks, is in the key too, each read the way restore reads a key
    // the snapshot lacks. Without them a lesson moved to odd weeks, or cut to
    // half a term, came out identical to a snapshot that restoring would
    // change. The classes and pupils are sets, so they are compared sorted.
    // `pupils` false leaves the pupils out, to find pairs differing in nothing
    // else.
    const key = (l: DiffLesson, pupils = true) =>
      [
        l.subjectId,
        l.studentGroupId,
        l.teacherId ?? "",
        l.coTeacherId ?? "",
        l.roomId ?? "",
        ...(isOnTray(l)
          ? ["tray"]
          : [l.dayOfWeek, toHHMM(l.startTime), toHHMM(l.endTime)]),
        weeksOf(l),
        dayOf(l.startDate) ?? "",
        dayOf(l.endDate) ?? "",
        [...(l.extraGroupIds ?? [])].sort().join(","),
        pupils ? [...(l.studentIds ?? [])].sort().join(",") : "",
      ].join("|");
    // Counted rather than put in a map: without the slot, two lessons of one
    // class and teacher on the tray share a key, and a map keeps only one of
    // them — parking a second would read as no change at all.
    const unmatched = (side: DiffLesson[], other: DiffLesson[]) => {
      const left = new Map<string, number>();
      for (const l of other) left.set(key(l), (left.get(key(l)) ?? 0) + 1);
      return side.filter((l) => {
        const k = key(l);
        const n = left.get(k) ?? 0;
        if (n > 0) left.set(k, n - 1);
        return n === 0;
      });
    };
    const added = unmatched(lessons, comparing.lessons);
    const removed = unmatched(comparing.lessons, lessons);
    // An added and a removed line never share a whole key, so two that agree
    // on everything but the pupils differ in the pupils alone. Counted, such a
    // pair would print alike; those lines name them.
    const lines = (side: DiffLesson[], other: DiffLesson[]) => {
      const rest = new Set(other.map((l) => key(l, false)));
      return side.map((lesson) => ({ lesson, namePupils: rest.has(key(lesson, false)) }));
    };
    return { added: lines(added, removed), removed: lines(removed, added) };
  }, [comparing, lessons]);

  const doExportIcs = async () => {
    if (!activeYear) return;
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
        yearStart: activeYear.startDate,
        yearEnd: activeYear.endDate,
      },
    );
    downloadIcs("timetable.ics", ics);
    toast.success(t("icsExported", { count: filtered.length }));
  };

  const doExportPdf = async () => {
    const { exportTimetablePdf } = await import("@/lib/pdf");
    await exportTimetablePdf({
      title: t("title"),
      subtitle: activeYear?.name,
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
    if (!activeYear) return;
    try {
      const result = await publish.mutateAsync({
        academicYearId: activeYear.id,
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
              disabled={!activeYear}
            >
              <Plus />
              {t("addLesson")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setVersionsOpen(true)}
              disabled={!activeYear}
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
              disabled={!activeYear || !lessons || lessons.length === 0}
            >
              <Footprints />
              {t("optimizeRooms")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={doExportIcs}
              disabled={!activeYear || filtered.length === 0}
              title={t("exportIcs")}
            >
              <Download />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={doExportPdf}
              disabled={!activeYear || filtered.length === 0}
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
                setFromDate(activeYear?.startDate ?? "");
                setToDate(activeYear?.endDate ?? "");
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
                href="/admin/generate"
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
      {/* A drag that lands on classes the administrator was not looking at. */}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sharedMoveTitle")}</DialogTitle>
            <DialogDescription>
              {/* The classes BY NAME. "Flera klasser berörs" would be the same
                  silence the "+1" badge kept: it tells you something is at
                  stake without telling you what. */}
              {t("sharedMoveBody", {
                classes: (confirming?.classes ?? [])
                  .map((id) => groupById.get(id)?.name ?? id)
                  .join(", "),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!confirming) return;
                applyGridChange(confirming.lesson, confirming.change);
                setConfirming(null);
              }}
            >
              {t("sharedMoveConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setRemoteEditing(null);
          }
        }}
      >
        {/* The component's own max-w-lg, not the max-w-md this used to narrow it
            to: two selects, two clocks and five buttons need the width, and a
            dialog narrower than its content scrolls sideways. */}
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            {/* WHICH lesson. Three maths lessons on a Tuesday all opened on the
                same "Justera lektion", and the reader had to remember which one
                they had clicked. */}
            <DialogDescription>
              {editing ? (
                <span className="block font-medium text-foreground">
                  {lessonName(editing)}
                </span>
              ) : null}
              {t("editBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 [&>*]:min-w-0">
            <div className="col-span-2 space-y-2">
              <Label>{t("editDay")}</Label>
              <Select value={editDay} onValueChange={setEditDay}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {tDays(String(day))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-start">{t("editStart")}</Label>
              <Input
                id="edit-start"
                type="time"
                value={editStart}
                onChange={(e) => setEditStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-end">{t("editEnd")}</Label>
              <Input
                id="edit-end"
                type="time"
                value={editEnd}
                onChange={(e) => setEditEnd(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("editRoom")}</Label>
              <Select value={editRoom} onValueChange={setEditRoom}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("noRoom")}</SelectItem>
                  {(rooms ?? []).map((room) => (
                    <SelectItem key={room.id} value={room.id}>
                      {room.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("editTeacher")}</Label>
              <Select value={editTeacher} onValueChange={setEditTeacher}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("noTeacher")}</SelectItem>
                  {teachers.map((teacher) => (
                    <SelectItem key={teacher.id} value={teacher.id}>
                      {teacher.firstName} {teacher.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Suspense fallback={<RecurrenceFieldsFallback />}>
              <RecurrenceFields
                idPrefix="edit"
                value={{
                  recurrence: editRecurrence,
                  startDate: editStartDate,
                  endDate: editEndDate,
                }}
                onChange={(next) => {
                  setEditRecurrence(next.recurrence);
                  setEditStartDate(next.startDate);
                  setEditEndDate(next.endDate);
                }}
              />
            </Suspense>
            <div className="col-span-2 flex items-center justify-between rounded-md border px-3 py-2">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">{t("lockLabel")}</div>
                  <div className="text-xs text-muted-foreground">{t("lockHint")}</div>
                </div>
              </div>
              <Switch checked={editLocked} onCheckedChange={setEditLocked} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("propagateHint")}</p>
          <DialogFooter className="gap-2 sm:justify-between">
            {/* Both groups WRAP. Five buttons on one row is the overflow that
                put a sideways scrollbar on this dialog; a second row is what a
                narrow window gets instead. */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={doDelete}
                disabled={deleteLesson.isPending}
              >
                <Trash2 />
                {t("deleteLesson")}
              </Button>
              <Button variant="outline" size="sm" onClick={doDuplicate}>
                <Copy />
                {t("duplicateLesson")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!editing) return;
                  park(editing);
                  setEditing(null);
                  setRemoteEditing(null);
                }}
              >
                <ParkingSquare />
                {t("park")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                {tCommon("cancel")}
              </Button>
              <Button
                onClick={doSaveEdit}
                disabled={updateLesson.isPending || !editStart || !editEnd}
              >
                {updateLesson.isPending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {tCommon("saving")}
                  </>
                ) : (
                  tCommon("save")
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Create dialog ---------------- */}
      <Dialog
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(null);
            setSlotMatches(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("addTitle")}</DialogTitle>
            <DialogDescription>{t("addBody")}</DialogDescription>
          </DialogHeader>
          {creating ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("addSubject")}</Label>
                <Select
                  value={creating.subjectId || undefined}
                  onValueChange={(value) =>
                    setCreating({ ...creating, subjectId: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("addSubject")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(subjects ?? []).map((subject) => (
                      <SelectItem key={subject.id} value={subject.id}>
                        {subject.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("addGroup")}</Label>
                <Select
                  value={creating.studentGroupId || undefined}
                  onValueChange={(value) =>
                    setCreating({ ...creating, studentGroupId: value })
                  }
                >
                  {/* Named here: a Label beside a Radix trigger is not tied to
                      it, so this dialog read as a row of unnamed comboboxes. */}
                  <SelectTrigger aria-label={t("addGroup")}>
                    <SelectValue placeholder={t("addGroup")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(groups ?? []).map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-3 rounded-md border p-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Sparkles className="h-4 w-4" />
                    {t("slotFinderTitle")}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("slotFinderHint")}</p>
                </div>
                {(groups ?? []).filter((group) => group.id !== creating.studentGroupId)
                  .length > 0 ? (
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">
                      {t("slotFinderAlsoFree")}
                    </div>
                    {/*
                      Capped like its two siblings below, which have had
                      `max-h` and a scroll all along — this list was the one
                      that did not, and it is the one that grows with the
                      school. Forty teaching groups made the dialog taller than
                      the window.
                    */}
                    <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                      {(groups ?? [])
                        .filter((group) => group.id !== creating.studentGroupId)
                        .map((group) => (
                          <button
                            key={group.id}
                            type="button"
                            onClick={() => toggleExtraGroup(group.id)}
                            className={
                              creating.extraGroupIds.includes(group.id)
                                ? "rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground"
                                : "rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                            }
                          >
                            {group.name}
                          </button>
                        ))}
                    </div>
                  </div>
                ) : null}
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">
                    {t("participantStudents")}
                  </div>
                  {creating.studentIds.length > 0 ? (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {creating.studentIds.map((studentId) => {
                        const student = students.find((entry) => entry.id === studentId);
                        return (
                          <button
                            key={studentId}
                            type="button"
                            onClick={() =>
                              setCreating({
                                ...creating,
                                studentIds: creating.studentIds.filter(
                                  (id) => id !== studentId,
                                ),
                              })
                            }
                            className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
                            title={tCommon("delete")}
                          >
                            {student
                              ? `${student.firstName} ${student.lastName} ×`
                              : "×"}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <Input
                    placeholder={t("participantSearch")}
                    value={studentFilter}
                    onChange={(e) => setStudentFilter(e.target.value)}
                    className="mb-1 h-8"
                  />
                  {studentFilter.trim().length > 0 ? (
                    <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border p-1">
                      {students
                        .filter(
                          (student) =>
                            !creating.studentIds.includes(student.id) &&
                            `${student.firstName} ${student.lastName}`
                              .toLowerCase()
                              .includes(studentFilter.trim().toLowerCase()),
                        )
                        .slice(0, 8)
                        .map((student) => (
                          <button
                            key={student.id}
                            type="button"
                            onClick={() => {
                              setSlotMatches(null);
                              setCreating({
                                ...creating,
                                studentIds: [...creating.studentIds, student.id],
                              });
                              setStudentFilter("");
                            }}
                            className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent"
                          >
                            <span>
                              {student.firstName} {student.lastName}
                            </span>
                            <span className="text-muted-foreground">
                              {student.studentGroupId
                                ? (groupById.get(student.studentGroupId)?.name ?? "")
                                : ""}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runSlotSearch}
                  disabled={!creating.subjectId || !creating.studentGroupId}
                >
                  {t("slotFinderSearch")}
                </Button>
                {slotMatches !== null ? (
                  slotMatches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("slotFinderNone")}
                    </p>
                  ) : (
                    <div className="max-h-44 space-y-1 overflow-y-auto">
                      {slotMatches.map((match) => {
                        const teacher = teacherById.get(match.teacherId);
                        return (
                          <button
                            key={`${match.dayOfWeek}-${match.startMinutes}-${match.teacherId}`}
                            type="button"
                            onClick={() => applySlot(match)}
                            className="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                          >
                            <span className="font-medium">
                              {tDays(String(match.dayOfWeek))}{" "}
                              <span className="tabular-nums">
                                {minutesToHHMM(match.startMinutes)}–
                                {minutesToHHMM(match.endMinutes)}
                              </span>
                            </span>
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              {teacher
                                ? `${teacher.firstName[0]}. ${teacher.lastName}`
                                : "—"}
                              <span
                                className={
                                  match.isFallback
                                    ? "rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                                    : "rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800"
                                }
                              >
                                {match.isFallback
                                  ? t("slotFinderFallback")
                                  : t("slotFinderAssigned")}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )
                ) : null}
              </div>
              <div className="col-span-2 space-y-2">
                <Label>{t("editDay")}</Label>
                <Select
                  value={creating.dayOfWeek}
                  onValueChange={(value) =>
                    setCreating({ ...creating, dayOfWeek: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {tDays(String(day))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-start">{t("editStart")}</Label>
                <Input
                  id="create-start"
                  type="time"
                  value={creating.startTime}
                  onChange={(e) =>
                    setCreating({ ...creating, startTime: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-end">{t("editEnd")}</Label>
                <Input
                  id="create-end"
                  type="time"
                  value={creating.endTime}
                  onChange={(e) =>
                    setCreating({ ...creating, endTime: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>{t("editRoom")}</Label>
                <Select
                  value={creating.roomId}
                  onValueChange={(value) =>
                    setCreating({ ...creating, roomId: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("noRoom")}</SelectItem>
                    {(rooms ?? []).map((room) => (
                      <SelectItem key={room.id} value={room.id}>
                        {room.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("editTeacher")}</Label>
                <Select
                  value={creating.teacherId}
                  onValueChange={(value) =>
                    setCreating({ ...creating, teacherId: value })
                  }
                >
                  <SelectTrigger aria-label={t("editTeacher")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("noTeacher")}</SelectItem>
                    {teachers.map((teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {teacher.firstName} {teacher.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Suspense fallback={<RecurrenceFieldsFallback />}>
                <RecurrenceFields
                  idPrefix="create"
                  value={{
                    recurrence: creating.recurrence,
                    startDate: creating.startDate,
                    endDate: creating.endDate,
                  }}
                  onChange={(next) => setCreating({ ...creating, ...next })}
                />
              </Suspense>
              <div className="col-span-2 flex items-center justify-between rounded-md border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{t("lockLabel")}</div>
                    <div className="text-xs text-muted-foreground">{t("lockHint")}</div>
                  </div>
                </div>
                <Switch
                  checked={creating.isLocked}
                  onCheckedChange={(checked) =>
                    setCreating({ ...creating, isLocked: checked })
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={doCreate}
              disabled={
                createLesson.isPending ||
                !creating ||
                !creating.subjectId ||
                !creating.studentGroupId ||
                !creating.startTime ||
                !creating.endTime
              }
            >
              {createLesson.isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  {tCommon("saving")}
                </>
              ) : (
                t("addConfirm")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Smart placement suggestions ---------------- */}
      <Dialog
        open={suggesting !== null}
        onOpenChange={(open) => !open && setSuggesting(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              {t("suggestTitle")}
            </DialogTitle>
            <DialogDescription>{t("suggestBody")}</DialogDescription>
          </DialogHeader>
          {suggesting && suggesting.options.length > 0 ? (
            <div className="space-y-2">
              {suggesting.options.map((option) => (
                <button
                  key={`${option.dayOfWeek}-${option.startMinutes}`}
                  type="button"
                  onClick={() => void applySuggestion(option)}
                  className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span className="font-medium">{tDays(String(option.dayOfWeek))}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {minutesToHHMM(option.startMinutes)}–{minutesToHHMM(option.endMinutes)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("suggestNone")}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuggesting(null)}>
              {tCommon("cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Versions dialog ---------------- */}
      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("versionsTitle")}</DialogTitle>
            <DialogDescription>{t("versionsBody")}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              placeholder={t("versionNamePlaceholder")}
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
            />
            <Button
              onClick={doSaveVersion}
              disabled={versionActions.save.isPending || !versionName.trim()}
            >
              {versionActions.save.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                t("versionSave")
              )}
            </Button>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {(versions ?? []).length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t("versionsEmpty")}
              </p>
            ) : (
              (versions ?? []).map((version) => (
                <div
                  key={version.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{version.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString()} ·{" "}
                      {t("lessonCount", { count: version.lessonCount })}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setComparingId(comparingId === version.id ? null : version.id)
                      }
                      title={t("versionCompare")}
                    >
                      <GitCompareArrows />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void doRestoreVersion(version.id)}
                      disabled={versionActions.restore.isPending}
                    >
                      {t("versionRestore")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void versionActions.remove.mutateAsync(version.id)}
                      disabled={versionActions.remove.isPending}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          {comparingId && versionDiff ? (
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-sm font-semibold">
                {t("diffTitle", { name: comparing?.name ?? "" })}
              </h4>
              {versionDiff.added.length === 0 && versionDiff.removed.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("diffIdentical")}</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-emerald-700">
                      {t("diffAdded", { count: versionDiff.added.length })}
                    </div>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {versionDiff.added.slice(0, 8).map(({ lesson, namePupils }, index) => (
                        <li key={index}>+ {lessonLabel(lesson, namePupils)}</li>
                      ))}
                      {versionDiff.added.length > 8 ? <li>…</li> : null}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-red-700">
                      {t("diffRemoved", { count: versionDiff.removed.length })}
                    </div>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {versionDiff.removed.slice(0, 8).map(({ lesson, namePupils }, index) => (
                        <li key={index}>− {lessonLabel(lesson, namePupils)}</li>
                      ))}
                      {versionDiff.removed.length > 8 ? <li>…</li> : null}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

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
            academicYearId={activeYear?.id ?? null}
            rooms={rooms ?? []}
            teachers={teachers}
            groups={groups ?? []}
            onApplied={afterRoomOptimization}
          />
        </Suspense>
      )}

      {/* ---------------- Publish dialog ---------------- */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("publishTitle")}</DialogTitle>
            <DialogDescription>{t("publishBody")}</DialogDescription>
          </DialogHeader>
          {lunchSettings?.lunchEnabled ? null : (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p>{tLunch("publishWarning")}</p>
                <Link
                  href="/admin/constraints"
                  className="font-medium underline underline-offset-4"
                >
                  {tLunch("publishWarningLink")}
                </Link>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="publish-from">{t("publishFrom")}</Label>
              <Suspense fallback={<Skeleton className="h-10 w-full" />}>
                <DateField
                  label={t("publishFrom")}
                  id="publish-from"
                  value={fromDate}
                  onChange={(value) => setFromDate(value)}
                />
              </Suspense>
            </div>
            <div className="space-y-2">
              <Label htmlFor="publish-to">{t("publishTo")}</Label>
              <Suspense fallback={<Skeleton className="h-10 w-full" />}>
                <DateField
                  label={t("publishTo")}
                  id="publish-to"
                  value={toDate}
                  onChange={(value) => setToDate(value)}
                />
              </Suspense>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={doPublish} disabled={publish.isPending}>
              {publish.isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("publishing")}
                </>
              ) : (
                t("publishConfirm")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
