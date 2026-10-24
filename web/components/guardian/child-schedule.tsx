"use client";

// "Schema" on /guardian: each of the guardian's children's PUBLISHED week, as
// the school shows it to families — time, subject, room, the teacher as the
// school names teachers to families, and whether the lesson is cancelled or
// has a substitute; the class's lunch and rasts where the school publishes
// them. One child at a time, today or the whole week.
//
// Loaded with lazy() by the page, inside the core tier's budget: the page
// carries only the import, and this module, its hook
// (lib/guardian-schedule-queries.ts), its mappers (lib/family-schedule.ts)
// and Radix Tabs for the day/week toggle arrive after it — none of them is
// in /guardian's own JS. A chunk that does not arrive renders nothing, so
// the absence report never depends on it.
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
import { sheetFromFamily } from "@/lib/print-sheet";
import { PrintWeekButton } from "@/components/timetable-sheet/print-week-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      {/* No CSS capitalize: the day names come capitalised, and it would
          also capitalise the month ("Måndag 12 Oktober"). */}
      <h3 className="text-sm font-semibold">{label}</h3>
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
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: lesson.subjectColor ?? "hsl(var(--primary))" }}
          />
          <span className={cn("font-medium", state === "cancelled" && "line-through text-muted-foreground")}>
            {lesson.subject}
          </span>
          {state === "cancelled" ? <Badge variant="destructive">{t("cancelled")}</Badge> : null}
          {state === "substitute" ? <Badge variant="warning">{t("substitute")}</Badge> : null}
        </span>
        {details.length > 0 ? (
          <span className="block truncate text-muted-foreground">{details.join(" · ")}</span>
        ) : null}
        {/* Lektionslogg: what the teacher chose to write for the lesson. */}
        {lesson.topic ? (
          <span className="mt-1 block">
            <span className="font-medium">{t("topic")}:</span> {lesson.topic}
          </span>
        ) : null}
        {lesson.homework ? (
          <span className="mt-1 block whitespace-pre-line">
            <span className="font-medium">{t("homework")}:</span> {lesson.homework}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** `school` heads a printed week: the school's name, as the guardian's own profile says it. */
export function ChildSchedule({ childList, school = "" }: { childList: ChildScheduleChild[]; school?: string }) {
  const t = useTranslations("guardian.schedule");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const [childId, setChildId] = useState<string | null>(null);
  const [view, setView] = useState<View>("today");
  // null: the school's own current week (the gateway's default).
  const [week, setWeek] = useState<string | null>(null);

  const selected = childList.find((child) => child.id === childId) ?? childList[0] ?? null;
  const { data, error, isLoading, isFetching, isPlaceholderData } = useFamilySchedule(selected?.id ?? null, week);
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

  return (
    <SectionCard
      id="child-schedule"
      title={t("title", { name: selected.firstName })}
      description={t("body")}
      action={
        // The app's segmented toggle (groups, staffing, cover): pill Tabs
        // with a named list. "I dag" always means the school's own week.
        <Tabs
          value={view}
          onValueChange={(value) => {
            if (value === "today") {
              setView("today");
              setWeek(null);
            } else {
              setView("week");
            }
          }}
        >
          <TabsList aria-label={t("viewLabel")}>
            <TabsTrigger value="today">{t("today")}</TabsTrigger>
            <TabsTrigger value="week">{t("week")}</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {childList.length > 1 ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("childLabel")}>
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

      {shown && view === "today" ? (
        <div className="flex justify-end">
          {/* The whole week on paper, the child's as the page read it (recorded then). */}
          <PrintWeekButton build={() => sheetFromFamily(shown, school, t("substitute"))} disabled={isFetching} />
        </div>
      ) : null}

      {view === "week" && shown ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => step(-1)}
            aria-disabled={blocked(-1)}
            className={cn(blocked(-1) && "cursor-not-allowed opacity-50")}
            aria-label={t("previousWeek")}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="min-w-24 text-center text-sm font-medium tabular-nums" aria-live="polite">
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
            <ChevronRight aria-hidden="true" />
          </Button>
          <div className="ml-auto">
            <PrintWeekButton build={() => sheetFromFamily(shown, school, t("substitute"))} disabled={isFetching} />
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {message ? (
          <Notice tone="destructive">{message}</Notice>
        ) : isLoading || !shown || (view === "today" && isPlaceholderData) ? (
          // In today view a kept-over week (another week's answer while
          // today's loads) would read as "nothing today".
          <div aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <span className="sr-only">{t("loading")}</span>
          </div>
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
    </SectionCard>
  );
}
