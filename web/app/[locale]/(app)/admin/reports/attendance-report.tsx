"use client";

import { useMemo, useState } from "react";
import { compareSwedish } from "@/lib/sorting";
import { groupLabel } from "@/lib/year-scope";
import { useLocale, useTranslations } from "next-intl";
import { BarChart3, Download, Users } from "lucide-react";
import {
  useAcademicYears,
  useGroupAttendance,
  useGroups,
  usePeople,
} from "@/lib/queries";
import { attendanceRateVariant } from "@/lib/status-variants";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface StudentStats {
  studentId: string;
  name: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  /** present + late, as a share of recorded (non-UNKNOWN) lessons. */
  rate: number | null;
  /** Minute-accurate absence (Skola24-style): giltig = EXCUSED minutes,
   * ogiltig = ABSENT minutes; LATE counts 15 min ogiltig by convention. */
  validAbsenceMinutes: number;
  invalidAbsenceMinutes: number;
  scheduledMinutes: number;
}

const LATE_PENALTY_MINUTES = 15;

function lessonMinutes(lesson: { startsAt: string; endsAt: string } | null): number {
  if (!lesson) return 0;
  const minutes =
    (new Date(lesson.endsAt).getTime() - new Date(lesson.startsAt).getTime()) / 60000;
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

/** Thirty days back on the school's wall clock (toISOString() named UTC's day). */
function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toDateString(d);
}

/** RFC 4180-style escaping: quote fields containing separators or quotes. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Närvaro: the attendance report, as /admin/reports was before staffing
 * Fas 3 gave the page a second tab; reports-tabs.tsx holds the tab shell and
 * the page's one header.
 *
 * NO FIGURE FROM A FAILED READ. The rates are computed here from the class's
 * pupils and their records, so a roster that did not load would leave every
 * pupil out and draw "no attendance" — the report says it could not read
 * instead, and shows no class average.
 */
