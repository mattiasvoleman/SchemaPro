import { useCallback } from "react";
import { toast } from "sonner";
import type {
  CreateMasterLessonInput,
  useCreateMasterLesson,
  useDeleteMasterLesson,
  useUpdateMasterLesson,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
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
}) {
  const { tEngine, t, tCommon, updateLesson, history, createLesson, deleteLesson } = inputs;

  // -------------------------------------------------------------------
  // Undoable mutations
  // -------------------------------------------------------------------

  const showError = useCallback(
    (error: unknown) => {
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
        // A block's card names the member it is about; the sentence alone would not say which lesson it was.
        const sentence = apiErrorText(error, tCommon);
        const member = error.params?.["requirement"];
        toast.error(typeof member === "string" ? `${member}: ${sentence}` : sentence);
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
      const result = await updateLesson.mutateAsync({ id: lesson.id, ...patch });
      const after = { ...before, ...patch };
      history.push({
        label: "update",
        undo: async () => {
          await updateLesson.mutateAsync({ id: lesson.id, ...before });
        },
        redo: async () => {
          await updateLesson.mutateAsync({ id: lesson.id, ...after });
        },
      });
      return result;
    },
    [updateLesson, history],
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
      const result = await deleteLesson.mutateAsync(lesson.id);
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
    [deleteLesson, createLesson, history],
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
