"use client";

import { useStaffingLoad } from "@/lib/staffing-queries";
import type { AcademicYear } from "@/lib/types";

/**
 * The teacher's own figures for the läsår this one was rolled from (staffing
 * Fas 5), for the one line "Förra läsåret" on Min tjänst.
 *
 * The same GET /staffing/load the page reads for this year, with the
 * predecessor's id: the gateway answers a TEACHER with their own row only,
 * so nothing here filters a colleague away — the userId match below is for
 * a SCHOOL_ADMIN who teaches and opens the page, as the page's own is.
 *
 * Null without a predecessor, without a row there, or when the read fails:
 * the line is a comparison, and a missing comparison is said by its absence,
 * never by a zero.
 */
export function useLastYearTjanst(
  years: readonly Pick<AcademicYear, "id" | "name">[] | undefined,
  activeYear: Pick<AcademicYear, "predecessorId"> | null,
  userId: string,
) {
  const predecessor = years?.find((year) => year.id === activeYear?.predecessorId) ?? null;
  const load = useStaffingLoad(predecessor?.id ?? null);
  const row = load.data?.teachers.find((teacher) => teacher.userId === userId) ?? null;
  return predecessor && row ? { yearName: predecessor.name, row } : null;
}
