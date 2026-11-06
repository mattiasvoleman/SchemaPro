"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Printer, Search } from "lucide-react";
import { toast } from "sonner";
import { useLocale } from "next-intl";
import { isNotOpen, useSchoolDay } from "@/lib/school-day-queries";
import {
  axisOf,
  buildRows,
  rowKindsOf,
  schoolClosure,
  shiftDay,
  type Axis,
  type Row,
  type SchoolDayView,
  weekColumns,
  weekRange,
  weekdayOf,
  type RowKind,
} from "@/lib/school-day";
import { isoWeek, toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DayGrid } from "./day-grid";
import { FreeFinder } from "./free-finder";
import { NotOpen } from "./not-open";
import { Field, Toolbar } from "./toolbar";
import { useSchoolDayText } from "./use-school-day-text";
import { WeekGrid } from "./week-grid";

type Mode = "day" | "week";

/** The next school day in a direction: Saturday and Sunday are stepped over, though a date may still be picked there. */
function stepDay(date: string, direction: 1 | -1): string {
  let next = shiftDay(date, direction);
  while (weekdayOf(next) > 5) next = shiftDay(next, direction);
  return next;
}

/**
 * The body of Skolans dag, which the administrators' page and a teacher's page
 * both draw: the free finder, and the day or the week of the whole school as
 * classes, teachers or rooms.
 *
 * What it shows is what the gateway answered for this reader: the rows a
 * reader may choose between (a teacher whose school lets them see the rooms
 * has the rooms), the free teachers or the sentence that they are not told,
 * and the Skriv ut button, which only an administrator has. The page does not
 * ask who the reader is; `access` says.
 *
 * It is a screen that stays open, so it asks again every minute (the lessons
 * change under the morning) and keeps the last figures dimmed while a new
 * range loads, instead of a blank between two days.
 *
 * PRINT. A printout names the staff and leaves the screen, so a teacher the
 * school has marked as having a protected identity is not named on it: at the
 * click the marks are read (components/school-day/print-actions.ts, fetched
 * then), the sheet is drawn again with 'Skyddad identitet' in their place and
 * a count, and only then does the browser's print open. The screen is drawn
 * as it was when the print is done.
 */
