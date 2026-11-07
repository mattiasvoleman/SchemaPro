"use client";

import { cn } from "@/lib/utils";
import type { Drawn } from "@/lib/school-day";
import { useSchoolDayText } from "./use-school-day-text";

/**
 * The ink and the edge of one drawn thing. Never the only signal: a block
 * says what it is in words (its own title, or "Inställd" in its name for a
 * screen reader), and a lesson that does not hold its time is struck through
 * and dashed as the timetable draws a cancelled one (components/schedule/
 * timetable-grid.tsx), at full-strength text: what was cancelled is exactly
 * what has to be readable.
 */
export function toneOf(item: Drawn): string {
  if (item.cancelled) return "border border-dashed border-l-4 border-muted-foreground bg-background line-through";
  switch (item.type) {
    case "LESSON":
      return item.activity ? "border-l-4 border-warning bg-warning/20" : "border-l-4 border-primary bg-primary/10";
    case "BOOKING":
      return "border-l-4 border-foreground/50 bg-muted";
    case "PASS":
    case "DUTY":
      return "border-l-4 border-warning bg-warning/10";
    default:
      return "border-l-4 border-destructive bg-destructive/10";
  }
}

/**
 * One block of the day grid, positioned by the row. The visible text is for
 * the eye (and hidden from assistive technology), the sentence is for the
 * ear: "08:15–09:00 Matematik, Sal 12, A Svensson, inställd".
 */
export function DrawnBlock({ item, style }: { item: Drawn; style: React.CSSProperties }) {
  const { itemName, itemWords } = useSchoolDayText();
  const { title, facts } = itemWords(item);
  const name = itemName(item);
  return (
    <li className={cn("absolute overflow-hidden rounded px-1 py-0.5 text-[11px] leading-tight text-foreground", toneOf(item))} style={style}>
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" title={name} className="block">
        <span className="block truncate font-medium">{title}</span>
        {facts.length > 0 ? <span className="block truncate">{facts.join(" · ")}</span> : null}
      </span>
    </li>
  );
}
