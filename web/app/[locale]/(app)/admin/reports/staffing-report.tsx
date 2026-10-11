"use client";

import { Fragment, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, Scale } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useProfile } from "@/components/profile-context";
import { useAcademicYears, useGroups, usePeople, useSubjects } from "@/lib/queries";
import { useStaffingLoad } from "@/lib/staffing-queries";
import { compareSwedish } from "@/lib/sorting";
import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/staffing-view";
import { formatStamp } from "@/lib/employment-history-view";
import {
  LOST_CAUSES,
  groupLossMinutes,
  hoursText,
  type StaffingNotice,
} from "@/lib/staffing-reconciliation";
import type { ScbNotice } from "@/lib/staffing-exports";
import type { YearTimplanRow } from "@/lib/year-timplan-queries";
import type { LocalTimplanListItem } from "@/lib/timplan-queries";
import type { SchoolForm, TeacherDuty, TeacherQualification } from "@/lib/types";
import { YearSelect } from "@/components/schedule/year-select";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useStaffingReconciliation } from "./use-staffing-reconciliation";

/**
 * Rapporter › Tjänstefördelning (staffing Fas 3): per lärare, planerat mot
 * schemalagt mot genomfört över en period, vikarietid, bortfall, och de två
 * exporterna.
 *
 * Every figure is GET /staffing/delivered's (and, for the post and the
 * exports, GET /staffing/load's) — computed by the gateway in one RLS
 * transaction over P3's ONE definition of held time; this tab sums nothing
 * but the KPI strip's hours. Admin-only: the page is under /admin, and the
 * gateway answers the whole school only to an admin.
 *
 * WHAT A NUMBER MEANS is said under the tables, not left to the reader:
 * the held-time definition, the crediting rule (LEAD/ASSISTANT at the row's
 * percentage, a vikarie at 100 %, a lead beside a vikarie credited to
 * nobody), "Schemalagt = today's grundschema over the period", that
 * "Vikarierad av andra" reads the CURRENT grundschema, the grade convention,
 * "avrundat per rad", and the Faktor model when it is on.
 *
 * THE EXPORTS are built in the browser on click (lib/staffing-exports.ts,
 * an import() so no route carries it). The SCB file is an UNDERLAG and is
 * never called SCB's file: the text beside its button says what to complete,
 * what to check and where SCB's columns came from.
 */
/**
 * The refusals the admin can act on: a period the gateway will not read
 * (400, entirely outside the year) and a year whose class lists cannot be
 * worked out yet (R6's 409). 401/403/404 carry Nest's English defaults and,
 * like a network failure or a 5xx, keep the generic "nothing changed" hint.
 */
const REFUSALS: ReadonlySet<number> = new Set([400, 409, 422]);
/** The DTO's field tag ("from: ", "from/to: ") in front of the gateway's Swedish sentence. */
const FIELD_TAG = /^[A-Za-z]+(?:\/[A-Za-z]+)*:\s+/;

