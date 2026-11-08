"use client";

import { useState } from "react";
import { CalendarOff, ChevronLeft, ChevronRight, Download, Printer } from "lucide-react";
import { toast } from "sonner";
import { addDays, csvName, MEAL_MAX_DAYS, MEAL_WEEK_DAYS, type MealCountsView } from "@/lib/meal-counts";
import { downloadMealCsv, useMealCounts } from "@/lib/meal-counts-queries";
import { useMealsText } from "@/components/meals/use-meals-text";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DayTable } from "./day-table";
import { SettingsCard } from "./settings-card";
import { WeekTable } from "./week-table";

type View = "day" | "week";

/**
 * Måltidskollen (20270123090000): the portions of each lunch sitting, for the kitchen, from today on.
 *
 * Two views of the one count the gateway makes (app.meal_counts_for_me): the day with its sittings and
 * the classes in each, and the week ahead a day to a row. Both print, and both go to Excel as a file in
 * windows-1252. What a portion is, and what is not counted (a diet, an allergy, a class away on an
 * activity, staff the school has not placed), is said on the page under the figures, because the
 * kitchen orders from them.
 *
 * Nobody is named. The school's own today is the gateway's: the page asks for "the week ahead" and
 * "the day" and learns the date from the answer, and the date field opens at it.
 */
