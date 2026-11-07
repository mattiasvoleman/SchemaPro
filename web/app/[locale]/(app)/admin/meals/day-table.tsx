"use client";

import type { MealDay } from "@/lib/meal-counts";
import { useMealsText } from "@/components/meals/use-meals-text";
import { Badge } from "@/components/ui/badge";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/**
 * One day's sittings: the classes that eat in each with what they add, and the sitting's pupils, the
 * absence taken off, the staff and the portions. Absence reported after the cut-off is a column of its own
 * and is never taken off. A class with a replacement lesson over the sitting says so and is counted.
 */
export function DayTable({ day, staffModelled, hasCutoff }: { day: MealDay; staffModelled: boolean; hasCutoff: boolean }) {
  const { t, long, number } = useMealsText();
  const after = (value: number) => (hasCutoff ? number(value) : t("table.notIncluded"));

  return (
    <TableCard caption={t("table.captionDay", { date: long(day.date) })} tableClassName="min-w-[44rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("table.column.sitting")}</TableHead>
          <TableHead scope="col">{t("table.column.classes")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.pupils")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.absent")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.staff")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.portions")}</TableHead>
          <TableHead scope="col" className="text-right">{t("table.column.after")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {day.sittings.map((sitting) => (
          <TableRow key={`${sitting.start}-${sitting.end}`}>
            <TableCell className="whitespace-nowrap font-medium tabular-nums">{`${sitting.start}–${sitting.end}`}</TableCell>
            <TableCell>
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {sitting.classes.map((one) => (
                  <li key={one.groupId} className="inline-flex items-center gap-1.5">
                    <span>{one.name}</span>{" "}
                    <span className="tabular-nums text-muted-foreground">{number(one.portions)}</span>
                    {one.underActivity ? (
                      <>
                        {" "}
                        <Badge variant="warning" title={t("table.activityTitle")}>
                          {t("table.activity")}
                        </Badge>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </TableCell>
            <TableCell className="text-right tabular-nums">{number(sitting.pupils)}</TableCell>
            <TableCell className="text-right tabular-nums">{hasCutoff ? `−${number(sitting.absentBefore)}` : t("table.notIncluded")}</TableCell>
            <TableCell className="text-right tabular-nums">{staffModelled ? `+${number(sitting.staff)}` : t("table.notIncluded")}</TableCell>
            <TableCell className="text-right text-base font-semibold tabular-nums">{number(sitting.portions)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{after(sitting.absentAfter)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      {day.sittings.length > 1 ? (
        <tfoot className="border-t bg-muted/50">
          <TableRow>
            <TableCell colSpan={2} className="font-medium">{t("table.total")}</TableCell>
            <TableCell className="text-right tabular-nums">{number(day.totals.pupils)}</TableCell>
            <TableCell className="text-right tabular-nums">{hasCutoff ? `−${number(day.totals.absentBefore)}` : t("table.notIncluded")}</TableCell>
            <TableCell className="text-right tabular-nums">{staffModelled ? `+${number(day.totals.staff)}` : t("table.notIncluded")}</TableCell>
            <TableCell className="text-right text-base font-semibold tabular-nums">{number(day.totals.portions)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{after(day.totals.absentAfter)}</TableCell>
          </TableRow>
        </tfoot>
      ) : null}
    </TableCard>
  );
}
