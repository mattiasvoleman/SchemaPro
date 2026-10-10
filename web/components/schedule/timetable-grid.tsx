"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { Check, Lock, TriangleAlert, X } from "lucide-react";
import { layoutDay } from "@/lib/day-lanes";
import { cn } from "@/lib/utils";

export interface TimetableLesson {
  id: string;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  /** Minutes since midnight. */
  startMinutes: number;
  endMinutes: number;
  title: string;
  subtitle?: string;
  room?: string;
  color: string;
  cancelled?: boolean;
  /** Pinned: survives regeneration; shown with a lock badge. */
  locked?: boolean;
  /** Existing clash detected by the client conflict engine. */
  conflicted?: boolean;
  /**
   * Short note about which weeks the lesson runs ("udda", "jämna", "period").
   *
   * A weekly grid cannot show it any other way: a lesson that runs every other
   * week, or stops in October, occupies the same rectangle as one that runs
   * all year, and without a mark the grid quietly claims more than is true.
   */
  recurrenceNote?: string;
  /** Label of a collaborator currently editing this lesson (soft lock). */
  remoteEditor?: string;
  /**
   * How much of the class in view sits here, as "2/4" — partial lessons only.
   *
   * A class is not one body: while 4ma1 runs, half of 4.1 is taught and the
   * other half is somewhere else. The grid draws a lesson as one rectangle
   * either way, so without this mark a half-class lesson claims the whole
   * class the same way an every-other-week lesson claims every week — which is
   * the argument recurrenceNote above already won.
   *
   * Deliberately NOT a lane of its own: layoutDay applies one laneCount per
   * whole day, so a lane for these would narrow every card on the day.
   */
  share?: string;
  /** What `share` means, spelled out for a reader who cannot see the badge. */
  shareLabel?: string;
  /**
   * The minutes the PUPILS are occupied outside this lesson, already worded by
   * the page — ombyte before idrotten, dusch and ombyte after it.
   *
   * IN THE HOVER TEXT ONLY, and the rectangle is deliberately left alone. The
   * block is sized by the clock, and the extra time is not teaching: folding it
   * into startMinutes/endMinutes would draw a 60-minute lesson as 90 and make
   * every timetable read longer than the school teaches. But a rule that
   * refuses the next slot while showing nothing at all is a grid that looks
   * broken, so the reason is one hover away — the same trade the time itself
   * makes, which the axis is too coarse to show either.
   */
  pupilTimeNote?: string;
}

