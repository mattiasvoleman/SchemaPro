"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { addDays, groupByYear, isGoingOn, pointsOfPupil, type Period } from "@/lib/absence-stats";
import { usePupilStats } from "@/lib/absence-stats-queries";
import { useProfile } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { MonthChart } from "./month-chart";
import { PatternsSection } from "./patterns-section";
import { ReaderNotice } from "./pupil-list";
import { printPupilCard, pupilIsMarked } from "./pupil-print";
import { PupilSheet } from "./pupil-sheet";
import { useAbsenceStatsText } from "./use-absence-stats-text";
import { isReaderRefusal } from "./use-pupil-reader";

const COLUMNS = 6;

type PrintNote = "protected" | "failed";

/**
 * One pupil's absence over three läsår, for the development talk: the pupil's
 * months with the class's beside them and the class's reporting rate, what the
 * figures rest on, the patterns, and a button that prints one A4.
 *
 * WHAT A MONTH WITHOUT A MARK IS. The gateway counts a pupil from the marks
 * that are left, and the months before the first one were gallrade or never
 * reported: they are "ingen registrering", never 0 % and never "ingen
 * frånvaro", and the card says from which day the marks stand (`marksFrom`).
 * A pupil with no marks left at all has no figure in any month.
 *
 * PRINT. The screen is `print:hidden` altogether: the paper is the sheet
 * (pupil-sheet.tsx) that the button puts on the page, so a print that did not
 * come from the button carries no pupil and says where the button is. A pupil
 * the school has marked as having a protected identity is shown to the
 * administrator who may read them, and is never printed: the button is not
 * there for a card the gateway flags, and for an administrator the marks are
 * read again at the click (pupil-print.ts, one entry of PEOPLE_FILES) — a read
 * that fails prints nothing. The sheet and that module come with the card's own
 * chunk, which is fetched when the first card is opened and never with a page.
 *
 * Nothing about the pupil outlives the card: the read leaves the cache when it
 * closes (lib/absence-stats-queries.ts), and nothing is written to the
 * browser's storage.
 */
