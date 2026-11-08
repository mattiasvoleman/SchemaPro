"use client";

import { Download, Landmark } from "lucide-react";
import { COST_CATEGORIES, type CostFigures } from "@/lib/analysis-types";
import { COST_NOT_YOURS, isNotYours, isRateLimited, useCostBasis, useSchoolParts } from "@/lib/analysis-queries";
import { costBasisCsv, costBasisFilename, gradeText, spanLabel } from "@/lib/analysis";
import { downloadCsv } from "@/lib/csv-export";
import { AnalysisNotices } from "@/components/analysis/analysis-notices";
import { useAnalysisText } from "@/components/analysis/use-analysis-text";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/**
 * Kostnadsunderlag per elev: a row per årskurs under its skoldel, with the
 * hours each personalkategori carries there, the teacher time per pupil and the
 * cost at the school's own rates. A cost the school has no rate for is UNKNOWN
 * and says so with a dash and a reason, never a zero. The file names nobody.
 *
 * The cost basis is the school's economy: a reader who is not given it is told
 * so calmly, and the huvudman's reader reads it as aggregates.
 */
export function CostBasisPanel({ yearId, yearName }: { yearId: string; yearName: string }) {
  const { t, number, money, category, day } = useAnalysisText();
  const query = useCostBasis(yearId);
  const parts = useSchoolParts();
  const view = query.data;

  if (query.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isNotYours(query.error, COST_NOT_YOURS)) {
    return <EmptyState icon={Landmark} headingLevel={2} title={t("cost.notYoursTitle")} description={t("cost.notYoursBody")} />;
  }
  if (query.isError || !view) {
    return (
      <LoadError
        title={isRateLimited(query.error) ? t("rateLimited") : t("cost.loadFailed")}
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

  const partRows = parts.data ?? [];
  const partOf = new Map(partRows.map((part) => [part.id, part]));
  const figures = (one: CostFigures) => (
    <>
      <TableCell className="text-right tabular-nums">{number(one.pupils)}</TableCell>
      {COST_CATEGORIES.map((one_) => (
        <TableCell key={one_} className="text-right tabular-nums">
          {number(one.hours[one_], 1)}
        </TableCell>
      ))}
      <TableCell className="text-right tabular-nums">{one.hoursPerPupil === null ? "–" : number(one.hoursPerPupil, 1)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {one.cost === null ? <span title={t("cost.unknownCost")}>{t("cost.unknown")}</span> : money(one.cost)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {one.costPerPupil === null ? <span title={one.cost === null ? t("cost.unknownCost") : t("cost.noPupils")}>–</span> : money(one.costPerPupil)}
      </TableCell>
    </>
  );

  const download = () =>
    downloadCsv(costBasisFilename(yearName), costBasisCsv(view, partRows, t("cost.noPart"), t("cost.noGrade"), t("cost.whole")));

  return (
    <div className="space-y-4">
      <AnalysisNotices notices={view.notices} />
      {view.aggregateOnly ? <Notice tone="neutral">{t("cost.aggregateOnly")}</Notice> : null}
      <p className="text-sm text-muted-foreground">
        {t("cost.basis", {
          rates:
            view.rates.length === 0
              ? t("cost.noRates")
              : view.rates.map((rate) => `${category(rate.category)} ${money(rate.hourlyCost)}`).join(", "),
        })}{" "}
        {view.substitutes ? t("cost.substitutesOver", { from: day(view.substitutes.from), to: day(view.substitutes.to) }) : t("cost.noSubstitutes")}
      </p>

      <SectionCard
        id="analysis-cost"
        title={t("cost.title")}
        description={t("cost.description")}
        action={
          <Button variant="outline" size="sm" onClick={download}>
            <Download aria-hidden="true" />
            {t("cost.download")}
          </Button>
        }
      >
        <TableCard caption={t("cost.caption")} tableClassName="min-w-[56rem]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("cost.column.where")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("cost.column.pupils")}
              </TableHead>
              {COST_CATEGORIES.map((one) => (
                <TableHead key={one} scope="col" className="text-right">
                  {t("cost.column.hours", { category: category(one) })}
                </TableHead>
              ))}
              <TableHead scope="col" className="text-right">
                {t("cost.column.perPupil")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("cost.column.cost")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("cost.column.costPerPupil")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.parts.map((part) => {
              const own = view.cells.filter((cell) => cell.schoolPartId === part.schoolPartId);
              const stated = part.schoolPartId === null ? undefined : partOf.get(part.schoolPartId);
              return [
                <TableRow key={`part-${part.schoolPartId ?? "none"}`} className="bg-muted/40 font-medium">
                  <TableCell>
                    {part.name ?? t("cost.noPart")}
                    {stated ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {t("cost.partDetail", { account: stated.account, span: spanLabel(stated) })}
                      </span>
                    ) : null}
                  </TableCell>
                  {figures(part)}
                </TableRow>,
                ...own.map((cell) => (
                  <TableRow key={`cell-${cell.schoolPartId ?? "none"}-${cell.gradeLevel ?? "none"}`}>
                    <TableCell className="pl-6">{t("cost.grade", { grade: gradeText(cell.gradeLevel, t("cost.noGrade")) })}</TableCell>
                    {figures(cell)}
                  </TableRow>
                )),
              ];
            })}
            <TableRow className="border-t-2 font-semibold">
              <TableCell>{t("cost.whole")}</TableCell>
              {figures(view.total)}
            </TableRow>
          </TableBody>
        </TableCard>
      </SectionCard>
    </div>
  );
}
