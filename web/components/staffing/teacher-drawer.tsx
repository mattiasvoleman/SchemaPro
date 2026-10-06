"use client";

import { useTranslations } from "next-intl";
import { formatPercent } from "@/lib/staffing-view";
import type { TeacherLoad, UnqualifiedAssignment } from "@/lib/teacher-load";
import type {
  StaffingPolicy,
  Subject,
  TeacherEmployment,
  TeacherQualification,
} from "@/lib/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { EmploymentCard } from "@/components/staffing/employment-card";
import { QualificationsCard } from "@/components/staffing/qualifications-card";
import { LoadBar } from "@/components/staffing/load-bar";
import { StatusBadge } from "@/components/staffing/staffing-matrix";

export interface TeacherDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teacher: { id: string; firstName: string; lastName: string };
  load: TeacherLoad | undefined;
  unqualified: UnqualifiedAssignment[];
  employment: TeacherEmployment | null | undefined;
  qualifications: TeacherQualification[] | undefined;
  policy: StaffingPolicy | null | undefined;
  subjects: Subject[];
  academicYearId: string;
  academicYearName: string;
}

/**
 * One teacher, in full: the bar, the post, the behörigheter and the subjects.
 *
 * A side panel rather than a centred dialog, because the matrix stays
 * readable behind it: an admin compares the row they opened with its
 * neighbours while editing the post. Built on the same Dialog primitive the
 * rest of the app uses, repositioned — a second overlay implementation would
 * be a second Escape ordering to get wrong.
 */
export function TeacherDrawer({
  open,
  onOpenChange,
  teacher,
  load,
  unqualified,
  employment,
  qualifications,
  policy,
  subjects,
  academicYearId,
  academicYearName,
}: TeacherDrawerProps) {
  const t = useTranslations("staffing");
  const name = `${teacher.firstName} ${teacher.lastName}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="inset-y-0 left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-xl translate-x-0 translate-y-0 rounded-none data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:rounded-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {name}
            {load ? <StatusBadge status={load.status} /> : null}
          </DialogTitle>
          {load ? (
            <DialogDescription>
              {load.targetMinutesPerWeek === null || load.percentOfTarget === null
                ? t("drawerSubtitleNoTarget", { assigned: load.assignedMinutesPerWeek })
                : t("drawerSubtitle", {
                    percent: formatPercent(load.percentOfTarget),
                    assigned: load.assignedMinutesPerWeek,
                    target: load.targetMinutesPerWeek,
                  })}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {load ? <LoadBar teacher={load} /> : null}

        <EmploymentCard
          teacher={teacher}
          academicYearId={academicYearId}
          academicYearName={academicYearName}
          employment={employment}
          policy={policy}
        />

        <QualificationsCard teacher={teacher} qualifications={qualifications} subjects={subjects} />

        {load && load.subjects.length > 0 ? (
          <section className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 font-semibold">{t("drawerSubjects")}</h3>
            <ul className="space-y-1 text-sm">
              {load.subjects.map((subject) => (
                <li key={subject.subjectId} className="flex justify-between gap-3">
                  <span className="font-medium">{subject.subjectName}</span>
                  <span className="text-right text-muted-foreground">
                    {subject.percentOfEmployment === null
                      ? t("drawerSubjectRow", {
                          minutes: subject.minutesPerWeek,
                          share: formatPercent(subject.shareOfTeaching * 100),
                        })
                      : t("drawerSubjectRowEmployment", {
                          minutes: subject.minutesPerWeek,
                          share: formatPercent(subject.shareOfTeaching * 100),
                          percent: formatPercent(subject.percentOfEmployment),
                        })}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("drawerAnnual", { hours: formatPercent(load.annual.assignedHoursPerYear) })}
            </p>
            {unqualified.length > 0 ? (
              <p className="mt-2 text-sm font-medium text-destructive">
                {t("drawerUnqualified", { count: unqualified.length })}:{" "}
                {unqualified.map((row) => `${row.groupName} · ${row.subjectName}`).join(", ")}
              </p>
            ) : null}
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
