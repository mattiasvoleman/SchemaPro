"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Lock, LockOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { restorableInput } from "@/lib/lesson-restore";
import type {
  CreateMasterLessonInput,
  useCreateMasterLesson,
  useDeleteMasterLesson,
  useUpdateMasterLesson,
} from "@/lib/queries";
import type { MasterLesson } from "@/lib/types";
import type { ScheduleHistory } from "@/lib/use-schedule-history";

/*
 * The timetable's bar for a selection (shift+click): lock, unlock and delete
 * the selected lessons, or let them go.
 *
 * Needed only once a lesson is selected, so it rides in the lesson dialogs'
 * chunk (components/schedule/lesson-dialogs.ts) rather than in the page's
 * first load. The page draws it, empty, as soon as its lessons are read, so
 * the code is in hand when the first lesson is selected. The page keeps the
 * selection; the bar acts on it with the page's own mutations and undo history.
 */

export interface SelectionBarProps {
  /** Whether anything is selected; the bar draws nothing until then. */
  shown: boolean;
  /** The selected lessons, a card's by its lessons, each once; `whole`: a card's whole block. */
  selectedLessons: (whole?: boolean) => MasterLesson[];
  updateLesson: ReturnType<typeof useUpdateMasterLesson>;
  deleteLesson: ReturnType<typeof useDeleteMasterLesson>;
  createLesson: ReturnType<typeof useCreateMasterLesson>;
  history: ScheduleHistory;
  showError: (error: unknown) => void;
  /**
   * The question before a change in Direkt that reaches families (lib/use-direct-reach-ask.tsx), asked around each delete: the first one asks
   * when the school has not answered, and the answer holds for the rest. Left out, a delete is run as it is and the gateway's own guard
   * answers 409 DIRECT_REACH_UNANSWERED when it reached families unasked.
   */
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Lets the selection go. */
  onClear: () => void;
  /** Ta bort's icon, from the page's first load (see where the page draws this bar). */
  deleteIcon: ReactNode;
}

export function SelectionBar({
  shown,
  selectedLessons,
  updateLesson,
  deleteLesson,
  createLesson,
  history,
  showError,
  guard,
  onClear,
  deleteIcon,
}: SelectionBarProps) {
  const t = useTranslations("timetable");

  const bulkSetLock = async (isLocked: boolean) => {
    // A card's whole block: the generation refuses a block locked in part.
    const targets = selectedLessons(true).filter((lesson) => lesson.isLocked !== isLocked);
    if (targets.length === 0) return;
    try {
      // What each lesson held of the lock when it was selected (E9): a colleague's lock or unlock since is not written over.
      for (const lesson of targets) {
        await updateLesson.mutateAsync({ id: lesson.id, isLocked, propagate: false, expected: { isLocked: lesson.isLocked } });
      }
      // A step of many lessons is taken lesson by lesson, and a try that stops halfway (the network falls, a colleague has changed lesson 3) has done the
      // ones before it: the next try goes on from the first it has not done. From the first again, it would ask those for the lock they no longer hold, and
      // be refused at once for a change that was its own (409 LESSON_CHANGED), every time, with the older steps shut behind it (E9, granskaren g521).
      let takenBack = 0;
      let doneAgain = 0;
      history.push({
        label: "bulk-lock",
        meta: { what: "bulk-lock", locked: isLocked, count: targets.length },
        // A colleague's change of one of the lessons is a no that the next try meets again, as the judge's is for a single lesson: the step goes.
        refusedUndo: (error) => error instanceof ApiError && error.code === "LESSON_CHANGED",
        undo: async () => {
          for (; takenBack < targets.length; takenBack++) {
            const lesson = targets[takenBack]!;
            await updateLesson.mutateAsync({
              id: lesson.id,
              isLocked: !isLocked,
              propagate: false,
              expected: { isLocked },
              // Undantag med flit rests on the lock: taking the lock off ended it (the gateway), and putting the lock back puts it back with it.
              ...(!isLocked && lesson.exemptFrom && lesson.exemptFrom.length > 0 ? { exempt: lesson.exemptFrom } : {}),
            });
          }
          takenBack = 0;
        },
        redo: async () => {
          for (; doneAgain < targets.length; doneAgain++) {
            await updateLesson.mutateAsync({ id: targets[doneAgain]!.id, isLocked, propagate: false, expected: { isLocked: !isLocked } });
          }
          doneAgain = 0;
        },
      });
      toast.success(t("bulkDone", { count: targets.length }));
    } catch (error) {
      showError(error);
    }
  };

  const bulkDelete = async () => {
    const targets = selectedLessons();
    if (targets.length === 0) return;
    try {
      // The SAME fields undoableDelete in the page restores, and for the
      // reason its own comment gives: without them undo quietly turns an
      // odd-week lesson into a weekly one. This path carried nine of the
      // fourteen, so a bulk undo also dropped the extra classes and the
      // individually named pupils — silently, on the lessons most likely to
      // have them.
      const inputs: CreateMasterLessonInput[] = targets.map(restorableInput);
      const refs = targets.map((lesson) => ({ id: lesson.id }));
      // One request per lesson, each asked on its own: a request that the gateway rolls back for the question is run again once it is
      // answered, which a loop of them cannot be (the lessons it had deleted are gone). Undo and redo are never asked.
      for (const lesson of targets) {
        const remove = () => deleteLesson.mutateAsync(lesson.id);
        await (guard ? guard(remove) : remove());
      }
      // As bulkSetLock's: a try that stopped halfway has made (or removed) the ones before it, and the next goes on from there, so that no lesson is made twice.
      let recreated = 0;
      let removedAgain = 0;
      history.push({
        label: "bulk-delete",
        meta: { what: "bulk-delete", count: targets.length },
        // The judge's no to putting one of them back (a colleague has used its time) is the same the next time: the step goes, as a single lesson's does.
        refusedUndo: (error) => error instanceof ApiError && error.code === "MASTER_LESSON_REFUSED",
        undo: async () => {
          for (; recreated < inputs.length; recreated++) {
            const again = await createLesson.mutateAsync(inputs[recreated]);
            refs[recreated].id = again.id;
          }
          recreated = 0;
        },
        redo: async () => {
          for (; removedAgain < refs.length; removedAgain++) {
            await deleteLesson.mutateAsync(refs[removedAgain].id);
          }
          removedAgain = 0;
        },
      });
      onClear();
      toast.success(t("bulkDeleted", { count: targets.length }));
    } catch (error) {
      showError(error);
    }
  };

  if (!shown) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/40 px-3 py-2">
      <span className="text-sm font-medium">
        {t("bulkSelected", { count: selectedLessons().length })}
      </span>
      <Button size="sm" variant="outline" onClick={() => void bulkSetLock(true)} data-writes="SCHEMALAGGNING DRIFT">
        <Lock />
        {t("bulkLock")}
      </Button>
      <Button size="sm" variant="outline" onClick={() => void bulkSetLock(false)} data-writes="SCHEMALAGGNING DRIFT">
        <LockOpen />
        {t("bulkUnlock")}
      </Button>
      <Button size="sm" variant="destructive" onClick={() => void bulkDelete()} data-writes="SCHEMALAGGNING DRIFT">
        {deleteIcon}
        {t("bulkDelete")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        <X />
        {t("bulkClear")}
      </Button>
    </div>
  );
}
