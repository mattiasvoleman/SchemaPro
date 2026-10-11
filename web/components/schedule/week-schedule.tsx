"use client";

import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { addDays, isoWeek, startOfIsoWeek } from "@/lib/utils";
import {
  TimetableGrid,
  type TimetableBand,
  type TimetableLesson,
} from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";

interface WeekScheduleProps {
  weekStart: Date;
  onWeekChange: (newStart: Date) => void;
  lessons: TimetableLesson[];
  isLoading: boolean;
  /**
   * The week's lessons could not be fetched: said as that, under the week's
   * own arrows, instead of "Inga lektioner denna vecka" — a free week that is
   * not one. Optional, so a page that draws its own error keeps doing so.
   */
  isError?: boolean;
  onLessonClick?: (lesson: TimetableLesson) => void;
  /** Stripes drawn behind the lessons — the meal, in a pupil's own week. */
  bands?: TimetableBand[];
}

export function WeekSchedule({
  weekStart,
  onWeekChange,
  lessons,
  isLoading,
  isError = false,
  onLessonClick,
  bands,
}: WeekScheduleProps) {
  const t = useTranslations("schedule");

  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const thisWeek = startOfIsoWeek(new Date());
  const onThisWeek = startOfIsoWeek(weekStart).getTime() === thisWeek.getTime();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          onClick={() => onWeekChange(addDays(weekStart, -7))}
          aria-label={t("previousWeek")}
        >
          <ChevronLeft />
        </Button>
        {/* Live, so a screen reader hears which week the arrows landed on. */}
        <span className="min-w-24 text-center text-sm font-medium tabular-nums" aria-live="polite">
          {t("week", { week: isoWeek(weekStart) })}
        </span>
        <Button
          variant="outline"
          size="icon"
          onClick={() => onWeekChange(addDays(weekStart, 7))}
          aria-label={t("nextWeek")}
        >
          <ChevronRight />
        </Button>
        {/* The way back after paging through the term. Disabled rather than
            hidden on the current week, so the row does not change shape. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onWeekChange(thisWeek)}
          disabled={onThisWeek}
        >
          {t("thisWeek")}
        </Button>
      </div>

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-96 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : lessons.length === 0 && (bands?.length ?? 0) === 0 ? (
        // Bands count. A week with no lessons but a meal every day is a week
        // with something in it, and replacing the grid with "inga lektioner"
        // threw the meal away before it was ever drawn — the one case a pupil
        // most needs the answer to is a day whose only entry is lunch.
        <EmptyState icon={CalendarDays} title={t("noLessons")} headingLevel={2} />
      ) : (
        <TimetableGrid
          lessons={lessons}
          dates={dates}
          onLessonClick={onLessonClick}
          bands={bands}
        />
      )}
    </div>
  );
}
