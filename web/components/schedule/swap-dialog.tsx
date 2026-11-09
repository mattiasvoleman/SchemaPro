"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  applyBody,
  clockOf,
  SWAP_LOCKED,
  SWAP_SPLITS_PARALLEL,
  SWAP_STALE,
  useSwaps,
  type ExternalTouch,
  type SoftCost,
  type SwapMove,
  type SwapProposal,
  type SwapSlot,
  type SwapSuggestion,
} from "@/lib/swaps";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";

/** How long the applied toast, and with it Ångra, stays up (as after the room optimisation). */
const UNDO_TOAST_MS = 15_000;

/** The soft rules in the order a school feels them: the pupils' day first. */
const SOFT_ORDER = ["PUPIL_GAPS", "TEACHER_GAPS", "DISTRIBUTION", "TEACHER_DAY"] as const;

export interface SwapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The picked lesson; null while nothing is. */
  lessonId: string | null;
  /** What it is called, for the description. */
  lessonName: string | null;
  /** The page's own lists: the proposal names ids only, and the names are the page's. */
  teacherName: (id: string) => string | null;
  roomName: (id: string) => string | null;
  /** Called after an apply and after its undo: each rewrote lessons under the page. */
  onApplied: () => void;
}

/**
 * Byten och flyttar: the swaps and chains of three a picked lesson can take
 * part in, each with the lessons that go along with it, the hard rules it was
 * judged by and what it costs in the soft ones.
 *
 * It decides nothing itself. The gateway judges every proposal by the write
 * path's own clash rule, as one move, and this only shows the verdict and the
 * costs and sends the moves it was given back to apply — whole, parallel
 * lessons included, so a proposal is never finished on the page's behalf.
 */
