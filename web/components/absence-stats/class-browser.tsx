"use client";

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { School } from "lucide-react";
import {
  availableChoices,
  periodOfChoice,
  type ClassSummaryView,
  type Period,
  type PeriodChoice,
} from "@/lib/absence-stats";
import { useClassesStats, useClassStats } from "@/lib/absence-stats-queries";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { PatternsSection } from "./patterns-section";
import { PupilList } from "./pupil-list";
import { SeriesSection } from "./series-section";
import { useAbsenceStatsText } from "./use-absence-stats-text";
import { useIsHuvudmanReader } from "./use-pupil-reader";

/**
 * The pupil's card is a further import() on the first card opened: neither the
 * administrator's tab nor the mentor's page needs it before a pupil is chosen,
 * and its sheet for paper is another one on the click of Skriv ut.
 */
const PupilCard = lazy(() => import("./pupil-card").then((module) => ({ default: module.PupilCard })));

export type ClassBrowserAudience = "admin" | "mentor";

/**
 * The classes over a period, and from a class down to its months, patterns,
 * pupils and a pupil's card: the part of Frånvarostatistik that an
 * administrator's tab and a mentor's page share. What each reader gets is the
 * database's say (an administrator every class, a mentor their own), so the
 * component is the same and an empty list is normal: a teacher who mentors
 * nobody gets one, said kindly.
 *
 * The period is the page's state, not the address, and so is the class and
 * the pupil chosen: no pupil's id is put in a URL or in the browser's
 * storage. A mentor with exactly one class has it open.
 */
export function ClassBrowser({ audience }: { audience: ClassBrowserAudience }) {
  const { t, day } = useAbsenceStatsText();
  const reader = useIsHuvudmanReader();
  const [selection, setSelection] = useState<{ choice: PeriodChoice; period: Period | null }>({ choice: "YEAR", period: null });
  const [classId, setClassId] = useState<string | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null);
  // Focus moves to the class or the card the reader chose, never on the first draw of the page.
  const [moved, setMoved] = useState(false);
  const query = useClassesStats(selection.period);
  const view = query.data;
  const moving = query.isPlaceholderData;

  const classes = view?.classes ?? [];
  const only = classes.length === 1 ? classes[0]! : null;
  const active: ClassSummaryView | null = classes.find((one) => one.classId === classId) ?? only;

  const choose = (choice: PeriodChoice) => {
    if (!view) return;
    setSelection({ choice, period: periodOfChoice(choice, view.window) });
  };

  return (
    <div className="space-y-4">
      <FilterBar>
        <FilterField id="absence-stats-period" label={t("period.label")}>
          <NativeSelect
            id="absence-stats-period"
            className="w-56"
            value={selection.choice}
            disabled={!view}
            onChange={(event) => choose(event.target.value as PeriodChoice)}
          >
            {(view ? availableChoices(view.window) : (["YEAR"] as PeriodChoice[])).map((one) => (
              <option key={one} value={one}>
                {t(`period.${one}`)}
              </option>
            ))}
          </NativeSelect>
        </FilterField>
        {/* Live, so a screen reader hears which period the choice landed on. */}
        <p className="pb-2 text-sm text-muted-foreground" aria-live="polite">
          {view ? t("period.range", { from: day(view.period.from), to: day(view.period.to) }) : null}
        </p>
      </FilterBar>

      <SectionCard
        id="absence-stats-classes"
        title={t("classes.title")}
        description={t(audience === "mentor" ? "classes.mentorDescription" : "classes.description")}
      >
        {query.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : query.isError || !view ? (
          <LoadError
            title={t("classes.loadFailed")}
            hint={t("loadFailedHint")}
            headingLevel={3}
            variant="inline"
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t("retry")}
              </Button>
            }
          />
        ) : classes.length === 0 ? (
          <EmptyState
            icon={School}
            headingLevel={3}
            title={t(`classes.empty.${audience}.title`)}
            description={t(`classes.empty.${audience}.body`)}
          />
        ) : (
          <ClassesTable
            classes={classes}
            minGroup={view.window.minGroup}
            activeId={active?.classId ?? null}
            busy={moving}
            onOpen={(id) => {
              setClassId(id);
              setStudentId(null);
              setMoved(true);
            }}
          />
        )}
      </SectionCard>

      {active && view ? (
        studentId ? (
          <Suspense
            fallback={
              <div aria-busy="true">
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <PupilCard
              studentId={studentId}
              period={selection.period}
              backName={active.className}
              onBack={() => {
                setStudentId(null);
                setMoved(true);
              }}
            />
          </Suspense>
        ) : (
          <ClassPanel
            key={active.classId}
            classId={active.classId}
            className={active.className}
            period={selection.period}
            reader={reader}
            focusHeading={moved}
            onOpenPupil={setStudentId}
          />
        )
      ) : null}
    </div>
  );
}

