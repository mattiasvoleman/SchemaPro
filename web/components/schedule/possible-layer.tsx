"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { boardCommands, possibleStore } from "@/lib/possible-store";
import { askPossibleTimes, clockOf, costWords, roomAt, type PossibleRun } from "@/lib/possible-times";

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

/** The grid's ghost: the square the lesson in hand is over (or the marker is on), and whether the page lets it stand there. */
interface GhostCell {
  get: () => { dayOfWeek: number; startMinutes: number; endMinutes: number; valid: boolean; roomId?: string | null } | null;
  set: (next: { dayOfWeek: number; startMinutes: number; endMinutes: number; valid: boolean; roomId?: string | null }) => void;
  subscribe: (listener: () => void) => () => void;
}

export function PossibleHold({ lessonId, ghost }: { lessonId: string; ghost?: GhostCell }) {
  /*
   * A square the board paints "Ledigt, annan sal" is one the lesson can be laid on, in the room the gateway judged: the page's own check
   * (the grid's validateChange) knows only the lesson's own room, which is taken, and would paint the ghost red and send the drop to the
   * suggestions. So where the ghost is over such a square it is made valid and carries the room, which the drop hands on with the move,
   * the way Enter does (board-keys.tsx). Done here, in the layer, and not in the grid: the grid is the route's own bytes, and this is
   * fetched when a lesson is first taken up. Followed on the ghost AND on the answer: the answer comes a fraction of a second after the lesson
   * is taken, and a pointer at rest on a square when it comes has not moved to give the ghost a new verdict (granskaren g503, #507 M-1).
   */
  useEffect(() => {
    if (!ghost) return;
    const lay = () => {
      const held = ghost.get();
      const state = possibleStore.get();
      if (!held || state?.lessonId !== lessonId || state.status !== "done") return;
      // A move of the lesson's own length: the gateway judged each start for that, and a lesson made longer or shorter is not one it judged.
      if (held.endMinutes - held.startMinutes !== state.times.subject.minutes) return;
      const room = roomAt(state.times, lessonId, held.dayOfWeek, held.startMinutes);
      // Also over a square the page says yes to: its check holds no room lent to another school, so where the lesson's own room is lent the
      // page calls the square free and the drop would go to that room, which the judge refuses (OTHER_SCHOOL), on a square the board paints
      // "Ledigt, annan sal". The room the gateway names goes with the move wherever it names one. Done once per square and room: the ghost
      // set here is what this follows, and an equal one is not set again.
      if (room === undefined || (held.valid && held.roomId === room)) return;
      ghost.set({ ...held, valid: true, roomId: room });
    };
    lay();
    const stops = [ghost.subscribe(lay), possibleStore.subscribe(lay)];
    return () => stops.forEach((stop) => stop());
  }, [ghost, lessonId]);
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
      if (possibleStore.get()?.lessonId === lessonId) possibleStore.release();
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
    // `overflow-hidden`: the gateway answers for 07:00 to 18:00 and the board's day is usually 08:00 to 16:00, so a run above or below it would
    // paint over the day's heading and make the grid's own box scroll (a vertical scrollbar that appears with the layer and goes with it).
    <div aria-hidden data-possible-day={day} className="pointer-events-none absolute inset-0 overflow-hidden">
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


/**
 * The best times as a list, for the lesson in hand: what the painting says, for a reader who cannot see it and for anybody who has no
 * use for a marker. Each is a button that lays the lesson there (the keyboard layer's own path: the same write, the same line), and a
 * clock can be typed to move the marker to it. Drawn below the week, and only while a lesson is in hand.
 */
export function PossibleList() {
  const t = useTranslations("boardPossible");
  const tDays = useTranslations("days");
  const state = useSyncExternalStore(possibleStore.subscribe, possibleStore.get, () => null);
  const [typed, setTyped] = useState("");
  if (!state) return null;
  const times = state.status === "done" ? state.times : null;
  const lesson = times ? `${times.subject.subjectName} ${times.subject.className}`.trim() : "";
  const typedMinutes = /^([01]\d|2[0-3]):([0-5]\d)$/.test(typed) ? Number(typed.slice(0, 2)) * 60 + Number(typed.slice(3, 5)) : null;

  return (
    <section aria-label={t("list.title", { lesson })} aria-busy={state.status === "loading"} data-possible-list className="mt-2 rounded-md border bg-card p-3 text-sm">
      <h3 className="mb-2 font-semibold">{t("list.title", { lesson })}</h3>
      {state.status === "loading" ? <p className="text-muted-foreground">{t("list.loading")}</p> : null}
      {state.status === "failed" ? <p className="text-muted-foreground">{t("list.failed")}</p> : null}
      {times && times.options.length === 0 ? <p className="text-muted-foreground">{t("list.none", { lesson })}</p> : null}
      {times && times.options.length > 0 ? (
        <ol className="grid gap-1">
          {times.options.map((option) => {
            const where = { day: tDays(String(option.dayOfWeek)), from: clockOf(option.startMinutes), to: clockOf(option.endMinutes) };
            const words = costWords(option);
            return (
              <li key={option.rank} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium tabular-nums">{t("list.option", { rank: option.rank, ...where })}</span>
                <span className="text-muted-foreground">{words.length > 0 ? words.map((word) => t(`list.words.${word}`)).join(", ") : t("list.plain")}</span>
                <button
                  type="button"
                  onClick={() => boardCommands.current?.lay(option.rank)}
                  aria-label={t("list.layLabel", { lesson, ...where })}
                  className="ml-auto min-h-8 rounded-md border px-3 text-xs font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {t("list.lay")}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (typedMinutes !== null) boardCommands.current?.goTo(typedMinutes);
        }}
      >
        <label className="grid gap-1 text-xs font-medium">
          {t("list.typeLabel")}
          <input
            type="time"
            step={300}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="min-h-8 rounded-md border bg-background px-2 text-sm"
          />
        </label>
        <button type="submit" disabled={typedMinutes === null} className="min-h-8 rounded-md border px-3 text-xs font-medium hover:bg-accent disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {t("list.typeGo")}
        </button>
        <button type="button" onClick={() => boardCommands.current?.layAtMarker()} className="min-h-8 rounded-md border px-3 text-xs font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {t("list.layAtMarker")}
        </button>
      </form>
    </section>
  );
}
