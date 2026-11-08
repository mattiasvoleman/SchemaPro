"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useCheck, useWeek } from "@/lib/class-teacher-queries";
import {
  WEEKDAYS,
  addDaysIso,
  lessonState,
  openSpansOf,
  problemOf,
  weekdayOf,
  type ChangeView,
  type FrameReason,
  type LessonRef,
} from "@/lib/class-teacher";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, isoWeek } from "@/lib/utils";
import { DraftsSection } from "./drafts-section";
import { LessonGrid, type GridDay, type GridItem } from "./lesson-grid";
import { LessonPanel } from "./lesson-panel";
import { useClassTeacherText } from "./use-class-teacher-text";

type Tab = "occasions" | "template";

/** What is chosen: a lesson, and whether it was chosen from the list of drafts (then its draft opens in its form). */
type Selection = LessonRef & { edit: boolean };

/**
 * One class, for the klasslärare of it: the week (or the weekly template) as
 * columns of time with the open hours behind the lessons, the lesson chosen
 * and what can be done with it, and the class's drafts.
 *
 * The week and the check are read again every minute or so and when the window
 * is looked at again, so that two people editing the same class see each
 * other's drafts; a week that cannot be read again is said, and what is on
 * screen is marked as possibly out of date.
 */
export function ClassSchedule({
  cls,
  classes,
  onClassChange,
  selfPublish,
}: {
  cls: { id: string; name: string };
  classes: Array<{ id: string; name: string }>;
  onClassChange: (id: string) => void;
  selfPublish: boolean;
}) {
  const { t, dayName, dateShort, span, reason } = useClassTeacherText();
  const tCommon = useTranslations("common");
  const [from, setFrom] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("occasions");
  const [selection, setSelection] = useState<Selection | null>(null);

  const week = useWeek(cls.id, from);
  const data = week.data;
  const check = useCheck(cls.id, (data?.drafts.length ?? 0) > 0);
  const fetching = week.isFetching || check.isFetching;
  const reload = () => {
    void week.refetch();
    void check.refetch();
  };

  if (week.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (!data) {
    const problem = week.isError ? problemOf(week.error) : null;
    if (problem?.kind === "notAppointed") {
      return <EmptyState icon={CalendarDays} headingLevel={2} title={t("noAppointment.title")} description={t("noAppointment.body")} />;
    }
    return <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />;
  }

  const roomName = (id: string | null) => (id ? (data.rooms.find((room) => room.id === id)?.name ?? null) : null);
  const go = (weeks: number) => {
    setFrom(addDaysIso(data.weekStart, weeks * 7));
    // A dated lesson belongs to its week: the chosen one is not on the next.
    setSelection((current) => (current?.layer === "occasion" ? null : current));
  };
  const range = `${dateShort(data.days[0]!)}–${dateShort(data.days[4]!)}`;

  const days: GridDay[] = WEEKDAYS.map((dow) => {
    const open = openSpansOf(data.openTimes, dow);
    return {
      day: dow,
      label: dayName(dow),
      sub: tab === "occasions" ? dateShort(data.days[dow - 1]!) : null,
      open,
      openText: open.length > 0 ? t("grid.open", { spans: open.map((one) => span(one.start, one.end)).join(", ") }) : t("grid.closed"),
    };
  });

  const itemOf = (
    id: string,
    day: number,
    lesson: { start: string; end: string; subjectName: string; roomId: string | null; refusal: FrameReason | null; draftId: string | null; status?: string },
    when: string,
  ): GridItem => {
    const state = lessonState(lesson);
    const stateLabel = t(`state.${state}`);
    const why = lesson.refusal !== null ? reason(lesson.refusal) : null;
    const room = roomName(lesson.roomId);
    return {
      id,
      day,
      start: lesson.start,
      end: lesson.end,
      title: lesson.subjectName,
      detail: room,
      state,
      stateLabel,
      reason: why,
      name: [lesson.subjectName, `${when} ${span(lesson.start, lesson.end)}`, room ? t("lesson.room", { room }) : null, stateLabel, why].filter(Boolean).join(", "),
    };
  };
  const items: GridItem[] =
    tab === "occasions"
      ? data.occasions.map((one) => itemOf(one.id, weekdayOf(one.date), one, `${dayName(weekdayOf(one.date))} ${dateShort(one.date)}`))
      : data.template.map((one) => itemOf(one.id, one.dayOfWeek, one, dayName(one.dayOfWeek)));

  const chosen = selection && selection.layer === (tab === "occasions" ? "occasion" : "template") ? selection : null;
  const lesson = chosen
    ? chosen.layer === "occasion"
      ? (() => {
          const view = data.occasions.find((one) => one.id === chosen.id);
          return view ? ({ layer: "occasion", view } as const) : null;
        })()
      : (() => {
          const view = data.template.find((one) => one.id === chosen.id);
          return view ? ({ layer: "template", view } as const) : null;
        })()
    : null;

  // "Redigera" in the list of drafts: the draft's lesson is brought to the screen (its week, its layer) and chosen.
  const open = (draft: ChangeView) => {
    if (draft.calendarLessonId !== null) {
      setTab("occasions");
      if (draft.date !== null && !data.days.includes(draft.date)) setFrom(draft.date);
      setSelection({ layer: "occasion", id: draft.calendarLessonId, edit: true });
    } else if (draft.masterLessonId !== null) {
      setTab("template");
      setSelection({ layer: "template", id: draft.masterLessonId, edit: true });
    }
  };

  const gridLabel =
    tab === "occasions"
      ? t("grid.labelWeek", { week: isoWeek(new Date(`${data.weekStart}T12:00:00`)), name: data.className })
      : t("grid.labelTemplate", { name: data.className });
  const checkProblem = check.isError ? problemOf(check.error) : null;
  const empty = tab === "occasions" ? data.occasions.length === 0 : data.template.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        {classes.length > 1 ? (
          <FormField id="class-teacher-class" label={t("classLabel")} className="w-48">
            <NativeSelect value={cls.id} onChange={(event) => onClassChange(event.target.value)}>
              {classes.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        ) : (
          <p className="text-base font-semibold">{t("classHeading", { name: data.className })}</p>
        )}
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList aria-label={t("view.label")}>
            <TabsTrigger value="occasions">{t("view.occasions")}</TabsTrigger>
            <TabsTrigger value="template">{t("view.template")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "occasions" ? (
          <div role="group" aria-label={t("week.nav")} className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon" aria-label={t("week.prev")} onClick={() => go(-1)}>
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => { setFrom(null); setSelection((current) => (current?.layer === "occasion" ? null : current)); }}>
              {t("week.current")}
            </Button>
            <Button type="button" variant="outline" size="icon" aria-label={t("week.next")} onClick={() => go(1)}>
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        {tab === "occasions" ? (
          <p className="text-sm font-medium" aria-live="polite">
            {t("week.label", { week: isoWeek(new Date(`${data.weekStart}T12:00:00`)), range })}
          </p>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">{tab === "occasions" ? t("view.occasionsHint") : t("view.templateHint")}</p>

      {week.isError ? (
        <Notice tone="warning" title={t("refetchFailed")}>
          {tCommon("refetchFailedHint")}
        </Notice>
      ) : null}
      {checkProblem?.kind === "appointerGone" || checkProblem?.kind === "notAppointed" ? (
        <Notice tone="warning" title={t("problem.appointerGone")}>
          {t("problem.appointerGoneDetail")}
        </Notice>
      ) : null}
      {data.openTimes.length === 0 ? (
        <Notice tone="neutral" title={t("grid.noOpenTimes.title")}>
          {t("grid.noOpenTimes.body")}
        </Notice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className={cn("min-w-0 space-y-2 transition-opacity", week.isPlaceholderData && "opacity-60")} aria-busy={week.isPlaceholderData || undefined}>
          <h2 className="sr-only">{gridLabel}</h2>
          {empty ? <p className="text-sm text-muted-foreground">{tab === "occasions" ? t("grid.noLessons") : t("grid.noTemplate")}</p> : null}
          <LessonGrid
            label={gridLabel}
            days={days}
            items={items}
            selectedId={chosen?.id ?? null}
            onSelect={(id) => setSelection({ layer: tab === "occasions" ? "occasion" : "template", id, edit: false })}
          />
          <p className="text-xs text-muted-foreground">{t("grid.legend")}</p>
        </div>
        <div className="min-w-0">
          {lesson ? (
            <LessonPanel
              // One panel per lesson, and per way of arriving at it: its state is its own.
              key={`${chosen!.layer}:${chosen!.id}:${chosen!.edit}`}
              classId={cls.id}
              week={data}
              lesson={lesson}
              check={check.data}
              fetching={fetching}
              onReload={reload}
              startEditing={chosen!.edit}
            />
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {week.isPlaceholderData ? t("panel.loading") : chosen ? t("panel.gone") : t("panel.empty")}
            </div>
          )}
        </div>
      </div>

      <DraftsSection classId={cls.id} week={data} check={check} selfPublish={selfPublish} fetching={fetching} onReload={reload} onOpen={open} />
    </div>
  );
}
