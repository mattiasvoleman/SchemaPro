"use client";

import { useActiveYear, useGroups, useSubjects } from "@/lib/queries";
import { useStaffingLoad, useTeacherDuties } from "@/lib/staffing-queries";
import { useEmploymentHistory } from "@/lib/staffing-history-queries";
import { latestVersion } from "@/lib/employment-history-view";

/**
 * What the teacher's own uppdragsbeskrivning reads: the same own-row report
 * and own uppdrag as Min tjänst, and the teacher's own history for the
 * version stamp (GET history for their own id — the one a teacher may ask
 * for). `userId` is the session's profile id, never a parameter. The year is
 * the asked one when the school has it, else the active year.
 */
export function useMyUppdragsbeskrivning(userId: string, askedYearId: string | null) {
  const years = useActiveYear();
  const year =
    years.data?.find((candidate) => candidate.id === askedYearId) ?? years.activeYear ?? null;
  const yearId = year?.id ?? null;
  const load = useStaffingLoad(yearId);
  const duties = useTeacherDuties(yearId, userId);
  const subjects = useSubjects();
  const groups = useGroups();
  const history = useEmploymentHistory(userId, yearId);

  return {
    isLoading: years.isLoading || (yearId !== null && (load.isLoading || duties.isLoading)),
    isError: years.isError || load.isError || duties.isError,
    yearName: year?.name ?? null,
    // An admin who teaches reads the whole school's report: their own row only.
    row: load.data?.teachers.find((teacher) => teacher.userId === userId) ?? null,
    loadModel: load.data?.loadModel ?? "MINUTES",
    duties: (duties.data ?? []).filter((duty) => duty.userId === userId),
    subjectName: (id: string) => subjects.data?.find((subject) => subject.id === id)?.name ?? null,
    groupName: (id: string) => groups.data?.find((group) => group.id === id)?.name ?? null,
    version: latestVersion(history.data?.entries),
  };
}
