"use client";

/*
 * The timetable's two small questions about a drag: "this lesson is shared,
 * move it for these classes too?" and "that did not fit, here is where it
 * would". Both open only after a drag, never on load, so they are fetched
 * apart from the grid, in the lesson dialogs' chunk (lesson-dialogs.ts) — see
 * lesson-edit-dialog for why the page lifts its dialogs out. What happens on
 * an answer stays with the page and is passed in.
 */

import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import type { PlacementSuggestion } from "@/lib/placement-search";
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
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The other classes the move reaches, by name, joined for the sentence. */
  classNames: string;
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
          <DialogTitle>{t("sharedMoveTitle")}</DialogTitle>
          <DialogDescription>
            {/* The classes BY NAME. "Flera klasser berörs" would be the same
                silence the "+1" badge kept: it tells you something is at
                stake without telling you what. */}
            {t("sharedMoveBody", { classes: classNames })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("sharedMoveConfirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Smart placement: the free times a refused drop could have gone to instead. */
export function SuggestPlacementsDialog({
  open,
  options,
  onPick,
  onClose,
}: {
  open: boolean;
  /** Empty when nothing fits, which the dialog says rather than hides. */
  options: PlacementSuggestion[];
  onPick: (option: PlacementSuggestion) => void;
  onClose: () => void;
}) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {t("suggestTitle")}
          </DialogTitle>
          <DialogDescription>{t("suggestBody")}</DialogDescription>
        </DialogHeader>
        {options.length > 0 ? (
          <div className="space-y-2">
            {options.map((option) => (
              <button
                key={`${option.dayOfWeek}-${option.startMinutes}`}
                type="button"
                onClick={() => onPick(option)}
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
      </DialogContent>
    </Dialog>
  );
}
