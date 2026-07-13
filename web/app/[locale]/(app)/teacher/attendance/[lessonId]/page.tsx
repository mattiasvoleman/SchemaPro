"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, CheckCheck, Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  useAbsenceReports,
  useLesson,
  useLessonRoster,
  useLessonAttendance,
  useReportAttendance,
  useSubjects,
  type AttendanceEntryInput,
} from "@/lib/queries";
import type { AttendanceStatus } from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

const STATUSES: AttendanceStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];

const STATUS_STYLES: Record<AttendanceStatus, string> = {
  PRESENT: "data-[active=true]:bg-success data-[active=true]:text-success-foreground",
  LATE: "data-[active=true]:bg-warning data-[active=true]:text-warning-foreground",
  ABSENT: "data-[active=true]:bg-destructive data-[active=true]:text-destructive-foreground",
  EXCUSED: "data-[active=true]:bg-primary data-[active=true]:text-primary-foreground",
  UNKNOWN: "",
};

export default function LessonAttendancePage({
  params,
}: {
  params: Promise<{ lessonId: string }>;
}) {
  const { lessonId } = use(params);
  const t = useTranslations("teacherAttendance");
  const tStatus = useTranslations("attendanceStatus");
  const tCommon = useTranslations("common");

  const { data: lesson } = useLesson(lessonId);
  // Full roster: primary class + extra classes + individual participants.
  const { data: students, isLoading: studentsLoading } = useLessonRoster(
    lesson ? lessonId : null,
    lesson?.studentGroupId ?? null,
  );
  const { data: existingRecords } = useLessonAttendance(lessonId);
  const { data: absenceReports } = useAbsenceReports({
    date: lesson?.date ? lesson.date.slice(0, 10) : undefined,
  });

  /** Students with a guardian-reported absence covering this lesson. */
  const reportedAbsent = useMemo(() => {
    if (!lesson || !absenceReports) return new Set<string>();
    const lessonStart = new Date(lesson.startsAt);
    const lessonEnd = new Date(lesson.endsAt);
    const toMin = (d: Date) => d.getHours() * 60 + d.getMinutes();
    const set = new Set<string>();
    for (const report of absenceReports) {
      if (report.date.slice(0, 10) !== lesson.date.slice(0, 10)) continue;
      if (report.startTime && report.endTime) {
        const [sh, sm] = report.startTime.split(":").map(Number);
        const [eh, em] = report.endTime.split(":").map(Number);
        const overlaps =
          sh * 60 + sm < toMin(lessonEnd) && toMin(lessonStart) < eh * 60 + em;
        if (!overlaps) continue;
      }
      set.add(report.studentId);
    }
    return set;
  }, [lesson, absenceReports]);

  const { data: subjects } = useSubjects();
  const report = useReportAttendance();

  const [statuses, setStatuses] = useState<Record<string, AttendanceStatus>>({});

  // Pre-fill reported-absent students as EXCUSED (teacher can override).
  useEffect(() => {
    if (reportedAbsent.size === 0) return;
    setStatuses((current) => {
      const next = { ...current };
      for (const studentId of reportedAbsent) {
        if (!(studentId in next)) next[studentId] = "EXCUSED";
      }
      return next;
    });
  }, [reportedAbsent]);

  // Seed local state from existing records once loaded.
  useEffect(() => {
    if (!existingRecords) return;
    setStatuses((current) => {
      const next = { ...current };
      for (const record of existingRecords) {
        if (!(record.studentId in next)) {
          next[record.studentId] = record.status;
        }
      }
      return next;
    });
  }, [existingRecords]);

  const subject = useMemo(
    () => subjects?.find((candidate) => candidate.id === lesson?.subjectId),
    [subjects, lesson],
  );

  const recordedCount = Object.values(statuses).filter(
    (status) => status !== "UNKNOWN",
  ).length;

  const markAllPresent = () => {
    const next: Record<string, AttendanceStatus> = {};
    for (const student of students ?? []) {
      next[student.id] = "PRESENT";
    }
    setStatuses(next);
  };

  const submit = async () => {
    const records: AttendanceEntryInput[] = Object.entries(statuses)
      .filter(([, status]) => status !== "UNKNOWN")
      .map(([studentId, status]) => ({ studentId, status }));
    if (records.length === 0) return;

    try {
      await report.mutateAsync({ calendarLessonId: lessonId, records });
      toast.success(t("recorded"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/teacher/attendance">
            <ArrowLeft />
            {tCommon("back")}
          </Link>
        </Button>
      </div>

      <PageHeader
        title={subject?.name ?? t("lessonTitle")}
        subtitle={
          lesson
            ? `${lesson.date} · ${formatTime(lesson.startsAt)}–${formatTime(lesson.endsAt)}`
            : undefined
        }
        actions={
          students && students.length > 0 ? (
            <Badge variant="secondary">
              {t("recordedBadge", { count: recordedCount, total: students.length })}
            </Badge>
          ) : null
        }
      />

      {studentsLoading || !students ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("studentCount", { count: students.length })}
            </span>
            <Button variant="outline" size="sm" onClick={markAllPresent}>
              <CheckCheck />
              {t("markAll")}
            </Button>
          </div>

          <Card>
            <CardContent className="divide-y p-0">
              {students.map((student) => {
                const current = statuses[student.id] ?? "UNKNOWN";
                return (
                  <div
                    key={student.id}
                    className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="font-medium">
                      {student.firstName} {student.lastName}
                      {reportedAbsent.has(student.id) ? (
                        <Badge variant="warning" className="ml-2">
                          {t("reportedAbsent")}
                        </Badge>
                      ) : null}
                    </span>
                    <div className="flex gap-1">
                      {STATUSES.map((status) => (
                        <button
                          key={status}
                          type="button"
                          data-active={current === status}
                          onClick={() =>
                            setStatuses({ ...statuses, [student.id]: status })
                          }
                          className={cn(
                            "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted",
                            STATUS_STYLES[status],
                            current === status && "border-transparent",
                          )}
                        >
                          {tStatus(status)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Button
            className="mt-6 w-full"
            size="lg"
            onClick={submit}
            disabled={recordedCount === 0 || report.isPending}
          >
            {report.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                {t("submitting")}
              </>
            ) : (
              t("submit")
            )}
          </Button>
        </>
      )}
    </div>
  );
}
