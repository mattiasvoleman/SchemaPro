"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { askPossibleTimes, clockOf, costWords, type PossibleTimes } from "@/lib/possible-times";
import type { LessonEditDraft } from "@/components/schedule/lesson-edit-dialog";
import type { MasterLesson } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * MÖJLIGA TIDER IN JUSTERA LEKTION (E3).
 *
 * The board paints where a lesson in hand can stand and lists the times (possible-layer.tsx), for a reader with a marker. A phone has
 * none: a tap opens this dialog, where day, clock and room are fields. This is the same answer as a list inside it: the best times of the
 * lesson, each a button that FILLS the fields (day, start, end, and the room when the gateway offered the time in another), after which
 * the dialog's own question says what the judge thinks of them and Spara lays the lesson. Nothing is written by a button here.
 *
 * Closed until opened, and asked only then: the gateway's answer costs a query over the whole year, and most openings of the dialog are
 * for a lesson whose clock is being corrected by a minute.
 */

export function LessonPossibleTimes({
  lesson,
  draft,
  onDraftChange,
}: {
  lesson: MasterLesson;
  draft: LessonEditDraft;
  onDraftChange: (draft: LessonEditDraft) => void;
}) {
  const t = useTranslations("boardPossible");
  const tDays = useTranslations("days");
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<{ lessonId: string; times: PossibleTimes | null } | null>(null);

  useEffect(() => {
    if (!opened) return;
    const asking = new AbortController();
    askPossibleTimes(lesson.id, asking.signal).then(
      (times) => {
        if (asking.signal.aborted) return;
        setState({ lessonId: lesson.id, times: times && Array.isArray(times.days) && Array.isArray(times.options) ? times : null });
      },
      () => {
        if (!asking.signal.aborted) setState({ lessonId: lesson.id, times: null });
      },
    );
    return () => asking.abort();
  }, [opened, lesson.id]);

  const answered = state?.lessonId === lesson.id ? state : null;
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
              const chosen = draft.dayOfWeek === String(option.dayOfWeek) && draft.startTime === where.from && draft.endTime === where.to;
              return (
                <li key={option.rank}>
                  <button
                    type="button"
                    aria-pressed={chosen}
                    onClick={() => {
                      // The room the gateway put the lesson in, when that is another than its own: the field says it, and the judge asks about it.
                      const room = option.roomChanged ? (option.lessons.find((entry) => entry.lessonId === lesson.id)?.roomId ?? null) : null;
                      onDraftChange({
                        ...draft,
                        dayOfWeek: String(option.dayOfWeek),
                        startTime: where.from,
                        endTime: where.to,
                        ...(room !== null ? { roomId: room } : {}),
                      });
                    }}
                    className={cn(
                      "grid min-h-11 w-full gap-0.5 rounded-md border px-3 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      chosen && "border-primary bg-accent",
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
