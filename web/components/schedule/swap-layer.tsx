"use client";

import { useTranslations } from "next-intl";
import { clockOf, type SwapProposal, type SwapSlot } from "@/lib/swaps";
import { cn } from "@/lib/utils";

/*
 * ONE PROPOSAL, DRAWN ON ONE DAY OF THE BOARD (E5a, "förslagen ritas på brädet").
 *
 * For each lesson the proposal moves: an outline where it goes ("hit"), with the lesson's name, and a dotted outline where it leaves ("härifrån")
 * with where it goes. A lesson that is laid and was no lesson before (a brick, a lesson on the tray) has only the first. The picked lesson is the
 * heavier outline, because it is the one the schemaläggare asked about. The outlines are drawn over the cards and are inert (a pointer or a key
 * goes through them): the list the proposal came from says the same in words, and this is a picture of it, so a screen reader has the list and
 * nothing here (aria-hidden), and the words are in the outline and not only in its colour.
 */

export interface SwapLayerProps {
  day: number;
  scale: { startMinutes: number; pxPerMinute: number };
  proposal: SwapProposal;
}

export default function SwapLayer({ day, scale, proposal }: SwapLayerProps) {
  const t = useTranslations("swapLayer");
  const tDays = useTranslations("days");
  const px = (minutes: number) => (minutes - scale.startMinutes) * scale.pxPerMinute;
  const nameOf = (id: string) => {
    const lesson = proposal.lessons.find((entry) => entry.id === id);
    return lesson ? `${lesson.subjectName} ${lesson.groupName}` : "";
  };
  const where = (slot: SwapSlot) => `${tDays(String(slot.dayOfWeek))} ${clockOf(slot.startMinutes)}`;

  /*
   * One outline for what arrives at one place, and one for what leaves it, with the names of every lesson of them. A place where one lesson
   * arrives and another leaves (a swap is nothing else) has an outline of each kind with the same top, and lessons that move as one (a parallel
   * block) have the same place twice: laid one over the next, the label of the last hid the others, and in a swap the picked lesson's words were
   * the ones under.
   */
  const boxes = new Map<string, { key: string; slot: SwapSlot; arrives: boolean; texts: string[]; picked: boolean }>();
  const add = (slot: SwapSlot, arrives: boolean, picked: boolean, text: string) => {
    const key = `${arrives ? "to" : "from"}-${slot.startMinutes}-${slot.endMinutes}`;
    const box = boxes.get(key) ?? { key, slot, arrives, texts: [], picked: false };
    box.texts.push(text);
    box.picked ||= picked;
    boxes.set(key, box);
  };
  for (const move of proposal.moves) {
    const level = proposal.levels?.[move.lessonId];
    const picked = level === 0 || (level === undefined && proposal.kind !== "MAKE_ROOM");
    if (move.to.dayOfWeek === day) add(move.to, true, picked, t("arrives", { lesson: nameOf(move.lessonId) }));
    if (move.from.dayOfWeek === day) add(move.from, false, picked, t("leaves", { lesson: nameOf(move.lessonId), to: where(move.to) }));
  }
  if (proposal.lay && proposal.lay.slot.dayOfWeek === day) {
    add(proposal.lay.slot, true, true, t("arrives", { lesson: `${proposal.lay.subjectName} ${proposal.lay.groupName}` }));
  }
  if (boxes.size === 0) return null;
  return (
    <div aria-hidden data-swap-layer={day} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {[...boxes.values()].map((box) => (
        <div
          key={box.key}
          data-swap-box={box.arrives ? "arrives" : "leaves"}
          data-swap-picked={box.picked ? "" : undefined}
          className={cn(
            "absolute inset-x-0.5 flex flex-col rounded-sm border-primary",
            box.arrives ? "border-2 border-dashed bg-primary/10" : "border border-dotted bg-background/30",
            box.picked && box.arrives && "border-[3px]",
          )}
          style={{ top: `${px(box.slot.startMinutes)}px`, height: `${Math.max(14, (box.slot.endMinutes - box.slot.startMinutes) * scale.pxPerMinute)}px` }}
        >
          {/* What arrives is named at the top and what leaves at the bottom, so that the two of one place can both be read. */}
          <span
            data-swap-label={box.arrives ? "top" : "bottom"}
            className={cn("block max-w-full truncate bg-background/90 px-1 text-[10px] font-semibold leading-3 text-foreground", !box.arrives && "mt-auto")}
          >
            {box.texts.join(" · ")}
          </span>
        </div>
      ))}
    </div>
  );
}
