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
import { Lock, TriangleAlert } from "lucide-react";
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
  className?: string;
}

type TimetableGridInnerProps = TimetableGridProps & {
  handleRef: React.ForwardedRef<TimetableGridHandle>;
};

/** A stripe across one day, drawn behind the lessons. */
export interface TimetableBand {
  id: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  label: string;
}

interface PositionedLesson extends TimetableLesson {
  lane: number;
  laneCount: number;
}

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const SLOT_HEIGHT_PX = 1.1; // pixels per minute
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

/** Assigns overlapping lessons within a day to side-by-side lanes. */
function layoutDay(lessons: TimetableLesson[]): PositionedLesson[] {
  const sorted = [...lessons].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );
  const laneEnds: number[] = [];
  const positioned: Array<TimetableLesson & { lane: number }> = [];

  for (const lesson of sorted) {
    let lane = laneEnds.findIndex((end) => end <= lesson.startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = lesson.endMinutes;
    positioned.push({ ...lesson, lane });
  }

  const laneCount = Math.max(1, laneEnds.length);
  return positioned.map((lesson) => ({ ...lesson, laneCount }));
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
  bands,
  className,
}: TimetableGridInnerProps) {
  const t = useTranslations("common");
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<GhostState | null>(null);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

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

  const totalMinutes = (endHour - startHour) * 60;
  const gridHeight = totalMinutes * SLOT_HEIGHT_PX;
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
      const minute = dayStartMinutes + y / SLOT_HEIGHT_PX;
      return { day, minute };
    },
    [dayCount, dayStartMinutes],
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
        draggingId && "select-none",
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
                style={{ top: `${(hour - startHour) * 60 * SLOT_HEIGHT_PX}px` }}
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
                      className="pointer-events-none absolute inset-x-0 z-0 flex items-start justify-end border-y border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[10px] leading-none text-amber-700 dark:text-amber-500"
                      style={{
                        top: `${(band.startMinutes - startHour * 60) * SLOT_HEIGHT_PX}px`,
                        height: `${Math.max(
                          12,
                          (band.endMinutes - band.startMinutes) * SLOT_HEIGHT_PX,
                        )}px`,
                      }}
                    >
                      {band.label}
                    </div>
                  ))}

                {/* Hour lines */}
                {hours.slice(1, -1).map((hour) => (
                  <div
                    key={hour}
                    className="pointer-events-none absolute inset-x-0 border-t border-border/60"
                    style={{ top: `${(hour - startHour) * 60 * SLOT_HEIGHT_PX}px` }}
                  />
                ))}

                {dayLessons.map((lesson) => {
                  const top = (lesson.startMinutes - startHour * 60) * SLOT_HEIGHT_PX;
                  const height = Math.max(
                    28,
                    (lesson.endMinutes - lesson.startMinutes) * SLOT_HEIGHT_PX,
                  );
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
                          ? () => onLessonClick(lesson)
                          : undefined
                      }
                      onPointerDown={
                        editable ? (event) => startDrag(event, lesson) : undefined
                      }
                      onKeyDown={
                        editable
                          ? (event) => handleLessonKey(event, lesson)
                          : undefined
                      }
                      className={cn(
                        "absolute overflow-hidden rounded-md border-l-4 p-1.5 text-left text-xs shadow-sm transition-shadow",
                        onLessonClick || editable
                          ? "cursor-pointer hover:shadow-md"
                          : "cursor-default",
                        editable && "touch-none",
                        lesson.cancelled && "opacity-45 line-through",
                        lesson.conflicted && "ring-2 ring-red-500/80",
                        selectedIds?.has(lesson.id) &&
                          "outline outline-2 outline-offset-1 outline-blue-500",
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
                      {lesson.subtitle ? (
                        <div className="truncate text-muted-foreground">{lesson.subtitle}</div>
                      ) : null}
                      {lesson.room ? (
                        <div className="truncate text-muted-foreground">{lesson.room}</div>
                      ) : null}
                      {lesson.recurrenceNote ? (
                        <div className="truncate font-medium uppercase tracking-wide text-[9px] text-muted-foreground">
                          {lesson.recurrenceNote}
                        </div>
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
                      top: `${(ghost.startMinutes - startHour * 60) * SLOT_HEIGHT_PX}px`,
                      height: `${Math.max(
                        20,
                        (ghost.endMinutes - ghost.startMinutes) * SLOT_HEIGHT_PX,
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
