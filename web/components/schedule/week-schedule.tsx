"use client";

import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { addDays, isoWeek } from "@/lib/utils";
import {
  TimetableGrid,
  type TimetableLesson,
} from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

interface WeekScheduleProps {
  weekStart: Date;
  onWeekChange: (newStart: Date) => void;
  lessons: TimetableLesson[];
  isLoading: boolean;
  onLessonClick?: (lesson: TimetableLesson) => void;
}

export function WeekSchedule({
  weekStart,
  onWeekChange,
  lessons,
  isLoading,
  onLessonClick,
}: WeekScheduleProps) {
  const t = useTranslations("schedule");

  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          onClick={() => onWeekChange(addDays(weekStart, -7))}
          aria-label={t("previousWeek")}
        >
          <ChevronLeft />
        </Button>
        <span className="min-w-24 text-center text-sm font-medium">
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
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : lessons.length === 0 ? (
        <EmptyState icon={CalendarDays} title={t("noLessons")} />
      ) : (
        <TimetableGrid lessons={lessons} dates={dates} onLessonClick={onLessonClick} />
      )}
    </div>
  );
}
