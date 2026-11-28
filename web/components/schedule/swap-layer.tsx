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

  const boxes: Array<{ key: string; slot: SwapSlot; arrives: boolean; text: string; picked: boolean }> = [];
  for (const move of proposal.moves) {
    const level = proposal.levels?.[move.lessonId];
    const picked = level === 0 || (level === undefined && proposal.kind !== "MAKE_ROOM");
    if (move.to.dayOfWeek === day) boxes.push({ key: `to-${move.lessonId}`, slot: move.to, arrives: true, picked, text: t("arrives", { lesson: nameOf(move.lessonId) }) });
    if (move.from.dayOfWeek === day) boxes.push({ key: `from-${move.lessonId}`, slot: move.from, arrives: false, picked, text: t("leaves", { lesson: nameOf(move.lessonId), to: where(move.to) }) });
  }
  if (proposal.lay && proposal.lay.slot.dayOfWeek === day) {
    boxes.push({ key: "lay", slot: proposal.lay.slot, arrives: true, picked: true, text: t("arrives", { lesson: `${proposal.lay.subjectName} ${proposal.lay.groupName}` }) });
  }
  if (boxes.length === 0) return null;
  return (
    <div aria-hidden data-swap-layer={day} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {boxes.map((box) => (
        <div
          key={box.key}
          data-swap-box={box.arrives ? "arrives" : "leaves"}
          data-swap-picked={box.picked ? "" : undefined}
          className={cn(
            "absolute inset-x-0.5 rounded-sm border-primary",
            box.arrives ? "border-2 border-dashed bg-primary/10" : "border border-dotted bg-background/30",
            box.picked && box.arrives && "border-[3px]",
          )}
          style={{ top: `${px(box.slot.startMinutes)}px`, height: `${Math.max(14, (box.slot.endMinutes - box.slot.startMinutes) * scale.pxPerMinute)}px` }}
        >
          <span className="block max-w-full truncate bg-background/90 px-1 text-[10px] font-semibold leading-3 text-foreground">{box.text}</span>
        </div>
      ))}
    </div>
  );
}
