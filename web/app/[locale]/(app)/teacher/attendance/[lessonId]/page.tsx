"use client";

import { use, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, CheckCheck, Loader2 } from "lucide-react";
import {
  isNotOnLesson,
  useLesson,
  useLessonRoster,
  useLessonAttendance,
  useLessonReportedAbsences,
  useReportAttendance,
  useSubjects,
  type AttendanceEntryInput,
} from "@/lib/queries";
import { ATTENDANCE_STATUS_VARIANT, type StatusVariant } from "@/lib/status-variants";
import type { AttendanceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

const STATUSES: AttendanceStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];

/*
 * The chosen status is drawn in its status colour as an edge and a tint, with
 * the text kept in the foreground colour and a check mark beside it: white
 * on --success measures 3.9:1 and on the dark theme's --destructive 4.1:1,
 * under AA for a label this size, and the check mark says "chosen" to anyone
 * who cannot tell the colours apart.
 */
const CHOSEN_TONE: Record<StatusVariant, string> = {
  success: "border-success bg-success/15",
  warning: "border-warning bg-warning/15",
  destructive: "border-destructive bg-destructive/10",
  secondary: "border-foreground/40 bg-secondary",
  outline: "border-foreground/40",
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
  const locale = useLocale();

  const lessonQuery = useLesson(lessonId);
  const lesson = lessonQuery.data;
  // Who the register lists: the lesson's active pupils, as the gateway's
  // roster reader answers it. Asked once the lesson has been read (the state
  // ladder below).
  const {
    data: students,
    isLoading: studentsLoading,
    isError: studentsError,
    error: rosterError,
  } = useLessonRoster(lesson ? lessonId : null);
  const { data: existingRecords, isError: existingError } = useLessonAttendance(lessonId);
  const { data: reported } = useLessonReportedAbsences(lessonId);

  /**
   * Students with an absence reported in advance covering this lesson. The
   * gateway decides which, in the school's timezone; the page never reads an
   * absence report, and with it no note.
   */
  const reportedAbsent = useMemo(
    () => new Set<string>(reported?.studentIds ?? []),
    [reported],
  );

  const { data: subjects } = useSubjects();
  const report = useReportAttendance();

  // What the teacher has chosen on this page.
  const [chosen, setChosen] = useState<Record<string, AttendanceStatus>>({});

  /**
   * Each listed pupil's status: an absence reported in advance pre-fills
   * EXCUSED, a stored record replaces that, and what the teacher chooses
   * here replaces both. Derived, not seeded: two effects that each filled
   * only the pupils still missing let whichever read answered first win, so a
   * pupil with a stored ABSENT and a report opened as one or the other by
   * network timing.
   *
   * Only the roster's pupils, which is all the save sends. The stored records
   * also hold pupils who have since left the lesson's groups; sent back, the
   * gateway refuses the whole register (403, not on the roster), and a
   * deactivated pupil's row would be rewritten in this teacher's name.
   */
  const statuses = useMemo(() => {
    const listed = new Set((students ?? []).map((student) => student.id));
    const known: Record<string, AttendanceStatus> = {};
    for (const studentId of reportedAbsent) known[studentId] = "EXCUSED";
    for (const record of existingRecords ?? []) known[record.studentId] = record.status;
    const all = { ...known, ...chosen };
    return Object.fromEntries(Object.entries(all).filter(([studentId]) => listed.has(studentId)));
  }, [students, reportedAbsent, existingRecords, chosen]);

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
    setChosen(next);
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

  // The lesson's day (a date) and clock times as the reader's locale writes them.
  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const subtitle = lesson
    ? (() => {
        const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" });
        const day = new Intl.DateTimeFormat(tag, {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        }).format(new Date(`${lesson.date.slice(0, 10)}T12:00:00Z`));
        return `${day} · ${time.format(new Date(lesson.startsAt))}–${time.format(new Date(lesson.endsAt))}`;
      })()
    : undefined;

  const header = (
    <PageHeader
      back={{ href: "/teacher/attendance", label: t("backToLessons") }}
      title={subject?.name ?? t("lessonTitle")}
      subtitle={subtitle}
      meta={
        students && students.length > 0 ? (
          <Badge variant="secondary">
            {t("recordedBadge", { count: recordedCount, total: students.length })}
          </Badge>
        ) : null
      }
    />
  );

  // The state ladder: the lesson first, then its roster. A lesson that cannot
  // be read never leaves the skeleton standing: the roster waits for it. A
  // roster refused because the teacher is not on the lesson is no failure to
  // wait out, and "reload in a moment" would never help.
  const notOnLesson = studentsError && isNotOnLesson(rosterError);
  const failed = lessonQuery.isError
    ? t("lessonLoadFailed")
    : notOnLesson
      ? t("notOnLesson")
      : studentsError
        ? t("rosterLoadFailed")
        : null;
  if (failed) {
    return (
      <Page width="narrow">
        {header}
        <LoadError
          title={failed}
          hint={notOnLesson ? t("notOnLessonHint") : t("lessonLoadFailedHint")}
          headingLevel={2}
        />
      </Page>
    );
  }

  if (lessonQuery.isLoading || studentsLoading || !students) {
    return (
      <Page width="narrow">
        {header}
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      {header}

      {existingError ? (
        <Notice tone="warning" title={t("existingLoadFailed")}>
          {t("existingLoadFailedHint")}
        </Notice>
      ) : null}

      <SectionCard
        id="attendance-roster"
        title={t("rosterTitle")}
        description={t("studentCount", { count: students.length })}
        action={
          <Button variant="outline" size="sm" onClick={markAllPresent}>
            <CheckCheck aria-hidden="true" />
            {t("markAll")}
          </Button>
        }
      >
        <ul className="divide-y">
          {students.map((student) => {
            const current = statuses[student.id] ?? "UNKNOWN";
            const nameId = `attendance-${student.id}-name`;
            return (
              <li
                key={student.id}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span id={nameId} className="font-medium">
                    {student.firstName} {student.lastName}
                  </span>
                  {reportedAbsent.has(student.id) ? (
                    <Badge variant="warning">{t("reportedAbsent")}</Badge>
                  ) : null}
                </span>
                {/* One radio group per pupil, named by the pupil: native
                    radios give the arrow keys, the "1 of 4" and the checked
                    state for free, and each label is a 44px target. */}
                <div
                  role="radiogroup"
                  aria-labelledby={nameId}
                  className="grid grid-cols-2 gap-1.5 sm:flex sm:shrink-0"
                >
                  {STATUSES.map((status) => {
                    const chosen = current === status;
                    return (
                      <label
                        key={status}
                        className={cn(
                          "relative flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
                          chosen ? CHOSEN_TONE[ATTENDANCE_STATUS_VARIANT[status]] : "hover:bg-muted",
                        )}
                      >
                        <input
                          type="radio"
                          name={`attendance-${student.id}`}
                          value={status}
                          checked={chosen}
                          onChange={() =>
                            setChosen((previous) => ({ ...previous, [student.id]: status }))
                          }
                          className="sr-only"
                        />
                        {chosen ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                        {tStatus(status)}
                      </label>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      {/* Held at the bottom of the screen on a long roster, so the teacher
          does not scroll back past thirty pupils to save. */}
      <div className="sticky bottom-0 z-10 bg-background py-3">
        <Button
          className="w-full"
          size="lg"
          onClick={submit}
          disabled={recordedCount === 0 || report.isPending}
        >
          {report.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t("submitting")}
            </>
          ) : (
            <>
              <Check aria-hidden="true" />
              {t("submit")}
            </>
          )}
        </Button>
      </div>
    </Page>
  );
}
