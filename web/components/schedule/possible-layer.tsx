"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { possibleStore } from "@/lib/possible-store";
import { askPossibleTimes, type PossibleRun } from "@/lib/possible-times";

/*
 * THE BOARD PAINTS WHERE THE LESSON IN HAND CAN STAND (E3, "Se").
 *
 * Two pieces, fetched together when a lesson is first taken up (or dragged), and not before: the route has no bytes for them in its
 * first load.
 *
 *   PossibleHold   mounted once while a lesson is in hand: asks the gateway where it can stand (lib/possible-times.ts) and puts the
 *                  answer in the store, which it empties when the lesson is let go.
 *   PossibleDay    one day's column: the runs painted behind the lessons, inert, from the store.
 *
 * What is painted is the gateway's answer and nothing of the page's own: the green runs are times its judge lets through, the hatched
 * ones are stretches a rule shuts (named, once per stretch), and a lesson in the way is outlined and named. Every run says what it is
 * in words as well: a colour alone is nothing to a reader who cannot tell the two apart (and nothing in a print). The layer is a
 * picture of what the status line and the keys already say, so it is hidden from a screen reader, who has the line.
 */

/** How long a lesson is held before the gateway is asked: a click presses and lets go at once, and asks nothing. */
export const HOLD_BEFORE_ASKING_MS = 150;

export function PossibleHold({ lessonId }: { lessonId: string }) {
  useEffect(() => {
    const asking = new AbortController();
    const timer = setTimeout(() => {
      possibleStore.set({ lessonId, status: "loading" });
      askPossibleTimes(lessonId, asking.signal).then(
        (times) => {
          if (asking.signal.aborted) return;
          // An answer that is not the gateway's shape (a proxy's page, an older gateway's body) is no answer: nothing is painted from it.
          if (!times || !Array.isArray(times.days) || !Array.isArray(times.options)) possibleStore.set({ lessonId, status: "failed" });
          else possibleStore.set({ lessonId, status: "done", times });
        },
        () => {
          if (!asking.signal.aborted) possibleStore.set({ lessonId, status: "failed" });
        },
      );
    }, HOLD_BEFORE_ASKING_MS);
    return () => {
      clearTimeout(timer);
      asking.abort();
      if (possibleStore.get()?.lessonId === lessonId) possibleStore.set(null);
    };
  }, [lessonId]);
  return null;
}

const BAND: Record<PossibleRun["kind"], string> = {
  FREE: "border border-emerald-700/60 bg-emerald-500/15 dark:border-emerald-400/60 dark:bg-emerald-400/15",
  CHANGE: "border border-dashed border-amber-700/70 bg-amber-500/15 dark:border-amber-400/70 dark:bg-amber-400/15",
  CLOSED:
    "border border-border bg-[repeating-linear-gradient(135deg,transparent_0,transparent_5px,hsl(var(--foreground)/0.09)_5px,hsl(var(--foreground)/0.09)_10px)]",
  IN_THE_WAY: "border-2 border-foreground/40",
  // Several lessons hold it, or a locked one: nothing is painted, and the line says how many.
  CROWDED: "",
  STANDS: "",
};

export function PossibleDay({ day, scale }: { day: number; scale: { startMinutes: number; pxPerMinute: number } }) {
  const t = useTranslations("boardPossible");
  const state = useSyncExternalStore(possibleStore.subscribe, possibleStore.get, () => null);
  if (!state || state.status !== "done") return null;
  const { times } = state;
  const runs = times.days.find((entry) => entry.dayOfWeek === day)?.runs ?? [];
  const px = (minutes: number) => (minutes - scale.startMinutes) * scale.pxPerMinute;

  const wordsOf = (run: PossibleRun): string => {
    switch (run.kind) {
      case "FREE":
        return t("free");
      case "CHANGE":
        return t("change");
      case "CLOSED":
        return t(`closed.${run.code ?? "AVAILABILITY"}`);
      case "IN_THE_WAY": {
        const blocker = run.blockerId ? times.blockers[run.blockerId] : undefined;
        return blocker ? t("inTheWay", { subject: blocker.subjectName, className: blocker.className }) : t("inTheWayUnnamed");
      }
      default:
        return "";
    }
  };

  return (
    <div aria-hidden data-possible-day={day} className="pointer-events-none absolute inset-0">
      {runs
        .filter((run) => BAND[run.kind] !== "")
        .map((run) => (
          <div
            key={`${run.fromMinutes}-${run.kind}-${run.blockerId ?? run.code ?? ""}`}
            data-possible-run={run.kind}
            className={cn("absolute inset-x-0.5 overflow-hidden rounded-sm", BAND[run.kind])}
            style={{ top: `${px(run.fromMinutes)}px`, height: `${Math.max(6, (run.toMinutes - run.fromMinutes + times.stepMinutes) * scale.pxPerMinute)}px` }}
          >
            <span className="block truncate px-1 text-[10px] font-medium leading-3 text-foreground/80">{wordsOf(run)}</span>
          </div>
        ))}
      {times.options
        .filter((option) => option.dayOfWeek === day)
        .map((option) => (
          <span
            key={`rank-${option.rank}`}
            data-possible-rank={option.rank}
            className="absolute right-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-emerald-800 bg-emerald-50 px-1 text-[10px] font-bold tabular-nums leading-none text-emerald-950 dark:border-emerald-300 dark:bg-emerald-950 dark:text-emerald-50"
            style={{ top: `${px(option.startMinutes)}px` }}
          >
            {option.rank}
          </span>
        ))}
    </div>
  );
}
