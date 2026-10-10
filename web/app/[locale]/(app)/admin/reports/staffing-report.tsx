"use client";

import { Fragment, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, Scale, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
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
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
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
export function StaffingReport() {
  const t = useTranslations("reports.staffing");
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
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label>{t("year")}</Label>
          <Select value={yearId ?? ""} onValueChange={chooseYear}>
            <SelectTrigger className="w-44" aria-label={t("year")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(years ?? []).map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="staffing-from">{tCommon("from")}</Label>
          <DateField
            label={tCommon("from")}
            id="staffing-from"
            className="w-40"
            value={range.from ?? data?.from ?? ""}
            onChange={(value) => value && editRange({ from: value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="staffing-to">{tCommon("to")}</Label>
          <DateField
            label={tCommon("to")}
            id="staffing-to"
            className="w-40"
            value={range.to ?? data?.to ?? ""}
            onChange={(value) => value && editRange({ to: value })}
          />
        </div>
        {crossed ? (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {t("rangeCrossed")}
          </p>
        ) : null}
      </div>

      {!yearId ? (
        <EmptyState icon={Scale} title={t("noYear")} />
      ) : rec.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : rec.isError || !data ? (
        <EmptyState
          icon={TriangleAlert}
          title={t("loadFailed")}
          description={rec.error instanceof Error ? rec.error.message : undefined}
        />
      ) : (
        <div
          className={cn("space-y-6 transition-opacity", rec.isPlaceholderData && "opacity-60")}
          aria-busy={rec.isPlaceholderData || undefined}
        >
          {data.notices.length > 0 ? (
            <ul role="status" className="space-y-1 rounded-md bg-muted px-4 py-3 text-sm text-foreground">
              {data.notices.map((notice) => (
                <li key={notice.code}>{noticeText(notice)}</li>
              ))}
            </ul>
          ) : null}

          {data.comparison ? (
            <p className="text-sm text-foreground">
              {t("comparison", { from: data.comparison.from, to: data.comparison.to, model: t(`model.${data.loadModel}`) })}
            </p>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {kpis.map((kpi) => (
              <div key={kpi.key} className="rounded-lg border bg-card p-4">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t(kpi.key)}
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{t("minutes", { minutes: kpi.minutes })}</dd>
                <dd className="text-sm text-muted-foreground tabular-nums">
                  {t("hours", { hours: hoursText(kpi.minutes, locale) })}
                </dd>
              </div>
            ))}
          </dl>

          {teachers.length === 0 ? (
            <EmptyState icon={Scale} title={t("empty")} />
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <caption className="sr-only">{t("tableCaption")}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("teacher")}</TableHead>
                    <TableHead className="text-right">{t("employment")}</TableHead>
                    <TableHead className="text-right">{t("planned")}</TableHead>
                    <TableHead className="text-right">{t("scheduled")}</TableHead>
                    <TableHead className="text-right">{t("delivered")}</TableHead>
                    <TableHead className="text-right">{t("deltaDelivered")}</TableHead>
                    <TableHead className="text-right">{t("substitute")}</TableHead>
                    <TableHead className="text-right">{t("coveredByOthers")}</TableHead>
                    <TableHead className="text-right">{t("lost")}</TableHead>
                    <TableHead className="text-right">{t("ahead")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teachers.map((row) => {
                    const expanded = open.has(row.userId);
                    const employment = loadOf.get(row.userId)?.employment ?? null;
                    const name = nameOf(row.userId);
                    return (
                      <Fragment key={row.userId}>
                        <TableRow>
                          <TableCell className="font-medium">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-left"
                              aria-expanded={expanded}
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
                          ? row.lines.map((line) => (
                              <TableRow
                                key={`${row.userId}-${line.studentGroupId}-${line.subjectId}`}
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
              </Table>
            </div>
          )}

          {data.groupLosses.length > 0 ? (
            <section aria-labelledby="group-losses-title" className="space-y-2">
              <h2 id="group-losses-title" className="text-lg font-semibold">
                {t("groupLosses")}
              </h2>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("groupSubject")}</TableHead>
                      <TableHead className="text-right">{tCause("teacherless")}</TableHead>
                      {LOST_CAUSES.map((cause) => (
                        <TableHead key={cause} className="text-right">
                          {tCause(cause)}
                        </TableHead>
                      ))}
                      {/* Only when a bulk avbokning cost something: the
                          gateway sends the key above 0 alone. */}
                      {eventLosses ? (
                        <TableHead className="text-right">{tCause("cancelledEvent")}</TableHead>
                      ) : null}
                      <TableHead className="text-right">{t("lessons")}</TableHead>
                      <TableHead className="text-right">{t("lost")}</TableHead>
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
                </Table>
              </div>
              <p className="text-xs text-foreground">{t("footGroupLosses")}</p>
            </section>
          ) : null}

          <ul className="list-disc space-y-1 pl-5 text-xs text-foreground">
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
        <section aria-labelledby="staffing-exports-title" className="mt-8 space-y-3 rounded-lg border bg-card p-4">
          <h2 id="staffing-exports-title" className="text-lg font-semibold">
            {t("exportsTitle")}
          </h2>
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
            <p className="text-xs text-foreground">{t("scbNotice")}</p>
            <p className="text-xs text-muted-foreground">{t("scbYearNote")}</p>
          </div>
          {scbNotices ? (
            <div role="status" className="space-y-1 rounded-md bg-muted px-4 py-3 text-sm text-foreground">
              <p className="font-medium">{t("scbNoticesTitle", { count: scbNotices.length })}</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {scbNotices.map((notice) => (
                  <li key={`${notice.code}-${JSON.stringify(notice.params)}`}>{scbNoticeText(notice)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