export function PupilCard({
  studentId,
  period,
  backName,
  onBack,
}: {
  studentId: string;
  period: Period | null;
  /** The class the card was opened from, which the way back is named after. */
  backName: string | null;
  onBack: () => void;
}) {
  const { t, number, percent, minutes, day, month } = useAbsenceStatsText();
  const { profile } = useProfile();
  const query = usePupilStats(studentId, period);
  const view = query.data;
  const heading = useRef<HTMLHeadingElement>(null);
  const [printing, setPrinting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [note, setNote] = useState<PrintNote | null>(null);

  // The card is a new page: the reader's place is its heading, which the way back leaves.
  const loaded = view?.student.id;
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);

  // The page is the sheet alone from the click until the browser says the print is done.
  useEffect(() => {
    if (!printing) return undefined;
    const root = window.document.documentElement;
    const done = () => {
      root.classList.remove("printing-sheet");
      window.removeEventListener("afterprint", done);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
      setPrinting(false);
    };
    root.classList.add("printing-sheet");
    window.addEventListener("afterprint", done);
    printPupilCard();
    // The dialog has closed when the reader can click or type on the page again: the way back for a browser that never sends afterprint.
    window.addEventListener("pointerdown", done);
    window.addEventListener("keydown", done);
    return () => {
      root.classList.remove("printing-sheet");
      window.removeEventListener("afterprint", done);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
    };
  }, [printing]);

  const classByMonth = useMemo(() => new Map((view?.classSeries ?? []).map((one) => [one.month, one])), [view]);
  const years = useMemo(() => groupByYear(view?.months ?? []).reverse(), [view]);
  const points = useMemo(() => (view ? pointsOfPupil(view.months, view.window.today) : []), [view]);

  const back = (
    <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
      <ArrowLeft aria-hidden="true" />
      {backName ? t("card.back", { name: backName }) : t("card.backList")}
    </Button>
  );

  if (query.isLoading) {
    return (
      <div className="print:hidden" aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isReaderRefusal(query.error)) {
    return (
      <div className="space-y-3 print:hidden">
        {back}
        <ReaderNotice />
      </div>
    );
  }
  if (query.isError || !view) {
    return (
      <div className="print:hidden">
        <LoadError
          title={t("card.loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={2}
          action={
            <>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t("retry")}
              </Button>
              {back}
            </>
          }
        />
      </div>
    );
  }

  const { student } = view;
  const name = `${student.firstName} ${student.lastName}`;
  const total = view.total;
  // A mentor may not read the marks (administrators do); for them the gateway never hands out a marked pupil.
  const readsMarks = profile.role === "SCHOOL_ADMIN";

  const print = async () => {
    if (preparing || printing) return;
    setNote(null);
    setPreparing(true);
    try {
      if (readsMarks && (await pupilIsMarked(student.id))) {
        setNote("protected");
        return;
      }
      setPrinting(true);
    } catch {
      setNote("failed");
    } finally {
      setPreparing(false);
    }
  };

  const previousLine = (value: string | null) => (
    <span className="block text-xs text-muted-foreground">
      {value === null ? t("card.previousNone") : t("series.previous", { value })}
    </span>
  );

  return (
    <>
      <div className="space-y-4 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            {back}
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
              {name}
            </h2>
            <p className="text-sm text-muted-foreground">
              {student.className ? t("card.class", { name: student.className }) : t("card.noClass")}
              {" · "}
              {t("card.period", { from: day(view.period.from), to: day(view.period.to) })}
            </p>
          </div>
          {student.isProtected ? null : (
            <Button type="button" variant="outline" onClick={() => void print()}>
              <Printer aria-hidden="true" />
              {t("card.print")}
            </Button>
          )}
        </div>

        {student.isProtected ? <Notice title={t("card.protectedTitle")}>{t("card.protectedBody")}</Notice> : null}
        {note === "protected" ? <Notice title={t("card.printProtected")}>{t("card.printProtectedBody")}</Notice> : null}
        {note === "failed" ? (
          <Notice tone="destructive" title={t("card.printFailed")}>
            {t("card.printFailedHint")}
          </Notice>
        ) : null}

        <Notice title={t("card.basisTitle")}>
          {view.marksFrom === null
            ? t("card.noMarks")
            : t("card.marksFrom", { from: day(view.marksFrom), to: day(view.marksTo ?? view.marksFrom) })}{" "}
          {t("card.readNote")}
        </Notice>

        <KpiStrip columns={4}>
          <KpiTile
            label={t("series.column.valid")}
            value={total ? percent(total.validPct) : null}
            fallback={t("card.noRegistration")}
            detail={total ? minutes(total.validMinutes) : undefined}
          />
          <KpiTile
            label={t("series.column.invalid")}
            value={total ? percent(total.invalidPct) : null}
            fallback={t("card.noRegistration")}
            detail={total ? minutes(total.invalidMinutes) : undefined}
          />
          <KpiTile
            label={t("series.column.late")}
            value={total ? number(total.lateCount) : null}
            fallback={t("card.noRegistration")}
          />
          <KpiTile
            label={t("card.recorded")}
            value={total ? minutes(total.recordedMinutes) : null}
            fallback={t("card.noRegistration")}
          />
        </KpiStrip>

        <SectionCard
          id="absence-stats-pupil-months"
          title={t("card.months.title")}
          description={t("card.months.description")}
          headingLevel={3}
        >
          <MonthChart points={points} />
          <TableCard caption={t("card.months.caption", { name })} tableClassName="min-w-[56rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{t("series.column.month")}</TableHead>
                <TableHead scope="col">{t("series.column.valid")}</TableHead>
                <TableHead scope="col">{t("series.column.invalid")}</TableHead>
                <TableHead scope="col">{t("series.column.late")}</TableHead>
                <TableHead scope="col">{t("card.column.class")}</TableHead>
                <TableHead scope="col">{t("card.column.classReporting")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {years.map((year) => [
                <TableRow key={`year-${year.start}`} className="bg-muted/40 hover:bg-muted/40">
                  <TableCell
                    colSpan={COLUMNS}
                    className="py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {t("series.year", { name: year.name })}
                  </TableCell>
                </TableRow>,
                ...[...year.rows].reverse().map((row) => {
                  const classMonth = classByMonth.get(row.month);
                  const previous = row.previousYear;
                  return (
                    <TableRow key={row.month}>
                      <TableCell className="font-medium">
                        {month(row.month)}
                        {isGoingOn(row.month, view.window.today) ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("series.going", { date: day(addDays(view.window.today, -1)) })}
                          </span>
                        ) : null}
                        {row.figures ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("card.lessons", { count: row.lessons })}
                          </span>
                        ) : null}
                      </TableCell>
                      {row.figures === null ? (
                        <TableCell colSpan={3} className="text-muted-foreground">
                          {t("card.noRegistration")}
                        </TableCell>
                      ) : (
                        <>
                          <TableCell className="tabular-nums">
                            {t("series.figure", { minutes: minutes(row.figures.validMinutes), percent: percent(row.figures.validPct) })}
                            {previous ? previousLine(previous.figures ? percent(previous.figures.validPct) : null) : null}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {t("series.figure", { minutes: minutes(row.figures.invalidMinutes), percent: percent(row.figures.invalidPct) })}
                            {previous ? previousLine(previous.figures ? percent(previous.figures.invalidPct) : null) : null}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {number(row.figures.lateCount)}
                            {previous ? previousLine(previous.figures ? number(previous.figures.lateCount) : null) : null}
                          </TableCell>
                        </>
                      )}
                      <TableCell className="tabular-nums">
                        {!classMonth ? (
                          "—"
                        ) : classMonth.figures === null ? (
                          <span className="text-muted-foreground">{t("card.classNoFigure")}</span>
                        ) : (
                          t("card.classFigures", {
                            valid: percent(classMonth.figures.validPct),
                            invalid: percent(classMonth.figures.invalidPct),
                          })
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {!classMonth ? (
                          "—"
                        ) : (
                          <>
                            {percent(classMonth.reporting.ratePct)}
                            <span className="block text-xs text-muted-foreground">
                              {classMonth.reporting.held === 0
                                ? t("series.noLessons")
                                : t("series.reportedOf", {
                                    reported: number(classMonth.reporting.reported),
                                    held: number(classMonth.reporting.held),
                                  })}
                            </span>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                }),
              ])}
            </TableBody>
          </TableCard>
          {view.classSeries === null ? <p className="text-sm text-muted-foreground">{t("card.noClassSeries")}</p> : null}
        </SectionCard>

        <PatternsSection
          id="absence-stats-pupil-patterns"
          title={t("card.patterns.title")}
          description={t("card.patterns.description")}
          patterns={view.patterns}
          minGroup={view.window.minGroup}
          headingLevel={3}
          pupil
        />
      </div>

      {/* A print that did not come from the button has no paper: it says where the button is. */}
      <p className="hidden print:block">{t("card.printUseButton")}</p>
      {printing ? <PupilSheet view={view} /> : null}
    </>
  );
}
