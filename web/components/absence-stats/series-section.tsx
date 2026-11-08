"use client";

import { useMemo } from "react";
import { groupByYear, pointsOfSeries, type SeriesMonthView } from "@/lib/absence-stats";
import { SectionCard } from "@/components/ui/section-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { MonthChart } from "./month-chart";
import { useAbsenceStatsText } from "./use-absence-stats-text";

const COLUMNS = 6;

/**
 * A school's or a class's months over three läsår: the chart, and under it the
 * table that says every number the chart draws, with the reporting rate
 * beside each month and the same month a year before under each figure.
 *
 * The table is newest first (the month that is going on is the one a rektor
 * opens the page for), grouped under its läsår; the chart reads left to right
 * in time. A month that is not over is marked "hittills" with the day it
 * reaches, and a month with no figure (fewer than five pupils had a mark)
 * says so in words: it is never a 0, in the table or the chart. A figure
 * rests on the pupils who had a mark, so that count stands in the row, and
 * the reporting rate sits beside it because a month in which few registers
 * were saved says less than its figure suggests.
 */
export function SeriesSection({
  id,
  title,
  description,
  caption,
  series,
  minGroup,
  headingLevel = 2,
}: {
  id: string;
  title: string;
  description?: string;
  caption: string;
  series: readonly SeriesMonthView[];
  minGroup: number;
  headingLevel?: 2 | 3;
}) {
  const { t, number, percent, minutes, day, month } = useAbsenceStatsText();
  const points = useMemo(() => pointsOfSeries(series), [series]);
  const years = useMemo(() => groupByYear(series).reverse(), [series]);

  const previousLine = (value: string | null) => (
    <span className="block text-xs text-muted-foreground">
      {value === null ? t("series.previousNone") : t("series.previous", { value })}
    </span>
  );

  return (
    <SectionCard id={id} title={title} description={description} headingLevel={headingLevel}>
      {series.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("series.empty")}</p>
      ) : (
        <>
          <MonthChart points={points} />
          <TableCard caption={caption} tableClassName="min-w-[52rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{t("series.column.month")}</TableHead>
                <TableHead scope="col">{t("series.column.pupils")}</TableHead>
                <TableHead scope="col">{t("series.column.valid")}</TableHead>
                <TableHead scope="col">{t("series.column.invalid")}</TableHead>
                <TableHead scope="col">{t("series.column.late")}</TableHead>
                <TableHead scope="col">{t("series.column.reporting")}</TableHead>
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
                  const previous = row.previousYear;
                  return (
                    <TableRow key={row.month}>
                      <TableCell className="font-medium">
                        {month(row.month)}
                        {row.partial ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("series.going", { date: day(row.throughDay) })}
                          </span>
                        ) : null}
                        {row.classNames.length > 1 ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("series.classNames", { names: row.classNames.join(", ") })}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {t("series.pupilsOf", { registered: number(row.pupilsRegistered), pupils: number(row.pupils) })}
                      </TableCell>
                      {row.figures === null ? (
                        <TableCell colSpan={3} className="text-muted-foreground">
                          {t("series.noFigure", { min: minGroup })}
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
                        {percent(row.reporting.ratePct)}
                        <span className="block text-xs text-muted-foreground">
                          {row.reporting.held === 0
                            ? t("series.noLessons")
                            : t("series.reportedOf", { reported: number(row.reporting.reported), held: number(row.reporting.held) })}
                        </span>
                        {previous ? previousLine(previous.reporting.held === 0 ? null : percent(previous.reporting.ratePct)) : null}
                      </TableCell>
                    </TableRow>
                  );
                }),
              ])}
            </TableBody>
          </TableCard>
        </>
      )}
    </SectionCard>
  );
}