export function SwapDialog({
  open,
  onOpenChange,
  lessonId,
  lessonName,
  teacherName,
  roomName,
  onApplied,
}: SwapDialogProps) {
  const t = useTranslations("swaps");
  const tDays = useTranslations("days");
  const { suggest, apply } = useSwaps();
  const [suggestion, setSuggestion] = useState<SwapSuggestion | null>(null);
  const [failed, setFailed] = useState(false);
  /*
   * Which ask an answer belongs to. Closing the dialog, or picking another
   * lesson, abandons the ask in flight; a late answer must not land in the
   * next lesson's list (as in the room optimisation dialog).
   */
  const ask = useRef(0);

  const slotLabel = useCallback(
    (slot: SwapSlot) => `${tDays(String(slot.dayOfWeek))} ${clockOf(slot.startMinutes)}–${clockOf(slot.endMinutes)}`,
    [tDays],
  );

  const search = useCallback(async () => {
    if (!lessonId) return;
    const mine = ++ask.current;
    setFailed(false);
    setSuggestion(null);
    try {
      const answer = await suggest.mutateAsync({ lessonId });
      if (mine === ask.current) setSuggestion(answer);
    } catch {
      if (mine === ask.current) setFailed(true);
    }
    // `suggest` is a fresh object each render; its mutation function is the same one.
  }, [lessonId]);

  useEffect(() => {
    if (open && lessonId) void search();
    if (!open) {
      ask.current += 1;
      setSuggestion(null);
      setFailed(false);
    }
  }, [open, lessonId, search]);

  const lessonOf = (proposal: SwapProposal, id: string) => proposal.lessons.find((lesson) => lesson.id === id);
  const labelOf = (proposal: SwapProposal, id: string) => {
    const lesson = lessonOf(proposal, id);
    return lesson ? `${lesson.subjectName} ${lesson.groupName}` : "?";
  };

  const message = (error: unknown) => (error instanceof Error ? error.message : t("failed"));

  /**
   * The same moves sent back: the apply's answer names them. What it says is
   * what it did: the timetable's lessons stand on their old times and the
   * published ones that followed are moved back. The calendar lessons the swap
   * removed (`removedBySwap`), and any the undo had to remove in its turn, do
   * not come back with it, nor does what hung on them.
   */
  const undo = async (picked: string, moves: SwapMove[], removedBySwap: number) => {
    try {
      const result = await apply.mutateAsync(applyBody(picked, moves, "Före ångra"));
      onApplied();
      const gone = removedBySwap + result.removedCalendarLessons;
      const description = [
        result.propagatedLessons > 0 ? t("undoneCalendar", { count: result.propagatedLessons }) : null,
        gone > 0 ? t("undoneNotRestored", { count: gone }) : null,
      ]
        .filter((part) => part !== null)
        .join(" ");
      if (description) toast.success(t("undone"), { description, duration: UNDO_TOAST_MS });
      else toast.success(t("undone"));
    } catch (error) {
      toast.error(error instanceof ApiError && error.status === 409 ? t("undoStale") : message(error));
    }
  };

  const doApply = async (proposal: SwapProposal) => {
    if (!lessonId) return;
    try {
      const result = await apply.mutateAsync(applyBody(lessonId, proposal.moves));
      onApplied();
      onOpenChange(false);
      const description = [
        result.propagatedLessons > 0 ? t("calendarUpdated", { count: result.propagatedLessons }) : null,
        result.removedCalendarLessons > 0 ? t("calendarRemoved", { count: result.removedCalendarLessons }) : null,
      ]
        .filter((part) => part !== null)
        .join(" ");
      toast.success(t("applied", { count: proposal.moves.length }), {
        ...(description ? { description } : {}),
        duration: UNDO_TOAST_MS,
        action: {
          label: t("undo"),
          onClick: () => void undo(lessonId, result.undo, result.removedCalendarLessons),
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Stale, parted or locked: the proposals no longer describe the
        // timetable, and the clash rule's own sentence is the reason otherwise.
        toast.error(
          error.code === SWAP_STALE
            ? t("stale")
            : error.code === SWAP_SPLITS_PARALLEL
              ? t("splitsParallel")
              : error.code === SWAP_LOCKED
                ? t("lockedPartner")
                : error.message,
        );
        void search();
        return;
      }
      toast.error(message(error));
    }
  };

  const costText = (cost: SoftCost) => {
    const text = (value: number) =>
      cost.unit === "MINUTES" ? t("minutes", { count: Math.round(value) }) : t("breaches", { count: value });
    return (
      <span
        className={cn(
          "tabular-nums",
          cost.delta < 0 && "font-semibold text-foreground",
          cost.delta > 0 && "font-semibold text-destructive",
        )}
      >
        {text(cost.before)} → {text(cost.after)}
      </span>
    );
  };

  const externalText = (touch: ExternalTouch) =>
    t(`external.${touch.kind}`, {
      teacher: teacherName(touch.resourceId) ?? t("unnamedTeacher"),
      room: roomName(touch.resourceId) ?? "?",
      schools: touch.schools.join(", "),
      when: slotLabel(touch),
    });

  const pending = suggest.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {lessonName !== null ? (
              <span className="block font-medium text-foreground">{lessonName}</span>
            ) : null}
            {t("body")}
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t("computing")}
          </p>
        ) : null}

        {failed ? (
          <Notice tone="warning">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>{t("failed")}</p>
              <Button size="sm" variant="outline" onClick={() => void search()}>
                {t("retry")}
              </Button>
            </div>
          </Notice>
        ) : null}

        {suggestion?.immovable ? (
          <Notice tone="warning">
            <p>{suggestion.immovable === "PARKED" ? t("parked") : suggestion.immovable === "PLACED" ? t("placed") : t("notPlaced")}</p>
          </Notice>
        ) : null}

        {suggestion && !suggestion.immovable ? (
          <>
            {suggestion.selectedLocked ? <p className="text-sm text-muted-foreground">{t("lockedPicked")}</p> : null}
            {suggestion.unit.links.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("withParallel", { count: suggestion.unit.lessonIds.length - 1 })}
              </p>
            ) : null}

            {suggestion.proposals.length === 0 ? (
              <p className="text-sm font-medium">{t("none")}</p>
            ) : (
              <>
                <p className="text-sm font-medium">{t("found", { count: suggestion.proposals.length })}</p>
                <ul className="space-y-3" aria-label={t("title")}>
                  {suggestion.proposals.map((proposal) => (
                    <li key={proposal.id} className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 id={`swap-${proposal.id}`} className="text-sm font-semibold">
                          {proposal.kind === "SWAP" ? t("swap") : t("chain")}
                          {/* What the heading is about, for the reader of a list of twelve of them. */}
                          <span className="sr-only">
                            {": "}
                            {proposal.moves.map((move) => labelOf(proposal, move.lessonId)).join(", ")}
                          </span>
                        </h3>
                        <Button
                          size="sm"
                          onClick={() => void doApply(proposal)}
                          aria-describedby={
                            proposal.removedCalendarLessons > 0
                              ? `swap-${proposal.id} swap-${proposal.id}-removes`
                              : `swap-${proposal.id}`
                          }
                          disabled={apply.isPending}
                          data-writes="SCHEMALAGGNING DRIFT"
                        >
                          {apply.isPending ? <Loader2 className="animate-spin" /> : null}
                          {t("apply")}
                        </Button>
                      </div>

                      <ul className="space-y-1 text-sm">
                        {proposal.moves.map((move) => {
                          const lesson = lessonOf(proposal, move.lessonId);
                          return (
                            <li key={move.lessonId} className="flex flex-wrap gap-x-2">
                              <span className="font-medium">{labelOf(proposal, move.lessonId)}</span>
                              <span className="text-muted-foreground">
                                {t("moveLine", { from: slotLabel(move.from), to: slotLabel(move.to) })}
                              </span>
                              {move.lessonId === lessonId ? (
                                <span className="text-xs text-muted-foreground">({t("picked")})</span>
                              ) : null}
                              {lesson?.isLocked ? (
                                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                  <Lock className="size-3" aria-hidden />
                                  {t("locked")}
                                </span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>

                      {proposal.removedCalendarLessons > 0 ? (
                        <Notice tone="warning" role={null} id={`swap-${proposal.id}-removes`}>
                          <p>{t("removesCalendar", { count: proposal.removedCalendarLessons })}</p>
                        </Notice>
                      ) : null}

                      {proposal.parallels.length > 0 ? (
                        <p className="text-sm">
                          <span className="font-medium">{t("follows")}: </span>
                          {proposal.parallels
                            .map((link) =>
                              t("followsBecause", {
                                lesson: labelOf(proposal, link.lessonId),
                                reason: t(`parallel.${link.kind}`),
                              }),
                            )
                            .join("; ")}
                        </p>
                      ) : null}

                      {proposal.external.length > 0 ? (
                        <div className="text-sm">
                          <p className="font-medium">{t("otherSchools")}</p>
                          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                            {proposal.external.map((touch, index) => (
                              <li key={`${touch.lessonId}-${touch.resourceId}-${index}`}>{externalText(touch)}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium text-foreground">{t("hardTitle")}: </span>
                        {proposal.hard.map((code) => t(`hard.${code}`)).join("; ")}
                      </p>

                      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" aria-label={t("softTitle")}>
                        {SOFT_ORDER.map((code) => {
                          const cost = proposal.soft.find((entry) => entry.code === code);
                          if (!cost) return null;
                          return (
                            <div key={code} className="contents">
                              <dt className="text-muted-foreground">{t(`soft.${code}`)}</dt>
                              <dd className="text-right">{costText(cost)}</dd>
                            </div>
                          );
                        })}
                        <dt className="text-muted-foreground">{t("soft.MOVED_LESSONS")}</dt>
                        <dd className="text-right tabular-nums">{t("lessons", { count: proposal.moves.length })}</dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {suggestion.proposals.length > 0 ? <p className="text-xs text-muted-foreground">{t("notChecked")}</p> : null}
            {suggestion.stats.truncated ? <p className="text-xs text-muted-foreground">{t("truncated")}</p> : null}
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("closeAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
