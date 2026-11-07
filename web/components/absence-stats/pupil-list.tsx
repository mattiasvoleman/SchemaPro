"use client";

import { useMemo } from "react";
import { Users } from "lucide-react";
import type { Period } from "@/lib/absence-stats";
import { useClassPupils } from "@/lib/absence-stats-queries";
import { compareSwedish } from "@/lib/sorting";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { EmptyState } from "@/components/ui/empty-state";
import { isReaderRefusal } from "./use-pupil-reader";
import { useAbsenceStatsText } from "./use-absence-stats-text";

/** What stands where the pupils would: the huvudman's läsare sees sums and never a pupil. */
export function ReaderNotice() {
  const { t } = useAbsenceStatsText();
  return (
    <Notice title={t("reader.title")} role="status">
      {t("reader.body")}
    </Notice>
  );
}

/**
 * The pupils of a class with their sums over the period, for a development
 * talk, each with a way to the pupil's card.
 *
 * Reading the list is recorded in the läslogg (the gateway does it), and the
 * page says so. A pupil the school has marked as having a protected identity
 * is not in the list: an administrator is told how many were left out
 * (`heldOut`), a mentor is told nothing, since a count would point at the
 * pupil. A pupil with no registered minute in the period is "ingen
 * registrering", not 0 %. The huvudman's läsare is not offered the list at
 * all, and a refusal that arrives anyway is read as the same explanation.
 *
 * Nothing read here outlives the list (lib/absence-stats-queries.ts).
 */
export function PupilList({
  classId,
  period,
  reader,
  onOpen,
}: {
  classId: string;
  period: Period | null;
  reader: boolean;
  onOpen: (studentId: string) => void;
}) {
  const { t, number, percent, minutes } = useAbsenceStatsText();
  const query = useClassPupils(classId, period, !reader);
  const view = query.data;
  const pupils = useMemo(
    () => [...(view?.pupils ?? [])].sort((a, b) => compareSwedish(`${a.lastName} ${a.firstName}`, `${b.lastName} ${b.firstName}`)),
    [view],
  );

  return (
    <SectionCard id="absence-stats-pupils" title={t("pupils.title")} description={t("pupils.description")} headingLevel={3}>
      {reader || isReaderRefusal(query.error) ? (
        <ReaderNotice />
      ) : query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.isError || !view ? (
        <LoadError
          title={t("pupils.loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={3}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <>
          {view.heldOut !== null && view.heldOut > 0 ? (
            <p className="text-sm text-muted-foreground">{t("pupils.heldOut", { count: view.heldOut })}</p>
          ) : null}
          {pupils.length === 0 ? (
            <EmptyState icon={Users} headingLevel={3} title={t("pupils.empty.title")} description={t("pupils.empty.body")} />
          ) : (
            <TableCard caption={t("pupils.caption")} tableClassName="min-w-[44rem]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">{t("pupils.column.pupil")}</TableHead>
                  <TableHead scope="col">{t("series.column.valid")}</TableHead>
                  <TableHead scope="col">{t("series.column.invalid")}</TableHead>
                  <TableHead scope="col">{t("series.column.late")}</TableHead>
                  <TableHead scope="col" className="w-32 text-right">
                    <span className="sr-only">{t("pupils.column.card")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pupils.map((pupil) => {
                  const name = `${pupil.lastName}, ${pupil.firstName}`;
                  return (
                    <TableRow key={pupil.studentId}>
                      <TableCell className="font-medium">{name}</TableCell>
                      {pupil.figures.recordedMinutes === 0 ? (
                        <TableCell colSpan={3} className="text-muted-foreground">
                          {t("pupils.noRegistration")}
                        </TableCell>
                      ) : (
                        <>
                          <TableCell className="tabular-nums">
                            {t("series.figure", { minutes: minutes(pupil.figures.validMinutes), percent: percent(pupil.figures.validPct) })}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {t("series.figure", { minutes: minutes(pupil.figures.invalidMinutes), percent: percent(pupil.figures.invalidPct) })}
                          </TableCell>
                          <TableCell className="tabular-nums">{number(pupil.figures.lateCount)}</TableCell>
                        </>
                      )}
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t("pupils.openNamed", { name })}
                          onClick={() => onOpen(pupil.studentId)}
                        >
                          {t("pupils.open")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableCard>
          )}
        </>
      )}
    </SectionCard>
  );
}
