"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  Download,
  History,
  FileText,
  Footprints,
  MoreHorizontal,
  Plus,
  Printer,
  Redo2,
  Trash2,
  TriangleAlert,
  UtensilsCrossed,
  Undo2,
  Upload,
} from "lucide-react";
import { useCreateMasterLesson, useDeleteMasterLesson, useUpdateMasterLesson } from "@/lib/queries";
import { useTimetableRealtime } from "@/lib/use-timetable-realtime";
import { PlanningYearPicker, ProjectedRostersBanner } from "@/components/schedule/planning-year";
import type { LessonCommand } from "@/components/schedule/board-keys";
import { useConflictNotes } from "./use-conflict-notes";
import type { MessageLookup } from "@/lib/engine-message";
import { savedToast, type LockedNote } from "@/lib/staffing-warnings";
import { FilterPicker } from "@/components/schedule/filter-picker";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import type { CreateDraft } from "@/components/schedule/create-lesson-dialog";
import type { LessonEditDraft } from "@/components/schedule/lesson-edit-dialog";
import type { MasterLesson, StaffingWarning } from "@/lib/types";
import { cn } from "@/lib/utils";
import { homeClassesReached } from "@/lib/lesson-audience";
import { pupilBufferOf, validatePlacement, type Placement } from "@/lib/conflicts";
import type { OpenSlotMatch, PlacementSuggestion } from "@/lib/placement-search";
import { useScheduleHistory } from "@/lib/use-schedule-history";
import { NextStep } from "@/components/layout/next-step";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { useReadOnly } from "@/components/profile-context";
import type { BlockKit } from "@/components/schedule/block-cards";
import {
  TimetableGrid,
  type LessonChange,
  type TimetableGridHandle,
} from "@/components/schedule/timetable-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
/*
 * Already on this route: FilterPicker draws its lists with the same menu, so
 * the header's overflow costs its own few lines and no second copy of Radix.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { swapBehind } from "@/components/schedule/swap-behind";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RoomOptimizationDialog,
  VersionsDialog,
  SwapDialog,
  loadLessonDialogs,
  lessonDialogs,
  resetLessonDialogs,
  resetRoomOptimizationDialog,
  resetSwapDialog,
  resetVersionsDialog,
  LessonTimePanel,
  resetLessonTimePanel,
  SelectionBar,
  resetSelectionBar,
} from "./timetable-lazy";
import { NONE, toHHMM, minutesToHHMM, type GroupBy } from "./timetable-helpers";
import { useTimetableReads } from "./use-timetable-reads";
import { useScheduleEngine } from "./use-schedule-engine";
import { useTimetableView } from "./use-timetable-view";
import { useUndoableEdits } from "./use-undoable-edits";
import { useDirectReachAsk } from "@/lib/use-direct-reach-ask";
import { DirectReachDeclined } from "@/lib/direct-reach";
import { useLunchEdits } from "./use-lunch-edits";

export default function TimetablePage() {
  const t = useTranslations("timetable");
  const locale = useLocale();
  const tLunch = useTranslations("lunch");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const tDays = useTranslations("days");
  const tNav = useTranslations("nav");
  const reads = useTimetableReads();
  const {
    planning, shownYear, yearsQuery, yearPending, lessons,
    isLoading, lessonsFailed, lessonsReadAt, subjects, groups,
    rooms, people, constraints, requirements, lunchSettings,
    frameTimes, lunchSittings,
  } = reads;
  /*
   * Block i schemat: a parallel block drawn as one card per slot, moved and
   * locked as one (components/schedule/block-cards.tsx). Fetched once the
   * year's timplan names a block and never otherwise — this route is near its
   * budget — and the kit its host hands back answers for the cards below.
   */
  const [blockModule, setBlockModule] = useState<typeof import("@/components/schedule/block-cards") | null>(null);
  const [blockKit, setBlockKit] = useState<BlockKit | null>(null);
  const hasBlocks = requirements?.some((row) => row.blockId) ?? false;
  useEffect(() => {
    if (hasBlocks && !blockModule) void import("@/components/schedule/block-cards").then(setBlockModule, () => {});
  }, [hasBlocks, blockModule]);
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
   * The saved toast, or — when a new teacher drew the staffing policy's WARN,
   * or the move broke the post's ämnesfördelning — the same line as a warning
   * with the sentence under it, rendered from the engine catalogue so an
   * English reader gets English. Held longer than a plain save: it names
   * something the admin may want to undo.
   */
  const announceSaved = (
    result: {
      id?: string;
      propagatedLessons: number;
      removedCalendarLessons?: number;
      warnings?: StaffingWarning[];
      lockedByMove?: true;
    },
    lock?: LockedNote,
  ): void => {
    // Låset vid en flytt (E4): the move locked the lesson, said in sight with the button that takes the lock off again (a block card's own, when it gives it).
    const id = result.lockedByMove ? result.id : undefined;
    savedToast(
      tEngine,
      editSavedMessage(result),
      result.warnings,
      lock ??
        (id === undefined
          ? undefined
          : {
              text: t("lockedByMove.note", { count: 1 }),
              unlock: t("lockedByMove.unlock"),
              onUnlock: () =>
                void updateLesson.mutateAsync({ id, isLocked: false }).then(() => toast.success(t("lockedByMove.unlocked", { count: 1 })), showError),
            }),
    );
  };
  const updateLesson = useUpdateMasterLesson();
  const createLesson = useCreateMasterLesson();
  const deleteLesson = useDeleteMasterLesson();
  const history = useScheduleHistory();
  const { peers, setEditing: setRemoteEditing } = useTimetableRealtime();
  // A reader (Läsbehörighet) gets the grid as a reading: no drag, no editor,
  // no presence saying it edits; the hover text is the lesson in full.
  const readOnly = useReadOnly();

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
    classes: string[];
    go: () => void;
    /** A parallel block's card, which moves all its lessons (block-cards.tsx). */
    block?: string;
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
  const [badgeFailed, setBadgeFailed] = useState(false);

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
    drop: LessonChange;
  } | null>(null);
  // Krocklistan: open or not, and whether it has been asked for this visit (the latch keeps it out of the tree until the first press).
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictsUsed, setConflictsUsed] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Whether Versioner has been pressed this visit, which is what decides that
  // the dialog's code is fetched — the same rule as roomsUsed below.
  const [versionsUsed, setVersionsUsed] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  // Whether the room dialog has been asked for at all this visit, which is what
  // decides that its code is fetched — see where it is rendered.
  const [roomsUsed, setRoomsUsed] = useState(false);
  // Byten och flyttar: the lesson it was asked about, and the latch that keeps
  // the dialog out of the tree until the first press (as roomsUsed above).
  const [swapLessonId, setSwapLessonId] = useState<string | null>(null);
  const [swapsUsed, setSwapsUsed] = useState(false);
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
    PublishReviewDialog,
    PublicationBadge,
    SharedMoveDialog,
    SuggestPlacementsDialog,
    ConflictList,
    TrayHead,
    TrayPanel,
  } = lazyDialogs;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  /*
   * How often the selection's bar failed to arrive. It is drawn, empty, as
   * soon as the lessons are read, so its code is in hand before the first
   * selection and that one shows the bar at once: a lazy() that renders for
   * the first time suspends, and React then holds the bar back up to 300 ms.
   * After a failure it is drawn only with a selection, so the next selection
   * fetches again and nothing retries behind the school's back.
   */
  const [barFailures, setBarFailures] = useState(0);

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
  const engine = useScheduleEngine({ ...reads, peers, editing });
  const {
    yearGroups, closedWeeks, teachers, students, studentGroupOf,
    gradeSpanOf, homeClassIds, rosterIndex, groupConflictMap, subjectById,
    groupById, roomById, teacherById, personById, lessonById,
    lunchOf, pupilBuffers, conflictMap, exemptionMap, exemptionStanding, remoteEditors, placements,
    validateChange,
  } = engine;
  // What each clashing card says, in words: made by a module fetched only when something clashes.
  const conflictNotes = useConflictNotes({
    conflictMap,
    lessonById,
    groupById,
    subjectById,
    constraints: reads.constraints,
    gradeSpanOf,
    roomLock: t("conflictRoomLock"),
    tCommon,
  });
  const view = useTimetableView({
    ...reads,
    ...engine,
    conflictNotes,
    t,
    tLunch,
    locale,
    onlyGroup,
    groupFilters,
    teacherFilters,
    roomFilters,
    blockKit,
    groupBy,
  });
  const {
    groupSections, lunchBands, audienceByLesson, filtered, groupLabel,
    shareLabelOf, toGridLesson, gridLessons, validateGridChange, parked,
    lessonName, resourceBoards,
  } = view;
  /*
   * The Lektionstid panel, open or not. Remembered for the tab
   * (sessionStorage, read after mount so the server render and the first
   * client render agree), so the admin who opened it to watch 7A's minutes
   * finds it open after a reload. Storage that throws is no memory.
   */
  const [lessonTimeOpen, setLessonTimeOpen] = useState(false);
  useEffect(() => {
    try {
      setLessonTimeOpen(sessionStorage.getItem("timetable.lessonTime") === "1");
    } catch {}
  }, []);
  // Att lägga: open or not (the panel's code arrives with the lesson dialogs' chunk, the head's with it), and whether the head failed to.
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayFailed, setTrayFailed] = useState(false);
  const toggleLessonTime = () => {
    const open = !lessonTimeOpen;
    setLessonTimeOpen(open);
    try {
      sessionStorage.setItem("timetable.lessonTime", open ? "1" : "0");
    } catch {}
  };
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
  const trayRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<TimetableGridHandle>(null);
  // The question before a change in Direkt that reaches families (P5, beslut 8): asked around the first write, once.
  const directReach = useDirectReachAsk();
  const {
    showError, undoableUpdate, undoableCreate, undoableDelete, doUndo,
    doRedo,
  } = useUndoableEdits({
    t,
    tCommon,
    tEngine,
    updateLesson,
    createLesson,
    deleteLesson,
    history,
    ask: directReach.ask,
  });

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
      resetLessonDialogs();
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
      setConflictsOpen(false);
      setConflictsUsed(false);
      setConfirmUsed(false);
      setEditUsed(false);
      setCreateUsed(false);
      setSuggestUsed(false);
      setPublishUsed(false);
    },
    [showError, setRemoteEditing],
  );

  /*
   * Versioner, Optimera salar and Byten och flyttar, each fetched on its first press and each with a boundary of its own, as the lesson dialogs
   * have: a piece that did not arrive (or threw while it drew) is said in a toast instead of taking the page down, and it gets a fresh lazy()
   * wrapper, so that the next press fetches again. Releasing the latch is what unmounts the boundary (a new one stands in the next press) and
   * keeps a chunk that keeps failing from being retried in a loop: the next attempt waits for somebody to press. Apart from one another,
   * because a dialog that is open and well must not be unmounted by a failure of another (the room dialog relies on outliving its own close).
   */
  const onDemandFailed = useCallback(
    (which: "versions" | "rooms" | "swaps") => {
      // A sentence of the app's own, as every other lazily fetched dialog of the app has (common.formLoadFailed, checklists.dialogLoadFailed): what the
      // error says is "Failed to load chunk /_next/static/…", in English and with the file's path, which a teacher cannot do anything with.
      toast.error(t("dialogLoadFailed"));
      if (which === "versions") {
        resetVersionsDialog();
        setVersionsUsed(false);
      } else if (which === "rooms") {
        resetRoomOptimizationDialog();
        setRoomsUsed(false);
      } else {
        resetSwapDialog();
        setSwapsUsed(false);
      }
    },
    [t],
  );

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
        // The room a numbered time was offered in, when it is not the lesson's own (board-keys.tsx): sent only then, so that an
        // ordinary move's patch is exactly what it was.
        ...(change.roomId !== undefined ? { roomId: change.roomId } : {}),
        // A lesson dragged in from the tray arrives placed. Sent only then,
        // so an ordinary move's patch is exactly what it was — and undo of an
        // arrival, which restores the snapshot, parks it again.
        ...(lesson.isParked ? { isParked: false } : {}),
      })
        .then((result) => blockKit?.announce(lesson, result) || announceSaved(result))
        .catch(showError);
    },
    [undoableUpdate, showError, t, blockKit],
  );

  /** A drop of lessons, asked first when they reach more than one class; `go` moves them. */
  const drop = useCallback(
    (moved: MasterLesson[], change: LessonChange, go = () => applyGridChange(moved[0]!, change), block?: string) => {
      // Asked of the LESSONS, not of the filter: which class you are looking
      // at has no bearing on whose week just moved.
      const classes = [...new Set(moved.flatMap((lesson) => homeClassesReached(lesson, homeClassIds, rosterIndex)))];
      if (classes.length > 1) setConfirming({ classes, go, block });
      else go();
    },
    [homeClassIds, rosterIndex, applyGridChange],
  );

  const handleGridChange = useCallback(
    (id: string, change: LessonChange) => {
      // A block card, or a member moved out of one, is the block's to move.
      if (blockKit?.move(id, change)) return;
      const lesson = lessonById.get(id);
      if (lesson) drop([lesson], change);
    },
    [lessonById, drop, blockKit],
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

  /**
   * The keys that are writes (L, P and Delete on a lesson, board-keys.tsx): the page's own, each one step of undo. A block's card is
   * not a lesson of its own and has its dialog, where the lock, the tray and the removal say what they do to the whole block.
   */
  const handleLessonCommand = useCallback(
    (id: string, command: LessonCommand) => {
      const lesson = lessonById.get(id);
      if (!lesson) return void openEditor(id);
      if (command === "park") return park(lesson);
      if (command === "lock") return void undoableUpdate(lesson, { isLocked: !lesson.isLocked }).catch(showError);
      void undoableDelete(lesson)
        .then((result) => toast.success(t("deleted", { count: result.removedCalendarLessons })))
        .catch(showError);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lessonById, park, undoableUpdate, undoableDelete, showError, t, blockKit],
  );

  /**
   * Put a parked lesson back where it was. The remembered slot may be taken,
   * and the day around it may have moved: what the save warns of (a walk
   * between sites, the ämnesfördelning) is said as after any other edit.
   */
  const putBack = useCallback(
    (lesson: MasterLesson) => {
      void undoableUpdate(lesson, { isParked: false })
        .then((result) => savedToast(tEngine, t("putBackDone", { lesson: lessonName(lesson) }), result.warnings))
        .catch(showError);
    },
    [undoableUpdate, showError, t, tEngine, lessonName],
  );

  /** A drag that let go off the grid: on the tray, it parks; elsewhere, nothing. */
  const handleDropOutside = useCallback(
    (id: string, point: { clientX: number; clientY: number }) => {
      const lesson = lessonById.get(id);
      const tray = trayRef.current;
      if (!tray) return;
      const rect = tray.getBoundingClientRect();
      const onTray =
        point.clientX >= rect.left &&
        point.clientX <= rect.right &&
        point.clientY >= rect.top &&
        point.clientY <= rect.bottom;
      if (!onTray) return;
      // A block's card is set aside one lesson at a time, and says so.
      if (lesson) park(lesson);
      else blockKit?.refuse(id, true);
    },
    [lessonById, park, blockKit],
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
      // A block's card has no suggestions of its own: it says why.
      if (!lesson) return void blockKit?.refuse(id, false);
      // No slot is "nearest free" for a lesson that cannot move: the sentence says where it is changed.
      if (lesson.fromPlacement) return void toast.error(t("lessonIsPlaced"));
      const candidate: Placement = {
        id,
        dayOfWeek: change.dayOfWeek,
        startMinutes: change.startMinutes,
        endMinutes: change.endMinutes,
        teacherId: lesson.teacherId,
        coTeacherId: lesson.coTeacherId,
        roomId: lesson.roomId,
        studentGroupId: lesson.studentGroupId,
        subjectId: lesson.subjectId,
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
        undefined,
        closedWeeks,
      );
      if (hits.length > 0 && hits.every((hit) => hit.pupilBufferOnly)) {
        toast.info(t("pupilTimeRefused"));
      }
      const hasWeekend = (lessons ?? []).some((l) => l.dayOfWeek > 5);
      // The search lives in the lesson dialogs' chunk, fetched when the page
      // mounted, so this await is normally a resolved promise.
      loadLessonDialogs().then(async ({ suggestPlacements, startsTheGatewayLets }) => {
        // Asked of the gateway as well: the page's check holds no room lent to another school, nor a teacher's lessons there (OTHER_SCHOOL).
        const lets = await startsTheGatewayLets(id);
        const options = suggestPlacements(candidate, placements, constraints ?? [], {
          days: hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
          studentGroupOf,
          // The drag's own judge, so that no time is offered that the drag then refuses (post mr-3), and what the gateway lets through.
          allows: (attempt) => validateChange(id, attempt) && lets(attempt.dayOfWeek, attempt.startMinutes),
        });
        setSuggesting({ lesson, options, drop: change });
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
      closedWeeks,
      validateChange,
      showError,
      t,
      blockKit,
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
      if (!blockKit?.announce(suggesting.lesson, result)) announceSaved(result);
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

  /** The selected lessons, a card's by its lessons, each once; `whole`: a card's whole block. */
  const selectedLessons = (whole = false) =>
    [...new Set([...selectedIds].flatMap((id) => blockKit?.lessonIdsOf(id, whole) ?? [id]))]
      .map((id) => lessonById.get(id))
      .filter((lesson): lesson is MasterLesson => Boolean(lesson));

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

  /*
   * A swap rewrote the days and clocks of lessons under the page, and its
   * undo is the dialog's own toast. The undo stack of earlier steps would
   * replay over it, so it goes, as after the room optimisation.
   */
  const afterSwap = useCallback(() => history.clear(), [history]);
  const { placeLunch, moveLunch, removeLunch } = useLunchEdits({
    ...reads,
    t,
    tCommon,
    onlyGroup,
    history,
  });

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
    if (blockKit?.open(lessonId)) return;
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
      // Undantag med flit: the lesson's own, so that it is said, and can be taken back, before anything is moved.
      exempt: lesson.exemptFrom ?? [],
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
        // Undantag med flit: the rules answered "Lägg ändå" for this time, or [] to take back one the lesson had. Said only then, so a
        // save of a lesson that has none is the request it always was.
        ...(editDraft.exempt && editDraft.exempt.length > 0 ? { exempt: editDraft.exempt } : editing.exemptFrom && editing.exemptFrom.length > 0 ? { exempt: [] } : {}),
      });
      if (!blockKit?.announce(editing, result)) announceSaved(result);
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
    // Pressed inside Lägg till, whose chunk carries the search: loaded by now.
    loadLessonDialogs().then(({ openSlotsFor }) => {
      setSlotMatches(
        openSlotsFor(creating, {
          requirements: requirements ?? [],
          lessons: lessons ?? [],
          studentGroupOf,
          placements,
          constraints: constraints ?? [],
          // The grid's own judge for a lesson that is not stored yet (the ramtid, the class's meal, the year rules, the weeks of a
          // lov), so that no time is offered that the create then refuses (E1: it asks the judge of a drag).
          allows: (slot) =>
            validatePlacement(
              {
                id: null,
                ...slot,
                teacherId: null,
                roomId: null,
                studentGroupId: creating.studentGroupId,
                subjectId: creating.subjectId,
                extraGroupIds: creating.extraGroupIds,
                studentIds: creating.studentIds,
                recurrence: creating.recurrence,
                startDate: creating.startDate || null,
                endDate: creating.endDate || null,
                ...pupilBufferOf(pupilBuffers, creating),
              },
              placements,
              constraints ?? [],
              studentGroupOf,
              groupConflictMap,
              gradeSpanOf,
              frameTimes,
              lunchOf,
              undefined,
              closedWeeks,
            ).length === 0,
        }),
      );
    }, showError);
  };

  const doCreate = async () => {
    if (!creating || !shownYear) return;
    try {
      const created = await undoableCreate({
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
      // A lesson placed by hand may break its subject's ämnesfördelning; it is
      // saved all the same, and the toast says which rule (savedToast).
      savedToast(tEngine, t("created"), created.warnings);
      setCreating(null);
    } catch (error) {
      showError(error);
    }
  };

  // -------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------

  /**
   * ICS or PDF of what the filters show, built where it is fetched: ./timetable-exports.ts.
   *
   * The two exports are imported where they are pressed, not at the top, and so
   * are the rows this page feeds them. Neither is needed to SHOW the week — the
   * school asks for a file. lib/pdf.ts already reasons this way about jspdf
   * inside its own export function; this moves the wrapper the same distance.
   */
  const doExport = async (kind: "exportIcs" | "exportPdf") => {
    try {
      const files = await import("./timetable-exports");
      await files[kind]({
        t,
        tDays,
        year: shownYear,
        lessons: filtered,
        subjectById,
        teacherById,
        roomById,
        groupLabel,
        shareLabelOf,
        audienceByLesson,
        onlyGroupName: onlyGroup ? (groupById.get(onlyGroup)?.name ?? "") : "",
      });
    } catch (error) {
      // A file chunk that did not arrive, or a PDF that could not be drawn.
      showError(error);
    }
  };

  const conflictCount = conflictMap.size;

  /*
   * What a pick in the header's overflow menu does, run once the menu has
   * closed rather than as it is picked. Skriv ut above all: window.print()
   * blocks on the page as it is drawn, and a menu still on screen would be
   * on the paper. Optimera salar opens its dialog the same way, so the
   * dialog's focus trap starts after the menu's has let go and hands focus
   * back to the menu button when it closes.
   */
  const afterMenu = useRef<(() => void) | null>(null);
  const fromMenu = (action: () => void) => () => {
    afterMenu.current = action;
  };

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {/* First in the actions, as every page's scope is. It shared the
                header with nine buttons once and ran past a 1440 px screen;
                the header holds four controls now, with the exports, the
                print and the room optimisation behind "Fler åtgärder". */}
            <PlanningYearPicker
              {...planning}
              onChoose={(yearId) => {
                // What was picked, ticked and undoable belongs to the other
                // year's grid: its group ids are not this year's, and an undo
                // would move a lesson nobody can see.
                setGroupFilters([]);
                setSelectedIds(new Set());
                setSuggesting(null);
                setPlacingLunch(false);
                history.clear();
                planning.choose(yearId);
              }}
            />
            <Button
              variant="outline"
              onClick={() => openCreate(1, 8 * 60)}
              disabled={!shownYear}
              data-writes="SCHEMALAGGNING DRIFT"
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("moreActions")}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={() => {
                  const action = afterMenu.current;
                  afterMenu.current = null;
                  action?.();
                }}
              >
                <DropdownMenuItem
                  disabled={!shownYear || !lessons || lessons.length === 0}
                  data-writes="SCHEMALAGGNING DRIFT"
                  onSelect={fromMenu(() => {
                    setRoomsUsed(true);
                    setRoomsOpen(true);
                  })}
                >
                  <Footprints />
                  {t("optimizeRooms")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!shownYear || filtered.length === 0}
                  onSelect={fromMenu(() => void doExport("exportIcs"))}
                >
                  <Download />
                  {t("exportIcs")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!shownYear || filtered.length === 0}
                  onSelect={fromMenu(() => void doExport("exportPdf"))}
                >
                  <FileText />
                  {t("exportPdf")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={fromMenu(() => window.print())}>
                  <Printer />
                  {t("print")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setPublishOpen(true)} disabled={!shownYear} data-writes="PUBLICERING DRIFT">
              <Upload />
              {t("publish")}
            </Button>
          </>
        }
      />
      {/* Utkastläge only: what the grid holds against what is published. The
          badge draws nothing in direct mode — and its row with it (empty:
          hidden), which is why it is a row of its own and not PageHeader's
          meta, whose wrapper would keep its margin with nothing in it. It
          arrives with the lesson dialogs' chunk, and a chunk that fails takes
          the badge away rather than the page — no toast, no retry loop; the
          dialogs say it. */}
      {shownYear && !badgeFailed ? (
        <DialogLoadBoundary onError={() => setBadgeFailed(true)}>
          <Suspense fallback={null}>
            <div className="empty:hidden">
              <PublicationBadge
                yearId={shownYear.id}
                revision={lessonsReadAt}
                onReview={() => setPublishOpen(true)}
              />
            </div>
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
      <ProjectedRostersBanner
        year={shownYear}
        active={planning.active}
        rosters={planning.rosters}
        failed={planning.rostersFailed}
      />

      {/* The board's own toolbar: filters, the view, the history and the
          modes. Undo and redo live here, beside what they undo, with their
          shortcuts said in words (aria-keyshortcuts) and on hover. */}
      <FilterBar className="items-center">
        <div className="flex items-center gap-1" data-writes="SCHEMALAGGNING DRIFT">
          <Button
            variant="outline"
            size="icon"
            onClick={doUndo}
            disabled={!history.canUndo}
            aria-label={t("undo")}
            aria-keyshortcuts="Control+Z Meta+Z"
            title={t("undoShortcut")}
          >
            <Undo2 />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={doRedo}
            disabled={!history.canRedo}
            aria-label={t("redo")}
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
            title={t("redoShortcut")}
          >
            <Redo2 />
          </Button>
        </div>
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
        {/* Named like the pickers beside it, inside rather than above: a
            visible label over one control of six would push the grid down
            for every school, every day. */}
        <Select
          value={groupBy}
          onValueChange={(value) => {
            // What is on screen changes, so the selection goes (pickFilter).
            setGroupBy(value as GroupBy);
            setSelectedIds(new Set());
          }}
        >
          <SelectTrigger className="w-40" aria-label={t("viewLabel")}>
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
            data-writes="SCHEMALAGGNING"
          >
            <UtensilsCrossed />
            {lunchMode ? t("placeLunchOn") : t("placeLunch")}
          </Button>
        ) : null}
        {shownYear && !trayFailed ? (
          <DialogLoadBoundary onError={() => setTrayFailed(true)}>
            <Suspense fallback={null}>
              <TrayHead yearId={shownYear.id} revision={lessonsReadAt} open={trayOpen} onToggle={() => setTrayOpen((open) => !open)} />
            </Suspense>
          </DialogLoadBoundary>
        ) : null}
        <Button
          size="sm"
          variant={lessonTimeOpen ? "default" : "outline"}
          aria-expanded={lessonTimeOpen}
          aria-controls="lesson-time"
          onClick={toggleLessonTime}
        >
          <CalendarDays />
          {t("lessonTime.button")}
        </Button>
        {filtered.length > 0 ? (
          <span className="text-sm tabular-nums text-muted-foreground">
            {t("lessonCount", { count: filtered.length })}
          </span>
        ) : null}
        {conflictCount > 0 ? (
          <Badge variant="destructive" className="gap-1.5">
            <TriangleAlert className="size-3.5" />
            {t("conflictCount", { count: conflictCount })}
          </Badge>
        ) : null}
        {/* Undantag med flit: lessons that stand against the ramtid or the class's meal on purpose are counted apart, never as conflicts. */}
        {exemptionMap.size > 0 ? <Badge variant="outline">{t("exemptionCount", { count: exemptionMap.size })}</Badge> : null}
        {conflictCount > 0 || exemptionMap.size > 0 ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              setConflictsUsed(true);
              setConflictsOpen(true);
            }}
          >
            {t("conflictListOpen")}
          </Button>
        ) : null}
        {/* How to drag, click and key the grid's writes: no use where the grid takes no pointer. */}
        <span className="text-xs text-muted-foreground" data-writes="SCHEMALAGGNING DRIFT">
          {t("dragHint")}
        </span>
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
      </FilterBar>

      {trayOpen && shownYear && !trayFailed ? (
        <DialogLoadBoundary onError={() => setTrayFailed(true)}>
          <Suspense fallback={null}>
            <TrayPanel
              yearId={shownYear.id}
              revision={lessonsReadAt}
              groupById={groupById}
              subjectById={subjectById}
              teacherById={teacherById}
              writable={!readOnly}
              guard={directReach.ask}
              declined={(error) => error instanceof DirectReachDeclined}
              onClose={() => setTrayOpen(false)}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}

      {lessonTimeOpen && shownYear ? (
        <DialogLoadBoundary
          onError={(error) => {
            showError(error);
            resetLessonTimePanel();
            setLessonTimeOpen(false);
          }}
        >
          <Suspense fallback={null}>
            <LessonTimePanel
              key={shownYear.id}
              id="lesson-time"
              year={shownYear}
              lessons={lessons}
              requirements={requirements}
              groups={groups ? yearGroups : undefined}
              subjects={subjects}
              groupFilters={groupFilters}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}

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
        <Notice
          tone="warning"
          action={
            canPlaceLunch ? (
              <Button size="sm" variant="outline" onClick={() => setPlacingLunch(true)} data-writes="SCHEMALAGGNING">
                <UtensilsCrossed />
                {t("noSittingsPlace")}
              </Button>
            ) : undefined
          }
        >
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
            </div>
          ) : (
            <p>
              {t("noSittingsGroup", {
                group: onlyGroup ? (groupById.get(onlyGroup)?.name ?? "") : "",
              })}
            </p>
          )}
        </Notice>
      ) : null}

      {lunchMode ? (
        <Notice>{t("placeLunchHint", { minutes: lunchSettings?.lunchMinutes ?? 0 })}</Notice>
      ) : null}

      {/* Drawn from the lesson dialogs' chunk (see barFailures). A chunk that
          does not arrive lets a selection go, says so once, and is fetched
          again at the next selection. */}
      {lessons && (barFailures === 0 || selectedIds.size > 0) ? (
        <DialogLoadBoundary
          key={`selection-${barFailures}`}
          onError={() => {
            resetSelectionBar();
            setBarFailures((failures) => failures + 1);
            if (selectedIds.size === 0) return;
            toast.error(t("selectionReleased"));
            setSelectedIds(new Set());
          }}
        >
          <Suspense fallback={null}>
            <SelectionBar
              shown={selectedIds.size > 0}
              selectedLessons={selectedLessons}
              updateLesson={updateLesson}
              deleteLesson={deleteLesson}
              createLesson={createLesson}
              history={history}
              showError={showError}
              guard={directReach.ask}
              onClear={() => setSelectedIds(new Set())}
              // Handed in rather than imported there: every admin page with a
              // delete button shares this icon, and taking it out of this
              // route's first load re-sliced their chunks (/admin/people
              // +1.4KB, /admin/lunch-servings +1.1KB, measured 2026-10-23).
              deleteIcon={<Trash2 />}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}

      {/*
        A failed refetch keeps the board. Realtime peers invalidate the
        lessons on every edit, so a background read that fails must not
        unmount a board someone is editing: the board stays as last read and
        this says so above it. The page-level error is only for a board that
        was never read.
      */}
      {lessonsFailed && lessons !== undefined ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}

      {isLoading || yearPending ? (
        <div aria-busy="true">
          <Skeleton className="h-96 w-full" />
        </div>
      ) : !shownYear && yearsQuery.isError ? (
        <LoadError title={t("yearsLoadFailed")} hint={t("yearsLoadFailedHint")} headingLevel={2} />
      ) : !shownYear ? (
        <EmptyState
          icon={CalendarDays}
          headingLevel={2}
          title={t("noYearTitle")}
          description={t("noYearHint")}
          action={
            <Button asChild variant="outline">
              <Link href="/admin/years">{t("noYearAction")}</Link>
            </Button>
          }
        />
      ) : lessonsFailed && lessons === undefined ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          headingLevel={2}
          title={t("emptyTitle")}
          description={t("emptyHint")}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild>
                <Link
                  href={
                    shownYear && !shownYear.isActive
                      ? `/admin/generate?year=${shownYear.id}`
                      : "/admin/generate"
                  }
                >
                  {t("emptyAction")}
                </Link>
              </Button>
              {/* The week where lessons are laid by hand before Generera (Förlägg i veckan); Planering's. */}
              <Button asChild variant="outline" data-writes="PLANERING">
                <Link
                  href={
                    shownYear && !shownYear.isActive
                      ? `/admin/placements?year=${shownYear.id}`
                      : "/admin/placements"
                  }
                >
                  {t("emptyAction2")}
                </Link>
              </Button>
            </div>
          }
        />
      ) : resourceBoards ? (
        <div className="space-y-6">
          {resourceBoards.map((board) => (
            <section key={board.key} aria-labelledby={`board-${board.key}`} className="space-y-2">
              <h2 id={`board-${board.key}`} className="text-base font-semibold">
                {board.label}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {t("lessonCount", { count: board.lessons.length })}
                </span>
              </h2>
              <TimetableGrid
                lessons={board.lessons}
                editable={!readOnly}
                board
                onLessonCommand={handleLessonCommand}
                onLessonClick={readOnly ? undefined : (lesson) => openEditor(lesson.id)}
                onLessonChange={handleGridChange}
                validateChange={validateGridChange}
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
            </section>
          ))}
        </div>
      ) : (
        <TimetableGrid
          ref={gridRef}
          lessons={gridLessons}
          editable={!readOnly}
          board
          onLessonCommand={handleLessonCommand}
          onLessonClick={readOnly ? undefined : (lesson) => openEditor(lesson.id)}
          onLessonChange={handleGridChange}
          validateChange={validateGridChange}
          onInvalidDrop={handleInvalidDrop}
          onDropOutside={handleDropOutside}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSlotClick={lunchMode ? (day, minute) => void placeLunch(day, minute) : openCreate}
          behind={swapBehind}
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
          "space-y-2 rounded-lg border border-dashed p-3",
          parked.length === 0 ? "text-muted-foreground" : "bg-card",
        )}
      >
        <div className="space-y-1">
          <h2 id="lesson-tray-title" className="text-base font-semibold text-foreground">
            {t("trayTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("trayHint")}</p>
        </div>
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
                  data-writes-inert="SCHEMALAGGNING DRIFT"
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
                <Button variant="ghost" size="sm" onClick={() => putBack(lesson)} data-writes="SCHEMALAGGNING DRIFT">
                  {t("putBack")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The manual's next step after the grundschema. */}
      <div className="flex justify-end">
        <NextStep href="/admin/gaps" name={tNav("gaps")} />
      </div>

      {/* ---------------- Edit dialog ---------------- */}
      {/*
        Each of the four dialogs below is mounted from its first open onward and
        never unmounted again, like the create, versions and room dialogs:
        closing keeps it in the tree so it animates out as before, and nothing
        is mounted for a dialog nobody opens. Their code is fetched right
        after the page mounts (see loadLessonDialogs), and a fetch that fails
        is caught here and reported (see lessonDialogsFailed).
      */}
      {blockModule && shownYear && lessons && requirements ? (
        <blockModule.BlockHost
          academicYearId={shownYear.id}
          lessons={lessons}
          requirements={requirements}
          onKit={setBlockKit}
          actions={{
            update: undoableUpdate,
            drop,
            validate: validateChange,
            history,
            showError,
            guard: directReach.ask,
            announce: announceSaved,
            title: editSavedMessage,
            name: lessonName,
            openEditor,
          }}
        />
      ) : null}
      {directReach.question}
      <DialogLoadBoundary key={`lessons-${dialogsAttempt}`} onError={lessonDialogsFailed}>
        {confirmUsed && (
          <Suspense fallback={null}>
            <SharedMoveDialog
              open={confirming !== null}
              classNames={(confirming?.classes ?? [])
                .map((id) => groupById.get(id)?.name ?? id)
                .join(", ")}
              block={confirming?.block}
              onCancel={() => setConfirming(null)}
              onConfirm={() => {
                confirming?.go();
                setConfirming(null);
              }}
            />
          </Suspense>
        )}

        {conflictsUsed && (
          <Suspense fallback={null}>
            <ConflictList
              open={conflictsOpen}
              rules={{ constraints: constraints ?? [], gradeSpanOf }}
              onOpenChange={setConflictsOpen}
              conflictMap={conflictMap}
              exemptions={exemptionMap}
              exemptionStanding={exemptionStanding}
              lessonById={lessonById}
              group={(id) => groupById.get(id)?.name ?? ""}
              subject={(id) => subjectById.get(id)?.name ?? ""}
              onGo={
                readOnly
                  ? undefined
                  : (lessonId) => {
                      setConflictsOpen(false);
                      openEditor(lessonId);
                    }
              }
            />
          </Suspense>
        )}

        {editUsed && (
          <Suspense fallback={null}>
            <LessonEditDialog
              open={editing !== null}
              lesson={editing}
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
              onSuggestSwaps={() => {
                if (!editing) return;
                setSwapLessonId(editing.id);
                setSwapsUsed(true);
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
              refused={suggesting}
              onApplied={afterSwap}
              guard={directReach.ask}
            />
          </Suspense>
        )}
      </DialogLoadBoundary>

      {/* ---------------- Versions dialog ---------------- */}
      {versionsUsed && (
        <DialogLoadBoundary onError={() => onDemandFailed("versions")}>
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
        </DialogLoadBoundary>
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
        <DialogLoadBoundary onError={() => onDemandFailed("rooms")}>
        <Suspense fallback={null}>
          <RoomOptimizationDialog
            open={roomsOpen}
            onOpenChange={setRoomsOpen}
            academicYearId={shownYear?.id ?? null}
            rooms={rooms ?? []}
            // Names only, so everybody: the people it names may stand on lessons without being teachers now.
            teachers={people ?? []}
            groups={groups ?? []}
            onApplied={afterRoomOptimization}
          />
        </Suspense>
        </DialogLoadBoundary>
      )}

      {/* ---------------- Byten och flyttar ---------------- */}
      {swapsUsed && (
        <DialogLoadBoundary onError={() => onDemandFailed("swaps")}>
        <Suspense fallback={null}>
          <SwapDialog
            open={swapLessonId !== null}
            onOpenChange={(open) => {
              if (!open) setSwapLessonId(null);
            }}
            lessonId={swapLessonId}
            lessonName={
              swapLessonId && lessonById.has(swapLessonId) ? lessonName(lessonById.get(swapLessonId)!) : null
            }
            teacherName={(id) => {
              const teacher = teacherById.get(id);
              return teacher ? `${teacher.firstName} ${teacher.lastName}` : null;
            }}
            roomName={(id) => roomById.get(id)?.name ?? null}
            onApplied={afterSwap}
            guard={directReach.ask}
          />
        </Suspense>
        </DialogLoadBoundary>
      )}

      {/* ---------------- Publish dialog ---------------- */}
      <DialogLoadBoundary key={`publish-${dialogsAttempt}`} onError={lessonDialogsFailed}>
        {publishUsed && (
          <Suspense fallback={null}>
            <PublishReviewDialog
              open={publishOpen}
              onOpenChange={setPublishOpen}
              year={shownYear}
              subjects={subjects}
              groups={groups}
              // Names only, so everybody: a lesson in the draft keeps its teacher when her mark is taken off.
              teachers={people ?? []}
              rooms={rooms}
            />
          </Suspense>
        )}
      </DialogLoadBoundary>
    </Page>
  );
}
