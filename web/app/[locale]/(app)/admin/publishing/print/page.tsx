"use client";

// Skriv ut scheman (Utskrift och inbäddning, 20261102090000): every class's,
// every teacher's or every room's PUBLISHED week, one landscape A4 each, for
// the doors, the staff room and the noticeboard. Reached from Publicering.
//
// WHAT A SHEET SHOWS is Schemavisaren's — the gateway builds each sheet with
// the viewer's own whitelist (GET /print/timetables, app.print_timetables):
// times, subject, the groups (a small teaching group as "Grupp"), the room,
// the teachers as chosen here, "Inställd" without a cause, never a pupil.
// The admin chooses only how teachers are named (by default as the school
// names them in Schemavisaren, or by signature when it names nobody) and
// whether a class's lunch is drawn, and may leave sheets out.
//
// ON PAPER each sheet is its own page (break-after), headed with the school,
// the class, teacher or room, the week and the period it is valid for
// ("Giltig fr.o.m./t.o.m."). Nothing else of the page is printed: the app
// shell and these controls are print:hidden.
//
// Not recorded in the read log: a set is the published timetable layer,
// which staff read directly anyway (src/access-log/access-log.ts, NOT
// RECORDED).
//
// Bundle: admin tier (190 KB). The sheet is lib/day-lanes.ts and
// lib/public-timetable.ts's arithmetic and plain markup; nothing lazy.

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarX, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { plusDays } from "@/lib/print-sheet";
import { defaultDisplay, usePrintSet, type PrintSet } from "@/lib/print-queries";
import { usePublicationSettings } from "@/lib/publication-queries";
import type { PublicKind } from "@/lib/public-timetable";
import type { TeacherDisplay } from "@/lib/publication-types";
import { SHEET_PAGE_STYLE, WeekSheet, type Translate } from "@/components/timetable-sheet/week-sheet";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const KINDS: PublicKind[] = ["GROUP", "TEACHER", "ROOM"];

