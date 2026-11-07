"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Users } from "lucide-react";
import { useKeyFigures, isRateLimited } from "@/lib/analysis-queries";
import {
  DEFAULT_KEY_SORT,
  ariaSortOf,
  hoursOf,
  nextKeySort,
  percentOfShare,
  sortTeachers,
  type KeyFigureSort,
  type KeyFigureSortKey,
} from "@/lib/analysis";
import { usePeople } from "@/lib/queries";
import { AnalysisNotices } from "@/components/analysis/analysis-notices";
import { useAnalysisText } from "@/components/analysis/use-analysis-text";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/**
 * Nyckeltal per skola and per lärare. The school's figures are four tiles; the
 * teachers are a table that sorts on every column. Nothing here is a figure
 * of its own: the time and the load are the belastningsrapport's, the pupils the
 * rosters', and tjänstgöringsgrad is left out of the answer (and of the table)
 * for a reader without HR-läs. The huvudman's reader is handed the tiles and no
 * teacher's row, and the page says so.
 */
export function KeyFiguresPanel({ yearId }: { yearId: string }) {
  const { t, number } = useAnalysisText();
  // The comparison with the grundschema is a second report over every master lesson: made when asked for.
  const [compare, setCompare] = useState(false);
  const query = useKeyFigures(yearId, compare);
  const people = usePeople();
  const [sort, setSort] = useState<KeyFigureSort>(DEFAULT_KEY_SORT);

  const names = useMemo(
    () => new Map((people.data ?? []).map((person) => [person.id, `${person.lastName}, ${person.firstName}`])),
    [people.data],
  );
  const nameOf = (userId: string): string => names.get(userId) ?? t("unknownPerson");
  const view = query.data;
  const rows = useMemo(
    () => (view?.teachers ? sortTeachers(view.teachers, sort, (userId) => names.get(userId) ?? "") : []),
    [view, sort, names],
  );

  if (query.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError || !view) {
    return (
      <LoadError
        title={isRateLimited(query.error) ? t("rateLimited") : t("keyFigures.loadFailed")}
        hint={isRateLimited(query.error) ? t("rateLimitedHint") : t("loadFailedHint")}
        headingLevel={2}
        action={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        }
      />
    );
  }

  const school = view.school;
  const showEmployment = !view.hrHidden && !view.aggregateOnly;
  const showScheduled = compare && rows.some((row) => row.scheduledMinutesPerWeek !== null);
  const columns: ReadonlyArray<{ key: KeyFigureSortKey; numeric: boolean; show: boolean }> = [
    { key: "teacher", numeric: false, show: true },
    { key: "teaching", numeric: true, show: true },
    { key: "scheduled", numeric: true, show: showScheduled },
    { key: "load", numeric: true, show: true },
    { key: "pupils", numeric: true, show: true },
    { key: "qualified", numeric: true, show: school.qualificationsRecorded },
    { key: "employment", numeric: true, show: showEmployment },
  ];

  return (
    <div className="space-y-4">
      <AnalysisNotices notices={view.notices} />
      {view.aggregateOnly ? <Notice tone="neutral">{t("keyFigures.aggregateOnly")}</Notice> : null}

      <KpiStrip columns={4}>
        <KpiTile
          label={t("keyFigures.kpi.pupils")}
          value={number(school.pupils)}
          detail={school.pupilsPerTeacher === null ? undefined : t("keyFigures.kpi.pupilsPerTeacher", { count: number(school.pupilsPerTeacher, 1) })}
        />
        <KpiTile
          label={t("keyFigures.kpi.density")}
          value={school.teachingFtePer100Pupils === null ? null : number(school.teachingFtePer100Pupils, 2)}
          fallback={t("keyFigures.kpi.densityFallback")}
          detail={
            school.teachersPer100Pupils === null
              ? undefined
              : t("keyFigures.kpi.densityDetail", {
                  teachers: number(school.teachers),
                  head: number(school.teachersPer100Pupils, 2),
                  ...(school.teachingFte === null ? {} : { fte: number(school.teachingFte, 2) }),
                })
          }
        />
        <KpiTile
          label={t("keyFigures.kpi.qualified")}
          value={school.qualifiedShare === null ? null : t("percent", { percent: number(percentOfShare(school.qualifiedShare), 1) })}
          fallback={t("keyFigures.kpi.qualifiedFallback")}
          detail={
            school.qualifiedShare === null
              ? undefined
              : t("keyFigures.kpi.qualifiedDetail", {
                  covered: number(hoursOf(school.qualifiedMinutesPerWeek), 1),
                  all: number(hoursOf(school.qualifiedMinutesPerWeek + school.unqualifiedMinutesPerWeek), 1),
                })
          }
        />
        <KpiTile
          label={t("keyFigures.kpi.teaching")}
          value={t("keyFigures.kpi.hours", { hours: number(school.teachingHoursPerYear, 0) })}
          detail={
            school.unstaffedMinutesPerWeek > 0
              ? t("keyFigures.kpi.unstaffed", { hours: number(hoursOf(school.unstaffedMinutesPerWeek), 1) })
              : t("keyFigures.kpi.perWeek", { hours: number(hoursOf(school.teachingMinutesPerWeek), 1) })
          }
        />
      </KpiStrip>
      {school.employmentFtePer100Pupils !== undefined && school.employmentFtePer100Pupils !== null ? (
        <p className="text-sm text-muted-foreground">
          {t("keyFigures.employmentDensity", {
            fte: number(school.employmentFte ?? 0, 2),
            per100: number(school.employmentFtePer100Pupils, 2),
          })}
        </p>
      ) : null}

      {view.teachers === null ? null : (
        <SectionCard id="analysis-teachers" title={t("keyFigures.teachers.title")} description={t("keyFigures.teachers.description")}>
          {rows.length === 0 ? (
            <EmptyState icon={Users} headingLevel={3} title={t("keyFigures.teachers.emptyTitle")} description={t("keyFigures.teachers.emptyBody")} />
          ) : (
            <>
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="analysis-compare">{t("keyFigures.compare.label")}</Label>
                  <p id="analysis-compare-hint" className="text-sm text-muted-foreground">
                    {compare && query.isPlaceholderData ? t("keyFigures.compare.reading") : t("keyFigures.compare.hint")}
                  </p>
                </div>
                <Switch id="analysis-compare" checked={compare} aria-describedby="analysis-compare-hint" onCheckedChange={setCompare} />
              </div>
              <p className="sr-only" aria-live="polite">
                {t("keyFigures.teachers.sortedBy", { column: t(`keyFigures.column.${sort.key}`), direction: sort.direction })}
              </p>
              <TableCard caption={t("keyFigures.teachers.caption")} tableClassName="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    {columns
                      .filter((column) => column.show)
                      .map(({ key, numeric }) => (
                        <TableHead key={key} scope="col" aria-sort={ariaSortOf(sort, key)} className={numeric ? "text-right" : undefined}>
                          <button
                            type="button"
                            onClick={() => setSort((current) => nextKeySort(current, key))}
                            className="inline-flex items-center gap-1 rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {t(`keyFigures.column.${key}`)}
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
                    <TableRow key={row.userId}>
                      <TableCell className="font-medium">{nameOf(row.userId)}</TableCell>
                      <TableCell className="text-right tabular-nums">{number(hoursOf(row.teachingMinutesPerWeek), 1)}</TableCell>
                      {showScheduled ? (
                        <TableCell className="text-right tabular-nums">
                          {row.scheduledMinutesPerWeek === null ? "–" : number(hoursOf(row.scheduledMinutesPerWeek), 1)}
                        </TableCell>
                      ) : null}
                      <TableCell className="text-right tabular-nums">
                        {row.percentOfTarget === null ? t("keyFigures.noTarget") : t("percent", { percent: number(row.percentOfTarget, 0) })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{number(row.pupils)}</TableCell>
                      {school.qualificationsRecorded ? (
                        <TableCell className="text-right tabular-nums">
                          {row.qualifiedShare === null ? "–" : t("percent", { percent: number(percentOfShare(row.qualifiedShare), 0) })}
                        </TableCell>
                      ) : null}
                      {showEmployment ? (
                        <TableCell className="text-right tabular-nums">
                          {row.employmentPercent === null ? "–" : t("percent", { percent: number(row.employmentPercent, 1) })}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </TableCard>
            </>
          )}
        </SectionCard>
      )}
    </div>
  );
}
