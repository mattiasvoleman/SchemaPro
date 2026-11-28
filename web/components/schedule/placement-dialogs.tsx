"use client";

/*
 * The timetable's two small questions about a drag: "this lesson is shared,
 * move it for these classes too?" and "that did not fit, here is where it
 * would". Both open only after a drag, never on load, so they are fetched
 * apart from the grid, in the lesson dialogs' chunk (lesson-dialogs.ts) — see
 * lesson-edit-dialog for why the page lifts its dialogs out. What happens on
 * an answer stays with the page and is passed in.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeftRight, Sparkles } from "lucide-react";
import type { PlacementSuggestion } from "@/lib/placement-search";
import type { MasterLesson } from "@/lib/types";
import { useLazyModule } from "@/lib/use-lazy-module";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** A drag that lands on classes the administrator was not looking at. */
export function SharedMoveDialog({
  open,
  classNames,
  block,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The other classes the move reaches, by name, joined for the sentence. */
  classNames: string;
  /** A parallel block's card: its name, for a sentence about its lessons. */
  block?: string;
  /** Closing the dialog any way but the confirm button. */
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{block ? t("sharedCardTitle") : t("sharedMoveTitle")}</DialogTitle>
          <DialogDescription>
            {/* The classes BY NAME. "Flera klasser berörs" would be the same
                silence the "+1" badge kept: it tells you something is at
                stake without telling you what. */}
            {block
              ? t("sharedCardBody", { name: block, classes: classNames })
              : t("sharedMoveBody", { classes: classNames })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={onConfirm} data-writes="SCHEMALAGGNING DRIFT">
            {t("sharedMoveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Where the lesson was let go, and what it is: what Byt and Gör plats are asked of. */
export interface RefusedDrop {
  lesson: MasterLesson;
  drop: { dayOfWeek: number; startMinutes: number };
}

/**
 * Smart placement: the free times a refused drop could have gone to instead, and (E5a) the two things to do about the lesson that stands there:
 * swap with it (Byt) or move it, and what stands in the way of that, to make room (Gör plats). Both are asked of the gateway and drawn on the board
 * beside the dialog, which is not modal while they are shown.
 */
export function SuggestPlacementsDialog({
  open,
  options,
  onPick,
  onClose,
  refused,
  onApplied,
  guard,
}: {
  open: boolean;
  /** Empty when nothing fits, which the dialog says rather than hides. */
  options: PlacementSuggestion[];
  onPick: (option: PlacementSuggestion) => void;
  onClose: () => void;
  /** The drop that was refused. Left out, the dialog offers the free times alone, as it did. */
  refused?: RefusedDrop | null;
  /** Called after a swap or a making of room and after its undo: each rewrote lessons under the page. */
  onApplied?: () => void;
  /** The question before a change in Direkt that reaches families, asked around an apply (lib/use-direct-reach-ask.tsx). */
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
}) {
  const t = useTranslations("timetable");
  const tSwaps = useTranslations("swaps");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const [view, setView] = useState<"times" | "swap" | "room">("times");
  useEffect(() => {
    if (!open) setView("times");
  }, [open]);
  // A lesson on the tray or one Generera wrote from a förläggning has no place to leave: Byt and Gör plats are for a lesson that stands.
  // Nor for a drop on a weekend day (a school with a lesson there has the columns): the search is of the school days, Monday to Friday, and the gateway answers 400.
  const offers = open && refused != null && !refused.lesson.isParked && refused.lesson.fromPlacement !== true && refused.drop.dayOfWeek <= 5;
  const beside = offers && view !== "times";
  /*
   * Byt and Gör plats (E5a): the lists of proposals (swap-dialog.tsx), fetched when one of the two is first asked for. By useLazyModule and not by a
   * module-level lazy(): a lazy() keeps a rejected fetch for good (a tab left open over a deploy), so every later press would throw the same error
   * into the page's boundary, which closes the dialog, for as long as the tab lives. Here a chunk that does not arrive is said, the dialog goes back
   * to the free times, and the next press fetches again.
   */
  const lists = useLazyModule(
    () => import("./swap-dialog"),
    () => {
      setView("times");
      toast.error(tSwaps("failed"));
    },
    beside,
  );
  return (
    <Dialog open={open} modal={!beside} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className={beside ? "top-auto bottom-2 max-h-[55dvh] translate-y-0 sm:max-w-2xl" : "max-w-md"}
        onInteractOutside={beside ? (event) => event.preventDefault() : undefined}
        onFocusOutside={beside ? (event) => event.preventDefault() : undefined}
      >
        {beside && refused ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ArrowLeftRight className="size-4" />
                {view === "swap" ? tSwaps("dropOffers.swapTitle") : tSwaps("dropOffers.roomTitle")}
              </DialogTitle>
              <DialogDescription>{view === "swap" ? tSwaps("dropOffers.swapBody") : tSwaps("dropOffers.roomBody")}</DialogDescription>
            </DialogHeader>
            {lists ? (
              <lists.SwapProposals
                ask={{ kind: view === "swap" ? "swap" : "room", lessonId: refused.lesson.id, target: refused.drop }}
                teacherName={() => null}
                roomName={() => null}
                onApplied={onApplied ?? (() => undefined)}
                guard={guard}
                onDone={onClose}
              />
            ) : null}
            <DialogFooter>
              <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setView("times")}>
                {tSwaps("dropOffers.back")}
              </Button>
              <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={onClose}>
                {tCommon("cancel")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
        {beside ? null : (
        <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            {t("suggestTitle")}
          </DialogTitle>
          <DialogDescription>{t("suggestBody")}</DialogDescription>
        </DialogHeader>
        {offers ? (
          <div className="grid gap-2 rounded-md border bg-accent/30 p-3" data-drop-offers>
            <p className="text-sm font-medium">{tSwaps("dropOffers.title")}</p>
            <p className="text-xs text-muted-foreground">{tSwaps("dropOffers.body")}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setView("swap")}>
                {tSwaps("dropOffers.swap")}
              </Button>
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setView("room")}>
                {tSwaps("dropOffers.room")}
              </Button>
            </div>
          </div>
        ) : null}
        {options.length > 0 ? (
          <div className="space-y-2">
            {options.map((option) => (
              <button
                key={`${option.dayOfWeek}-${option.startMinutes}`}
                type="button"
                onClick={() => onPick(option)}
                data-writes="SCHEMALAGGNING DRIFT"
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
          <Button variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
        </DialogFooter>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}
