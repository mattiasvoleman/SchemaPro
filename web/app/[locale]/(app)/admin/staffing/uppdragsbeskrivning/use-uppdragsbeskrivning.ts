"use client";

import { useAcademicYears, useGroups, usePeople, useSubjects } from "@/lib/queries";
import { useStaffingLoad, useTeacherDuties } from "@/lib/staffing-queries";
import { useEmploymentHistory } from "@/lib/staffing-history-queries";
import { versionStampOf } from "@/lib/employment-history-view";

/**
 * What the admin's uppdragsbeskrivning reads, for one teacher and one läsår:
 * the year's load report (the teacher's row is the one source of every
 * figure), the teacher's uppdrag, their history's newest version, and the
 * names. Page-specific, so it lives beside the page.
 *
 * NO FALLBACK. `row` is the row whose userId IS the asked teacher, or null —
 * never the first row, never another teacher's (C18): a printed paper with a
 * colleague's tjänst under a name is the one failure this page cannot have.
 */
export function useAdminUppdragsbeskrivning(teacherId: string | null, yearId: string | null) {
  const years = useAcademicYears();
  const load = useStaffingLoad(yearId);
  const duties = useTeacherDuties(teacherId ? yearId : null, teacherId);
  const people = usePeople();
  const subjects = useSubjects();
  const groups = useGroups();
  const history = useEmploymentHistory(teacherId, yearId);

  const row = teacherId ? (load.data?.teachers.find((teacher) => teacher.userId === teacherId) ?? null) : null;
  const person = teacherId ? (people.data?.find((candidate) => candidate.id === teacherId) ?? null) : null;
  const year = years.data?.find((candidate) => candidate.id === yearId) ?? null;

  return {
    isLoading: years.isLoading || load.isLoading || duties.isLoading,
    isError: years.isError || load.isError || duties.isError,
    row,
    loadModel: load.data?.loadModel ?? "MINUTES",
    yearName: year?.name ?? null,
    teacherName: person ? `${person.firstName} ${person.lastName}` : (row?.employment?.signature ?? null),
    // Their own only: the gateway filters by userId, and so does this.
    duties: (duties.data ?? []).filter((duty) => duty.userId === teacherId),
    subjectName: (id: string) => subjects.data?.find((subject) => subject.id === id)?.name ?? null,
    groupName: (id: string) => groups.data?.find((group) => group.id === id)?.name ?? null,
    // Never stops the page; a read in flight or failed is said as such, and
    // only a successful read can say "no version" (versionStampOf).
    version: versionStampOf(history),
  };
}
