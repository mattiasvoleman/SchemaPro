"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet, FileText, ShieldAlert } from "lucide-react";
import { HR_NOT_YOURS, isNotYours, isRateLimited, usePayrollBasis, usePayrollFile } from "@/lib/analysis-queries";
import { hoursOf, spanLabel } from "@/lib/analysis";
import type { PayrollFormat } from "@/lib/analysis-types";
import { usePeople } from "@/lib/queries";
import { saveBase64 } from "@/lib/schedule-exchange";
import { compareSwedish } from "@/lib/sorting";
import { AnalysisNotices } from "@/components/analysis/analysis-notices";
import { useAnalysisText } from "@/components/analysis/use-analysis-text";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/** The first and the last day of the month before `today`: the period a payroll is usually made for. */
export function previousMonth(today: Date): { from: string; to: string } {
  const first = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * Löneunderlag: kontering per anställning och skoldel for a period, with the
 * undervisning, the uppdrag and the vikariepass of each person, and the file
 * the payroll office imports. HR data through and through (each person's time
 * and tjänst), so a reader who does not read it is told so calmly.
 *
 * Asked for a period at a click, never on opening: the gateway counts the held
 * lessons of the whole school and the period is the payroll's month, not a
 * default. The file is built by the gateway (Excel's Swedish CSV in
 * windows-1252, or an .xlsx) and handed over as it is.
 *
 * A person the school has marked as having a protected identity is named by
 * signature here as in the file, never by name or e-mail, though the page
 * reads the register: the answer says who (PayrollPerson.protectedIdentity),
 * and those rows stand after the named, by signature, as in the file.
 */
export function PayrollPanel({ yearId }: { yearId: string }) {
  const { t, number, day } = useAnalysisText();
  const initial = useMemo(() => previousMonth(new Date()), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const query = usePayrollBasis(yearId, period);
  const people = usePeople();
  const order = usePayrollFile();
  const view = query.data;

  const names = useMemo(
    () => new Map((people.data ?? []).map((person) => [person.id, `${person.lastName}, ${person.firstName}`])),
    [people.data],
  );
  const nameOf = (userId: string): string => names.get(userId) ?? t("unknownPerson");
  const personOf = useMemo(() => new Map((view?.people ?? []).map((person) => [person.userId, person])), [view]);
  const isMarked = (userId: string): boolean => personOf.get(userId)?.protectedIdentity === true;
  /** What a row is sorted by: the name, or for a marked person the signature, after every name. */
  const keyOf = (userId: string): string => (isMarked(userId) ? (personOf.get(userId)?.signature ?? "") : nameOf(userId));
  const lines = useMemo(
    () =>
      view
        ? [...view.lines].sort(
            (a, b) =>
              Number(isMarked(a.userId)) - Number(isMarked(b.userId)) ||
              compareSwedish(keyOf(a.userId), keyOf(b.userId)) ||
              a.userId.localeCompare(b.userId),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, names, personOf],
  );
  const partOf = new Map((view?.parts ?? []).map((part) => [part.id, part]));
  const valid = from !== "" && to !== "" && from <= to;

  const hand = async (format: PayrollFormat) => {
    if (!period || order.isPending) return;
    try {
      const file = await order.mutateAsync({ academicYearId: yearId, from: period.from, to: period.to, format });
      saveBase64(file.filename, file.contentType, file.contentBase64);
      toast.success(
        file.protectedInFile > 0
          ? t("payroll.downloadedProtected", { file: file.filename, people: file.protectedInFile })
          : t("payroll.downloaded", { file: file.filename }),
      );
    } catch (error) {
      toast.error(isNotYours(error, HR_NOT_YOURS) ? t("payroll.notYoursBody") : error instanceof Error ? error.message : t("loadFailedHint"));
    }
  };

  const notYours = isNotYours(query.error, HR_NOT_YOURS);
  return (
    <div className="space-y-4">
      <SectionCard id="analysis-payroll-period" title={t("payroll.periodTitle")} description={t("payroll.periodDescription")}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) setPeriod({ from, to });
          }}
        >
          <FormField id="analysis-payroll-from" label={t("payroll.from")}>
            <DateField value={from} onChange={setFrom} label={t("payroll.from")} />
          </FormField>
          <FormField id="analysis-payroll-to" label={t("payroll.to")}>
            <DateField value={to} onChange={setTo} min={from || undefined} label={t("payroll.to")} />
          </FormField>
          <Button type="submit" disabled={!valid}>
            {t("payroll.show")}
          </Button>
        </form>
      </SectionCard>

      {period === null ? (
        <EmptyState icon={FileText} headingLevel={2} title={t("payroll.noPeriodTitle")} description={t("payroll.noPeriodBody")} />
      ) : query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : notYours ? (
        <EmptyState icon={ShieldAlert} headingLevel={2} title={t("payroll.notYoursTitle")} description={t("payroll.notYoursBody")} />
      ) : query.isError || !view ? (
        <LoadError
          title={isRateLimited(query.error) ? t("rateLimited") : t("payroll.loadFailed")}
          hint={isRateLimited(query.error) ? t("rateLimitedHint") : t("loadFailedHint")}
          headingLevel={2}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <>
          <AnalysisNotices notices={view.notices} />
          <SectionCard
            id="analysis-payroll"
            title={t("payroll.title", { from: day(view.from), to: day(view.to) })}
            description={t("payroll.description", { people: number(view.people.length) })}
            action={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={order.isPending || view.people.length === 0} onClick={() => void hand("CSV")}>
                  <FileText aria-hidden="true" />
                  {t("payroll.csv")}
                </Button>
                <Button variant="outline" size="sm" disabled={order.isPending || view.people.length === 0} onClick={() => void hand("XLSX")}>
                  <FileSpreadsheet aria-hidden="true" />
                  {t("payroll.xlsx")}
                </Button>
              </div>
            }
          >
            {lines.length === 0 ? (
              <EmptyState icon={FileText} headingLevel={3} title={t("payroll.emptyTitle")} description={t("payroll.emptyBody")} />
            ) : (
              <TableCard caption={t("payroll.caption")} tableClassName="min-w-[50rem]">
                <TableHeader>
                  <TableRow>
                    {(["person", "part", "account", "teaching", "duty", "substitute", "total"] as const).map((key) => (
                      <TableHead key={key} scope="col" className={["person", "part", "account"].includes(key) ? undefined : "text-right"}>
                        {t(`payroll.column.${key}`)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const part = line.schoolPartId === null ? undefined : partOf.get(line.schoolPartId);
                    return (
                      <TableRow key={`${line.userId}-${line.schoolPartId ?? "none"}`}>
                        <TableCell className="font-medium">
                          {isMarked(line.userId) ? (
                            <>
                              {personOf.get(line.userId)?.signature ?? t("payroll.noSignature")}
                              <span className="ml-2 font-normal text-muted-foreground">{t("payroll.protected")}</span>
                            </>
                          ) : (
                            nameOf(line.userId)
                          )}
                          {line.kind === "POOL" ? <span className="ml-2 font-normal text-muted-foreground">{t("payroll.pool")}</span> : null}
                        </TableCell>
                        <TableCell>
                          {part ? `${part.name} (${spanLabel(part)})` : t("payroll.noPart")}
                        </TableCell>
                        <TableCell className="tabular-nums">{line.account ?? "–"}</TableCell>
                        <TableCell className="text-right tabular-nums">{number(hoursOf(line.teachingMinutes), 2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{number(hoursOf(line.dutyMinutes), 2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{number(hoursOf(line.substituteMinutes), 2)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {number(hoursOf(line.teachingMinutes + line.dutyMinutes + line.substituteMinutes), 2)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </TableCard>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
