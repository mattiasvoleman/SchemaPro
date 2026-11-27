"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { askPossibleTimes, clockOf, costWords, type PossibleOption, type PossibleTimes } from "@/lib/possible-times";
import { cn } from "@/lib/utils";

/*
 * THE BEST TIMES OF A LESSON, AS BUTTONS THAT CHOOSE (E3): the list that Justera lektion and a block's dialog both show.
 *
 * Closed until opened, and asked only then (the answer costs a query over the whole year); each time is a button whose name is its
 * whole sentence, with what it does to the week in words, at least 44 px tall. What a button does is the caller's: the lesson's dialog
 * fills its fields with the time, and the block's dialog moves the block there. A lesson that is part of a block or of a pair is asked
 * as the unit it moves with, so what is offered is a time for all of it.
 */

export function PossibleTimesChoices({
  lessonId,
  chosen,
  onChoose,
  writes,
}: {
  lessonId: string;
  /** The areas whose profile may write what a button does (area-refusal.tsx marks it), when a button writes at once. */
  writes?: string;
  /** Whether a time is the one already chosen: it is marked pressed. */
  chosen?: (option: PossibleOption) => boolean;
  onChoose: (option: PossibleOption, times: PossibleTimes) => void;
}) {
  const t = useTranslations("boardPossible");
  const tDays = useTranslations("days");
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<{ lessonId: string; times: PossibleTimes | null } | null>(null);

  useEffect(() => {
    if (!opened) return;
    const asking = new AbortController();
    askPossibleTimes(lessonId, asking.signal).then(
      (times) => {
        if (asking.signal.aborted) return;
        setState({ lessonId, times: times && Array.isArray(times.days) && Array.isArray(times.options) ? times : null });
      },
      () => {
        if (!asking.signal.aborted) setState({ lessonId, times: null });
      },
    );
    return () => asking.abort();
  }, [opened, lessonId]);

  const answered = state?.lessonId === lessonId ? state : null;
  const times = answered?.times ?? null;
  const name = times ? `${times.subject.subjectName} ${times.subject.className}`.trim() : "";

  return (
    <details className="col-span-2 rounded-md border" onToggle={(event) => setOpened((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="min-h-11 cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        {t("dialog.title")}
      </summary>
      <div className="space-y-2 px-3 pb-3 text-sm">
        <p className="text-muted-foreground">{t("dialog.hint")}</p>
        {opened && !answered ? <p className="text-muted-foreground">{t("list.loading")}</p> : null}
        {answered && !times ? <p className="text-muted-foreground">{t("dialog.failed")}</p> : null}
        {times && times.options.length === 0 ? <p className="text-muted-foreground">{t("list.none", { lesson: name })}</p> : null}
        {times && times.options.length > 0 ? (
          <ol className="grid gap-1">
            {times.options.map((option) => {
              const where = { day: tDays(String(option.dayOfWeek)), from: clockOf(option.startMinutes), to: clockOf(option.endMinutes) };
              const words = costWords(option);
              const pressed = chosen?.(option) ?? false;
              return (
                <li key={option.rank}>
                  <button
                    type="button"
                    aria-pressed={chosen ? pressed : undefined}
                    data-writes={writes}
                    onClick={() => onChoose(option, times)}
                    className={cn(
                      "grid min-h-11 w-full gap-0.5 rounded-md border px-3 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      pressed && "border-primary bg-accent",
                    )}
                  >
                    <span className="font-medium tabular-nums">{t("list.option", { rank: option.rank, ...where })}</span>
                    <span className="text-xs text-muted-foreground">
                      {words.length > 0 ? words.map((word) => t(`list.words.${word}`)).join(", ") : t("list.plain")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </details>
  );
}
