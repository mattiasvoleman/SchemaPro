import { useCallback } from "react";
import { toast } from "sonner";
import type {
  CreateMasterLessonInput,
  useCreateMasterLesson,
  useDeleteMasterLesson,
  useUpdateMasterLesson,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { DirectReachDeclined } from "@/lib/direct-reach";
import { LESSON_IS_PLACED } from "@/lib/lesson-is-placed";
import { staffingRefusal, refusalText } from "@/lib/staffing-warnings";
import type { MasterLesson } from "@/lib/types";
import { restorableInput } from "@/lib/lesson-restore";
import { useHistoryKeyboard, type useScheduleHistory } from "@/lib/use-schedule-history";
import type { MessageLookup } from "@/lib/engine-message";
import type { useTranslations } from "next-intl";
import { type LessonSnapshot, snapshotOf } from "./timetable-helpers";
import { apiErrorText } from "@/lib/api-error-text";

type Translator = ReturnType<typeof useTranslations>;

/**
 * The errors an UNDO of a move threw (a lesson put back where it stood). The gateway's judge lets a lesson that stands against a rule stand
 * (låt stå) and moving it away is let through, but putting it back is a NEW place and is refused by the same rule (beslut 4): the reader is told
 * that the undo cannot be done and why, and that the lesson stays where it is (granskaren g461, M-3). Only a move is told so: what an undone
 * create or delete meets is another matter, and a redo is a move like the first.
 */
const undoOfAMove = new WeakSet<object>();

/** A write that is asked nothing first: one function for every render, so the callbacks below keep their identity. */
const runAsIs = <T>(run: () => Promise<T>): Promise<T> => run();

/**
 * Undoable writes of lessons, the history keyboard and the one way a failed write is told. Every
 * mutation of the page goes through here, so that "drag freely, undo if wrong" is one idiom.
 */
export function useUndoableEdits(inputs: {
  tEngine: MessageLookup;
  t: Translator;
  tCommon: Translator;
  updateLesson: ReturnType<typeof useUpdateMasterLesson>;
  history: ReturnType<typeof useScheduleHistory>;
  createLesson: ReturnType<typeof useCreateMasterLesson>;
  deleteLesson: ReturnType<typeof useDeleteMasterLesson>;
  /**
   * The question before a change in Direkt that reaches families (lib/use-direct-reach-ask.tsx): asked around a write that moves or
   * removes published lessons, once, and never around an undo or a redo (a change put back is the same change). Left out, a write is
   * run as it is and the gateway's own guard answers 409 when it reached families unasked.
   */
  ask?: <T>(run: () => Promise<T>) => Promise<T>;
}) {
  const { tEngine, t, tCommon, updateLesson, history, createLesson, deleteLesson } = inputs;
  const ask = inputs.ask ?? runAsIs;

  // -------------------------------------------------------------------
  // Undoable mutations
  // -------------------------------------------------------------------

  const showError = useCallback(
    (error: unknown) => {
      // The reader said no to the question before a change in Direkt: Avbryt is an answer, and not a failure to tell.
      if (error instanceof DirectReachDeclined) return;
      // The staffing policy's REFUSE is a 409 too, but no clash: its own
      // sentence, from the catalogue, without "Schemakonflikt" in front.
      const refusal = staffingRefusal(error);
      if (refusal) {
        toast.error(refusalText(tEngine, refusal));
      } else if (error instanceof ApiError && error.code === LESSON_IS_PLACED) {
        // No clash either: the lesson is its förläggning's, and is changed there.
        toast.error(t("lessonIsPlaced"));
      } else if (error instanceof ApiError && error.code === "MASTER_LESSON_REFUSED") {
        // The one judge's no (src/calendar/lesson-judge.ts): the reason and the other lesson's class, subject, day and
        // time, in the reader's language and from the catalogue, so "Schemakonflikt" in front would only say it twice.
        // A block's card names the member it is about (lib/problem-codes.ts says it, as it does for a swap's apply).
        const why = apiErrorText(error, tCommon);
        // The sentence is the heaviest reason's, the one the gateway sends the params of; the others are only named by their codes (`reasons`),
        // and the reader is told that there are more and where to see them, which is more than a toast that says one rule and stops.
        const reasons = typeof error.params?.["reasons"] === "string" ? new Set(error.params["reasons"].split(",").filter(Boolean)) : new Set<string>();
        const more = reasons.size > 1 ? ` ${t("moreReasons", { count: reasons.size - 1 })}` : "";
        toast.error(undoOfAMove.has(error) ? t("undoRefused", { why: `${why}${more}` }) : `${why}${more}`);
      } else if (error instanceof ApiError && error.status === 409) {
        toast.error(`${t("editConflict")}: ${apiErrorText(error, tCommon)}`);
      } else {
        toast.error(apiErrorText(error, tCommon));
      }
    },
    [t, tCommon, tEngine],
  );

  /** Applies a patch and registers the inverse operation in history. */
  const undoableUpdate = useCallback(
    async (lesson: MasterLesson, patch: Partial<LessonSnapshot>) => {
      const before = snapshotOf(lesson);
      const result = await ask(() => updateLesson.mutateAsync({ id: lesson.id, ...patch }));
      const after = { ...before, ...patch };
      history.push({
        label: "update",
        // The judge's final no (a lesson put back on a time that breaks a rule, beslut 4) is dropped from the history, so that the older
        // steps are not shut behind it; the toast says so (t("undoRefused")).
        refusedUndo: (error) => error instanceof ApiError && error.code === "MASTER_LESSON_REFUSED",
        undo: async () => {
          try {
            await updateLesson.mutateAsync({ id: lesson.id, ...before });
          } catch (error) {
            if (typeof error === "object" && error !== null) undoOfAMove.add(error);
            throw error;
          }
        },
        redo: async () => {
          await updateLesson.mutateAsync({ id: lesson.id, ...after });
        },
      });
      return result;
    },
    [updateLesson, history, ask],
  );

  const undoableCreate = useCallback(
    async (input: CreateMasterLessonInput) => {
      const created = await createLesson.mutateAsync(input);
      const ref = { id: created.id };
      history.push({
        label: "create",
        undo: async () => {
          await deleteLesson.mutateAsync(ref.id);
        },
        redo: async () => {
          const again = await createLesson.mutateAsync(input);
          ref.id = again.id;
        },
      });
      return created;
    },
    [createLesson, deleteLesson, history],
  );

  const undoableDelete = useCallback(
    async (lesson: MasterLesson) => {
      const input: CreateMasterLessonInput = restorableInput(lesson);
      const result = await ask(() => deleteLesson.mutateAsync(lesson.id));
      const ref = { id: lesson.id };
      history.push({
        label: "delete",
        undo: async () => {
          const again = await createLesson.mutateAsync(input);
          ref.id = again.id;
        },
        redo: async () => {
          await deleteLesson.mutateAsync(ref.id);
        },
      });
      return result;
    },
    [deleteLesson, createLesson, history, ask],
  );

  useHistoryKeyboard(
    history,
    (kind, entry) => {
      if (entry) toast.info(kind === "undo" ? t("undone") : t("redone"));
    },
    // The same report doUndo/doRedo give below: Ctrl+Z is not a quieter way
    // to hit a 409 than the toolbar button.
    (_kind, error) => showError(error),
  );

  const doUndo = async () => {
    try {
      const entry = await history.undo();
      if (entry) toast.info(t("undone"));
    } catch (error) {
      showError(error);
    }
  };
  const doRedo = async () => {
    try {
      const entry = await history.redo();
      if (entry) toast.info(t("redone"));
    } catch (error) {
      showError(error);
    }
  };

  return { showError, undoableUpdate, undoableCreate, undoableDelete, doUndo, doRedo };
}