function ClassesTable({
  classes,
  minGroup,
  activeId,
  busy,
  onOpen,
}: {
  classes: readonly ClassSummaryView[];
  minGroup: number;
  activeId: string | null;
  busy: boolean;
  onOpen: (classId: string) => void;
}) {
  const { t, number, percent, minutes } = useAbsenceStatsText();
  return (
    <TableCard caption={t("classes.caption")} busy={busy} tableClassName="min-w-[52rem]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">{t("classes.column.class")}</TableHead>
          <TableHead scope="col">{t("series.column.pupils")}</TableHead>
          <TableHead scope="col">{t("series.column.valid")}</TableHead>
          <TableHead scope="col">{t("series.column.invalid")}</TableHead>
          <TableHead scope="col">{t("series.column.late")}</TableHead>
          <TableHead scope="col">{t("series.column.reporting")}</TableHead>
          <TableHead scope="col" className="w-28 text-right">
            <span className="sr-only">{t("classes.column.open")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {classes.map((one) => (
          <TableRow key={one.classId} data-state={one.classId === activeId ? "selected" : undefined}>
            <TableCell className="font-medium">
              {one.className}
              <span className="block text-xs font-normal text-muted-foreground">
                {one.yearName ? `${one.yearName} · ` : ""}
                {t("classes.monthsCounted", { count: one.monthsCounted })}
              </span>
            </TableCell>
            <TableCell className="tabular-nums">
              {t("series.pupilsOf", { registered: number(one.pupilsRegistered), pupils: number(one.pupils) })}
            </TableCell>
            {one.figures === null ? (
              <TableCell colSpan={3} className="text-muted-foreground">
                {t("series.noFigure", { min: minGroup })}
              </TableCell>
            ) : (
              <>
                <TableCell className="tabular-nums">
                  {t("series.figure", { minutes: minutes(one.figures.validMinutes), percent: percent(one.figures.validPct) })}
                </TableCell>
                <TableCell className="tabular-nums">
                  {t("series.figure", { minutes: minutes(one.figures.invalidMinutes), percent: percent(one.figures.invalidPct) })}
                </TableCell>
                <TableCell className="tabular-nums">{number(one.figures.lateCount)}</TableCell>
              </>
            )}
            <TableCell className="tabular-nums">
              {percent(one.reporting.ratePct)}
              <span className="block text-xs text-muted-foreground">
                {one.reporting.held === 0
                  ? t("series.noLessons")
                  : t("series.reportedOf", { reported: number(one.reporting.reported), held: number(one.reporting.held) })}
              </span>
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant={one.classId === activeId ? "secondary" : "outline"}
                size="sm"
                aria-label={t("classes.openNamed", { name: one.className })}
                aria-pressed={one.classId === activeId}
                onClick={() => onOpen(one.classId)}
              >
                {t("classes.open")}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableCard>
  );
}

/** A class and its predecessors month by month, its patterns, and its pupils. */
function ClassPanel({
  classId,
  className,
  period,
  reader,
  focusHeading,
  onOpenPupil,
}: {
  classId: string;
  className: string;
  period: Period | null;
  reader: boolean;
  focusHeading: boolean;
  onOpenPupil: (studentId: string) => void;
}) {
  const { t } = useAbsenceStatsText();
  const query = useClassStats(classId, period);
  const view = query.data;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);

  return (
    <section aria-labelledby="absence-stats-class-title" className="space-y-4">
      <h2 id="absence-stats-class-title" ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
        {t("class.title", { name: className })}
      </h2>
      {query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.isError || !view ? (
        <LoadError
          title={t("class.loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={3}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <>
          <SeriesSection
            id="absence-stats-class-series"
            title={t("class.series.title")}
            description={t("class.series.description")}
            caption={t("class.series.caption", { name: className })}
            series={view.series}
            minGroup={view.window.minGroup}
            headingLevel={3}
          />
          <PatternsSection
            id="absence-stats-class-patterns"
            title={t("class.patterns.title")}
            description={t("class.patterns.description")}
            patterns={view.patterns}
            minGroup={view.window.minGroup}
            headingLevel={3}
          />
        </>
      )}
      <PupilList classId={classId} period={period} reader={reader} onOpen={onOpenPupil} />
    </section>
  );
}
