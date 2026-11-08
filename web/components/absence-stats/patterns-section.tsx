"use client";

import type { PatternCell, PatternsView } from "@/lib/absence-stats";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { useAbsenceStatsText } from "./use-absence-stats-text";

type Dimension = "weekdays" | "slots" | "subjects";
const DIMENSIONS: readonly Dimension[] = ["weekdays", "slots", "subjects"];

/**
 * When absence falls: by weekday, by pass (the lesson's start time) and by
 * subject, over the period, as a share of the recorded minutes of each.
 *
 * A class with fewer than five pupils with a mark in the period has no
 * pattern: a pattern over so few would point at a pupil. The page says that
 * instead, and draws no table. The bar beside a share is the eye's help and
 * hidden from assistive tech; the percent is the reading, and a share of
 * nothing recorded is a dash, never 0 %.
 */
export function PatternsSection({
  id,
  title,
  description,
  patterns,
  minGroup,
  headingLevel = 2,
  pupil = false,
}: {
  id: string;
  title: string;
  description?: string;
  patterns: PatternsView;
  minGroup: number;
  headingLevel?: 2 | 3;
  /** A pupil's own patterns: no group behind them to count. */
  pupil?: boolean;
}) {
  const { t, percent, minutes, weekday } = useAbsenceStatsText();
  const empty = DIMENSIONS.every((one) => patterns[one].length === 0);

  const labelOf = (dimension: Dimension, cell: PatternCell): string => (dimension === "weekdays" ? weekday(cell.key) : cell.label);

  return (
    <SectionCard id={id} title={title} description={description} headingLevel={headingLevel}>
      {patterns.suppressed ? (
        <Notice title={t("patterns.suppressedTitle")}>{t("patterns.suppressedBody", { min: minGroup })}</Notice>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">{t("patterns.empty")}</p>
      ) : (
        <>
          {pupil ? null : (
            <p className="text-sm text-muted-foreground">{t("patterns.groupSize", { count: patterns.groupSize })}</p>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            {DIMENSIONS.map((dimension) => {
              const cells = patterns[dimension];
              if (cells.length === 0) return null;
              const tallest = Math.max(10, ...cells.map((cell) => cell.figures.totalPct ?? 0));
              return (
                <TableCard key={dimension} caption={t(`patterns.caption.${dimension}`)} tableClassName="min-w-[20rem]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col">{t(`patterns.column.${dimension}`)}</TableHead>
                      <TableHead scope="col" className="text-right">
                        {t("patterns.column.valid")}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t("patterns.column.invalid")}
                      </TableHead>
                      <TableHead scope="col">{t("patterns.column.total")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cells.map((cell) => (
                      <TableRow key={cell.key}>
                        <TableCell className="font-medium">
                          {labelOf(dimension, cell)}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("patterns.recorded", { minutes: minutes(cell.figures.recordedMinutes) })}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{percent(cell.figures.validPct)}</TableCell>
                        <TableCell className="text-right tabular-nums">{percent(cell.figures.invalidPct)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div aria-hidden="true" className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${((cell.figures.totalPct ?? 0) / tallest) * 100}%` }}
                              />
                            </div>
                            <span className="whitespace-nowrap tabular-nums">{percent(cell.figures.totalPct)}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </TableCard>
              );
            })}
          </div>
        </>
      )}
    </SectionCard>
  );
}
