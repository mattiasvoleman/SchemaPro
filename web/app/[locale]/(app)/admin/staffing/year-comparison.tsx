"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { compareYears, type ComparisonRow, type YearFigures } from "@/lib/staffing-compare";
import { useStaffingLoad } from "@/lib/staffing-queries";
import { formatPercent } from "@/lib/staffing-view";
import type { TeacherLoad } from "@/lib/teacher-load";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/**
 * "Jämför med förra läsåret" (staffing Fas 5): per teacher, last year's tjänst
 * % and counted minutes beside this year's — the first question after a
 * rollover is who carries more or less than last year, and who is new or gone.
 *
 * Both columns are GET /staffing/load, once per year; the predecessor's is
 * fetched only when this view is opened (React.lazy from the page). The join
 * is lib/staffing-compare.ts, a union, so a teacher who left is a row.
 *
 * A FAILED READ IS A SENTENCE, NEVER A TABLE OF ZEROS: "0 min last year"
 * would be a confident statement about a year the page could not read. The
 * predecessor's report can be refused with ROLLOVER_NOT_ACTIVATED (a year
 * chain made outside the rollover), which gets a sentence of its own.
 */
export function YearComparison({
  thisYear,
  predecessor,
  teacherName,
}: {
  thisYear: { name: string; teachers: readonly TeacherLoad[] };
  predecessor: { id: string; name: string };
  teacherName: (userId: string) => string;
}) {
  const t = useTranslations("staffing.compare");
  const last = useStaffingLoad(predecessor.id);
  const [changedOnly, setChangedOnly] = useState(false);

  const rows = useMemo(() => {
    if (!last.data) return [];
    const joined = compareYears(thisYear.teachers, last.data.teachers);
    return joined
      .map((row) => ({ row, name: teacherName(row.userId) }))
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  }, [last.data, thisYear.teachers, teacherName]);

  if (last.isLoading) return <Skeleton className="h-48 w-full" aria-busy="true" />;
  if (last.isError || !last.data) {
    const notActivated = last.error instanceof ApiError && last.error.code === "ROLLOVER_NOT_ACTIVATED";
    return (
      <Notice tone="destructive">
        {notActivated ? t("notActivated", { year: predecessor.name }) : t("failed", { year: predecessor.name })}
      </Notice>
    );
  }

  const shown = changedOnly ? rows.filter(({ row }) => row.change !== "SAME") : rows;
  const percent = (value: number | null | undefined) => (value == null ? "—" : `${formatPercent(value)} %`);
  // A post that changes during the year: each step, "100 → 50 %".
  const grad = (year: YearFigures | null) =>
    year && year.employmentSteps.length > 1
      ? `${year.employmentSteps.map(formatPercent).join(" → ")} %`
      : percent(year?.employmentPercent);
  // A nedsättning that changes during the year, under the post: what makes a
  // row CHANGED when the grad and the first day are the same as last year.
  const reductionSteps = (year: YearFigures | null) =>
    year && year.reductionSteps.length > 1 ? (
      <span className="block text-xs text-muted-foreground">
        {t("reductionSteps", { steps: year.reductionSteps.map(formatPercent).join(" → ") })}
      </span>
    ) : null;
  const minutes = (value: number | null | undefined) => (value == null ? "—" : String(value));
  const delta = (value: number | null, unit: string) =>
    value === null || value === 0 ? "" : `${value > 0 ? "+" : "−"}${formatPercent(Math.abs(value))}${unit}`;
  const change = (row: ComparisonRow) => (row.change === "NEW" || row.change === "LEFT" ? t(`change${row.change}`) : "");

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} />
        {t("changedOnly")}
      </label>
      <TableCard caption={t("caption", { last: predecessor.name, current: thisYear.name })}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("teacher")}</TableHead>
            <TableHead scope="col" className="text-right">
              {t("post", { year: predecessor.name })}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t("post", { year: thisYear.name })}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t("counted", { year: predecessor.name })}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t("counted", { year: thisYear.name })}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t("difference")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                {t("noChanges")}
              </TableCell>
            </TableRow>
          ) : (
            shown.map(({ row, name }) => (
              <TableRow key={row.userId} data-teacher={row.userId}>
                <th scope="row" className="px-3 py-2.5 text-left align-middle font-medium">
                  {name}
                  {change(row) ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{change(row)}</span>
                  ) : null}
                </th>
                <TableCell className="text-right tabular-nums">
                  {grad(row.lastYear)}
                  {reductionSteps(row.lastYear)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {grad(row.thisYear)}
                  {reductionSteps(row.thisYear)}
                  {row.employmentDelta ? (
                    <span className="ml-1 text-xs text-muted-foreground">({delta(row.employmentDelta, " %")})</span>
                  ) : null}
                  {row.reductionChanged ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("reductionChange", {
                        from: formatPercent(row.lastYear!.reductionPercent),
                        to: formatPercent(row.thisYear!.reductionPercent),
                      })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {minutes(row.lastYear?.countedMinutesPerWeek)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {minutes(row.thisYear?.countedMinutesPerWeek)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{delta(row.countedDelta, "")}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </TableCard>
      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
