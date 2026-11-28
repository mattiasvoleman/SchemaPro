"use client";

import { useTranslations } from "next-intl";
import { clockOf, type FillPlaced } from "@/lib/board-fill";
import type { FillShown } from "@/lib/fill-store";
import { layoutDay } from "@/lib/day-lanes";

/*
 * THE PROPOSAL OF LÄGG DET SOM GÅR, DRAWN ON ONE DAY OF THE BOARD (E7a, "förslaget ritas på brädet").
 *
 * For each brick the proposal lays on this day: a dashed outline where it would stand, with what it is and when ("Matematik 7A 08:00"), and "Utan sal" for a
 * brick laid with no room. The outlines are drawn over the cards and are inert (a pointer or a key goes through them): the dialog the proposal came from
 * says the same in words, and this is a picture of it, so a screen reader has the dialog and nothing here (aria-hidden), and the words are in the outline
 * and not only in its colour. A proposal writes nothing until it is taken in: an outline is not a lesson, and the board says so by drawing it dashed.
 */

/**
 * A board that is one class's, one teacher's or one room's (the views by class, teacher and room) draws only the bricks that are that one's: `id` null is the
 * board of "no teacher" or "no room". The combined board draws them all.
 */
export interface FillOnly {
  by: "group" | "teacher" | "room";
  id: string | null;
}

export interface FillLayerProps {
  day: number;
  scale: { startMinutes: number; pxPerMinute: number };
  shown: FillShown;
  only?: FillOnly;
}

export default function FillLayer({ day, scale, shown, only }: FillLayerProps) {
  const t = useTranslations("fillLayer");
  const px = (minutes: number) => (minutes - scale.startMinutes) * scale.pxPerMinute;
  const mine = (entry: FillPlaced) =>
    !only || (only.by === "group" ? entry.studentGroupId : only.by === "teacher" ? entry.teacherId : entry.roomId) === only.id;
  const here = shown.proposal.placed.filter((entry) => entry.dayOfWeek === day && mine(entry));
  if (here.length === 0) return null;
  return (
    <div aria-hidden data-fill-layer={day} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {layoutDay(here).map((entry) => (
        <div
          key={entry.key}
          data-fill-box=""
          className="absolute rounded-sm border-2 border-dashed border-primary bg-primary/10"
          style={{
            top: `${px(entry.startMinutes)}px`,
            height: `${Math.max(14, (entry.endMinutes - entry.startMinutes) * scale.pxPerMinute)}px`,
            // Bricks of other classes in the same hours stand side by side, as the lessons they lie over do (lib/day-lanes.ts): laid over one another only the last was readable.
            left: `calc(${(entry.lane * 100) / entry.laneCount}% + 2px)`,
            width: `calc(${100 / entry.laneCount}% - 4px)`,
          }}
        >
          <span className="block max-w-full truncate bg-background/90 px-1 text-[10px] font-semibold leading-3 text-foreground">
            {entry.noRoom
              ? t("withoutRoom", { lesson: shown.labels.get(entry.key) ?? "", from: clockOf(entry.startMinutes) })
              : t("proposed", { lesson: shown.labels.get(entry.key) ?? "", from: clockOf(entry.startMinutes) })}
          </span>
        </div>
      ))}
    </div>
  );
}
