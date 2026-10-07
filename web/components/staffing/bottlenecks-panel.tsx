"use client";

import { useTranslations } from "next-intl";
import type { TeacherLoadReport } from "@/lib/teacher-load";
import { Badge } from "@/components/ui/badge";

/**
 * "Ämnesflaskhalsar" — Untis' Fach-Engpässe, as two numbers per subject.
 *
 * Demand is the minutes the year's UNSTAFFED rows in the subject would charge
 * a lead; capacity is what the teachers holding a behörighet in it have left
 * to their targets. Short when the first is larger: no assignment of the
 * people the school has can staff those rows without someone going over.
 * Teachers without a target are counted beside the figure rather than in it
 * — "unknown" is not "plenty" — so the admin can see when the capacity is
 * understated rather than missing.
 *
 * NOT COMPUTED, rather than zero, for a school with no behörighet recorded:
 * capacity in a subject is then unknowable, and the panel says so instead of
 * painting every subject short. The order is the report's (short first, by
 * deficit), as the matrix keeps the report's order.
 */
export function BottlenecksPanel({
  report,
}: {
  report: Pick<TeacherLoadReport, "subjectBottlenecks" | "bottlenecksComputed">;
}) {
  const t = useTranslations("staffing");
  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="staffing-bottlenecks">
      <h2 id="staffing-bottlenecks" className="font-semibold">
        {t("bottlenecksTitle")}
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">{t("bottlenecksHint")}</p>
      {!report.bottlenecksComputed ? (
        <p className="text-sm text-foreground">{t("bottlenecksNotComputed")}</p>
      ) : report.subjectBottlenecks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("bottlenecksEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("bottlenecksCaption")}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t("bottleneckSubject")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  {t("bottleneckDemand")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  {t("bottleneckCapacity")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  {t("bottleneckTeachers")}
                </th>
                <th scope="col" className="py-1.5 font-medium">
                  {t("bottleneckVerdict")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.subjectBottlenecks.map((row) => (
                <tr key={row.subjectId} className="border-b last:border-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                    {row.subjectName}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t("bottleneckRows", { count: row.unstaffedCount })}
                    </span>
                  </th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{row.demandedMinutesPerWeek}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {row.qualifiedRemainingMinutesPerWeek}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {row.qualifiedNoTargetCount > 0
                      ? t("bottleneckTeachersNoTarget", {
                          count: row.qualifiedTeacherCount,
                          noTarget: row.qualifiedNoTargetCount,
                        })
                      : row.qualifiedTeacherCount}
                  </td>
                  <td className="py-1.5">
                    {row.short ? (
                      <Badge variant="destructive">
                        {t("bottleneckShort", {
                          minutes: row.demandedMinutesPerWeek - row.qualifiedRemainingMinutesPerWeek,
                        })}
                      </Badge>
                    ) : (
                      <Badge variant="success">{t("bottleneckEnough")}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
