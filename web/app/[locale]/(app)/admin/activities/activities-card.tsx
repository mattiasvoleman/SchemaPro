"use client";

/*
 * The year's aktiviteter: what each cancelled and put in its place, whether
 * it still stands, and — for one that does — Ändra and Ta bort. A removed
 * activity stays on the list as the record of what the school did, dimmed and
 * without buttons.
 *
 * DOUBLE COUNTING. An activity's replacement subject must not count toward
 * the timplan: the day's minutes are credited on named subjects instead.
 * Subjects can change after the fact (a school ticks "Räknas som
 * undervisningstid" on Temadag), and then the lesson and the credit would
 * count the same hours twice. The gateway says so per activity
 * (doubleCounts); the row says it too, beside the state, with the way out.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";
import type { ScheduleActivity } from "@/lib/schedule-activity-types";
import type { AcademicYear, Person, Room, StudentGroup, Subject } from "@/lib/types";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useReadOnly } from "@/components/profile-context";
import { useFormats } from "./activity-format";
import { EditActivityDialog } from "./edit-activity-dialog";
import { RemoveActivityDialog } from "./remove-activity-dialog";
import { useScheduleActivities } from "./use-schedule-activities";

/** How many named classes a row spells out before it says "och N till". */
const NAMED_GROUPS_SHOWN = 6;

export function ActivitiesCard({
  year,
  groups,
  rooms,
  subjects,
  people,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  rooms: readonly Room[];
  subjects: readonly Subject[];
  people: readonly Person[];
}) {
  const t = useTranslations("scheduleActivities");
  const tCommon = useTranslations("common");
  const tGrades = useTranslations("grades");
  const { periodText } = useFormats();
  const readOnly = useReadOnly();
  const activities = useScheduleActivities(year.id);
  const [changing, setChanging] = useState<ScheduleActivity | null>(null);
  const [removing, setRemoving] = useState<ScheduleActivity | null>(null);
  const today = toDateString(new Date());

  const scopeLabel = (activity: ScheduleActivity): string => {
    if (activity.scope === "SCHOOL") return t("scopes.SCHOOL");
    if (activity.scope === "GRADES") {
      const { minGradeLevel: min, maxGradeLevel: max } = activity;
      if (min === null || max === null) return t("scopes.GRADES");
      return min === max ? tGrades("grade", { grade: min }) : t("gradeRange", { min, max });
    }
    const names = activity.scopeGroupIds.map((id) => groups.find((group) => group.id === id)?.name ?? "?");
    return names.length > NAMED_GROUPS_SHOWN
      ? `${names.slice(0, NAMED_GROUPS_SHOWN).join(", ")} ${t("andMoreGroups", { count: names.length - NAMED_GROUPS_SHOWN })}`
      : names.join(", ");
  };

  return (
    <SectionCard id="activity-list" title={t("listTitle", { year: year.name })}>
      {activities.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : activities.isError ? (
        <LoadError variant="inline" title={t("listLoadFailed")} hint={t("listLoadFailedHint")} />
      ) : !activities.data || activities.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("listNone")}</p>
      ) : (
        <TableCard caption={t("listCaption", { year: year.name })}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("name")}</TableHead>
              <TableHead scope="col">{t("period")}</TableHead>
              <TableHead scope="col">{t("scope")}</TableHead>
              <TableHead scope="col">{t("lessons")}</TableHead>
              <TableHead scope="col">{t("state")}</TableHead>
              {readOnly ? null : (
                <TableHead scope="col">
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {activities.data.map((activity) => {
              const removed = activity.removedAt !== null;
              const finished = !removed && activity.toDate < today;
              return (
                <TableRow key={activity.id} className={removed ? "text-muted-foreground" : undefined}>
                  <TableCell className="font-medium">
                    {activity.name}
                    {activity.replacementSubject ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t("replacementIn", { subject: activity.replacementSubject.name })}
                      </span>
                    ) : null}
                    {activity.description ? (
                      <span className="block max-w-xs text-xs font-normal text-muted-foreground">{activity.description}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {periodText(activity.fromDate, activity.toDate)}
                    {activity.startTime && activity.endTime ? (
                      <span className="block text-xs text-muted-foreground">{`${activity.startTime}–${activity.endTime}`}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{scopeLabel(activity)}</TableCell>
                  <TableCell className="tabular-nums">
                    {t("cancelledCount", { count: activity.cancelled })}
                    <span className="block text-xs text-muted-foreground">
                      {t("replacementCount", { count: activity.replacementLessons })}
                    </span>
                    {activity.credits > 0 ? (
                      <span className="block text-xs text-muted-foreground">{t("creditsCount", { count: activity.credits })}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {removed ? (
                      <Badge variant="outline">{t("stateRemoved")}</Badge>
                    ) : finished ? (
                      <Badge variant="outline">{t("stateFinished")}</Badge>
                    ) : (
                      <Badge variant="secondary">{t("stateActive")}</Badge>
                    )}
                    {!removed && activity.notifies ? (
                      <span className="block pt-1 text-xs text-muted-foreground">{t("notified")}</span>
                    ) : null}
                    {!removed && activity.doubleCounts ? (
                      <p className="flex max-w-xs items-start gap-1.5 pt-1 text-xs">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-strong" aria-hidden="true" />
                        <span>{t("doubleCounts")}</span>
                      </p>
                    ) : null}
                  </TableCell>
                  {readOnly ? null : (
                    <TableCell className="text-right">
                      {removed ? null : (
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={tCommon("actionNamed", { action: t("change"), name: activity.name })}
                            onClick={() => setChanging(activity)}
                            data-writes="DRIFT"
                          >
                            {t("change")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={tCommon("actionNamed", { action: t("remove"), name: activity.name })}
                            onClick={() => setRemoving(activity)}
                            data-writes="DRIFT"
                          >
                            {t("remove")}
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}

      <EditActivityDialog
        activity={changing}
        year={year}
        groups={groups}
        subjects={subjects}
        people={people}
        onClose={() => setChanging(null)}
      />
      <RemoveActivityDialog activity={removing} rooms={rooms} onClose={() => setRemoving(null)} />
    </SectionCard>
  );
}
