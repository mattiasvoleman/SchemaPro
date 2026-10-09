"use client";

import { useTranslations } from "next-intl";
import { Printer } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { formatPercent } from "@/lib/staffing-view";
import { useTeacherDuties } from "@/lib/staffing-queries";
import type { LoadModel, TeacherLoad, UnqualifiedAssignment } from "@/lib/teacher-load";
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
import { DutiesCard } from "@/components/staffing/duties-card";
import { AnnualCard } from "@/components/staffing/annual-card";
import { EmploymentHistoryCard } from "@/components/staffing/employment-history-card";
import {
  TeacherRequirementsCard,
  type TeacherRequirementRow,
} from "@/components/staffing/teacher-requirements-card";

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
  /** The year's timplansposter; the drawer lists the ones this teacher carries. */
  requirements: TeacherRequirementRow[];
  /** The year's groups, for the names and the mentorskap picker. */
  groups: { id: string; name: string }[];
  teacherName: (userId: string) => string;
  /** The report's model: under FACTOR the teaching figures are räknad tid. */
  loadModel?: LoadModel;
  /** A person's name, or null when the people list has none (Historik's actor). */
  personName?: (userId: string) => string | null;
}

/**
 * One teacher, in full: the bar, the post, the behörigheter, the uppdrag, the
 * timplansposter they carry (each one can be handed on from here — Fas 2's
 * "change a row's teacher from the drawer") and the subjects.
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
  requirements,
  groups,
  teacherName,
  loadModel = "MINUTES",
  personName = () => null,
}: TeacherDrawerProps) {
  const t = useTranslations("staffing");
  // The same query (and cache entry) DutiesCard reads: Historik names an
  // uppdrag whose version does not carry its label by today's label.
  const { data: duties } = useTeacherDuties(academicYearId, teacher.id);
  const name = `${teacher.firstName} ${teacher.lastName}`;
  const subjectName = (id: string) => subjects.find((subject) => subject.id === id)?.name ?? "—";
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? "—";

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
                ? t("drawerSubtitleNoTarget", { assigned: load.countedMinutesPerWeek })
                : t("drawerSubtitle", {
                    percent: formatPercent(load.percentOfTarget),
                    // Counted, since Fas 2: what the percentage and the status read.
                    assigned: load.countedMinutesPerWeek,
                    target: load.targetMinutesPerWeek,
                  })}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {load ? <LoadBar teacher={load} /> : null}

        <Link
          href={`/admin/staffing/uppdragsbeskrivning?teacher=${encodeURIComponent(teacher.id)}&year=${encodeURIComponent(academicYearId)}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <Printer className="size-4" aria-hidden="true" />
          {t("printUppdrag")}
        </Link>

        <EmploymentCard
          teacher={teacher}
          academicYearId={academicYearId}
          academicYearName={academicYearName}
          employment={employment}
          policy={policy}
        />

        <QualificationsCard teacher={teacher} qualifications={qualifications} subjects={subjects} />

        <DutiesCard
          teacher={teacher}
          academicYearId={academicYearId}
          academicYearName={academicYearName}
          subjects={subjects}
          groups={groups}
        />

        <TeacherRequirementsCard
          teacherId={teacher.id}
          rows={requirements}
          subjectName={subjectName}
          groupName={groupName}
          teacherName={teacherName}
        />

        {load && load.subjects.length > 0 ? (
          <section className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 font-semibold">
              {loadModel === "FACTOR" ? t("drawerSubjectsFactor") : t("drawerSubjects")}
            </h3>
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
            {unqualified.length > 0 ? (
              <p className="mt-2 text-sm font-medium text-destructive">
                {t("drawerUnqualified", { count: unqualified.length })}:{" "}
                {unqualified.map((row) => `${row.groupName} · ${row.subjectName}`).join(", ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {load ? <AnnualCard annual={load.annual} loadModel={loadModel} showSettingsPath /> : null}

        <EmploymentHistoryCard
          userId={teacher.id}
          academicYearId={academicYearId}
          personName={personName}
          subjectName={(id) => subjects.find((subject) => subject.id === id)?.name ?? null}
          groupName={(id) => groups.find((group) => group.id === id)?.name ?? null}
          dutyLabel={(id) => duties?.find((duty) => duty.id === id)?.label ?? null}
        />
      </DialogContent>
    </Dialog>
  );
}
