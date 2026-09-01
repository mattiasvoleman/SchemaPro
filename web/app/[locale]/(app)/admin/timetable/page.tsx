"use client";

import { useCallback, useMemo, useState } from "react";
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
  FileText,
  Plus,
  Printer,
  Redo2,
  Sparkles,
  Trash2,
  TriangleAlert,
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
  useRoomPreferences,
} from "@/lib/queries";
import { buildIcs, downloadIcs } from "@/lib/ics";
import { exportTimetablePdf } from "@/lib/pdf";
import { useTimetableRealtime } from "@/lib/use-timetable-realtime";
import { ApiError } from "@/lib/api";
import { RecurrenceFields, recurrenceBadge } from "@/components/schedule/recurrence-fields";
import type { LessonRecurrence, MasterLesson } from "@/lib/types";
import { subjectColor, timeToMinutes } from "@/lib/utils";
import { audienceFor, buildRosterIndex, type Audience } from "@/lib/lesson-audience";
import {
  buildGroupConflictMap,
  detectConflicts,
  findOpenSlots,
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
} from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
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

const ALL = "__all__";
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

  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [teacherFilter, setTeacherFilter] = useState<string>(ALL);
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
  const changeFilter = (set: (value: string) => void) => (value: string) => {
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
  const { data: roomRules } = useRoomPreferences();
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

  const placements = useMemo(
    () => (lessons ?? []).map(toPlacement),
    [lessons],
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
    if (groupFilter === ALL) return undefined;
    return (lunchSittings ?? [])
      .filter((sitting) => sitting.studentGroupId === groupFilter)
      .map((sitting) => ({
        id: sitting.id,
        dayOfWeek: sitting.dayOfWeek,
        startMinutes: timeToMinutes(sitting.startTime),
        endMinutes: timeToMinutes(sitting.endTime),
        label: tLunch("bandLabel"),
      }));
  }, [lunchSittings, groupFilter, tLunch]);

  /**
   * lessonId → what this lesson means for the class in view. Empty for "all".
   *
   * Resolved ONCE here rather than inside toGridLesson, which runs for every
   * card on every frame of a drag; the cards only ever read this map.
   */
  const audienceByLesson = useMemo(() => {
    const map = new Map<string, Audience>();
    if (groupFilter === ALL) return map;
    for (const lesson of lessons ?? []) {
      const audience = audienceFor(lesson, groupFilter, rosterIndex);
      if (audience) map.set(lesson.id, audience);
    }
    return map;
  }, [lessons, groupFilter, rosterIndex]);

  const filtered = useMemo(
    () =>
      (lessons ?? []).filter(
        (lesson) =>
          // Every lesson holding one of this class's pupils, not only the ones
          // filed under its name: 4.1's maths is filed under 4ma1, and the
          // pupils in it already saw it on their own phones — the RLS policy
          // calendar_lessons_teaching_group_select grants exactly that — while
          // the administrator filtering to 4.1 did not.
          (groupFilter === ALL || audienceByLesson.has(lesson.id)) &&
          // Both teachers. A lesson somebody only CO-taught was missing from
          // their own view — the filter asked a name question where the data
          // is a set.
          (teacherFilter === ALL ||
            teacherIdsOf(toPlacement(lesson)).includes(teacherFilter)),
      ),
    [lessons, groupFilter, teacherFilter, audienceByLesson],
  );

  const toGridLesson = useCallback(
    (lesson: MasterLesson): TimetableLesson => {
      const subject = subjectById.get(lesson.subjectId);
      const group = groupById.get(lesson.studentGroupId);
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
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
            [group?.name, ...lesson.extraGroupIds.map((id) => groupById.get(id)?.name)]
              .filter(Boolean)
              .join(" + "),
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
        remoteEditor: remoteEditors.get(lesson.id),
      };
    },
    [subjectById, groupById, teacherById, roomById, conflictMap, remoteEditors],
  );

  const gridLessons: TimetableLesson[] = useMemo(
    () => filtered.map(toGridLesson),
    [filtered, toGridLesson],
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

  useHistoryKeyboard(history, (kind, entry) => {
    if (entry) toast.info(kind === "undo" ? t("undone") : t("redone"));
  });

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

  const handleGridChange = useCallback(
    (id: string, change: LessonChange) => {
      const lesson = lessonById.get(id);
      if (!lesson) return;
      void undoableUpdate(lesson, {
        dayOfWeek: change.dayOfWeek,
        startTime: minutesToHHMM(change.startMinutes),
        endTime: minutesToHHMM(change.endMinutes),
      })
        .then((result) =>
          toast.success(editSavedMessage(result)),
        )
        .catch(showError);
    },
    [lessonById, undoableUpdate, showError, t],
  );

  /** Invalid drop → rank the nearest conflict-free slots and offer them. */
  const handleInvalidDrop = useCallback(
    (id: string, change: LessonChange) => {
      const lesson = lessonById.get(id);
      if (!lesson) return;
      const hasWeekend = (lessons ?? []).some((l) => l.dayOfWeek > 5);
      const options = suggestPlacements(
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
        },
        placements,
        constraints ?? [],
        {
          days: hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
          studentGroupOf,
        },
      );
      setSuggesting({ lesson, options });
    },
    [lessonById, lessons, placements, constraints, studentGroupOf],
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

  const openCreate = (dayOfWeek: number, startMinutes: number) => {
    setSlotMatches(null);
    setCreating({
      subjectId: "",
      studentGroupId: groupFilter !== ALL ? groupFilter : "",
      extraGroupIds: [],
      studentIds: [],
      dayOfWeek: String(dayOfWeek),
      recurrence: "ALL_WEEKS",
      startDate: "",
      endDate: "",
      startTime: minutesToHHMM(startMinutes),
      endTime: minutesToHHMM(Math.min(startMinutes + 60, 23 * 60 + 45)),
      roomId: NONE,
      teacherId: teacherFilter !== ALL ? teacherFilter : NONE,
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

  const lessonLabel = useCallback(
    (l: {
      subjectId: string;
      studentGroupId: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
    }) =>
      `${subjectById.get(l.subjectId)?.name ?? "?"} · ${
        groupById.get(l.studentGroupId)?.name ?? "?"
      } · ${tDays(String(l.dayOfWeek))} ${toHHMM(l.startTime)}–${toHHMM(l.endTime)}`,
    [subjectById, groupById, tDays],
  );

  const versionDiff = useMemo(() => {
    if (!comparing || !lessons) return null;
    const key = (l: VersionLesson | MasterLesson) =>
      [
        l.subjectId,
        l.studentGroupId,
        l.teacherId ?? "",
        l.roomId ?? "",
        l.dayOfWeek,
        toHHMM(l.startTime),
        toHHMM(l.endTime),
      ].join("|");
    const snapshotKeys = new Map(comparing.lessons.map((l) => [key(l), l]));
    const currentKeys = new Map(lessons.map((l) => [key(l), l]));
    const added = [...currentKeys.entries()]
      .filter(([k]) => !snapshotKeys.has(k))
      .map(([, l]) => l);
    const removed = [...snapshotKeys.entries()]
      .filter(([k]) => !currentKeys.has(k))
      .map(([, l]) => l);
    return { added, removed };
  }, [comparing, lessons]);

  const doExportIcs = () => {
    if (!activeYear) return;
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
            groupById.get(lesson.studentGroupId)?.name ?? "",
          ]
            .filter(Boolean)
            .join(" — "),
          location: lesson.roomId
            ? (roomById.get(lesson.roomId)?.name ?? undefined)
            : undefined,
          description: teacher
            ? `${teacher.firstName} ${teacher.lastName}`
            : undefined,
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
          group: groupById.get(lesson.studentGroupId)?.name ?? "",
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
        <Select value={groupFilter} onValueChange={changeFilter(setGroupFilter)}>
          {/* Named because two unlabelled comboboxes sit side by side: a screen
              reader read both as "Alla klasser"/"Alla lärare" with nothing to
              say which was which. The keys existed already and went unused. */}
          <SelectTrigger className="w-44" aria-label={t("filterGroup")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allGroups")}</SelectItem>
            {(groups ?? []).map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={teacherFilter} onValueChange={changeFilter(setTeacherFilter)}>
          <SelectTrigger className="w-52" aria-label={t("filterTeacher")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allTeachers")}</SelectItem>
            {teachers.map((teacher) => (
              <SelectItem key={teacher.id} value={teacher.id}>
                {teacher.firstName} {teacher.lastName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSlotClick={openCreate}
                bands={lunchBands}
              />
            </div>
          ))}
        </div>
      ) : (
        <TimetableGrid
          lessons={gridLessons}
          editable
          onLessonClick={(lesson) => openEditor(lesson.id)}
          onLessonChange={handleGridChange}
          validateChange={validateChange}
          onInvalidDrop={handleInvalidDrop}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSlotClick={openCreate}
          bands={lunchBands}
        />
      )}

      {/* ---------------- Edit dialog ---------------- */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setRemoteEditing(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("editBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
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
            <div className="flex gap-2">
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
            </div>
            <div className="flex gap-2">
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
                  <SelectTrigger>
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
              <RecurrenceFields
                idPrefix="create"
                value={{
                  recurrence: creating.recurrence,
                  startDate: creating.startDate,
                  endDate: creating.endDate,
                }}
                onChange={(next) => setCreating({ ...creating, ...next })}
              />
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
                      {versionDiff.added.slice(0, 8).map((lesson, index) => (
                        <li key={index}>+ {lessonLabel(lesson)}</li>
                      ))}
                      {versionDiff.added.length > 8 ? <li>…</li> : null}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-red-700">
                      {t("diffRemoved", { count: versionDiff.removed.length })}
                    </div>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {versionDiff.removed.slice(0, 8).map((lesson, index) => (
                        <li key={index}>− {lessonLabel(lesson)}</li>
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
              <DateField
                label={t("publishFrom")}
                id="publish-from"
                value={fromDate}
                onChange={(value) => setFromDate(value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="publish-to">{t("publishTo")}</Label>
              <DateField
                label={t("publishTo")}
                id="publish-to"
                value={toDate}
                onChange={(value) => setToDate(value)}
              />
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
