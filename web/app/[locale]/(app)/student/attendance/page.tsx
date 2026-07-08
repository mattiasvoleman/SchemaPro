"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ClipboardCheck } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { useStudentAttendance, useSubjects } from "@/lib/queries";
import type { AttendanceStatus } from "@/lib/types";
import { formatTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const BADGE_VARIANTS: Record<
  AttendanceStatus,
  "success" | "warning" | "destructive" | "secondary" | "outline"
> = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "destructive",
  EXCUSED: "secondary",
  UNKNOWN: "outline",
};

export default function StudentAttendancePage() {
  const t = useTranslations("studentAttendance");
  const tStatus = useTranslations("attendanceStatus");
  const tCommon = useTranslations("common");
  const { profile } = useProfile();

  const { data: records, isLoading } = useStudentAttendance(profile.id);
  const { data: subjects } = useSubjects();

  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject])),
    [subjects],
  );

  const rate = useMemo(() => {
    if (!records || records.length === 0) return null;
    const counted = records.filter((record) => record.status !== "UNKNOWN");
    if (counted.length === 0) return null;
    const present = counted.filter(
      (record) => record.status === "PRESENT" || record.status === "LATE",
    ).length;
    return Math.round((present / counted.length) * 100);
  }, [records]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          rate !== null ? (
            <Card>
              <CardContent className="px-4 py-2 text-center">
                <div className="text-xs text-muted-foreground">{t("rate")}</div>
                <div className="text-lg font-semibold tabular-nums">{rate}%</div>
              </CardContent>
            </Card>
          ) : null
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !records || records.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("date")}</TableHead>
                <TableHead>{tCommon("time")}</TableHead>
                <TableHead>{tCommon("subject")}</TableHead>
                <TableHead>{tCommon("status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="tabular-nums">{record.lesson?.date ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">
                    {record.lesson
                      ? `${formatTime(record.lesson.startsAt)}–${formatTime(record.lesson.endsAt)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {record.lesson
                      ? (subjectById.get(record.lesson.subjectId)?.name ?? "—")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={BADGE_VARIANTS[record.status]}>
                      {tStatus(record.status)}
                    </Badge>
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
