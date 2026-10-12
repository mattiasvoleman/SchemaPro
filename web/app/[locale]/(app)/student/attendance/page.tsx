"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ClipboardCheck } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { useStudentAttendance, useSubjects } from "@/lib/queries";
import { ATTENDANCE_STATUS_VARIANT } from "@/lib/status-variants";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function StudentAttendancePage() {
  const t = useTranslations("studentAttendance");
  const tStatus = useTranslations("attendanceStatus");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { profile } = useProfile();

  const { data: records, isLoading, isError } = useStudentAttendance(profile.id);
  const { data: subjects } = useSubjects();

  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject])),
    [subjects],
  );

  // The lesson's own day (a date, not an instant) and its clock times as the
  // reader's locale writes them; 24-hour in both languages, as the school runs.
  const formats = useMemo(() => {
    const tag = locale === "en" ? "en-GB" : "sv-SE";
    return {
      day: new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
      time: new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
      percent: new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 }),
    };
  }, [locale]);
  const dayText = (date: string) => formats.day.format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
  const timeText = (iso: string) => formats.time.format(new Date(iso));

  // Lessons not yet taken (UNKNOWN) are left out: a rate over them would read
  // as absence that nobody recorded.
  const summary = useMemo(() => {
    const counted = (records ?? []).filter((record) => record.status !== "UNKNOWN");
    const present = counted.filter(
      (record) => record.status === "PRESENT" || record.status === "LATE",
    ).length;
    return {
      counted: counted.length,
      present,
      rate: counted.length === 0 ? null : present / counted.length,
    };
  }, [records]);

  const header = <PageHeader title={t("title")} subtitle={t("subtitle")} />;

  if (isLoading) {
    return (
      <Page width="narrow">
        {header}
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      </Page>
    );
  }

  if (isError) {
    return (
      <Page width="narrow">
        {header}
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      </Page>
    );
  }

  if (!records || records.length === 0) {
    return (
      <Page width="narrow">
        {header}
        <PurgedNotice kind="ATTENDANCE" />
        <EmptyState
          icon={ClipboardCheck}
          title={t("emptyTitle")}
          description={t("empty")}
          headingLevel={2}
        />
      </Page>
    );
  }

  return (
    <Page width="narrow">
      {header}
      {/* The rate is of what is left: older lessons may be gallrade. */}
      <PurgedNotice kind="ATTENDANCE" />
      <KpiStrip columns={3}>
        <KpiTile
          label={t("rate")}
          value={summary.rate === null ? null : formats.percent.format(summary.rate)}
          fallback={t("rateNone")}
          detail={
            summary.rate === null
              ? undefined
              : t("rateDetail", { present: summary.present, counted: summary.counted })
          }
        />
      </KpiStrip>
      <TableCard caption={t("tableCaption")}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{tCommon("date")}</TableHead>
            <TableHead scope="col">{tCommon("time")}</TableHead>
            <TableHead scope="col">{tCommon("subject")}</TableHead>
            <TableHead scope="col">{tCommon("status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={record.id}>
              <TableCell className="whitespace-nowrap font-medium tabular-nums">
                {record.lesson ? dayText(record.lesson.date) : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {record.lesson ? (
                  `${timeText(record.lesson.startsAt)}–${timeText(record.lesson.endsAt)}`
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                {(record.lesson ? subjectById.get(record.lesson.subjectId)?.name : undefined) ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={ATTENDANCE_STATUS_VARIANT[record.status]}>
                  {tStatus(record.status)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TableCard>
    </Page>
  );
}