export function AttendanceReport() {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [groupId, setGroupId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(() => toDateString(new Date()));

  const groupsQuery = useGroups();
  const groups = groupsQuery.data;
  // Every year's classes, named with their year unless it is the active
  // one's: last year's attendance is reported after the activation, so a
  // filter would hide it, and between a rollover and its activation every
  // class name exists twice.
  const { data: years } = useAcademicYears();
  const activeYearId = years?.find((year) => year.isActive)?.id ?? null;
  const peopleQuery = usePeople();
  const people = peopleQuery.data;
  const recordsQuery = useGroupAttendance(groupId, fromDate, toDate);
  const records = recordsQuery.data;
  const failed = groupsQuery.isError || peopleQuery.isError || recordsQuery.isError;
  const loading = recordsQuery.isLoading || peopleQuery.isLoading;

  const stats: StudentStats[] = useMemo(() => {
    if (!records || !people) return [];

    const students = people.filter(
      (person) => person.role === "STUDENT" && person.studentGroupId === groupId,
    );
    const byStudent = new Map<string, StudentStats>(
      students.map((student) => [
        student.id,
        {
          studentId: student.id,
          name: `${student.lastName}, ${student.firstName}`,
          present: 0,
          absent: 0,
          late: 0,
          excused: 0,
          total: 0,
          rate: null,
          validAbsenceMinutes: 0,
          invalidAbsenceMinutes: 0,
          scheduledMinutes: 0,
        },
      ]),
    );

    for (const record of records) {
      const entry = byStudent.get(record.studentId);
      if (!entry || record.status === "UNKNOWN") continue;
      entry.total += 1;
      const minutes = lessonMinutes(record.lesson);
      entry.scheduledMinutes += minutes;
      if (record.status === "PRESENT") entry.present += 1;
      else if (record.status === "ABSENT") {
        entry.absent += 1;
        entry.invalidAbsenceMinutes += minutes;
      } else if (record.status === "LATE") {
        entry.late += 1;
        entry.invalidAbsenceMinutes += Math.min(LATE_PENALTY_MINUTES, minutes);
      } else if (record.status === "EXCUSED") {
        entry.excused += 1;
        entry.validAbsenceMinutes += minutes;
      }
    }

    for (const entry of byStudent.values()) {
      entry.rate =
        entry.total > 0 ? (entry.present + entry.late) / entry.total : null;
    }

    // Not localeCompare(): with no locale argument it follows the browser's
    // language, so two admins looking at the same report could see the rows in
    // different orders — and on an English browser Öberg folds in with Olsson.
    return [...byStudent.values()].sort((a, b) => compareSwedish(a.name, b.name));
  }, [records, people, groupId]);

  const classAverage = useMemo(() => {
    const rated = stats.filter((entry) => entry.rate !== null);
    if (rated.length === 0) return null;
    return rated.reduce((sum, entry) => sum + (entry.rate ?? 0), 0) / rated.length;
  }, [stats]);

  const hasData = stats.some((entry) => entry.total > 0);
  const rated = stats.filter((entry) => entry.total > 0).length;
  const validMinutes = stats.reduce((sum, entry) => sum + entry.validAbsenceMinutes, 0);
  const invalidMinutes = stats.reduce((sum, entry) => sum + entry.invalidAbsenceMinutes, 0);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const percent = useMemo(() => new Intl.NumberFormat(locale, { style: "percent" }), [locale]);

  const exportCsv = () => {
    const groupName = groups?.find((group) => group.id === groupId)?.name ?? t("class");
    const header = [
      t("student"),
      t("lessons"),
      t("present"),
      t("absent"),
      t("late"),
      t("excused"),
      t("rate"),
      t("validMinutes"),
      t("invalidMinutes"),
      t("scheduledMinutes"),
    ];
    const lines = [
      header.map(csvField).join(";"),
      ...stats.map((entry) =>
        [
          entry.name,
          entry.total,
          entry.present,
          entry.absent,
          entry.late,
          entry.excused,
          entry.rate !== null ? `${Math.round(entry.rate * 100)}%` : "",
          entry.validAbsenceMinutes,
          entry.invalidAbsenceMinutes,
          entry.scheduledMinutes,
        ]
          .map(csvField)
          .join(";"),
      ),
    ];
    // BOM so Excel opens the UTF-8 file with correct encoding.
    const blob = new Blob([`\uFEFF${lines.join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = t("csvFilename", { group: groupName, from: fromDate, to: toDate });
    link.click();
    URL.revokeObjectURL(url);
  };

  const ratePercent = (rate: number | null) => (rate !== null ? percent.format(rate) : "—");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>

      <FilterBar>
        <FilterField id="report-class" label={t("class")}>
          <Select value={groupId ?? ""} onValueChange={setGroupId}>
            <SelectTrigger id="report-class" className="w-44">
              <SelectValue placeholder={t("classPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {(groups ?? []).map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {groupLabel(group, years, activeYearId)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField id="report-from" label={tCommon("from")}>
          <DateField
            label={tCommon("from")}
            id="report-from"
            className="w-40"
            value={fromDate}
            onChange={(value) => value && setFromDate(value)}
          />
        </FilterField>
        <FilterField id="report-to" label={tCommon("to")}>
          <DateField
            label={tCommon("to")}
            id="report-to"
            className="w-40"
            value={toDate}
            onChange={(value) => value && setToDate(value)}
          />
        </FilterField>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={exportCsv}
          disabled={!groupId || !hasData || failed}
        >
          <Download />
          {t("exportCsv")}
        </Button>
      </FilterBar>

      {/* A period that starts before the school's gallring says so, rather
          than showing the purged days as days without absence. */}
      {groupId ? <PurgedNotice kind="ATTENDANCE" from={fromDate} /> : null}

      {failed ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !groupId ? (
        <EmptyState icon={Users} title={t("chooseClassTitle")} description={t("chooseClass")} headingLevel={2} />
      ) : loading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !hasData ? (
        <EmptyState icon={BarChart3} title={t("emptyTitle")} description={t("empty")} headingLevel={2} />
      ) : (
        <>
          <KpiStrip>
            <KpiTile label={t("classAverage")} value={classAverage !== null ? percent.format(classAverage) : null} />
            <KpiTile
              label={t("kpiStudents")}
              value={number.format(rated)}
              detail={t("kpiStudentsDetail", { total: stats.length })}
            />
            <KpiTile label={t("kpiInvalid")} value={t("kpiMinutes", { minutes: number.format(invalidMinutes) })} />
            <KpiTile label={t("kpiValid")} value={t("kpiMinutes", { minutes: number.format(validMinutes) })} />
          </KpiStrip>

          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("student")}</TableHead>
                <TableHead scope="col" className="text-right">{t("lessons")}</TableHead>
                <TableHead scope="col" className="text-right">{t("present")}</TableHead>
                <TableHead scope="col" className="text-right">{t("absent")}</TableHead>
                <TableHead scope="col" className="text-right">{t("late")}</TableHead>
                <TableHead scope="col" className="text-right">{t("excused")}</TableHead>
                <TableHead scope="col" className="text-right">{t("rate")}</TableHead>
                <TableHead scope="col" className="text-right">{t("validMinutes")}</TableHead>
                <TableHead scope="col" className="text-right">{t("invalidMinutes")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((entry) => (
                <TableRow key={entry.studentId}>
                  <TableCell className="font-medium">{entry.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.present}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.absent}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.late}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.excused}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={attendanceRateVariant(entry.rate)} className="tabular-nums">
                      {ratePercent(entry.rate)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.validAbsenceMinutes}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">
                    {entry.invalidAbsenceMinutes}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableCard>
        </>
      )}
    </div>
  );
}
