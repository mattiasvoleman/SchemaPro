"use client";

import { ChevronRight, CircleCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useMyReportingRate } from "@/lib/reporting-rate-queries";
import { oldestFirst, type MyReportingRate, type OpenLesson, type ReportingInterval } from "@/lib/reporting-rate";
import { RateBar } from "@/components/reporting-rate/rate-bar";
import { useReportingRateText } from "@/components/reporting-rate/use-reporting-rate-text";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * /teacher/reporting-rate — Rapporteringsgrad (20270108090100), the teacher's
 * own: the lessons whose register is not saved yet, the oldest first, each a
 * link to the register, and the share of the lessons held that were reported
 * this week, this month and this läsår.
 *
 * Read through the gateway: the open lessons are a function that answers only
 * for the signed-in teacher, and the figures are the teacher's own rows. No
 * one else's are on this page, and reading one's own is not recorded in the
 * läslogg. A lesson stays here until someone saves its register: a colleague on
 * the same lesson counts, and a lesson cancelled or a day of one's own absence
 * leaves the list. Bundle: core tier, like the teacher's other pages; nothing
 * here is lazy.
 */
export default function TeacherReportingRatePage() {
  const { t } = useReportingRateText();
  const query = useMyReportingRate();

  return (
    <Page width="wide">
      <PageHeader title={t("teacher.title")} subtitle={t("teacher.subtitle")} intro={t("teacher.intro")} />
      {query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.isError || !query.data ? (
        <LoadError title={t("teacher.loadFailed")} hint={t("teacher.loadFailedHint")} headingLevel={2} />
      ) : (
        <>
          <OpenLessons mine={query.data} />
          <MyRate mine={query.data} />
        </>
      )}
    </Page>
  );
}

function OpenLessons({ mine }: { mine: MyReportingRate }) {
  const { t, weekday, time } = useReportingRateText();
  const lessons = oldestFirst(mine.open);
  const overdue = lessons.filter((lesson) => lesson.overdue).length;

  return (
    <SectionCard
      id="reporting-rate-open"
      title={t("teacher.open.title")}
      description={t("teacher.open.description", { days: mine.openAfterDays })}
    >
      {lessons.length === 0 ? (
        <EmptyState icon={CircleCheck} headingLevel={3} title={t("teacher.open.emptyTitle")} description={t("teacher.open.emptyBody")} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t("teacher.open.summary", { count: lessons.length, overdue })}
          </p>
          <ul className="divide-y overflow-hidden rounded-lg border" aria-label={t("teacher.open.listLabel")}>
            {lessons.map((lesson: OpenLesson) => (
              <li key={lesson.lessonId}>
                <Link
                  href={`/teacher/attendance/${lesson.lessonId}`}
                  className="flex min-h-16 items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{lesson.subjectName}</span>
                      {lesson.overdue ? <Badge variant="warning">{t("teacher.open.overdue")}</Badge> : null}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      <span className="tabular-nums">
                        {weekday(lesson.date)} {time(lesson.startsAt)}–{time(lesson.endsAt)}
                      </span>
                      {` · ${lesson.groupName}`}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

function MyRate({ mine }: { mine: MyReportingRate }) {
  const { t, day, number, periodName } = useReportingRateText();
  const rows: Array<{ key: "WEEK" | "MONTH" | "YEAR"; name: string; interval: ReportingInterval }> = [
    { key: "WEEK", name: periodName("WEEK", mine.week.from, null), interval: mine.week },
    { key: "MONTH", name: periodName("MONTH", mine.month.from, null), interval: mine.month },
    ...(mine.year ? [{ key: "YEAR" as const, name: periodName("YEAR", mine.year.from, mine.year.name), interval: mine.year }] : []),
  ];

  return (
    <SectionCard
      id="reporting-rate-mine"
      title={t("teacher.mine.title")}
      description={mine.through ? t("updatedThrough", { date: day(mine.through) }) : t("notCountedYet")}
    >
      <ul className="divide-y rounded-lg border" aria-label={t("teacher.mine.listLabel")}>
        {rows.map(({ key, name, interval }) => (
          <li key={key} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3">
            <div className="min-w-0">
              <div className="font-medium">{name}</div>
              <div className="text-sm text-muted-foreground">
                {`${day(interval.from)} – ${day(interval.to)} · `}
                {t("teacher.mine.figures", { reported: number(interval.reported), held: number(interval.held) })}
              </div>
            </div>
            <RateBar figures={interval} />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
