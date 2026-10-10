"use client";

// "Schema" on /guardian: each of the guardian's children's PUBLISHED week, as
// the school shows it to families — time, subject, room, the teacher as the
// school names teachers to families, and whether the lesson is cancelled or
// has a substitute; the class's lunch and rasts where the school publishes
// them. One child at a time, today or the whole week.
//
// Loaded with lazy() by the page, inside the core tier's budget: the page
// carries only the import, and this module, its hook
// (lib/guardian-schedule-queries.ts) and its mappers (lib/family-schedule.ts)
// arrive after it. A chunk that does not arrive renders nothing, so the
// absence report never depends on it.
//
// What it never shows: another family's child (the gateway's 404, RLS's
// arms), a draft (the calendar is the published layer), a note, a cause, an
// absence reason or who the substitute replaces. Times are the gateway's
// HH:MM on the school's clock, drawn as they come.

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  canStep,
  familyDays,
  lessonState,
  shiftDate,
  weekNumber,
  type FamilyDay,
  type FamilyEntry,
} from "@/lib/family-schedule";
import { useFamilySchedule } from "@/lib/guardian-schedule-queries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ChildScheduleChild {
  id: string;
  firstName: string;
}

type View = "today" | "week";

function DayList({ day, label, empty }: { day: FamilyDay; label: string; empty: string }) {
  const t = useTranslations("guardian.schedule");
  return (
    <section aria-label={label} className="space-y-1.5">
      <h3 className="text-sm font-medium capitalize">{label}</h3>
      {day.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {day.entries.map((entry) => (
            <EntryRow key={entry.key} entry={entry} lunch={t("lunch")} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EntryRow({ entry, lunch }: { entry: FamilyEntry; lunch: string }) {
  const t = useTranslations("guardian.schedule");
  const time = (
    <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
      {entry.start}–{entry.end}
    </span>
  );
  if (entry.kind !== "LESSON") {
    return (
      <li className="flex gap-3 rounded-md bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground">
        {time}
        <span>{entry.kind === "LUNCH" ? lunch : entry.name}</span>
      </li>
    );
  }
  const { lesson } = entry;
  const state = lessonState(lesson);
  const details = [lesson.room, ...lesson.teachers].filter((part): part is string => Boolean(part));
  return (
    <li className="flex gap-3 rounded-md border px-3 py-2 text-sm">
      {time}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: lesson.subjectColor ?? "hsl(var(--primary))" }}
          />
          <span className={cn("font-medium", state === "cancelled" && "line-through text-muted-foreground")}>
            {lesson.subject}
          </span>
          {state === "cancelled" ? (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
              {t("cancelled")}
            </span>
          ) : null}
          {state === "substitute" ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              {t("substitute")}
            </span>
          ) : null}
        </span>
        {details.length > 0 ? (
          <span className="block truncate text-muted-foreground">{details.join(" · ")}</span>
        ) : null}
      </span>
    </li>
  );
}

export function ChildSchedule({ childList }: { childList: ChildScheduleChild[] }) {
  const t = useTranslations("guardian.schedule");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const [childId, setChildId] = useState<string | null>(null);
  const [view, setView] = useState<View>("today");
  // null: the school's own current week (the gateway's default).
  const [week, setWeek] = useState<string | null>(null);

  const selected = childList.find((child) => child.id === childId) ?? childList[0] ?? null;
  const { data, error, isLoading, isFetching } = useFamilySchedule(selected?.id ?? null, week);
  if (!selected) return null;

  const dayMonth = (date: string) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, d)),
    );
  };
  const dayLabel = (day: FamilyDay) => `${tDays(String(day.weekday))} ${dayMonth(day.date)}`;

  // Only an answer for the child on screen: while another child's week loads,
  // the previous child's must not stand under this child's name.
  const shown = data && data.student.id === selected.id ? data : null;
  const days = shown ? familyDays(shown) : [];
  const todayDay = shown ? days.find((day) => day.date === shown.today) ?? null : null;
  // Never `disabled`: a disabled button that has focus drops it to <body>,
  // so a keyboard reader would start from the top after every step. While a
  // week loads, or at a bound, the button says so (aria-disabled) and a press
  // does nothing.
  const blocked = (direction: -1 | 1) => !shown || !canStep(shown, direction) || isFetching;
  const step = (direction: -1 | 1) => {
    if (!shown || blocked(direction)) return;
    setView("week");
    setWeek(shiftDate(shown.week.from, 7 * direction));
  };
  const message =
    error instanceof ApiError && error.code === "WEEK_OUT_OF_RANGE" ? t("weekOutOfRange") : error ? t("error") : null;
  const titleId = `child-schedule-${selected.id}`;

  return (
    <section aria-labelledby={titleId} className="mb-6 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={titleId} className="font-semibold">
            {t("title", { name: selected.firstName })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </div>
        <div className="flex gap-1" role="group" aria-label={t("viewLabel")}>
          <Button
            size="sm"
            variant={view === "today" ? "default" : "outline"}
            aria-pressed={view === "today"}
            onClick={() => {
              setView("today");
              setWeek(null);
            }}
          >
            {t("today")}
          </Button>
          <Button
            size="sm"
            variant={view === "week" ? "default" : "outline"}
            aria-pressed={view === "week"}
            onClick={() => setView("week")}
          >
            {t("week")}
          </Button>
        </div>
      </div>

      {childList.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label={t("childLabel")}>
          {childList.map((child) => (
            <Button
              key={child.id}
              size="sm"
              variant={child.id === selected.id ? "secondary" : "ghost"}
              aria-pressed={child.id === selected.id}
              onClick={() => setChildId(child.id)}
            >
              {child.firstName}
            </Button>
          ))}
        </div>
      ) : null}

      {view === "week" && shown ? (
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => step(-1)}
            aria-disabled={blocked(-1)}
            className={cn(blocked(-1) && "cursor-not-allowed opacity-50")}
            aria-label={t("previousWeek")}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-24 text-center text-sm font-medium" aria-live="polite">
            {t("weekLabel", { week: weekNumber(shown.week.isoWeek) })}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => step(1)}
            aria-disabled={blocked(1)}
            className={cn(blocked(1) && "cursor-not-allowed opacity-50")}
            aria-label={t("nextWeek")}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        {message ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : isLoading || !shown ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : view === "today" ? (
          todayDay ? (
            <DayList day={todayDay} label={dayLabel(todayDay)} empty={t("emptyToday")} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("emptyToday")}</p>
          )
        ) : days.every((day) => day.entries.length === 0) ? (
          <p className="text-sm text-muted-foreground">{t("emptyWeek")}</p>
        ) : (
          days.map((day) => <DayList key={day.date} day={day} label={dayLabel(day)} empty={t("emptyDay")} />)
        )}
      </div>
    </section>
  );
}
