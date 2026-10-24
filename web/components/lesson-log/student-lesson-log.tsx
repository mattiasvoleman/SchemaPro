"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { entriesByLesson } from "@/lib/lesson-log";
import { useLessonLogEntries } from "@/lib/lesson-log-queries";
import type { CalendarLessonRow } from "@/lib/types";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";

/**
 * Ämne och läxa for the pupil's week, under the week itself: each lesson its
 * teacher wrote something for, in the week's order, with the topic and the
 * homework. The gateway answers the pupil's own lessons only, by the one
 * roster reader, and never a note to the substitute.
 *
 * Loaded with lazy() from /student, a core-tier route: the hook and this list
 * ride in their own chunk, and a chunk that fails renders nothing rather than
 * take the week away.
 */
export function StudentLessonLog({
  from,
  to,
  lessons,
  subjectName,
}: {
  from: string;
  to: string;
  lessons: readonly CalendarLessonRow[];
  subjectName: ReadonlyMap<string, string>;
}) {
  const t = useTranslations("lessonLog");
  const locale = useLocale();
  const { data, isError, isLoading } = useLessonLogEntries(from, to);
  const byLesson = useMemo(() => entriesByLesson(data), [data]);
  const rows = useMemo(
    () =>
      lessons
        .filter((lesson) => byLesson.has(lesson.id))
        .slice()
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [lessons, byLesson],
  );

  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const day = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" });

  return (
    <SectionCard id="lesson-logs" title={t("weekTitle")} description={t("weekDescription")}>
      {isError ? (
        <LoadError variant="inline" title={t("weekLoadFailed")} hint={t("loadFailedHint")} />
      ) : isLoading ? null : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("weekEmpty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((lesson) => {
            const entry = byLesson.get(lesson.id)!;
            return (
              <li key={lesson.id} className="space-y-1 px-3 py-2 text-sm">
                <p>
                  <span className="font-medium">{subjectName.get(lesson.subjectId) ?? "—"}</span>{" "}
                  <span className="text-muted-foreground">
                    <span className="capitalize">{day.format(new Date(`${lesson.date.slice(0, 10)}T12:00:00Z`))}</span>{" "}
                    {time.format(new Date(lesson.startsAt))}
                  </span>
                </p>
                {entry.topic ? (
                  <p>
                    <span className="font-medium">{t("topic")}:</span> {entry.topic}
                  </p>
                ) : null}
                {entry.homework ? (
                  <p className="whitespace-pre-line">
                    <span className="font-medium">{t("homework")}:</span> {entry.homework}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