export default function MealsPage() {
  const { t, long, number } = useMealsText();
  const [view, setView] = useState<View>("day");
  // null: the school's today, which the gateway knows (the browser's clock may not be the school's).
  const [picked, setPicked] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // The date field keeps what was typed in it; a day taken to the nearest allowed one draws the field again.
  const [fieldKey, setFieldKey] = useState(0);

  // The week ahead is always read: it holds the school's today and, for the days in it, the day too.
  const week = useMealCounts(null, MEAL_WEEK_DAYS);
  const today = week.data?.from ?? null;
  const dayDate = picked ?? today;
  const inWeek = dayDate !== null && (week.data?.days.some((one) => one.date === dayDate) ?? false);
  // A day beyond the week is read on its own; the first render of "today" needs no second request.
  const alone = useMealCounts(picked, 1, view === "day" && picked !== null && today !== null && !inWeek);

  const source: MealCountsView | undefined = view === "week" ? week.data : inWeek ? week.data : alone.data;
  const day = view === "day" ? source?.days.find((one) => one.date === dayDate) : undefined;
  const loading = view === "week" ? week.isLoading : week.isLoading || (!inWeek && picked !== null && alone.isLoading);
  const failed = view === "week" ? week.isError || !week.data : week.isError || (!inWeek && picked !== null && (alone.isError || !alone.data));
  const moving = view === "week" ? week.isPlaceholderData : alone.isPlaceholderData;
  const last = today === null ? null : addDays(today, MEAL_MAX_DAYS - 1);
  const retry = () => {
    void week.refetch();
    if (picked !== null) void alone.refetch();
  };

  const empty =
    view === "week" ? source?.days.every((one) => one.sittings.length === 0) === true : day !== undefined && day.sittings.length === 0;

  const download = async () => {
    if (downloading || !source) return;
    setDownloading(true);
    try {
      if (view === "week") {
        await downloadMealCsv(null, MEAL_WEEK_DAYS, csvName(source.from, source.to));
      } else if (dayDate) {
        await downloadMealCsv(dayDate, 1, csvName(dayDate, dayDate));
      }
    } catch {
      toast.error(t("actions.csvFailed"));
    } finally {
      setDownloading(false);
    }
  };

  // A day typed into the field may lie outside what the gateway answers for (today to thirteen days on); it is
  // taken to the nearest day that does, and today is "no day picked" so that the week already read serves it.
  const choose = (value: string) => {
    if (!today || !last) return;
    const day = value < today ? today : value > last ? last : value;
    if (day !== value) setFieldKey((key) => key + 1);
    setPicked(day === today ? null : day);
  };
  const step = (by: number) => {
    if (dayDate) choose(addDays(dayDate, by));
  };

  const printTitle =
    view === "week" && source
      ? t("print.weekTitle", { from: long(source.from), to: long(source.to) })
      : dayDate
        ? t("print.dayTitle", { date: long(dayDate) })
        : "";

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro")} />

      <FilterBar className="print:hidden">
        <Tabs value={view} onValueChange={(value) => setView(value as View)}>
          <TabsList aria-label={t("view.label")}>
            <TabsTrigger value="day">{t("view.day")}</TabsTrigger>
            <TabsTrigger value="week">{t("view.week")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "day" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="icon" aria-label={t("day.previous")} disabled={!dayDate || !today || dayDate <= today} onClick={() => step(-1)}>
              <ChevronLeft />
            </Button>
            <DateField
              key={fieldKey}
              id="meals-day"
              label={t("day.pick")}
              aria-label={t("day.pick")}
              value={dayDate ?? ""}
              min={today ?? undefined}
              max={last ?? undefined}
              disabled={today === null}
              onChange={(value) => value && choose(value)}
            />
            <Button variant="outline" size="icon" aria-label={t("day.next")} disabled={!dayDate || !last || dayDate >= last} onClick={() => step(1)}>
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" disabled={picked === null} onClick={() => setPicked(null)}>
              {t("day.today")}
            </Button>
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!source || empty || downloading} onClick={() => void download()}>
            <Download aria-hidden="true" />
            {t("actions.csv")}
          </Button>
          <Button variant="outline" size="sm" disabled={!source || empty} onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            {t("actions.print")}
          </Button>
        </div>
      </FilterBar>

      {loading ? (
        <div aria-busy="true" className="print:hidden">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : failed || !source ? (
        <LoadError
          title={t("loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={2}
          className="print:hidden"
          action={
            <Button variant="outline" size="sm" onClick={retry}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <>
          <h2 className="hidden text-lg font-semibold print:block">{`${t("print.school")} · ${printTitle}`}</h2>
          {empty ? (
            <EmptyState
              icon={CalendarOff}
              headingLevel={2}
              title={t(view === "week" ? "emptyWeek.title" : "empty.title")}
              description={t(view === "week" ? "emptyWeek.body" : "empty.body")}
            />
          ) : view === "day" && day ? (
            <>
              <KpiStrip columns={5} className="print:hidden">
                <KpiTile label={t("kpi.portions")} value={number(day.totals.portions)} />
                <KpiTile label={t("kpi.pupils")} value={number(day.totals.pupils)} />
                <KpiTile
                  label={t("kpi.absent")}
                  value={source.cutoff ? `−${number(day.totals.absentBefore)}` : null}
                  fallback={t("kpi.notIncluded")}
                />
                <KpiTile
                  label={t("kpi.staff")}
                  value={source.staffModelled ? `+${number(day.totals.staff)}` : null}
                  fallback={t("kpi.notIncluded")}
                />
                <KpiTile
                  label={t("kpi.after")}
                  value={source.cutoff ? number(day.totals.absentAfter) : null}
                  fallback={t("kpi.notIncluded")}
                  detail={source.cutoff ? t("kpi.afterDetail") : undefined}
                />
              </KpiStrip>
              <SectionCard id="meals-day" title={long(day.date)} className="print:border-0 print:shadow-none">
                <div className={moving ? "opacity-60" : undefined} aria-busy={moving || undefined}>
                  <DayTable day={day} staffModelled={source.staffModelled} hasCutoff={source.cutoff !== null} />
                </div>
              </SectionCard>
            </>
          ) : (
            <SectionCard id="meals-week" title={t("view.week")} className="print:border-0 print:shadow-none">
              <div className={moving ? "opacity-60" : undefined} aria-busy={moving || undefined}>
                <WeekTable
                  days={source.days}
                  staffModelled={source.staffModelled}
                  hasCutoff={source.cutoff !== null}
                  onOpen={(date) => {
                    setPicked(date === today ? null : date);
                    setView("day");
                  }}
                />
              </div>
            </SectionCard>
          )}

          <Notice tone="neutral" title={t("notes.title")} className="print:border print:bg-transparent">
            <ul className="list-disc space-y-1 pl-5">
              <li>{source.cutoff ? t("notes.cutoff", { time: source.cutoff }) : t("notes.noCutoff")}</li>
              {source.cutoff ? <li>{t("notes.partial")}</li> : null}
              <li>{source.staffModelled ? t("notes.staff") : t("notes.noStaff")}</li>
              <li>{t("notes.activity")}</li>
              <li>{t("notes.diet")}</li>
            </ul>
          </Notice>
        </>
      )}

      <SettingsCard />
    </Page>
  );
}
