"use client";

// Min tjänst: a teacher's own tjänstefördelning, read-only.
//
// Everything here is the teacher's OWN row, and it is cut down to that on the
// gateway, not here: GET /staffing/load answers a TEACHER with their row alone
// (StaffingLoadService.load — RLS hands them no colleague's post, and the
// response drops the unstaffed list and the bottlenecks), and GET
// /teacher-duties answers them with their own uppdrag and 403s a colleague's.
// The `userId` filter below is for a SCHOOL_ADMIN who teaches and opens this
// page — they get the whole school's report, and this page is about one
// person.
//
// READ-ONLY on purpose. A post, a behörighet and an uppdrag are set by the
// skolledning (every write endpoint is @Roles(SCHOOL_ADMIN)), and the page
// says so in one sentence rather than greying out controls a teacher could
// never use. What it does give a teacher is what Lectio and Skola24 give
// theirs: the same bar the admin sees, so a conversation about the tjänst
// starts from one picture.
//
// LAST YEAR, ONE LINE (staffing Fas 5). A year rolled from another shows the
// teacher's own tjänst % and counted minutes of the year before, under this
// year's — the question every teacher asks in the tjänstefördelning talk, and
// one the gateway already answers (GET /staffing/load with the predecessor's
// id, cut to their own row). Absent without a predecessor or without a row
// there: a missing comparison is not a zero.
//
// ÅRSARBETSTID AND THE UPPDRAGSBESKRIVNING (staffing Fas 3). The year in
// hours beside the frame the school has set (annual-card.tsx, the card the
// drawer shows the admin — figures the gateway computed from the school's
// settings, labelled as such), and a link to the printable
// uppdragsbeskrivning of the teacher's own tjänst, which takes no id: the
// page under /teacher/tjanst/uppdragsbeskrivning reads the same own-row
// report this one does.
//
// Bundle: core tier (170KB). It reuses lib/staffing-queries.ts, the LoadBar
// and the AnnualCard the admin surfaces draw — small presentational modules —
// and nothing from the admin drawer, whose cards carry forms this page has no
// use for.

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, CalendarRange, Printer, Scale } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useProfile } from "@/components/profile-context";
import { useActiveYear, useGroups, useSubjects } from "@/lib/queries";
import { useStaffingLoad, useTeacherDuties } from "@/lib/staffing-queries";
import { dutyPeriodLine, dutySlotsLine } from "@/lib/duty-lines";
import { useLastYearTjanst } from "./use-last-year-tjanst";
import { isJudged, postAtStart } from "@/lib/period-view";
import { formatPercent } from "@/lib/staffing-view";
import { LoadBar } from "@/components/staffing/load-bar";
import { AnnualCard } from "@/components/staffing/annual-card";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableScroll } from "@/components/ui/table-scroll";

