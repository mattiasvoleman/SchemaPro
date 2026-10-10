"use client";

// "Timplaner per årskull" for /admin/timplan: the rows computed in the
// browser from the school's classes, then drawn by CohortNotice.
//
// A file of its own, loaded with lazy() by the page, for the bundle: with the
// computation and lib/timplan-cohorts.ts imported statically the route rose
// 1,5 KB (181,0 → 182,5 KB own JS, measured 2026-10-10), over the 1,0 KB the
// design review set for it. The notice is a closed reference, not what the
// page is for, so it arrives a moment after the plan.
//
// What is read: the active year's classes and its rolled successor's, and
// the reference data's versions. One difference from the Stadium tab, which
// gets the same rows from the gateway, said here rather than hidden: the
// gateway takes the school form from the plans the active year ATTACHES per
// årskurs, this page from the school's plans — the attachments are a read
// this route does not otherwise make — so a school running two school forms
// side by side could see the two disagree on which form a cohort is read in.

import { useMemo } from "react";
import { cohortNotice, htOf } from "@/lib/timplan-cohorts";
import type { SchoolForm } from "@/lib/timplan-coverage";
import type { AcademicYear, NationalTimplanVersion, StudentGroup } from "@/lib/types";
import { CohortNotice } from "@/components/timplan/cohort-notice";

export interface SchoolCohortNoticeProps {
  years: readonly AcademicYear[];
  groups: readonly Pick<StudentGroup, "id" | "academicYearId" | "name" | "kind" | "gradeLevel">[];
  versions: readonly NationalTimplanVersion[];
  /** The school's plans' forms; the most common is the form cohorts are read in. */
  planForms: readonly SchoolForm[];
  className?: string;
}

export function SchoolCohortNotice({ years, groups, versions, planForms, className }: SchoolCohortNoticeProps) {
  const rows = useMemo(() => {
    const active = years.find((entry) => entry.isActive);
    if (!active) return [];
    const successor = years.find((entry) => entry.predecessorId === active.id) ?? null;
    const htOfYear = new Map([[active.id, htOf(active.startDate)]]);
    if (successor) htOfYear.set(successor.id, htOf(successor.startDate));
    const forms = new Map<SchoolForm, number>();
    for (const form of planForms) forms.set(form, (forms.get(form) ?? 0) + 1);
    const schoolForm = [...forms].reduce<[SchoolForm, number]>((a, b) => (b[1] > a[1] ? b : a), ["GRUNDSKOLA", 0])[0];
    return cohortNotice(
      groups
        .filter((group) => group.kind === "CLASS" && htOfYear.has(group.academicYearId))
        .map((group) => ({
          id: group.id,
          name: group.name,
          gradeLevel: group.gradeLevel,
          ht: htOfYear.get(group.academicYearId)!,
        })),
      versions.map((entry) => ({
        code: entry.code,
        schoolForm: entry.schoolForm,
        appliesFromCohortTerm: entry.appliesFromCohortTerm,
        appliesBy: entry.appliesBy,
        entryCount: entry.entries.length,
      })),
      schoolForm,
    );
  }, [years, groups, versions, planForms]);
  return <CohortNotice rows={rows} className={className} />;
}