export function StaffingReport() {
  const t = useTranslations("reports.staffing");
  const tYearErrors = useTranslations("years.errors");
  const locale = useLocale();
  const tCause = useTranslations("timplanCoverage.delivered.cause");
  const tCommon = useTranslations("common");
  const { school } = useProfile();
  const timeZone = school?.timezone ?? "Europe/Stockholm";

  const { data: years } = useAcademicYears();
  const [chosenYearId, setChosenYearId] = useState<string | null>(null);
  const yearId = chosenYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;
  const year = years?.find((candidate) => candidate.id === yearId) ?? null;
  // `range` is what the fields show once edited; `asked` is the last range
  // that makes sense (from ≤ to) and is what the gateway is asked for, so a
  // start typed past the end never sends a request that can only answer 400
  // and wipe the tab.
  const [range, setRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [asked, setAsked] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });

  const rec = useStaffingReconciliation(yearId, asked.from, asked.to);
  const load = useStaffingLoad(yearId);
  const { data: people } = usePeople();
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [includeQualifications, setIncludeQualifications] = useState(false);
  const [exporting, setExporting] = useState<"samverkan" | "scb" | null>(null);
  const [scbNotices, setScbNotices] = useState<ScbNotice[] | null>(null);

  const personOf = useMemo(() => new Map((people ?? []).map((person) => [person.id, person])), [people]);
  const loadOf = useMemo(
    () => new Map((load.data?.teachers ?? []).map((row) => [row.userId, row])),
    [load.data],
  );
  const nameOf = (userId: string) => {
    const person = personOf.get(userId);
    if (person) return `${person.firstName} ${person.lastName}`;
    return loadOf.get(userId)?.employment?.signature ?? userId.slice(0, 8);
  };
  const subjectName = (id: string) => subjects?.find((subject) => subject.id === id)?.name ?? "—";
  const groupName = (id: string) => groups?.find((group) => group.id === id)?.name ?? "—";

  const data = rec.data;
  const eventLosses = (data?.groupLosses ?? []).some((loss) => (loss.cancelledEvent ?? 0) > 0);
  // By family name, Swedish order; a teacher the roster cannot name by their
  // signature (or id), like the staffing matrix.
  const teachers = useMemo(() => {
    const key = (userId: string) => {
      const person = personOf.get(userId);
      if (person) return `${person.lastName} ${person.firstName}`;
      return loadOf.get(userId)?.employment?.signature ?? userId;
    };
    return [...(data?.teachers ?? [])].sort((a, b) => compareSwedish(key(a.userId), key(b.userId)));
  }, [data, personOf, loadOf]);

  const chooseYear = (id: string) => {
    setChosenYearId(id);
    setRange({ from: null, to: null });
    setAsked({ from: null, to: null });
    setOpen(new Set());
    setScbNotices(null);
  };
  /*
   * One edited field fixes the other at what it shows: the gateway's default
   * (the answer's from/to) until it is edited, so changing "Från" never
   * blanks "Till" while the new range loads.
   */
  const editRange = (edit: { from?: string; to?: string }) => {
    const next = {
      from: edit.from ?? range.from ?? data?.from ?? null,
      to: edit.to ?? range.to ?? data?.to ?? null,
    };
    setRange(next);
    if (!(next.from && next.to && next.from > next.to)) setAsked(next);
  };
  const crossed = range.from !== null && range.to !== null && range.from > range.to;

  const toggle = (userId: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const exportDate = () => formatStamp(new Date().toISOString(), timeZone).slice(0, 10);

  const exportSamverkan = async () => {
    if (!data || !load.data || !year) return;
    setExporting("samverkan");
    try {
      const [{ samverkanCsv, samverkanFilename }, { downloadCsv }, qualifications] = await Promise.all([
        import("@/lib/staffing-exports"),
        import("@/lib/csv-export"),
        includeQualifications
          ? api.get<TeacherQualification[]>("/api/v1/teacher-qualifications")
          : Promise.resolve(null),
      ]);
      downloadCsv(
        samverkanFilename(year.name, data.from, data.to),
        samverkanCsv({
          loadModel: data.loadModel,
          load: load.data.teachers,
          reconciliation: data.teachers,
          from: data.from,
          to: data.to,
          year: data.year,
          personOf: (id) => personOf.get(id) ?? null,
          subjectName,
          qualifications,
        }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("exportFailed"));
    } finally {
      setExporting(null);
    }
  };

  const exportScb = async () => {
    if (!load.data || !year) return;
    setExporting("scb");
    try {
      const encoded = encodeURIComponent(year.id);
      const [{ scbUnderlag, scbFilename }, { downloadCsv }, duties, yearPlans, plans] = await Promise.all([
        import("@/lib/staffing-exports"),
        import("@/lib/csv-export"),
        api.get<TeacherDuty[]>(`/api/v1/teacher-duties?academicYearId=${encoded}`),
        api.get<YearTimplanRow[]>(`/api/v1/academic-years/${encoded}/timplans`),
        api.get<LocalTimplanListItem[]>("/api/v1/local-timplans"),
      ]);
      const formOf = new Map(plans.map((plan) => [plan.id, plan.schoolForm]));
      const schoolFormByGrade = new Map<number, SchoolForm>();
      for (const row of yearPlans) {
        const form = formOf.get(row.localTimplanId);
        if (form) schoolFormByGrade.set(row.gradeLevel, form);
      }
      const result = scbUnderlag({
        exportDate: exportDate(),
        yearStartDate: year.startDate,
        schoolName: school?.name ?? "",
        load: load.data.teachers,
        duties,
        subjects: subjects ?? [],
        schoolFormByGrade,
        personOf: (id) => personOf.get(id) ?? null,
        adminIds: new Set((people ?? []).filter((person) => person.role === "SCHOOL_ADMIN").map((p) => p.id)),
      });
      downloadCsv(scbFilename(year.name), result.csv);
      setScbNotices(result.notices);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("exportFailed"));
    } finally {
      setExporting(null);
    }
  };

  const noticeText = (notice: StaffingNotice) =>
    t(`notice.${notice.code}`, notice.params as Record<string, string | number>);
  const scbNoticeText = (notice: ScbNotice) => {
    const params = { ...notice.params };
    if (typeof params.form === "string") params.form = t(`scb.form.${params.form}`);
    return t(`scb.notice.${notice.code}`, params as Record<string, string | number>);
  };

  /*
   * Why the reconciliation could not be read. A refusal says its reason,
   * from the code's own sentence when there is one, else the gateway's
   * Swedish sentence; anything else says what did not change.
   */
  const failureHint = (error: unknown): string => {
    if (error instanceof ApiError && REFUSALS.has(error.status)) {
      if (error.code === "ROLLOVER_NOT_ACTIVATED" && error.params) {
        return tYearErrors("ROLLOVER_NOT_ACTIVATED", error.params);
      }
      const reason = error.message.replace(FIELD_TAG, "").trim();
      if (reason) return reason.charAt(0).toLocaleUpperCase(locale) + reason.slice(1);
    }
    return t("loadFailedHint");
  };

  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  const kpis = data?.totals
    ? [
        { key: "planned", minutes: data.totals.planned },
        { key: "scheduled", minutes: data.totals.scheduled },
        { key: "delivered", minutes: data.totals.delivered },
        { key: "substitute", minutes: data.totals.substituteMinutes },
        { key: "lost", minutes: data.totals.lostMinutes },
      ]
    : [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>

      <FilterBar>
        <FilterField id="staffing-year" label={t("year")}>
          <YearSelect id="staffing-year" value={yearId} onValueChange={chooseYear} years={years} />
        </FilterField>
        <FilterField id="staffing-from" label={tCommon("from")}>
          <DateField
            label={tCommon("from")}
            id="staffing-from"
            className="w-40"
            min={year?.startDate}
            max={year?.endDate}
            value={range.from ?? data?.from ?? ""}
            onChange={(value) => value && editRange({ from: value })}
          />
        </FilterField>
        <FilterField id="staffing-to" label={tCommon("to")}>
          <DateField
            label={tCommon("to")}
            id="staffing-to"
            className="w-40"
            min={year?.startDate}
            max={year?.endDate}
            value={range.to ?? data?.to ?? ""}
            onChange={(value) => value && editRange({ to: value })}
          />
        </FilterField>
        {crossed ? (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {t("rangeCrossed")}
          </p>
        ) : null}
      </FilterBar>

      {!yearId ? (
        <EmptyState icon={Scale} title={t("noYear")} headingLevel={2} />
      ) : rec.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : rec.isError || !data ? (
        // A refusal the admin must act on names its reason; a network
        // failure or a 5xx says that nothing changed.
        <LoadError title={t("loadFailed")} hint={failureHint(rec.error)} headingLevel={2} />
      ) : (
        <div
          className={cn("space-y-4 transition-opacity", rec.isPlaceholderData && "opacity-60")}
          aria-busy={rec.isPlaceholderData || undefined}
        >
          {data.notices.length > 0 ? (
            <Notice>
              <ul className="space-y-1">
                {data.notices.map((notice) => (
                  <li key={notice.code}>{noticeText(notice)}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {data.comparison ? (
            <p className="text-sm">
              {t("comparison", { from: data.comparison.from, to: data.comparison.to, model: t(`model.${data.loadModel}`) })}
            </p>
          ) : null}

          {kpis.length > 0 ? (
            <KpiStrip columns={5}>
              {kpis.map((kpi) => (
                <KpiTile
                  key={kpi.key}
                  label={t(kpi.key)}
                  value={t("minutes", { minutes: kpi.minutes })}
                  detail={t("hours", { hours: hoursText(kpi.minutes, locale) })}
                />
              ))}
            </KpiStrip>
          ) : null}

          {teachers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <TableCard caption={t("tableCaption")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("teacher")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("employment")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("planned")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("scheduled")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("delivered")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("deltaDelivered")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("substitute")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("coveredByOthers")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("lost")}</TableHead>
                  <TableHead scope="col" className="text-right">{t("ahead")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teachers.map((row) => {
                  const expanded = open.has(row.userId);
                  const employment = loadOf.get(row.userId)?.employment ?? null;
                  const name = nameOf(row.userId);
                  const lineId = (index: number) => `staffing-lines-${row.userId}-${index}`;
                  return (
                    <Fragment key={row.userId}>
                      <TableRow>
                        <TableCell className="font-medium">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-left"
                            aria-expanded={expanded}
                            aria-controls={
                              expanded && row.lines.length > 0
                                ? row.lines.map((_, index) => lineId(index)).join(" ")
                                : undefined
                            }
                            aria-label={t(expanded ? "hideLines" : "showLines", { name })}
                            onClick={() => toggle(row.userId)}
                          >
                            {expanded ? (
                              <ChevronDown className="size-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-4" aria-hidden="true" />
                            )}
                            {name}
                          </button>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {employment ? `${formatPercent(employment.employmentPercent)} %` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{row.planned}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.scheduled}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.delivered}</TableCell>
                        <TableCell className="text-right tabular-nums">{signed(row.delivered - row.planned)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.substituteMinutes}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.coveredByOthersMinutes}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.lostMinutes}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.aheadMinutes}</TableCell>
                      </TableRow>
                      {expanded
                        ? row.lines.map((line, index) => (
                            <TableRow
                              key={`${row.userId}-${line.studentGroupId}-${line.subjectId}`}
                              id={lineId(index)}
                              className="bg-muted/40 text-sm"
                            >
                              <TableCell className="pl-8">
                                {subjectName(line.subjectId)} · {groupName(line.studentGroupId)}
                                {line.extraGroupIds.length > 0
                                  ? ` ${t("withGroups", { groups: line.extraGroupIds.map(groupName).join(", ") })}`
                                  : ""}
                              </TableCell>
                              <TableCell />
                              <TableCell className="text-right tabular-nums">{line.planned}</TableCell>
                              <TableCell className="text-right tabular-nums">{line.scheduled}</TableCell>
                              <TableCell className="text-right tabular-nums">{line.delivered}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {signed(line.delivered - line.planned)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{line.substituteMinutes}</TableCell>
                              <TableCell />
                              <TableCell className="text-right tabular-nums">{line.lostMinutes}</TableCell>
                              <TableCell />
                            </TableRow>
                          ))
                        : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </TableCard>
          )}

          {data.groupLosses.length > 0 ? (
            <section aria-labelledby="group-losses-title" className="space-y-3">
              <h2 id="group-losses-title" className="text-base font-semibold">
                {t("groupLosses")}
              </h2>
              <TableCard caption={t("groupLosses")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("groupSubject")}</TableHead>
                    <TableHead scope="col" className="text-right">{tCause("teacherless")}</TableHead>
                    {LOST_CAUSES.map((cause) => (
                      <TableHead key={cause} scope="col" className="text-right">
                        {tCause(cause)}
                      </TableHead>
                    ))}
                    {/* Only when a bulk avbokning cost something: the
                        gateway sends the key above 0 alone. */}
                    {eventLosses ? (
                      <TableHead scope="col" className="text-right">{tCause("cancelledEvent")}</TableHead>
                    ) : null}
                    <TableHead scope="col" className="text-right">{t("lessons")}</TableHead>
                    <TableHead scope="col" className="text-right">{t("lost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.groupLosses.map((loss) => (
                    <TableRow key={`${loss.studentGroupId}-${loss.subjectId}`}>
                      <TableCell>
                        {groupName(loss.studentGroupId)} · {subjectName(loss.subjectId)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{loss.teacherless}</TableCell>
                      {LOST_CAUSES.map((cause) => (
                        <TableCell key={cause} className="text-right tabular-nums">
                          {loss[cause]}
                        </TableCell>
                      ))}
                      {eventLosses ? (
                        <TableCell className="text-right tabular-nums">{loss.cancelledEvent ?? 0}</TableCell>
                      ) : null}
                      <TableCell className="text-right tabular-nums">{loss.lessons}</TableCell>
                      <TableCell className="text-right tabular-nums">{groupLossMinutes(loss)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableCard>
              <p className="text-xs text-muted-foreground">{t("footGroupLosses")}</p>
            </section>
          ) : null}

          {/* What each figure means, said under the tables; hints are muted
              like every other hint on the page. */}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t("footDefinition")}</li>
            <li>{t("footCredit")}</li>
            <li>{t("footCoTeacher")}</li>
            <li>{t("footScheduled")}</li>
            <li>{t("footGrade")}</li>
            <li>{t("footAhead")}</li>
            <li>{t("footRounding")}</li>
            {data.loadModel === "FACTOR" ? <li>{t("footFactor")}</li> : null}
          </ul>
        </div>
      )}

      {yearId ? (
        <SectionCard id="staffing-exports" title={t("exportsTitle")} icon={Download}>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                onClick={() => void exportSamverkan()}
                disabled={!data || !load.data || exporting !== null}
              >
                <Download />
                {t("exportSamverkan")}
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={includeQualifications}
                  onChange={(event) => setIncludeQualifications(event.target.checked)}
                />
                {t("includeQualifications")}
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t("exportSamverkanHint")}</p>
          </div>
          <div className="space-y-2">
            <Button variant="outline" onClick={() => void exportScb()} disabled={!load.data || exporting !== null}>
              <Download />
              {t("exportScb")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("scbNotice")}</p>
            <p className="text-xs text-muted-foreground">{t("scbYearNote")}</p>
          </div>
          {scbNotices ? (
            <Notice title={t("scbNoticesTitle", { count: scbNotices.length })}>
              <ul className="list-disc space-y-0.5 pl-5">
                {scbNotices.map((notice) => (
                  <li key={`${notice.code}-${JSON.stringify(notice.params)}`}>{scbNoticeText(notice)}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
