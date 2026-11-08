"use client";

import { Fragment } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dayText, hoursText, shareText, weekNumber, type UtilisationBucket, type UtilisationRow } from "@/lib/local";
import { cn } from "@/lib/utils";

/** A row's key in the set of rows that are open: a room and a resource may share an id's text, never an id. */
export const rowKey = (row: Pick<UtilisationRow, "kind" | "id">) => `${row.kind}:${row.id}`;

/**
 * The report: a room or a resource to a row, with the share of its school time
 * and of its evenings and weekends that is booked over the whole period, and the
 * same for each week of it in a row that opens under it. The shares are the
 * gateway's (a share is null where there is no time to divide by, and then it is
 * a dash); this draws them. A resource of more than one is counted in unit-hours,
 * which the row says.
 *
 * Open rows print as they stand, so what is printed is what is on the screen.
 */
export function UtilisationTable({
  rows,
  open,
  onToggle,
}: {
  rows: readonly UtilisationRow[];
  open: ReadonlySet<string>;
  onToggle: (row: UtilisationRow) => void;
}) {
  const t = useTranslations("adminUtilisation");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  return (
    <TableCard caption={t("tableCaption")}>
      <TableHeader>
        <TableRow>
          <TableHead rowSpan={2} className="align-bottom">
            {tCommon("name")}
          </TableHead>
          <TableHead colSpan={2} className="border-l text-center">
            {t("schoolTime")}
          </TableHead>
          <TableHead colSpan={2} className="border-l text-center">
            {t("outsideTime")}
          </TableHead>
        </TableRow>
        <TableRow>
          <TableHead className="border-l text-right">{t("booked")}</TableHead>
          <TableHead className="text-right">{t("share")}</TableHead>
          <TableHead className="border-l text-right">{t("booked")}</TableHead>
          <TableHead className="text-right">{t("share")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const key = rowKey(row);
          const isOpen = open.has(key);
          const panel = row.weeks.map((week) => `${key}:${week.weekStart}`.replace(/[^\w-]/g, "-")).join(" ");
          return (
            <Fragment key={key}>
              <TableRow>
                <TableCell className="font-medium">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring print:cursor-default"
                    aria-expanded={isOpen}
                    aria-controls={isOpen && panel !== "" ? panel : undefined}
                    aria-label={t(isOpen ? "hideWeeksNamed" : "showWeeksNamed", { name: row.name })}
                    onClick={() => onToggle(row)}
                  >
                    <ChevronRight
                      className={cn("size-4 shrink-0 transition-transform print:hidden", isOpen && "rotate-90")}
                      aria-hidden="true"
                    />
                    <span>{row.name}</span>
                  </button>
                  <span className="ml-5 mt-0.5 flex flex-wrap items-center gap-1.5 text-xs font-normal text-muted-foreground">
                    <Badge variant="outline">{t(row.kind === "ROOM" ? "kindRoom" : "kindResource")}</Badge>
                    {row.unit === "UNIT_MINUTES" ? <span>{t("unitHours")}</span> : null}
                  </span>
                </TableCell>
                <Cells bucket={row.total} locale={locale} />
              </TableRow>
              {isOpen
                ? row.weeks.map((week) => (
                    <TableRow key={week.weekStart} id={`${key}:${week.weekStart}`.replace(/[^\w-]/g, "-")} className="bg-muted/30 hover:bg-muted/30">
                      <TableCell className="pl-10 text-muted-foreground">
                        {t("weekLabel", { week: weekNumber(week.weekStart), date: dayText(week.weekStart, locale) })}
                      </TableCell>
                      <Cells bucket={week} locale={locale} />
                    </TableRow>
                  ))
                : null}
            </Fragment>
          );
        })}
      </TableBody>
    </TableCard>
  );
}

/** The four figures of a bucket: booked hours of the school time, its share, then the same outside it. */
function Cells({ bucket, locale }: { bucket: UtilisationBucket; locale: string }) {
  const t = useTranslations("adminUtilisation");
  return (
    <>
      <TableCell className="border-l text-right tabular-nums">
        {t("hoursOf", { booked: hoursText(bucket.bookedSchoolMinutes, locale), total: hoursText(bucket.schoolMinutes, locale) })}
      </TableCell>
      <TableCell className="text-right tabular-nums">{shareText(bucket.schoolShare, locale)}</TableCell>
      <TableCell className="border-l text-right tabular-nums">
        {t("hoursOf", { booked: hoursText(bucket.bookedOutsideMinutes, locale), total: hoursText(bucket.outsideMinutes, locale) })}
      </TableCell>
      <TableCell className="text-right tabular-nums">{shareText(bucket.outsideShare, locale)}</TableCell>
    </>
  );
}
