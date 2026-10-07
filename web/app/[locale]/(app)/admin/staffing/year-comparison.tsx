"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { compareYears, type ComparisonRow } from "@/lib/staffing-compare";
import { useStaffingLoad } from "@/lib/staffing-queries";
import { formatPercent } from "@/lib/staffing-view";
import type { TeacherLoad } from "@/lib/teacher-load";
import { Skeleton } from "@/components/ui/skeleton";

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

  if (last.isLoading) return <Skeleton className="h-48 w-full" />;
  if (last.isError || !last.data) {
    const notActivated = last.error instanceof ApiError && last.error.code === "ROLLOVER_NOT_ACTIVATED";
    return (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {notActivated ? t("notActivated", { year: predecessor.name }) : t("failed", { year: predecessor.name })}
      </p>
    );
  }

  const shown = changedOnly ? rows.filter(({ row }) => row.change !== "SAME") : rows;
  const percent = (value: number | null | undefined) => (value == null ? "—" : `${formatPercent(value)} %`);
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
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("caption", { last: predecessor.name, current: thisYear.name })}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("teacher")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("post", { year: predecessor.name })}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("post", { year: thisYear.name })}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("counted", { year: predecessor.name })}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("counted", { year: thisYear.name })}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("difference")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-muted-foreground">
                  {t("noChanges")}
                </td>
              </tr>
            ) : (
              shown.map(({ row, name }) => (
                <tr key={row.userId} data-teacher={row.userId}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    {name}
                    {change(row) ? <span className="ml-2 text-xs text-muted-foreground">{change(row)}</span> : null}
                  </th>
                  <td className="px-3 py-1.5 text-right tabular-nums">{percent(row.lastYear?.employmentPercent)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {percent(row.thisYear?.employmentPercent)}
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
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{minutes(row.lastYear?.countedMinutesPerWeek)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{minutes(row.thisYear?.countedMinutesPerWeek)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{delta(row.countedDelta, "")}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