export function SchoolDayBody() {
  const { t, dayLong, day, protectedName } = useSchoolDayText();
  const locale = useLocale();
  const [date, setDate] = useState(() => toDateString(new Date()));
  const [mode, setMode] = useState<Mode>("day");
  const [chosen, setChosen] = useState<RowKind | null>(null);
  const [filter, setFilter] = useState("");
  // The teachers a printed copy leaves out; null while the screen is drawn as itself.
  const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
  const printer = useRef<typeof import("./print-actions") | null>(null);

  const range = mode === "day" ? { from: date, to: date } : weekRange(date);
  const query = useSchoolDay(range.from, range.to);
  const view = query.data;
  const moving = query.isPlaceholderData;

  const kinds = view ? rowKindsOf(view.access) : [];
  const kind: RowKind = chosen && kinds.includes(chosen) ? chosen : kinds.includes("GROUP") ? "GROUP" : "ROOM";
  const rows = useMemo(() => (view ? buildRows(view, kind, held ?? undefined) : []), [view, kind, held]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase(locale);
    return needle === "" ? rows : rows.filter((row) => (row.name ?? protectedName()).toLocaleLowerCase(locale).includes(needle));
  }, [rows, filter, locale, protectedName]);
  const axis = useMemo(() => (view ? axisOf(view) : { start: 7 * 60, end: 16 * 60 }), [view]);

  // Printing: the sheet is on the page with the marked left out, then the browser's dialog.
  useEffect(() => {
    if (held === null || printer.current === null) return;
    const done = () => setHeld(null);
    window.addEventListener("afterprint", done, { once: true });
    printer.current.printGrid();
    return () => window.removeEventListener("afterprint", done);
  }, [held]);

  const print = async () => {
    if (!view) return;
    try {
      printer.current = await import("./print-actions");
      setHeld(await printer.current.protectedAmongTeachers(view));
    } catch {
      toast.error(t("print.failed"));
    }
  };

  const label =
    mode === "day"
      ? dayLong(date)
      : t("week.label", { week: isoWeek(new Date(`${range.from}T12:00:00`)), from: day(range.from), to: day(range.to) });
  const step = (direction: 1 | -1) => setDate(mode === "day" ? stepDay(date, direction) : shiftDay(date, 7 * direction));

  return (
    <>
      <Toolbar className="print:hidden">
        <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <TabsList aria-label={t("mode.label")}>
            <TabsTrigger value="day">{t("mode.day")}</TabsTrigger>
            <TabsTrigger value="week">{t("mode.week")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {kinds.length > 1 ? (
          <Tabs value={kind} onValueChange={(value) => setChosen(value as RowKind)}>
            <TabsList aria-label={t("rows.label")}>
              {kinds.map((one) => (
                <TabsTrigger key={one} value={one}>
                  {t(`rows.${one}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label={t(mode === "day" ? "nav.previousDay" : "nav.previousWeek")} disabled={moving} onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          {/*
            Live, so a screen reader hears which day or week the arrows landed on. Today is the reader's clock,
            which the server that drew the page first does not share (a time zone, a minute past midnight), so
            the text it drew may differ from the first client render: said, not an error.
          */}
          <span className="min-w-48 text-center text-sm font-medium" aria-live="polite" suppressHydrationWarning>
            {label}
          </span>
          <Button variant="outline" size="icon" aria-label={t(mode === "day" ? "nav.nextDay" : "nav.nextWeek")} disabled={moving} onClick={() => step(1)}>
            <ChevronRight />
          </Button>
          <Button variant="ghost" size="sm" disabled={date === toDateString(new Date())} onClick={() => setDate(toDateString(new Date()))}>
            {t("nav.today")}
          </Button>
        </div>
        <Field id="school-day-date" label={t("nav.date")}>
          <DateField id="school-day-date" value={date} onChange={setDate} className="w-40" />
        </Field>
        <Field id="school-day-filter" label={t("filter.label")} className="relative">
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input id="school-day-filter" className="w-44 pl-8" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t(`filter.placeholder.${kind}`)} />
        </Field>
        {view?.access.admin ? (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => void print()} disabled={held !== null}>
            <Printer aria-hidden="true" />
            {t("print.button")}
          </Button>
        ) : null}
      </Toolbar>

      {/* The sheet's own heading: the toolbar above is the screen's. */}
      <p className="hidden text-sm font-medium print:block" suppressHydrationWarning>
        {label} · {t(`rows.${kind}`)}
      </p>
      {held !== null && held.size > 0 ? <p className="text-sm">{t("print.held", { count: held.size })}</p> : null}

      {view ? <FreeFinder /> : null}

      {query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isNotOpen(query.error) ? (
        // The school closed the page for teachers since this one was drawn.
        <NotOpen />
      ) : query.isError || !view ? (
        <LoadError
          title={t("loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={2}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <div className={moving ? "opacity-60 transition-opacity" : undefined} aria-busy={moving}>
          {view.heldOut.teachers > 0 ? (
            <p className="mb-2 text-sm text-muted-foreground">{t("heldOut", { count: view.heldOut.teachers })}</p>
          ) : null}
          {mode === "day" ? <DayView rows={shown} view={view} kind={kind} axis={axis} /> : (
            <WeekGrid rows={shown} days={weekColumns(view)} axis={axis} kind={kind} onOpenDay={(opened) => { setDate(opened); setMode("day"); }} />
          )}
          <Legend />
        </div>
      )}
    </>
  );
}

function DayView({ rows, view, kind, axis }: { rows: Row[]; view: SchoolDayView; kind: RowKind; axis: Axis }) {
  const { t, breakText } = useSchoolDayText();
  const gridDay = view.days[0]!;
  const closure = schoolClosure(gridDay);
  return (
    <div className="space-y-3">
      {closure ? (
        <Notice tone="warning" title={t("closedTitle")}>
          {breakText(closure)}
        </Notice>
      ) : gridDay.breaks.length > 0 ? (
        <Notice>{gridDay.breaks.map(breakText).join(" · ")}</Notice>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon={Search} headingLevel={2} title={t("noRows.title")} description={t("noRows.body")} />
      ) : (
        <DayGrid rows={rows} day={gridDay} axis={axis} kind={kind} />
      )}
    </div>
  );
}

/** What the colours and the line mean, in words beside them. */
function Legend() {
  const { t } = useSchoolDayText();
  const entries = [
    ["border-l-4 border-primary bg-primary/10", t("legend.lesson")],
    ["border border-dashed border-muted-foreground bg-background line-through", t("legend.cancelled")],
    ["border-l-4 border-warning bg-warning/20", t("legend.activity")],
    ["border-l-4 border-foreground/50 bg-muted", t("legend.booking")],
    ["border-l-4 border-destructive bg-destructive/10", t("legend.closed")],
  ] as const;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground print:hidden" aria-label={t("legend.label")}>
      {entries.map(([tone, text]) => (
        <li key={text} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-3 w-5 rounded-sm ${tone}`} />
          {text}
        </li>
      ))}
    </ul>
  );
}
