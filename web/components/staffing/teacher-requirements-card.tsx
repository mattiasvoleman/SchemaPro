"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeftRight, BookOpen } from "lucide-react";
import type { StaffingWarning } from "@/lib/types";
import { formatLengths } from "@/lib/lesson-lengths-text";
import { lessonCountOf } from "@/lib/lesson-lengths";
import { teacherPartsOf, type LessonShare } from "@/lib/lesson-shares";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { TeacherSuggestions } from "@/components/staffing/teacher-suggestions";
import { WarningsNotice } from "@/components/staffing/staffing-notices";

export interface TeacherRequirementRow {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** Lektionslängder, longest first; empty or absent when uniform. */
  lessonLengths?: number[];
  /** Delade lektioner: the lessons other teachers take; absent when nobody shares. */
  shares?: LessonShare[];
}

/**
 * The timplansposter one teacher carries, and the place to hand one on.
 *
 * "Byt lärare" opens the same ranked list the unstaffed panel uses, with this
 * teacher marked as the current one — so the question asked is the right one:
 * who ELSE could take 7A Ma, and what would it do to them. Only the rows they
 * LEAD can be handed on here; a co-teaching row is listed for completeness
 * and changed in the timplan's own dialog, where both teachers are visible.
 * So is a row they take some of the lessons of (delade lektioner), with how
 * many: "1 av 3 lektioner" — the split itself is the timplan dialog's too.
 *
 * A WARN verdict on the handover is shown in this card, not as a toast: the
 * sentence names the subject and the limit, and the admin needs it on screen
 * long enough to decide whether to undo.
 */
export function TeacherRequirementsCard({
  teacherId,
  rows,
  subjectName,
  groupName,
  teacherName,
}: {
  teacherId: string;
  rows: TeacherRequirementRow[];
  subjectName: (id: string) => string;
  groupName: (id: string) => string;
  teacherName: (userId: string) => string;
}) {
  const t = useTranslations("staffing");
  const [openId, setOpenId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<StaffingWarning[]>([]);

  const mine = rows
    .filter(
      (row) =>
        row.teacherId === teacherId ||
        row.coTeacherId === teacherId ||
        (row.shares ?? []).some((share) => share.teacherId === teacherId),
    )
    .map((row) => ({ row, label: `${groupName(row.studentGroupId)} · ${subjectName(row.subjectId)}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "sv"));

  return (
    <SectionCard
      id={`requirements-${teacherId}`}
      headingLevel={3}
      icon={BookOpen}
      title={t("teacherRowsTitle")}
      description={t("teacherRowsHint")}
    >
      <WarningsNotice warnings={warnings} onDismiss={() => setWarnings([])} />
      {mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("teacherRowsEmpty")}</p>
      ) : (
        <ul className="divide-y text-sm">
          {mine.map(({ row, label }) => {
            const leads = row.teacherId === teacherId;
            const coTeaches = row.coTeacherId === teacherId;
            // Delade lektioner: this teacher's own lessons of a shared row.
            const own = (row.shares ?? []).length > 0 && !coTeaches
              ? (teacherPartsOf(row).find((part) => part.teacherId === teacherId)?.lessons ?? null)
              : null;
            const open = openId === row.id;
            return (
              <li key={row.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{label}</span>{" "}
                    <span className="text-muted-foreground">
                      {t("teacherRowLessons", { post: formatLengths(row) })}
                      {coTeaches ? ` · ${t("teacherRowCoTeacher")}` : ""}
                      {own !== null ? ` · ${t("teacherRowShare", { lessons: own, of: lessonCountOf(row) })}` : ""}
                    </span>
                  </span>
                  {leads ? (
                    <Button
                      size="sm"
                      variant={open ? "secondary" : "outline"}
                      aria-expanded={open}
                      aria-controls={`handover-${row.id}`}
                      aria-label={t("changeTeacherFor", { row: label })}
                      onClick={() => setOpenId(open ? null : row.id)}
                      data-writes="PLANERING"
                    >
                      <ArrowLeftRight />
                      {t("changeTeacher")}
                    </Button>
                  ) : null}
                </div>
                {open ? (
                  <div id={`handover-${row.id}`} className="mt-2">
                    <TeacherSuggestions
                      requirementId={row.id}
                      currentTeacherId={teacherId}
                      teacherName={teacherName}
                      onAssigned={(result) => {
                        setOpenId(null);
                        setWarnings(result.warnings);
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