export default function MyStaffingPage() {
  const t = useTranslations("myStaffing");
  const tStaffing = useTranslations("staffing");
  const tDays = useTranslations("days");
  const { profile } = useProfile();
  const { data: years, activeYear, isLoading: yearLoading, isError: yearError } = useActiveYear();
  const yearId = activeYear?.id ?? null;
  const load = useStaffingLoad(yearId);
  const duties = useTeacherDuties(yearId, profile.id);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const lastYear = useLastYearTjanst(years, activeYear, profile.id);

  const row = useMemo(
    () => load.data?.teachers.find((teacher) => teacher.userId === profile.id) ?? null,
    [load.data, profile.id],
  );
  const ownDuties = useMemo(
    () => (duties.data ?? []).filter((duty) => duty.userId === profile.id),
    [duties.data, profile.id],
  );
  const subjectName = (id: string | null) =>
    id ? (subjects?.find((subject) => subject.id === id)?.name ?? null) : null;
  const groupName = (id: string | null) =>
    id ? (groups?.find((group) => group.id === id)?.name ?? null) : null;

  const loading = yearLoading || (yearId !== null && (load.isLoading || duties.isLoading));
  // A failed read is said as one, never drawn as an empty tjänst: "no
  // teaching assigned" is a statement a teacher would take to their rektor.
  // The years count too: without them the page cannot tell "no active year"
  // from "could not ask".
  const failed = yearError || load.isError || duties.isError;
  const ready = !loading && !failed && activeYear !== null && (row !== null || ownDuties.length > 0);

  // One header for every state. The print action only once there is a
  // tjänst to print; the read-only sentence only over the tjänst it is about.
  const header = (
    <PageHeader
      title={t("title")}
      subtitle={activeYear ? t("subtitle", { year: activeYear.name }) : undefined}
      intro={ready ? t("readOnly") : undefined}
      actions={
        ready && activeYear ? (
          <Button variant="outline" asChild>
            <Link href={`/teacher/tjanst/uppdragsbeskrivning?year=${encodeURIComponent(activeYear.id)}`}>
              <Printer aria-hidden="true" />
              {t("printLink")}
            </Link>
          </Button>
        ) : null
      }
    />
  );

  if (loading) {
    return (
      <Page width="narrow">
        {header}
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      </Page>
    );
  }

  if (failed) {
    return (
      <Page width="narrow">
        {header}
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      </Page>
    );
  }

  if (!activeYear) {
    return (
      <Page width="narrow">
        {header}
        <EmptyState icon={Scale} title={t("noYear")} description={t("noYearBody")} headingLevel={2} />
      </Page>
    );
  }

  if (!row && ownDuties.length === 0) {
    return (
      <Page width="narrow">
        {header}
        <EmptyState
          icon={Scale}
          title={t("notRegistered", { year: activeYear.name })}
          description={t("notRegisteredBody")}
          headingLevel={2}
        />
      </Page>
    );
  }

  const employment = row?.employment ?? null;

  return (
    <Page width="narrow">
      {header}

      <SectionCard id="tjanst-employment" title={tStaffing("employmentTitle")} className="text-sm">
        {employment ? (
          <p>
            {/* A post that changes during the year: as it is on the läsår's
                first day, and said so; the periods are listed below. */}
            {(() => {
              const start = postAtStart(row!) ?? employment;
              const changing = (row!.periods?.length ?? 0) > 0;
              const kind = tStaffing(`contract${employment.contractKind}`);
              const percent = formatPercent(start.employmentPercent);
              if (start.reductionPercent > 0) {
                const reduction = formatPercent(start.reductionPercent);
                return changing
                  ? t("employmentAtStartReduction", { percent, reduction, kind })
                  : tStaffing("employmentSummaryReduction", { percent, reduction, kind });
              }
              return changing ? t("employmentAtStart", { percent, kind }) : tStaffing("employmentSummary", { percent, kind });
            })()}
          </p>
        ) : (
          <p>{t("noEmployment")}</p>
        )}
        {row ? (
          <>
            {/* Without a target there is nothing to count AGAINST and no
                status but "Inget mål": one sentence with the minutes, not
                "Inget mål · räknat mot målet 600 min/v · Inget mål". With
                no post at all, noEmployment above has already said there
                is no target, so only the minutes. */}
            <p>
              {row.targetMinutesPerWeek === null ? (
                t(employment ? "countedNoTarget" : "countedOnly", { minutes: row.countedMinutesPerWeek })
              ) : (
                <>
                  {t("target", { minutes: row.targetMinutesPerWeek })}
                  {" · "}
                  {t("counted", { minutes: row.countedMinutesPerWeek })}
                  {" · "}
                  <span className="font-medium">{tStaffing(`status${row.status}`)}</span>
                </>
              )}
            </p>
            <LoadBar teacher={row} />
            {/* The post from a date (20261022120000): the teacher's own
                stretches, each judged on its own; the status above is the
                worst of them. Only the teacher's own — the report hands a
                teacher nobody else's row. */}
            {(row.periods?.length ?? 0) > 0 ? (
              <section aria-labelledby="tjanst-periods" className="space-y-1 border-t pt-3">
                <h3 id="tjanst-periods" className="font-medium">
                  {t("periodsTitle")}
                </h3>
                <p className="text-muted-foreground">{t("periodsIntro")}</p>
                <ol className="divide-y">
                  {row.periods!.map((period) => (
                    <li key={`${period.kind}-${period.from}`} className="space-y-0.5 py-1.5">
                      <p>
                        <span className="font-medium">
                          {tStaffing("periodDates", { from: period.from, to: period.to })}
                        </span>
                        {" · "}
                        {period.reductionPercent > 0
                          ? tStaffing("periodFiguresReduction", {
                              percent: formatPercent(period.employmentPercent),
                              reduction: formatPercent(period.reductionPercent),
                            })
                          : tStaffing("periodFigures", { percent: formatPercent(period.employmentPercent) })}
                      </p>
                      <p>
                        {period.effectiveFrom === null ? (
                          tStaffing("periodNoWeek")
                        ) : !isJudged(period) ? (
                          // Whole weeks, all of them lov: no verdict to give.
                          tStaffing("periodNoTeachingWeek")
                        ) : period.targetMinutesPerWeek === null ? (
                          t("countedOnly", { minutes: period.countedMinutesPerWeek })
                        ) : (
                          <>
                            {t("target", { minutes: period.targetMinutesPerWeek })}
                            {" · "}
                            {t("counted", { minutes: period.countedMinutesPerWeek })}
                            {" · "}
                            <span className="font-medium">{tStaffing(`status${period.status}`)}</span>
                          </>
                        )}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </>
        ) : null}
        {lastYear ? (
          <p className="text-muted-foreground">
            {lastYear.row.employment
              ? t("lastYear", {
                  year: lastYear.yearName,
                  // Where last year's post started, should it have changed during the year.
                  percent: formatPercent(postAtStart(lastYear.row)!.employmentPercent),
                  minutes: lastYear.row.countedMinutesPerWeek,
                })
              : t("lastYearNoPost", { year: lastYear.yearName, minutes: lastYear.row.countedMinutesPerWeek })}
          </p>
        ) : null}
      </SectionCard>

      {row ? (
        <AnnualCard
          annual={row.annual}
          loadModel={load.data?.loadModel ?? "MINUTES"}
          headingLevel="h2"
        />
      ) : null}

      <SectionCard id="tjanst-teaching" title={t("teachingTitle")}>
        {row && row.subjects.length > 0 ? (
          <TableScroll>
            <table className="w-full text-sm">
              <caption className="sr-only">{t("teachingCaption")}</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("subjectHeader")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("minutesHeader")}
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    {t("shareHeader")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {row.subjects.map((subject) => (
                  <tr key={subject.subjectId}>
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                      {subject.subjectName}
                    </th>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {subject.minutesPerWeek}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {/* No post, no denominator: a dash, never a 0 %. */}
                      {subject.percentOfEmployment === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `${formatPercent(subject.percentOfEmployment)} %`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noTeaching")}</p>
        )}
      </SectionCard>

      <SectionCard id="tjanst-duties" title={tStaffing("dutiesTitle")}>
        {ownDuties.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noDuties")}</p>
        ) : (
          <ul className="divide-y text-sm">
            {ownDuties.map((duty) => {
              const about = [subjectName(duty.subjectId), groupName(duty.studentGroupId)].filter(
                (part): part is string => part !== null,
              );
              return (
                <li key={duty.id} className="space-y-0.5 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{duty.label}</span>
                    <Badge variant="outline">{tStaffing(`dutyKind${duty.kind}`)}</Badge>
                  </div>
                  <p>
                    {duty.countsAsTeaching
                      ? tStaffing("dutyMinutesCounted", { minutes: duty.minutesPerWeek })
                      : tStaffing("dutyMinutes", { minutes: duty.minutesPerWeek })}
                    {about.length > 0 ? ` · ${about.join(" · ")}` : ""}
                  </p>
                  {dutyPeriodLine(tStaffing, duty) ? (
                    <p className="flex items-center gap-1">
                      <CalendarRange className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      {dutyPeriodLine(tStaffing, duty)}
                    </p>
                  ) : null}
                  {dutySlotsLine(tStaffing, tDays, duty.slots) ? (
                    <p className="flex items-start gap-1">
                      <CalendarClock
                        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {dutySlotsLine(tStaffing, tDays, duty.slots)}
                    </p>
                  ) : null}
                  {duty.note ? <p className="text-muted-foreground">{duty.note}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </Page>
  );
}