const pad = (value: number) => String(value).padStart(2, "0");
const todayOf = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export default function PrintTimetablesPage() {
  const t = useTranslations("printTimetables");
  const tViewer = useTranslations("publicViewer") as unknown as Translate;
  const tDays = useTranslations("days") as unknown as Translate;
  const locale = useLocale();
  const settings = usePublicationSettings();

  const [kind, setKind] = useState<PublicKind>("GROUP");
  const [date, setDate] = useState(todayOf);
  const [chosenDisplay, setChosenDisplay] = useState<TeacherDisplay | null>(null);
  const [chosenMeals, setChosenMeals] = useState<boolean | null>(null);
  const [left, setLeft] = useState<Set<string>>(() => new Set());

  const display = chosenDisplay ?? defaultDisplay(settings.data?.publicTeacherDisplay, kind);
  // A teacher's sheet is titled by its teacher: "nobody" is no choice for that set.
  const shownDisplay = kind === "TEACHER" && display === "NONE" ? "SIGNATURE" : display;
  const meals = chosenMeals ?? settings.data?.publicShowMeals ?? true;
  // Not before the settings are read: the defaults are theirs, and a first
  // set asked without them would name teachers the school does not.
  const set = usePrintSet(
    { kind, date, teachers: shownDisplay, meals: kind === "GROUP" ? meals : false },
    settings.data !== undefined || settings.isError,
  );
  const data = set.data && set.data.kind === kind ? set.data : null;

  const chosen = useMemo(() => (data ? data.sheets.filter((sheet) => !left.has(sheet.id)) : []), [data, left]);
  const outOfYears = set.error instanceof ApiError && set.error.code === "PRINT_WEEK_OUTSIDE_YEARS";

  const step = (weeks: number) => setDate((current) => plusDays(isDay(current) ? current : todayOf(), 7 * weeks));
  const toggle = (id: string) =>
    setLeft((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Page width="wide">
      <style>{SHEET_PAGE_STYLE}</style>
      <div className="space-y-4 print:hidden">
        <PageHeader
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            <Button variant="outline" asChild>
              <Link href="/admin/publishing">{t("back")}</Link>
            </Button>
          }
        />

        <SectionCard id="print-choices" title={t("choicesTitle")} description={t("choicesBody")}>
          <div className="space-y-4">
            <Tabs
              value={kind}
              onValueChange={(value) => {
                setKind(value as PublicKind);
                setLeft(new Set());
              }}
            >
              <TabsList aria-label={t("kindLabel")}>
                {KINDS.map((value) => (
                  <TabsTrigger key={value} value={value}>
                    {t(`kind.${value}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex flex-wrap items-end gap-4">
              <div className="flex items-end gap-2">
                <Button variant="outline" size="icon" onClick={() => step(-1)} aria-label={t("previousWeek")}>
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <FormField id="print-date" label={t("dateLabel")} hint={t("dateHint")}>
                  <Input
                    type="date"
                    value={date}
                    onChange={(event) => {
                      if (isDay(event.target.value)) setDate(event.target.value);
                    }}
                    className="w-44"
                  />
                </FormField>
                <Button variant="outline" size="icon" onClick={() => step(1)} aria-label={t("nextWeek")}>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>

              <FormField id="print-teachers" label={t("teachersLabel")} hint={kind === "TEACHER" ? t("teachersHintTeacher") : t("teachersHint")}>
                <NativeSelect
                  value={shownDisplay}
                  onChange={(event) => setChosenDisplay(event.target.value as TeacherDisplay)}
                  className="w-48"
                >
                  <option value="SIGNATURE">{t("display.SIGNATURE")}</option>
                  <option value="NAME">{t("display.NAME")}</option>
                  {kind === "TEACHER" ? null : <option value="NONE">{t("display.NONE")}</option>}
                </NativeSelect>
              </FormField>

              {kind === "GROUP" ? (
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={meals}
                    onChange={(event) => setChosenMeals(event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  {t("mealsLabel")}
                </label>
              ) : null}
            </div>

            {data && data.sheets.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("sheetsLabel")}</legend>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setLeft(new Set())}>
                    {t("all")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setLeft(new Set(data.sheets.map((sheet) => sheet.id)))}>
                    {t("none")}
                  </Button>
                </div>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4 lg:grid-cols-6">
                  {data.sheets.map((sheet) => (
                    <li key={sheet.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!left.has(sheet.id)}
                          onChange={() => toggle(sheet.id)}
                          className="size-4 accent-primary"
                        />
                        {sheet.title}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => window.print()} disabled={chosen.length === 0 || set.isFetching}>
                <Printer aria-hidden="true" />
                {t("print", { count: chosen.length })}
              </Button>
              {data ? (
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {t("chosen", { chosen: chosen.length, total: data.sheets.length })}
                </p>
              ) : null}
            </div>
          </div>
        </SectionCard>
      </div>

      {set.isLoading ? (
        <div aria-busy="true" className="print:hidden">
          <Skeleton className="h-96 w-full" />
        </div>
      ) : outOfYears ? (
        <EmptyState icon={CalendarX} title={t("outOfYearsTitle")} description={t("outOfYearsBody")} headingLevel={2} className="print:hidden" />
      ) : set.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : data && data.sheets.length === 0 ? (
        <EmptyState icon={Printer} title={t(`emptyTitle.${kind}`)} description={t(`emptyBody.${kind}`)} headingLevel={2} className="print:hidden" />
      ) : data ? (
        <Sheets set={data} left={left} locale={locale} t={tViewer} tDays={tDays} label={t("preview")} />
      ) : null}
    </Page>
  );
}

function Sheets({
  set,
  left,
  locale,
  t,
  tDays,
  label,
}: {
  set: PrintSet;
  left: ReadonlySet<string>;
  locale: string;
  t: Translate;
  tDays: Translate;
  label: string;
}) {
  return (
    <section aria-label={label} className="space-y-6 print:space-y-0">
      {/* A sheet left out is not drawn at all, rather than hidden: the last
          sheet drawn is then the last child, and no page break follows it
          onto a blank page. */}
      {set.sheets.map((sheet, index) =>
        left.has(sheet.id) ? null : (
          <article
            key={sheet.id}
            className="rounded-md border bg-background p-4 print:break-after-page print:rounded-none print:border-0 print:p-0 print:last:break-after-auto"
          >
            <WeekSheet
              document={{ kind: set.kind, title: sheet.title, school: set.school, week: set.week, days: sheet.days, validity: set.validity }}
              locale={locale}
              t={t}
              tDays={tDays}
              variant="print"
              headingLevel={2}
              idPrefix={`print-${index}`}
            />
          </article>
        ),
      )}
    </section>
  );
}
