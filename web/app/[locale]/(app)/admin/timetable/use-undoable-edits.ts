import { useCallback, useContext, useRef } from "react";
import { QueryClientContext } from "@tanstack/react-query";
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
import { seenOf } from "@/lib/lesson-expected";
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

/**
 * A write the gateway refused because somebody else had changed the lesson since the page read it (409 LESSON_CHANGED, E9), with what was asked of
 * which lesson: the sentence that says what happened (lib/lesson-changed.ts) reads the lesson again and offers the change once more on what is there.
 */
const changedLessons = new WeakMap<object, { lesson: MasterLesson; patch: Partial<LessonSnapshot> }>();
const isLessonChanged = (error: unknown): error is ApiError => error instanceof ApiError && error.code === "LESSON_CHANGED";

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
  // Not `useQueryClient`, which throws without a provider: a page that is drawn without one (its tests) has no refusal to tell either.
  const queryClient = useContext(QueryClientContext);
  // The change of a lesson that was refused is offered again from the toast (showError, which is made before undoableUpdate is).
  const offerAgain = useRef<(lesson: MasterLesson, patch: Partial<LessonSnapshot>) => Promise<unknown>>(async () => undefined);

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
      } else if (isLessonChanged(error)) {
        // Somebody else changed the lesson since the page read it (E9): said as it is, in a module of its own that comes with the first such refusal.
        void import("@/lib/lesson-changed")
          .then((later) =>
            later.told({ queryClient, error, asked: changedLessons.get(error), undo: undoOfAMove.has(error), t, tCommon, again: (fresh, patch) => offerAgain.current(fresh, patch) }),
          )
          .catch(() => toast.error(apiErrorText(error, tCommon)));
      } else if (error instanceof ApiError && error.status === 409) {
        toast.error(`${t("editConflict")}: ${apiErrorText(error, tCommon)}`);
      } else {
        toast.error(apiErrorText(error, tCommon));
      }
    },
    [t, tCommon, tEngine, queryClient],
  );

  /** Applies a patch and registers the inverse operation in history. */
  const undoableUpdate = useCallback(
    async (lesson: MasterLesson, patch: Partial<LessonSnapshot>) => {
      const before = snapshotOf(lesson);
      // What the page saw of the fields it sets (E9): somebody else's change of one of them is refused, and not written over.
      const seen = seenOf(before, patch);
      let result;
      try {
        result = await ask(() => updateLesson.mutateAsync({ id: lesson.id, ...patch, expected: seen }));
      } catch (error) {
        if (isLessonChanged(error)) changedLessons.set(error, { lesson, patch });
        throw error;
      }
      const after = { ...before, ...patch };
      // What the lesson holds of EVERY field the undo writes (the whole snapshot, not only what the patch set), as the gateway answered (what it did not say is what the page
      // had): the undo is held to it, so that a colleague's later change of the lesson, of any field, is not put back, and the lock a move set is what it waits for.
      const written = seenOf({ ...before, ...patch, ...result, exempt: undefined }, after);
      // And the redo, which writes the same snapshot, to what the lesson holds once the undo has put it back: what the page saw before.
      const sawBefore = seenOf(before, after);
      history.push({
        label: "update",
        meta: { what: "update", lesson, patch },
        // The judge's final no (a lesson put back on a time that breaks a rule, beslut 4) and a lesson somebody else has changed since are
        // dropped from the history, so that the older steps are not shut behind them; the toast says so (t("undoRefused")).
        refusedUndo: (error) => error instanceof ApiError && (error.code === "MASTER_LESSON_REFUSED" || error.code === "LESSON_CHANGED"),
        undo: async () => {
          try {
            await updateLesson.mutateAsync({ id: lesson.id, ...before, expected: written });
          } catch (error) {
            if (typeof error === "object" && error !== null) undoOfAMove.add(error);
            throw error;
          }
        },
        redo: async () => {
          await updateLesson.mutateAsync({ id: lesson.id, ...after, expected: sawBefore });
        },
      });
      return result;
    },
    [updateLesson, history, ask],
  );
  offerAgain.current = undoableUpdate;

  const undoableCreate = useCallback(
    async (input: CreateMasterLessonInput) => {
      const created = await createLesson.mutateAsync(input);
      const ref = { id: created.id };
      history.push({
        label: "create",
        meta: { what: "create", lesson: input },
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
        meta: { what: "delete", lesson },
        // The judge's no to making the lesson again (a colleague has used its time) is the same the next time: the step goes, so that the older steps are not shut
        // behind it, and the toast says so as it does for a move (E9, granskaren g521).
        refusedUndo: (error) => error instanceof ApiError && error.code === "MASTER_LESSON_REFUSED",
        undo: async () => {
          try {
            const again = await createLesson.mutateAsync(input);
            ref.id = again.id;
          } catch (error) {
            if (typeof error === "object" && error !== null) undoOfAMove.add(error);
            throw error;
          }
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
