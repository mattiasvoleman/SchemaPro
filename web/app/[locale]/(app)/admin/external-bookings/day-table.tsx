"use client";

import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dayState, dayText, type DayState, type ExternalConflict } from "@/lib/local";

const STATE_VARIANT: Record<DayState, "destructive" | "warning" | "success"> = {
  BLOCK: "destructive",
  WARN: "warning",
  FREE: "success",
};

/** One day of a series and what it meets: a day of a preview, a day left out, a day that stands. */
export interface DayRow {
  /** A key that is unique in the table. */
  key: string;
  /** The ISO day. */
  date: string;
  conflicts: ExternalConflict[];
  /** The last cell, for a day that can be acted on. */
  action?: React.ReactNode;
  /** The day is cancelled: its state is that, not what it would meet. */
  cancelled?: boolean;
}

/**
 * The days of a series, each with its state and the reasons: what the preview
 * shows before a registration, what a refusal names, what a registration left
 * out, and what a series holds. BLOCK is red, WARN yellow and free green, and
 * each says its word, so the colour is never the only sign. The labels are what
 * the expedition reads ("Matematik 7A"): a lesson, a booking, a ramtid, never a
 * person.
 */
export function DayTable({
  days,
  caption,
  withAction = false,
  held = false,
}: {
  days: DayRow[];
  caption: string;
  withAction?: boolean;
  /** The days are booked already (a series that stands): a day with nothing in its way is Bokad, not Ledig. */
  held?: boolean;
}) {
  const t = useTranslations("local");
  const tPage = useTranslations("adminExternalBookings");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  return (
    <TableCard caption={caption}>
      <TableHeader>
        <TableRow>
          <TableHead>{tCommon("date")}</TableHead>
          <TableHead>{tCommon("status")}</TableHead>
          <TableHead>{tPage("reasonColumn")}</TableHead>
          {withAction ? <TableHead className="w-28 text-right">{tCommon("actions")}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {days.map((day) => {
          const state = dayState(day.conflicts);
          return (
            <TableRow key={day.key}>
              <TableCell className="whitespace-nowrap tabular-nums">{dayText(day.date, locale)}</TableCell>
              <TableCell>
                {day.cancelled ? (
                  <Badge variant="outline">{t("dayCancelled")}</Badge>
                ) : (
                  <Badge variant={STATE_VARIANT[state]}>
                    {held && state === "FREE" ? t("dayBooked") : t(`dayState.${state}`)}
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                {day.conflicts.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="space-y-0.5">
                    {day.conflicts.map((conflict, index) => (
                      <li key={index}>
                        <span className="text-muted-foreground">{t(`conflictKind.${conflict.kind}`)}:</span> {conflict.label}
                        {conflict.severity === "WARN" ? (
                          <span className="text-muted-foreground"> ({t("warning")})</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              {withAction ? <TableCell className="text-right">{day.action}</TableCell> : null}
            </TableRow>
          );
        })}
      </TableBody>
    </TableCard>
  );
}
