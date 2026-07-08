"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
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
}

interface TimetableGridProps {
  lessons: TimetableLesson[];
  /** Optional dates rendered under each day header (index 0 = Monday). */
  dates?: Date[];
  onLessonClick?: (lesson: TimetableLesson) => void;
  className?: string;
}

interface PositionedLesson extends TimetableLesson {
  lane: number;
  laneCount: number;
}

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const SLOT_HEIGHT_PX = 1.1; // pixels per minute

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

export function TimetableGrid({ lessons, dates, onLessonClick, className }: TimetableGridProps) {
  const t = useTranslations("common");

  const includeWeekend = lessons.some((lesson) => lesson.dayOfWeek > 5);
  const dayCount = includeWeekend ? 7 : 5;

  const { startHour, endHour } = useMemo(() => {
    if (lessons.length === 0) return { startHour: 8, endHour: 16 };
    const min = Math.min(...lessons.map((l) => l.startMinutes));
    const max = Math.max(...lessons.map((l) => l.endMinutes));
    return {
      startHour: Math.min(8, Math.floor(min / 60)),
      endHour: Math.max(16, Math.ceil(max / 60)),
    };
  }, [lessons]);

  const totalMinutes = (endHour - startHour) * 60;
  const gridHeight = totalMinutes * SLOT_HEIGHT_PX;

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

  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);

  return (
    <div className={cn("overflow-x-auto rounded-lg border bg-card", className)}>
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
              <div key={day} className="relative border-l">
                {/* Hour lines */}
                {hours.slice(1, -1).map((hour) => (
                  <div
                    key={hour}
                    className="absolute inset-x-0 border-t border-border/60"
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
                  return (
                    <button
                      key={lesson.id}
                      type="button"
                      onClick={onLessonClick ? () => onLessonClick(lesson) : undefined}
                      className={cn(
                        "absolute overflow-hidden rounded-md border-l-4 p-1.5 text-left text-xs shadow-sm transition-shadow",
                        onLessonClick ? "cursor-pointer hover:shadow-md" : "cursor-default",
                        lesson.cancelled && "opacity-45 line-through",
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
                      <div className="truncate font-semibold" style={{ color: lesson.color }}>
                        {lesson.title}
                      </div>
                      {lesson.subtitle ? (
                        <div className="truncate text-muted-foreground">{lesson.subtitle}</div>
                      ) : null}
                      {lesson.room ? (
                        <div className="truncate text-muted-foreground">{lesson.room}</div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
