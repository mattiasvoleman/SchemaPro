"use client";

import { Pin } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { RequirementPlacement } from "@/lib/requirement-placements";

/*
 * The mark "Förlagd" on a timplanspost that has lessons placed by hand, and
 * the sentence that says where. Drawn in the matrix cell (beside the recurrence
 * badge, the same size and weight), in the cell's dialog and wherever else the
 * post is listed.
 *
 * Small on purpose: the timplan page is within a few KB of its bundle budget,
 * so the mark is a pin and a word, and the dialog that edits the rows is
 * fetched on the first press of Förlägg (placement-dialog.tsx).
 *
 * The rows are in the title (the tooltip) and the cell's own aria-label: a cell
 * is a button, and a button's label replaces what is inside it, so the mark's
 * words reach a screen reader through the page's label for the cell and not
 * through this element.
 */

/** common.* keys of the short weekday names, Monday = 1. */
const DAY_KEYS = ["", "monday", "tuesday", "wednesday", "thursday", "friday"] as const;

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "tis 10:00–11:00, Simhallen, udda veckor": one placed lesson, for a tooltip and a cell's label. */
export function placementLine(row: RequirementPlacement, t: Translate, tCommon: Translate): string {
  return t("placements.row", {
    day: DAY_KEYS[row.dayOfWeek] ? tCommon(DAY_KEYS[row.dayOfWeek]!).toLowerCase() : String(row.dayOfWeek),
    start: row.startTime,
    end: row.endTime,
    room: row.roomName,
    weeks: row.recurrence,
  });
}

/** All of a post's rows in the order the week reads them, one after another. */
export function placementsSummary(rows: readonly RequirementPlacement[], t: Translate, tCommon: Translate): string {
  return [...rows]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime))
    .map((row) => placementLine(row, t, tCommon))
    .join("; ");
}

export function PlacedBadge({
  rows,
  className,
  withRows = false,
}: {
  rows: readonly RequirementPlacement[];
  className?: string;
  /** Says the rows beside the mark, for a place with room for them (the cell's dialog). */
  withRows?: boolean;
}) {
  const t = useTranslations("requirements");
  const tCommon = useTranslations("common");
  const summary = placementsSummary(rows, t, tCommon);
  return (
    <span
      title={summary}
      className={cn(
        "inline-flex max-w-24 items-center justify-center gap-0.5 text-[10px] font-semibold uppercase leading-tight tracking-wide",
        withRows && "max-w-none",
        className,
      )}
    >
      <Pin className="size-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("placements.badge")}</span>
      {withRows ? (
        <span className="ml-1 font-normal normal-case tracking-normal text-muted-foreground">{summary}</span>
      ) : null}
    </span>
  );
}
