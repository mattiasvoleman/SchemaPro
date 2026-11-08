"use client";

import { Ban, Lock, NotebookPen, Pencil } from "lucide-react";
import { gridSpan, layoutLanes, minutesOf, type LessonState } from "@/lib/class-teacher";
import { cn } from "@/lib/utils";

/** One lesson as the grid draws it; the page has said it all in words already. */
export interface GridItem {
  id: string;
  /** 1 = Monday ... 5 = Friday. */
  day: number;
  start: string;
  end: string;
  title: string;
  /** Room and the like, under the title when the card is tall enough. */
  detail: string | null;
  state: LessonState;
  stateLabel: string;
  /** The reason a locked lesson is locked, in words. */
  reason: string | null;
  /** The sentence a screen reader gets for the card. */
  name: string;
}

export interface GridDay {
  day: number;
  label: string;
  /** The date under the day's name; null in the weekly template. */
  sub: string | null;
  /** The hours open to the klasslärare this day. */
  open: Array<{ start: string; end: string }>;
  /** "Öppet 08:00–12:00" or "Inget öppet": said in text, since the band is a tint. */
  openText: string;
}

/** Pixels to a minute: an hour is 60 px, so a 40-minute lesson is a card one can read. */
const PX_PER_MINUTE = 1;
/** Under this height a card holds one line. */
const COMPACT_PX = 44;
/** The hour labels' column, in rem. */
const GUTTER_REM = 1.75;

const STATE_ICON = { editable: Pencil, locked: Lock, draft: NotebookPen, cancelled: Ban } as const;

const STATE_CLASS: Record<LessonState, string> = {
  editable: "border bg-card hover:bg-accent",
  locked: "border border-dashed bg-muted",
  draft: "border-2 border-warning bg-warning/10",
  cancelled: "border border-dashed bg-muted",
};

/**
 * A week of the class (or its weekly template) as columns of time: one column
 * a day, a card a lesson, the hours open to the klasslärare as a quiet tint
 * behind them. The tint is only a tint: each day's heading says the same
 * hours in words, and each card says its state in words and in an icon (never
 * colour alone), with the reason a locked lesson is locked in the sentence a
 * screen reader gets.
 *
 * Lessons that overlap stand side by side (a class can have two at once).
 * Every card is a button, locked ones too: choosing one is how a klasslärare
 * reads why it cannot be changed.
 */
export function LessonGrid({
  label,
  days,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  days: GridDay[];
  items: GridItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { from, to } = gridSpan(
    [
      ...items.flatMap((item) => [minutesOf(item.start), minutesOf(item.end)]),
      ...days.flatMap((day) => day.open.flatMap((open) => [minutesOf(open.start), minutesOf(open.end)])),
    ],
  );
  const hours = Array.from({ length: (to - from) / 60 }, (_, index) => from + index * 60);

  return (
    <div role="group" aria-label={label} className="grid gap-3 md:grid-cols-5">
      {days.map((day) => {
        const dayItems = items.filter((item) => item.day === day.day);
        const lanes = layoutLanes(dayItems.map((item) => ({ id: item.id, start: minutesOf(item.start), end: minutesOf(item.end) })));
        const headingId = `lesson-grid-day-${day.day}`;
        return (
          <section key={day.day} aria-labelledby={headingId} className="min-w-0 space-y-1">
            <div className="text-sm">
              <h3 id={headingId} className="font-semibold">
                {day.label}
                {day.sub ? <span className="ml-1 font-normal text-muted-foreground">{day.sub}</span> : null}
              </h3>
              <p className="text-xs text-muted-foreground">{day.openText}</p>
            </div>
            <div className="relative overflow-hidden rounded-md border bg-background" style={{ height: (to - from) * PX_PER_MINUTE }}>
              {day.open.map((open) => (
                <div
                  key={`${open.start}-${open.end}`}
                  aria-hidden="true"
                  data-open-band=""
                  className="absolute inset-x-0 bg-primary/[0.07]"
                  style={{ top: (minutesOf(open.start) - from) * PX_PER_MINUTE, height: (minutesOf(open.end) - minutesOf(open.start)) * PX_PER_MINUTE }}
                />
              ))}
              {hours.map((hour) => (
                <div
                  key={hour}
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-dashed border-border/70"
                  style={{ top: (hour - from) * PX_PER_MINUTE }}
                >
                  <span className="absolute left-0.5 top-0 text-[10px] leading-none text-muted-foreground">{String(hour / 60).padStart(2, "0")}</span>
                </div>
              ))}
              {dayItems.map((item) => {
                const place = lanes.get(item.id)!;
                const height = (minutesOf(item.end) - minutesOf(item.start)) * PX_PER_MINUTE;
                const Icon = STATE_ICON[item.state];
                const selected = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    aria-label={item.name}
                    title={item.reason ?? undefined}
                    onClick={() => onSelect(item.id)}
                    data-state={item.state}
                    className={cn(
                      "absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      STATE_CLASS[item.state],
                      selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                    )}
                    style={{
                      top: (minutesOf(item.start) - from) * PX_PER_MINUTE,
                      height: height - 1,
                      left: `calc(${GUTTER_REM}rem + (100% - ${GUTTER_REM}rem) * ${place.lane / place.lanes})`,
                      width: `calc((100% - ${GUTTER_REM}rem) / ${place.lanes} - 2px)`,
                    }}
                  >
                    <span className="flex items-center gap-1 font-medium text-foreground">
                      <Icon className="size-3 shrink-0" aria-hidden="true" />
                      <span className={cn("truncate", item.state === "cancelled" && "line-through")}>{item.title}</span>
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {height < COMPACT_PX ? `${item.start} · ${item.stateLabel}` : `${item.start}–${item.end} · ${item.stateLabel}`}
                    </span>
                    {height >= COMPACT_PX && item.detail ? <span className="block truncate text-muted-foreground">{item.detail}</span> : null}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
