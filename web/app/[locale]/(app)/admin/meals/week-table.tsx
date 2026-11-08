"use client";

import type { MealDay } from "@/lib/meal-counts";
import { useMealsText } from "@/components/meals/use-meals-text";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/**
 * The days ahead, one row each: the sittings of the day with their portions, the day's pupils, the
 * absence taken off, the staff and the portions, and what has been reported since the cut-off. A day
 * with no sitting (a weekend, a lov, a day the schedule is not published for) says so and has no figures.
 * A row opens the day.
 */
export function WeekTable({
  days,
  staffModelled,
  hasCutoff,
  onOpen,
}: {
  days: readonly MealDay[];
  staffModelled: boolean;
  hasCutoff: boolean;
  onOpen: (date: string) => void;
}) {
  const { t, short, long, number } = useMealsText();

  return (
    <TableCard caption={t("table.captionWeek")} tableClassName="min-w-[44rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("table.column.date")}</TableHead>
          <TableHead scope="col">{t("table.column.sittings")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.pupils")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.absent")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.staff")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.portions")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.after")}</TableHead>
          <TableHead scope="col" className="print:hidden">
            <span className="sr-only">{t("table.open")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {days.map((day) =>
          day.sittings.length === 0 ? (
            <TableRow key={day.date} className="text-muted-foreground">
              <TableCell className="whitespace-nowrap font-medium">{short(day.date)}</TableCell>
              <TableCell colSpan={6}>{t("table.none")}</TableCell>
              <TableCell className="print:hidden" />
            </TableRow>
          ) : (
            <TableRow key={day.date}>
              <TableCell className="whitespace-nowrap font-medium">{short(day.date)}</TableCell>
              <TableCell>
                <ul className="space-y-0.5">
                  {day.sittings.map((sitting) => (
                    <li key={`${sitting.start}-${sitting.end}`} className="whitespace-nowrap tabular-nums">
                      {`${sitting.start}–${sitting.end}`} <span className="text-muted-foreground">· {number(sitting.portions)}</span>
                    </li>
                  ))}
                </ul>
              </TableCell>
              <TableCell className="text-right tabular-nums">{number(day.totals.pupils)}</TableCell>
              <TableCell className="text-right tabular-nums">{hasCutoff ? `−${number(day.totals.absentBefore)}` : t("table.notIncluded")}</TableCell>
              <TableCell className="text-right tabular-nums">{staffModelled ? `+${number(day.totals.staff)}` : t("table.notIncluded")}</TableCell>
              <TableCell className="text-right text-base font-semibold tabular-nums">{number(day.totals.portions)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{hasCutoff ? number(day.totals.absentAfter) : t("table.notIncluded")}</TableCell>
              <TableCell className="text-right print:hidden">
                <Button variant="ghost" size="sm" aria-label={t("table.openFor", { date: long(day.date) })} onClick={() => onOpen(day.date)}>
                  {t("table.open")}
                </Button>
              </TableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </TableCard>
  );
}
