"use client";

import { useMemo, useState } from "react";
import { compareSwedish } from "@/lib/sorting";
import { groupLabel } from "@/lib/year-scope";
import { useTranslations } from "next-intl";
import { BarChart3, Download } from "lucide-react";
import {
  useAcademicYears,
  useGroupAttendance,
  useGroups,
  usePeople,
} from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
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

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toDateInput(d);
}

/** RFC 4180-style escaping: quote fields containing separators or quotes. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Närvaro: the attendance report, as /admin/reports was before staffing
 * Fas 3 gave the page a second tab. Moved here unchanged; reports-tabs.tsx
 * holds the tab shell.
 */
export function AttendanceReport() {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");

  const [groupId, setGroupId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(() => toDateInput(new Date()));

  const { data: groups } = useGroups();
  // Every year's classes, named with their year unless it is the active
  // one's: last year's attendance is reported after the activation, so a
  // filter would hide it, and between a rollover and its activation every
  // class name exists twice.
  const { data: years } = useAcademicYears();
  const activeYearId = years?.find((year) => year.isActive)?.id ?? null;
  const { data: people } = usePeople();
  const { data: records, isLoading } = useGroupAttendance(groupId, fromDate, toDate);

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

  const exportCsv = () => {
    const groupName = groups?.find((group) => group.id === groupId)?.name ?? "class";
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
    link.download = `attendance_${groupName}_${fromDate}_${toDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const ratePercent = (rate: number | null) =>
    rate !== null ? `${Math.round(rate * 100)}%` : "—";

  const rateBadgeVariant = (rate: number | null) => {
    if (rate === null) return "outline" as const;
    if (rate >= 0.9) return "secondary" as const;
    if (rate >= 0.75) return "default" as const;
    return "destructive" as const;
  };

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={exportCsv} disabled={!groupId || !hasData}>
            <Download />
            {t("exportCsv")}
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label>{t("class")}</Label>
          <Select value={groupId ?? ""} onValueChange={setGroupId}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(groups ?? []).map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {groupLabel(group, years, activeYearId)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="report-from">{tCommon("from")}</Label>
          <DateField
            label={tCommon("from")}
            id="report-from"
            className="w-40"
            value={fromDate}
            onChange={(value) => value && setFromDate(value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="report-to">{tCommon("to")}</Label>
          <DateField
            label={tCommon("to")}
            id="report-to"
            className="w-40"
            value={toDate}
            onChange={(value) => value && setToDate(value)}
          />
        </div>
        {classAverage !== null ? (
          <div className="ml-auto rounded-lg border bg-card px-4 py-2 text-sm">
            <span className="text-muted-foreground">{t("classAverage")}: </span>
            <span className="font-semibold tabular-nums">
              {Math.round(classAverage * 100)}%
            </span>
          </div>
        ) : null}
      </div>

      {!groupId ? (
        <EmptyState icon={BarChart3} title={t("title")} description={t("chooseClass")} />
      ) : isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : !hasData ? (
        <EmptyState icon={BarChart3} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("student")}</TableHead>
                <TableHead className="text-right">{t("lessons")}</TableHead>
                <TableHead className="text-right">{t("present")}</TableHead>
                <TableHead className="text-right">{t("absent")}</TableHead>
                <TableHead className="text-right">{t("late")}</TableHead>
                <TableHead className="text-right">{t("excused")}</TableHead>
                <TableHead className="text-right">{t("rate")}</TableHead>
                <TableHead className="text-right">{t("validMinutes")}</TableHead>
                <TableHead className="text-right">{t("invalidMinutes")}</TableHead>
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
                    <Badge variant={rateBadgeVariant(entry.rate)}>
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
          </Table>
        </div>
      )}
    </div>
  );
}