export interface LessonChange {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

interface TimetableGridProps {
  lessons: TimetableLesson[];
  /** Optional dates rendered under each day header (index 0 = Monday). */
  dates?: Date[];
  onLessonClick?: (lesson: TimetableLesson) => void;
  /** Enables drag-to-move, drag-to-resize and empty-slot clicks. */
  editable?: boolean;
  /** Called after a valid drag-move or resize is dropped. */
  onLessonChange?: (id: string, change: LessonChange) => void;
  /** Live validity check during drag: return false to show the ghost red. */
  validateChange?: (id: string, change: LessonChange) => boolean;
  /** Called when a drag ends on an invalid slot (e.g. to offer suggestions). */
  onInvalidDrop?: (id: string, change: LessonChange) => void;
  /**
   * Called when a drag ends OUTSIDE the grid, with where the pointer let go.
   *
   * The grid does not know what is out there — the page does — so it reports
   * the point and commits nothing. `locate` clamps every position into a day
   * column, which is right for a drag that wanders past the edge and wrong for
   * one that is meant to leave; this is how the two are told apart.
   */
  onDropOutside?: (id: string, point: { clientX: number; clientY: number }) => void;
  /** Lessons rendered with a selection outline (bulk editing). */
  selectedIds?: ReadonlySet<string>;
  /** Shift+click toggles selection instead of opening the editor. */
  onToggleSelect?: (id: string) => void;
  /** Click on an empty slot (create-lesson affordance). */
  onSlotClick?: (dayOfWeek: number, startMinutes: number) => void;
  /**
   * Stripes drawn behind the lessons — the lunch each class was given.
   *
   * Not lessons, and not passed as lessons: layoutDay applies ONE laneCount to
   * a whole day, so folding a band into `lessons` would halve the width of
   * every lesson beside it. They are also not clickable and must never be: see
   * the `pointer-events-none` on the element below.
   */
  bands?: TimetableBand[];
  /** A movable band dropped at a new day and start (drag, or the arrow keys). */
  onBandMove?: (id: string, dayOfWeek: number, startMinutes: number) => void;
  /** A removable band's × pressed, or Delete on its grip. */
  onBandRemove?: (id: string) => void;
  className?: string;
}

type TimetableGridInnerProps = TimetableGridProps & {
  handleRef: React.ForwardedRef<TimetableGridHandle>;
};

/** Minutes since midnight as "13:05". */
function clockOf(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A stripe across one day, drawn behind the lessons. */
export interface TimetableBand {
  id: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  label: string;
  /** Can be dragged to another time — a meal this screen may move. */
  movable?: boolean;
  /** Placed by hand, and a run keeps it where it is: drawn with a padlock. */
  handPlaced?: boolean;
  /** The grip's accessible name. Defaults to the label. */
  moveLabel?: string;
  /** Present only when the band can be removed — a meal placed by hand. */
  removeLabel?: string;
}

interface PositionedLesson extends TimetableLesson {
  lane: number;
  laneCount: number;
}

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/*
 * HOW TALL A MINUTE IS, and why it is not a constant.
 *
 * It was 1.1 px, which suits a school of hour-long lessons and cuts a
 * 40-minute one in half: 40 x 1.1 = 44 px, less 12 px of padding, leaves
 * exactly two 16 px rows — the title and the group — and the room begins at
 * pixel 32 and is clipped mid-glyph. That is not an edge case anywhere: at
 * Kunskapsskolan half the week is 40-minute lessons.
 *
 * So the grid is measured against the lessons it actually draws, and a school
 * of hour-long lessons keeps the compact grid it has (60 / 60 = 1.0, below the
 * base). It reads the MOST COMMON length rather than the shortest: one
 * 20-minute pass among forties should not double the height of everybody's
 * day, and what does not fit its box is handled by the box instead — see
 * `linesThatFit` below.
 *
 * The scale can only change when a committed edit shifts which length is most
 * common; a drag draws a ghost and leaves `lessons` alone, so the grid never
 * rescales under the pointer.
 */
const BASE_PX_PER_MINUTE = 1.1;
/*
 * The ceiling stops a short pass from stretching the day past what a screen
 * holds. A 15-minute lesson would ask for 4 px per minute — a 10-hour day
 * 2,400 px tall — and it is the compact layout's job to fit it, not the
 * grid's.
 */
const MAX_PX_PER_MINUTE = 2.2;
/** One row of `text-xs`: 12 px on a 16 px line. */
const LINE_PX = 16;
/** `p-1.5`, top and bottom. */
const BLOCK_PADDING_PX = 12;
/**
 * Title, group-and-teacher, room. The recurrence note is a fourth row and is
 * deliberately not counted: it is present on a handful of lessons, and sizing
 * every school's grid for it would cost 16 px a lesson to spare a merge.
 */
const LINES_A_LESSON_WANTS = 3;
const TIME_AXIS_PX = 56; // 3.5rem
const DRAG_SNAP_MINUTES = 5;
const SLOT_CLICK_SNAP_MINUTES = 15;
const DRAG_THRESHOLD_PX = 5;
const MIN_DURATION_MINUTES = 15;
const RESIZE_HANDLE_PX = 8;

/**
 * What a parent may ask of the grid imperatively.
 *
 * One method, for one reason: a lesson on the tray is not among `lessons`, so
 * nothing on the grid can start its drag. The tray starts it here, and from
 * then on the grid's own move/up machinery carries it exactly as it would a
 * lesson that began on the grid.
 */
export interface TimetableGridHandle {
  beginExternalDrag: (
    lesson: TimetableLesson,
    pointer: { pointerId: number; clientX: number; clientY: number },
  ) => void;
}

interface DragState {
  pointerId: number;
  lessonId: string;
  mode: "move" | "resize";
  /**
   * Began off the grid. The origin is then a remembered slot rather than a
   * place the lesson is, so a drop ON that slot is still a change — the lesson
   * is arriving, not staying.
   */
  external?: boolean;
  /** Minutes between pointer and lesson start at drag begin (move mode). */
  grabOffsetMinutes: number;
  origin: TimetableLesson;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

interface GhostState {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  valid: boolean;
}

function snap(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

export const TimetableGrid = forwardRef<TimetableGridHandle, TimetableGridProps>(
  function TimetableGrid(props, ref) {
    return <TimetableGridInner {...props} handleRef={ref} />;
  },
);

function TimetableGridInner({
  lessons,
  dates,
  onLessonClick,
  editable = false,
  onLessonChange,
  validateChange,
  onInvalidDrop,
  onDropOutside,
  handleRef,
  selectedIds,
  onToggleSelect,
  onSlotClick,
  onBandMove,
  onBandRemove,
  bands,
  className,
}: TimetableGridInnerProps) {
  const t = useTranslations("common");
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<GhostState | null>(null);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /*
   * A meal being dragged, in state of its own beside the lessons'. Not folded
   * into DragState: a band is not a lesson — no validateChange, no tray, no
   * resize, a length that is the school's and not the grid's — and sharing that
   * machinery would thread "is this a band?" through every branch of it. The
   * ghost lives in a ref as well as state for the reason the lesson ghost does:
   * the pointerup handler must read the last position synchronously, and a
   * side effect inside a setState updater runs twice under StrictMode.
   */
  const bandDragRef = useRef<{
    id: string;
    pointerId: number;
    grabOffsetMinutes: number;
    duration: number;
    originDay: number;
    originStart: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const bandGhostRef = useRef<{
    dayOfWeek: number;
    startMinutes: number;
    endMinutes: number;
  } | null>(null);
  const [bandGhost, setBandGhost] = useState<{
    id: string;
    dayOfWeek: number;
    startMinutes: number;
    endMinutes: number;
  } | null>(null);
  const [bandDraggingId, setBandDraggingId] = useState<string | null>(null);

  const includeWeekend = lessons.some((lesson) => lesson.dayOfWeek > 5);
  const dayCount = includeWeekend ? 7 : 5;

  const { startHour, endHour } = useMemo(() => {
    // The bands count towards the bounds. A lunch at 07:30 or 16:30 drawn on a
    // grid derived from the lessons alone would be clipped off the edge — and
    // silently, since a band has no other affordance to notice its absence by.
    const starts = [
      ...lessons.map((l) => l.startMinutes),
      ...(bands ?? []).map((b) => b.startMinutes),
    ];
    const ends = [
      ...lessons.map((l) => l.endMinutes),
      ...(bands ?? []).map((b) => b.endMinutes),
    ];
    if (starts.length === 0) return { startHour: 8, endHour: 16 };
    return {
      startHour: Math.min(8, Math.floor(Math.min(...starts) / 60)),
      endHour: Math.max(16, Math.ceil(Math.max(...ends) / 60)),
    };
  }, [lessons, bands]);

  /** The most common lesson length, which is what the grid is measured for. */
  const pxPerMinute = useMemo(() => {
    const counts = new Map<number, number>();
    for (const lesson of lessons) {
      const minutes = lesson.endMinutes - lesson.startMinutes;
      if (minutes > 0) counts.set(minutes, (counts.get(minutes) ?? 0) + 1);
    }
    if (counts.size === 0) return BASE_PX_PER_MINUTE;
    // Ties go to the SHORTER length, which is the one at risk of being cut.
    const typical = [...counts.entries()].reduce((best, entry) =>
      entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0]) ? entry : best,
    )[0];
    const wanted = (BLOCK_PADDING_PX + LINES_A_LESSON_WANTS * LINE_PX) / typical;
    return Math.min(MAX_PX_PER_MINUTE, Math.max(BASE_PX_PER_MINUTE, wanted));
  }, [lessons]);

  const totalMinutes = (endHour - startHour) * 60;
  const gridHeight = totalMinutes * pxPerMinute;
  const dayStartMinutes = startHour * 60;
  const dayEndMinutes = endHour * 60;

  const byDay = useMemo(() => {
    const map = new Map<number, PositionedLesson[]>();
    for (let day = 1; day <= dayCount; day++) {
      map.set(
        day,
        layoutDay(lessons.filter((lesson) => lesson.dayOfWeek === day)),
      );
    }
    return map;
  }, [lessons, dayCount]);

  const lessonById = useMemo(
    () => new Map(lessons.map((lesson) => [lesson.id, lesson])),
    [lessons],
  );

  /** Converts a pointer event to grid coordinates (day + minute). */
  const locate = useCallback(
    (clientX: number, clientY: number): { day: number; minute: number } | null => {
      const body = bodyRef.current;
      if (!body) return null;
      const rect = body.getBoundingClientRect();
      const x = clientX - rect.left - TIME_AXIS_PX;
      const y = clientY - rect.top;
      const dayWidth = (rect.width - TIME_AXIS_PX) / dayCount;
      if (dayWidth <= 0) return null;
      const day = Math.min(dayCount, Math.max(1, Math.floor(x / dayWidth) + 1));
      const minute = dayStartMinutes + y / pxPerMinute;
      return { day, minute };
    },
    [dayCount, dayStartMinutes, pxPerMinute],
  );

  const updateGhost = useCallback(
    (next: GhostState | null) => {
      ghostRef.current = next;
      setGhost(next);
    },
    [],
  );

  const endDrag = useCallback(
    (commit: boolean, point?: { clientX: number; clientY: number }) => {
      const drag = dragRef.current;
      const currentGhost = ghostRef.current;
      dragRef.current = null;
      setDraggingId(null);
      updateGhost(null);

      if (!drag || !drag.moved) return;
      if (!commit) return;

      // Let go outside the grid: hand the point to the page and commit nothing.
      // Checked before the ghost, because `locate` clamps into a column and
      // the ghost therefore always looks like a valid drop somewhere.
      if (point && onDropOutside && bodyRef.current) {
        const rect = bodyRef.current.getBoundingClientRect();
        const outside =
          point.clientX < rect.left ||
          point.clientX > rect.right ||
          point.clientY < rect.top ||
          point.clientY > rect.bottom;
        if (outside) {
          onDropOutside(drag.lessonId, point);
          return;
        }
      }

      if (!currentGhost) return;
      if (!currentGhost.valid) {
        if (onInvalidDrop) {
          onInvalidDrop(drag.lessonId, {
            dayOfWeek: currentGhost.dayOfWeek,
            startMinutes: currentGhost.startMinutes,
            endMinutes: currentGhost.endMinutes,
          });
        }
        return;
      }

      const changed =
        drag.external === true ||
        currentGhost.dayOfWeek !== drag.origin.dayOfWeek ||
        currentGhost.startMinutes !== drag.origin.startMinutes ||
        currentGhost.endMinutes !== drag.origin.endMinutes;
      if (changed && onLessonChange) {
        onLessonChange(drag.lessonId, {
          dayOfWeek: currentGhost.dayOfWeek,
          startMinutes: currentGhost.startMinutes,
          endMinutes: currentGhost.endMinutes,
        });
      }
    },
    [onLessonChange, onInvalidDrop, onDropOutside, updateGhost],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      beginExternalDrag: (lesson, pointer) => {
        if (!editable) return;
        dragRef.current = {
          pointerId: pointer.pointerId,
          lessonId: lesson.id,
          mode: "move",
          // The grab is at the lesson's start: a card on the tray has no
          // position on the clock for the pointer to be offset from.
          grabOffsetMinutes: 0,
          origin: lesson,
          startClientX: pointer.clientX,
          startClientY: pointer.clientY,
          // Past the threshold from the first pixel. The tray card is already
          // in hand; asking it to travel five pixels before the ghost appears
          // would make the grid look dead until it did.
          moved: true,
          external: true,
        };
        setDraggingId(lesson.id);
      },
    }),
    [editable],
  );

  useEffect(() => {
    if (!draggingId) return;

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.moved) {
        const dx = Math.abs(event.clientX - drag.startClientX);
        const dy = Math.abs(event.clientY - drag.startClientY);
        if (dx + dy < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
      }

      const located = locate(event.clientX, event.clientY);
      if (!located) return;

      const duration = drag.origin.endMinutes - drag.origin.startMinutes;
      let next: GhostState;

      if (drag.mode === "move") {
        let start = snap(located.minute - drag.grabOffsetMinutes, DRAG_SNAP_MINUTES);
        start = Math.max(dayStartMinutes, Math.min(start, dayEndMinutes - duration));
        next = {
          dayOfWeek: located.day,
          startMinutes: start,
          endMinutes: start + duration,
          valid: true,
        };
      } else {
        let end = snap(located.minute, DRAG_SNAP_MINUTES);
        end = Math.max(
          drag.origin.startMinutes + MIN_DURATION_MINUTES,
          Math.min(end, dayEndMinutes),
        );
        next = {
          dayOfWeek: drag.origin.dayOfWeek,
          startMinutes: drag.origin.startMinutes,
          endMinutes: end,
          valid: true,
        };
      }

      if (validateChange) {
        next.valid = validateChange(drag.lessonId, {
          dayOfWeek: next.dayOfWeek,
          startMinutes: next.startMinutes,
          endMinutes: next.endMinutes,
        });
      }
      updateGhost(next);
    };

    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const wasClick = !drag.moved;
      const lesson = lessonById.get(drag.lessonId);
      endDrag(true, { clientX: event.clientX, clientY: event.clientY });
      if (wasClick && lesson) {
        if (event.shiftKey && onToggleSelect) onToggleSelect(lesson.id);
        else if (onLessonClick) onLessonClick(lesson);
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDrag(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [
    draggingId,
    locate,
    lessonById,
    onLessonClick,
    onToggleSelect,
    endDrag,
    updateGhost,
    validateChange,
    dayStartMinutes,
    dayEndMinutes,
  ]);

  useEffect(() => {
    if (!bandDraggingId) return;

    const clear = () => {
      bandDragRef.current = null;
      bandGhostRef.current = null;
      setBandDraggingId(null);
      setBandGhost(null);
    };

    const onMove = (event: PointerEvent) => {
      const drag = bandDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) {
        const dx = Math.abs(event.clientX - drag.startClientX);
        const dy = Math.abs(event.clientY - drag.startClientY);
        if (dx + dy < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
      }
      const located = locate(event.clientX, event.clientY);
      if (!located) return;
      let start = snap(located.minute - drag.grabOffsetMinutes, DRAG_SNAP_MINUTES);
      start = Math.max(dayStartMinutes, Math.min(start, dayEndMinutes - drag.duration));
      const next = {
        dayOfWeek: located.day,
        startMinutes: start,
        endMinutes: start + drag.duration,
      };
      bandGhostRef.current = next;
      setBandGhost({ id: drag.id, ...next });
    };

    const onUp = (event: PointerEvent) => {
      const drag = bandDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const ghost = bandGhostRef.current;
      clear();
      if (
        drag.moved &&
        ghost &&
        onBandMove &&
        (ghost.dayOfWeek !== drag.originDay || ghost.startMinutes !== drag.originStart)
      ) {
        onBandMove(drag.id, ghost.dayOfWeek, ghost.startMinutes);
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [bandDraggingId, locate, dayStartMinutes, dayEndMinutes, onBandMove]);

  const startBandDrag = (event: React.PointerEvent, band: TimetableBand) => {
    if (!editable || !onBandMove || event.button !== 0) return;
    event.preventDefault();
    // The column behind the band creates a lesson on a click. This press is
    // the meal's, and must not become that.
    event.stopPropagation();
    const located = locate(event.clientX, event.clientY);
    bandDragRef.current = {
      id: band.id,
      pointerId: event.pointerId,
      grabOffsetMinutes: located ? located.minute - band.startMinutes : 0,
      duration: band.endMinutes - band.startMinutes,
      originDay: band.dayOfWeek,
      originStart: band.startMinutes,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    setBandDraggingId(band.id);
  };

  /** Keyboard parity with a lesson: arrows move it, Delete removes a hand-placed one. */
  const handleBandKey = (event: React.KeyboardEvent, band: TimetableBand) => {
    if (!editable) return;
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      band.removeLabel &&
      onBandRemove
    ) {
      event.preventDefault();
      onBandRemove(band.id);
      return;
    }
    if (!onBandMove) return;
    const duration = band.endMinutes - band.startMinutes;
    let day = band.dayOfWeek;
    let start = band.startMinutes;
    if (event.key === "ArrowUp") start -= SLOT_CLICK_SNAP_MINUTES;
    else if (event.key === "ArrowDown") start += SLOT_CLICK_SNAP_MINUTES;
    else if (event.key === "ArrowLeft") day -= 1;
    else if (event.key === "ArrowRight") day += 1;
    else return;
    event.preventDefault();
    day = Math.max(1, Math.min(dayCount, day));
    start = Math.max(dayStartMinutes, Math.min(start, dayEndMinutes - duration));
    if (day !== band.dayOfWeek || start !== band.startMinutes) {
      onBandMove(band.id, day, start);
    }
  };

  const startDrag = (event: React.PointerEvent, lesson: TimetableLesson) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault();

    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const nearBottom = rect.bottom - event.clientY <= RESIZE_HANDLE_PX;

    const located = locate(event.clientX, event.clientY);
    dragRef.current = {
      pointerId: event.pointerId,
      lessonId: lesson.id,
      mode: nearBottom ? "resize" : "move",
      grabOffsetMinutes: located ? located.minute - lesson.startMinutes : 0,
      origin: lesson,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    setDraggingId(lesson.id);
  };

  /**
   * Keyboard editing (a11y-parity with drag & drop): arrows move the focused
   * lesson by 15 min (Up/Down) or one day (Left/Right); Enter opens the
   * editor. Moves are validated before being applied.
   */
  const handleLessonKey = (event: React.KeyboardEvent, lesson: TimetableLesson) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.shiftKey && onToggleSelect) onToggleSelect(lesson.id);
      else if (onLessonClick) onLessonClick(lesson);
      return;
    }
    if (!onLessonChange) return;

    const duration = lesson.endMinutes - lesson.startMinutes;
    let day = lesson.dayOfWeek;
    let start = lesson.startMinutes;
    if (event.key === "ArrowUp") start -= SLOT_CLICK_SNAP_MINUTES;
    else if (event.key === "ArrowDown") start += SLOT_CLICK_SNAP_MINUTES;
    else if (event.key === "ArrowLeft") day -= 1;
    else if (event.key === "ArrowRight") day += 1;
    else return;

    event.preventDefault();
    day = Math.min(dayCount, Math.max(1, day));
    start = Math.max(dayStartMinutes, Math.min(start, dayEndMinutes - duration));
    const change: LessonChange = {
      dayOfWeek: day,
      startMinutes: start,
      endMinutes: start + duration,
    };
    if (
      change.dayOfWeek === lesson.dayOfWeek &&
      change.startMinutes === lesson.startMinutes
    ) {
      return;
    }
    if (validateChange && !validateChange(lesson.id, change)) {
      onInvalidDrop?.(lesson.id, change);
      return;
    }
    onLessonChange(lesson.id, change);
  };

  const handleSlotClick = (event: React.MouseEvent, day: number) => {
    if (!editable || !onSlotClick) return;
    // Only clicks on the column background (not on a lesson) create slots.
    if (event.target !== event.currentTarget) return;
    const located = locate(event.clientX, event.clientY);
    if (!located) return;
    const minute = Math.max(
      dayStartMinutes,
      Math.min(
        dayEndMinutes - MIN_DURATION_MINUTES,
        Math.floor(located.minute / SLOT_CLICK_SNAP_MINUTES) * SLOT_CLICK_SNAP_MINUTES,
      ),
    );
    onSlotClick(day, minute);
  };

  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-lg border bg-card",
        (draggingId || bandDraggingId) && "select-none",
        className,
      )}
    >
      <div className="min-w-[720px]">
        {/* Header row */}
        <div
          className="grid border-b"
          style={{ gridTemplateColumns: `3.5rem repeat(${dayCount}, 1fr)` }}
        >
          <div />
          {Array.from({ length: dayCount }, (_, i) => {
            const date = dates?.[i];
            const isToday =
              date !== undefined && date.toDateString() === new Date().toDateString();
            return (
              <div
                key={i}
                className={cn(
                  "border-l px-2 py-2.5 text-center",
                  isToday && "bg-accent/60",
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(DAY_KEYS[i] as string)}
                </div>
                {date ? (
                  <div
                    className={cn(
                      "text-sm font-medium",
                      isToday && "text-accent-foreground",
                    )}
                  >
                    {date.getDate()}/{date.getMonth() + 1}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          className="relative grid"
          style={{
            gridTemplateColumns: `3.5rem repeat(${dayCount}, 1fr)`,
            height: `${gridHeight}px`,
          }}
        >
          {/* Time axis */}
          <div className="relative">
            {hours.slice(0, -1).map((hour) => (
              <div
                key={hour}
                className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground"
                style={{ top: `${(hour - startHour) * 60 * pxPerMinute}px` }}
              >
                {hour !== startHour ? `${String(hour).padStart(2, "0")}:00` : ""}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {Array.from({ length: dayCount }, (_, i) => {
            const day = i + 1;
            const dayLessons = byDay.get(day) ?? [];
            return (
              <div
                key={day}
                className="relative border-l"
                onClick={(event) => handleSlotClick(event, day)}
              >
                {/*
                  The bands, behind everything and inert.

                  `pointer-events-none` is load-bearing, not cosmetic:
                  handleSlotClick only fires when `event.target ===
                  event.currentTarget`, so a band that swallowed pointer events
                  would silently kill empty-slot lesson creation across its whole
                  stripe — on exactly the hours a school is most likely to click.
                */}
                {(bands ?? [])
                  .filter((band) => band.dayOfWeek === day)
                  .map((band) => (
                    <div
                      key={band.id}
                      className={cn(
                        "pointer-events-none absolute inset-x-0 z-0 flex items-start justify-end border-y border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[10px] leading-none text-amber-700 dark:text-amber-500",
                        bandDraggingId === band.id && "opacity-40",
                      )}
                      style={{
                        top: `${(band.startMinutes - startHour * 60) * pxPerMinute}px`,
                        height: `${Math.max(
                          12,
                          (band.endMinutes - band.startMinutes) * pxPerMinute,
                        )}px`,
                      }}
                    >
                      {/*
                        A meal this screen may move gets a GRIP, and only the grip
                        takes the pointer. The stripe itself stays inert for the
                        reason given above — it spans the whole column, and a
                        stripe that swallowed clicks would kill lesson creation
                        across it. A handle the size of its label does not.
                      */}
                      {band.movable && editable && onBandMove ? (
                        <span className="pointer-events-auto flex items-center gap-0.5">
                          <button
                            type="button"
                            aria-label={band.moveLabel ?? band.label}
                            title={band.moveLabel ?? band.label}
                            onPointerDown={(event) => startBandDrag(event, band)}
                            onKeyDown={(event) => handleBandKey(event, band)}
                            className="flex cursor-grab items-center gap-0.5 rounded px-0.5 hover:bg-amber-500/20 focus-visible:outline-2 focus-visible:outline-amber-600 active:cursor-grabbing"
                          >
                            {band.handPlaced ? <Lock aria-hidden className="size-2.5" /> : null}
                            {band.label}
                          </button>
                          {band.removeLabel && onBandRemove ? (
                            <button
                              type="button"
                              aria-label={band.removeLabel}
                              title={band.removeLabel}
                              onClick={() => onBandRemove(band.id)}
                              className="rounded px-0.5 hover:bg-amber-500/20 focus-visible:outline-2 focus-visible:outline-amber-600"
                            >
                              <X aria-hidden className="size-2.5" />
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        band.label
                      )}
                    </div>
                  ))}
                {bandGhost && bandGhost.dayOfWeek === day ? (
                  <div
                    data-testid="band-ghost"
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 z-20 border-2 border-dotted border-amber-500 bg-amber-500/20"
                    style={{
                      top: `${(bandGhost.startMinutes - startHour * 60) * pxPerMinute}px`,
                      height: `${Math.max(
                        12,
                        (bandGhost.endMinutes - bandGhost.startMinutes) * pxPerMinute,
                      )}px`,
                    }}
                  />
                ) : null}

                {/* Hour lines */}
                {hours.slice(1, -1).map((hour) => (
                  <div
                    key={hour}
                    className="pointer-events-none absolute inset-x-0 border-t border-border/60"
                    style={{ top: `${(hour - startHour) * 60 * pxPerMinute}px` }}
                  />
                ))}

                {dayLessons.map((lesson) => {
                  // Callbacks always get the caller's own object: `lane` and
                  // `laneCount` are layout state of this render, and the
                  // editable pointer path already hands out the original.
                  const source = lessonById.get(lesson.id) ?? lesson;
                  const top = (lesson.startMinutes - startHour * 60) * pxPerMinute;
                  const height = Math.max(
                    28,
                    (lesson.endMinutes - lesson.startMinutes) * pxPerMinute,
                  );
                  /*
                   * WHAT THE BOX CAN HOLD, and what to do when it holds less
                   * than the lesson has to say.
                   *
                   * The grid is measured for the school's usual lesson, so a
                   * shorter one still arrives here with more rows than room —
                   * and the rows used to be drawn anyway and clipped by
                   * `overflow-hidden`, which cuts the last one through the
                   * middle of its letters. A half-letter is not information;
                   * it reads as a rendering fault.
                   *
                   * So the facts collapse onto one line before they are cut,
                   * and below two lines only the title survives. The full text
                   * is on the block's `title` either way — see below — so
                   * nothing is ever only half-said.
                   */
                  const facts = [
                    lesson.subtitle,
                    lesson.room,
                    lesson.recurrenceNote,
                  ].filter((fact): fact is string => Boolean(fact));
                  const linesThatFit = Math.max(
                    1,
                    Math.floor((height - BLOCK_PADDING_PX) / LINE_PX),
                  );
                  const stacked = 1 + facts.length <= linesThatFit;
                  const selected = selectedIds?.has(lesson.id) ?? false;
                  const widthPct = 100 / lesson.laneCount;
                  const isDragSource = draggingId === lesson.id;
                  return (
                    <button
                      key={lesson.id}
                      type="button"
                      onClick={
                        // In editable mode clicks are resolved on pointerup
                        // (drag vs click); otherwise plain click-to-open.
                        !editable && onLessonClick
                          ? () => onLessonClick(source)
                          : undefined
                      }
                      onPointerDown={
                        editable ? (event) => startDrag(event, source) : undefined
                      }
                      onKeyDown={
                        editable
                          ? (event) => handleLessonKey(event, source)
                          : undefined
                      }
                      /*
                       * The whole of it, one hover away.
                       *
                       * A block is a rectangle sized by the clock, so there is
                       * always a lesson somewhere that does not fit in it —
                       * and until this there was no way to read what had been
                       * left out without opening the editor. The time is here
                       * too, which the grid shows nowhere else: the axis is
                       * hourly, and a 40-minute lesson starts between its
                       * lines.
                       */
                      title={[
                        `${clockOf(lesson.startMinutes)}-${clockOf(lesson.endMinutes)}`,
                        lesson.title,
                        ...facts,
                        // NOT in `facts`, which is also what the block prints
                        // when it has room. A fourth line inside the rectangle
                        // would change what fits and push a real subject or a
                        // period badge out for a note about time that is not
                        // the lesson's; and the block's geometry stays the
                        // teaching time either way. See pupilTimeNote.
                        lesson.pupilTimeNote,
                      ]
                        .filter((fact): fact is string => Boolean(fact))
                        .join(" · ")}
                      className={cn(
                        "absolute overflow-hidden rounded-md border-l-4 p-1.5 text-left text-xs shadow-sm transition-shadow",
                        onLessonClick || editable
                          ? "cursor-pointer hover:shadow-md"
                          : "cursor-default",
                        editable && "touch-none",
                        lesson.cancelled && "opacity-45 line-through",
                        lesson.conflicted && "ring-2 ring-red-500/80",
                        /*
                         * THE FOREGROUND COLOUR, not a blue one.
                         *
                         * A block is tinted with its subject's colour at a
                         * tenth of an opacity, so every one of them is pale —
                         * against which the foreground reads, and a mid-blue
                         * outline reads on a green lesson and disappears on a
                         * blue one. Which half of the timetable a selection is
                         * visible on should not depend on the subject.
                         *
                         * `outline` and not `ring`: the red clash mark above
                         * is a ring, and the two would be the same CSS
                         * property fighting over one lesson.
                         */
                        selected && "outline outline-2 outline-offset-1 outline-foreground",
                        isDragSource && "opacity-40",
                      )}
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                        left: `calc(${lesson.lane * widthPct}% + 3px)`,
                        width: `calc(${widthPct}% - 6px)`,
                        backgroundColor: `${lesson.color}1a`,
                        borderLeftColor: lesson.color,
                      }}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div
                          className="truncate font-semibold"
                          style={{ color: lesson.color }}
                        >
                          {lesson.title}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {selected ? (
                            // Beside the outline rather than instead of it: an
                            // icon is independent of colour and contrast, and
                            // it settles one block on its own without holding
                            // it up against its neighbours.
                            <span className="rounded bg-foreground px-0.5 text-background">
                              <Check className="h-3 w-3" />
                              <span className="sr-only">{t("selected")}</span>
                            </span>
                          ) : null}
                          {lesson.share ? (
                            <span
                              title={lesson.shareLabel}
                              className="rounded bg-foreground/10 px-1 text-[9px] font-semibold tabular-nums text-foreground"
                            >
                              {lesson.share}
                              <span className="sr-only">
                                {lesson.shareLabel ? ` ${lesson.shareLabel}` : ""}
                              </span>
                            </span>
                          ) : null}
                          {lesson.remoteEditor ? (
                            <span
                              title={lesson.remoteEditor}
                              className="rounded bg-amber-200/80 px-1 text-[9px] font-semibold text-amber-900"
                            >
                              {lesson.remoteEditor}
                            </span>
                          ) : null}
                          {lesson.conflicted ? (
                            <TriangleAlert className="h-3 w-3 text-red-500" />
                          ) : null}
                          {lesson.locked ? (
                            <Lock className="h-3 w-3 text-muted-foreground" />
                          ) : null}
                        </div>
                      </div>
                      {stacked ? (
                        <>
                          {lesson.subtitle ? (
                            <div className="truncate text-muted-foreground">
                              {lesson.subtitle}
                            </div>
                          ) : null}
                          {lesson.room ? (
                            <div className="truncate text-muted-foreground">{lesson.room}</div>
                          ) : null}
                          {lesson.recurrenceNote ? (
                            <div className="truncate font-medium uppercase tracking-wide text-[9px] text-muted-foreground">
                              {lesson.recurrenceNote}
                            </div>
                          ) : null}
                        </>
                      ) : linesThatFit >= 2 && facts.length > 0 ? (
                        <div className="truncate text-muted-foreground">
                          {facts.join(" · ")}
                        </div>
                      ) : facts.length > 0 ? (
                        // Nowhere to draw them, but a reader who is listening
                        // rather than looking is not short of pixels. The
                        // sighted reader has the same text on the tooltip.
                        <span className="sr-only">{facts.join(" · ")}</span>
                      ) : null}
                      {editable ? (
                        <div className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize" />
                      ) : null}
                    </button>
                  );
                })}

                {/* Drag ghost */}
                {ghost && draggingId && ghost.dayOfWeek === day ? (
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0.5 z-10 rounded-md border-2 border-dashed px-1.5 py-1 text-[11px] font-medium tabular-nums",
                      ghost.valid
                        ? "border-emerald-500 bg-emerald-500/15 text-emerald-700"
                        : "border-red-500 bg-red-500/15 text-red-700",
                    )}
                    style={{
                      top: `${(ghost.startMinutes - startHour * 60) * pxPerMinute}px`,
                      height: `${Math.max(
                        20,
                        (ghost.endMinutes - ghost.startMinutes) * pxPerMinute,
                      )}px`,
                    }}
                  >
                    {String(Math.floor(ghost.startMinutes / 60)).padStart(2, "0")}:
                    {String(ghost.startMinutes % 60).padStart(2, "0")}
                    {"–"}
                    {String(Math.floor(ghost.endMinutes / 60)).padStart(2, "0")}:
                    {String(ghost.endMinutes % 60).padStart(2, "0")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
