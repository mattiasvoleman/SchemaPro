"use client";

import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  ariaSortOf,
  openOf,
  sortTeachers,
  type ReportingSort,
  type ReportingSortKey,
  type ReportingTeacherRow,
} from "@/lib/reporting-rate";
import { RateBar } from "@/components/reporting-rate/rate-bar";
import { useReportingRateText } from "@/components/reporting-rate/use-reporting-rate-text";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

const COLUMNS: ReadonlyArray<{ key: ReportingSortKey; numeric: boolean }> = [
  { key: "teacher", numeric: false },
  { key: "held", numeric: true },
  { key: "reported", numeric: true },
  { key: "open", numeric: true },
  { key: "share", numeric: false },
];

/**
 * The teachers' reporting rate: lessons held, reported and open, and the share
 * as a bar and a percent. Every column sorts. The heading is a button, so the
 * keyboard reaches it and a screen reader hears it as one; the sorted column
 * carries aria-sort, and a polite line says what the table is now ordered by,
 * because aria-sort changing under a focused button is not read out.
 *
 * It opens on the lowest share (DEFAULT_SORT), the order a rektor wants.
 */
export function RateTable({
  teachers,
  sort,
  onSort,
  busy,
}: {
  teachers: readonly ReportingTeacherRow[];
  sort: ReportingSort;
  onSort: (key: ReportingSortKey) => void;
  busy: boolean;
}) {
  const { t, number } = useReportingRateText();
  const rows = useMemo(() => sortTeachers(teachers, sort), [teachers, sort]);

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {t("table.sortedBy", { column: t(`table.column.${sort.key}`), direction: sort.direction })}
      </p>
      <TableCard caption={t("table.caption")} busy={busy} tableClassName="min-w-[40rem]">
        <TableHeader>
          <TableRow>
            {COLUMNS.map(({ key, numeric }) => (
              <TableHead key={key} scope="col" aria-sort={ariaSortOf(sort, key)} className={numeric ? "text-right" : undefined}>
                <button
                  type="button"
                  onClick={() => onSort(key)}
                  className="inline-flex items-center gap-1 rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t(`table.column.${key}`)}
                  {sort.key !== key ? (
                    <ArrowUpDown className="size-3.5 opacity-60" aria-hidden="true" />
                  ) : sort.direction === "asc" ? (
                    <ArrowUp className="size-3.5" aria-hidden="true" />
                  ) : (
                    <ArrowDown className="size-3.5" aria-hidden="true" />
                  )}
                </button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.teacherId}>
              <TableCell className="font-medium">{`${row.lastName}, ${row.firstName}`}</TableCell>
              <TableCell className="text-right tabular-nums">{number(row.held)}</TableCell>
              <TableCell className="text-right tabular-nums">{number(row.reported)}</TableCell>
              <TableCell className="text-right tabular-nums">{number(openOf(row))}</TableCell>
              <TableCell>
                <RateBar figures={row} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TableCard>
    </>
  );
}
