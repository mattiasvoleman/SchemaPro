import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import type { useScheduleHistory } from "@/lib/use-schedule-history";
import type { useTranslations } from "next-intl";
import { minutesToHHMM } from "./timetable-helpers";
import type { TimetableReads } from "./use-timetable-reads";
import { apiErrorText } from "@/lib/api-error-text";

type Translator = ReturnType<typeof useTranslations>;

/** Placing, moving and removing a class's meal by hand, each undoable. */
export function useLunchEdits(inputs: Pick<TimetableReads, "lunchSittings" | "shownYear" | "lunchMutations"> & {
  tCommon: Translator;
  onlyGroup: string | null;
  history: ReturnType<typeof useScheduleHistory>;
  t: Translator;
}) {
  const { lunchSittings, shownYear, lunchMutations, tCommon, onlyGroup, history, t } = inputs;

  const lunchError = (error: unknown) =>
    toast.error(error instanceof ApiError ? apiErrorText(error, tCommon) : tCommon("error"));

  const sittingOn = (dayOfWeek: number) =>
    (lunchSittings ?? []).find(
      (sitting) => sitting.studentGroupId === onlyGroup && sitting.dayOfWeek === dayOfWeek,
    );

  /**
   * The class's meal on that day, placed where the school clicked.
   *
   * Undone to what the day MEANT before, not merely to where the band was. A
   * day with a meal the school had placed goes back to that start. A day the
   * solver had fed goes back to the solver: the hand row is removed and the
   * next run places the meal again. A day with no meal goes back to none.
   */
  const placeLunch = async (dayOfWeek: number, startMinutes: number) => {
    if (!onlyGroup || !shownYear) return;
    const before = sittingOn(dayOfWeek);
    const body = {
      academicYearId: shownYear.id,
      studentGroupId: onlyGroup,
      dayOfWeek,
      startTime: minutesToHHMM(startMinutes),
    };
    try {
      const placed = (await lunchMutations.create.mutateAsync(body)) as { id: string };
      const ref = { id: placed.id };
      history.push({
        label: "lunch",
        meta: { what: "lunch", kind: "place", dayOfWeek: body.dayOfWeek, startTime: body.startTime },
        undo: async () => {
          if (before && !before.isGenerated) {
            await lunchMutations.update.mutateAsync({
              id: ref.id,
              startTime: before.startTime.slice(0, 5),
            });
          } else {
            await lunchMutations.remove.mutateAsync(ref.id);
          }
        },
        redo: async () => {
          const again = (await lunchMutations.create.mutateAsync(body)) as { id: string };
          ref.id = again.id;
        },
      });
    } catch (error) {
      lunchError(error);
    }
  };

  /**
   * A meal dragged to another day or time.
   *
   * Onto a day that already has a meal for this class it is refused HERE, not
   * left to the server — which would replace the other meal, and a drag that
   * silently deleted Wednesday's lunch is the worst thing this gesture could do.
   */
  const moveLunch = async (id: string, dayOfWeek: number, startMinutes: number) => {
    const sitting = (lunchSittings ?? []).find((row) => row.id === id);
    if (!sitting) return;
    if (dayOfWeek !== sitting.dayOfWeek && sittingOn(dayOfWeek)) {
      toast.error(t("lunchDayTaken"));
      return;
    }
    const before = { dayOfWeek: sitting.dayOfWeek, startTime: sitting.startTime.slice(0, 5) };
    const after = { dayOfWeek, startTime: minutesToHHMM(startMinutes) };
    try {
      await lunchMutations.update.mutateAsync({ id, ...after });
      history.push({
        label: "lunch",
        meta: { what: "lunch", kind: "move", dayOfWeek: after.dayOfWeek, startTime: after.startTime },
        undo: async () => {
          await lunchMutations.update.mutateAsync({ id, ...before });
        },
        redo: async () => {
          await lunchMutations.update.mutateAsync({ id, ...after });
        },
      });
    } catch (error) {
      lunchError(error);
    }
  };

  const removeLunch = async (id: string) => {
    const sitting = (lunchSittings ?? []).find((row) => row.id === id);
    if (!sitting || !shownYear) return;
    const body = {
      academicYearId: shownYear.id,
      studentGroupId: sitting.studentGroupId,
      dayOfWeek: sitting.dayOfWeek,
      startTime: sitting.startTime.slice(0, 5),
    };
    const ref = { id };
    try {
      await lunchMutations.remove.mutateAsync(id);
      history.push({
        label: "lunch",
        meta: { what: "lunch", kind: "remove", dayOfWeek: body.dayOfWeek, startTime: body.startTime },
        undo: async () => {
          const again = (await lunchMutations.create.mutateAsync(body)) as { id: string };
          ref.id = again.id;
        },
        redo: async () => {
          await lunchMutations.remove.mutateAsync(ref.id);
        },
      });
    } catch (error) {
      lunchError(error);
    }
  };

  return { placeLunch, moveLunch, removeLunch };
}
