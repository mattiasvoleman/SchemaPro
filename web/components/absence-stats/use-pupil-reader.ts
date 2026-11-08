"use client";

import { useProfile } from "@/components/profile-context";
import { NO_PUPILS_FOR_THE_READER } from "@/lib/absence-stats";
import { ApiError } from "@/lib/api";

/**
 * Whether the signed-in person is the huvudman's läsare at this school: an
 * administrator with no row of their own there, who reads the school through
 * the huvudman's membership (the login's school list names the huvudman for
 * the school the page is drawn for). The gateway and the database refuse such
 * a reader every pupil (403 ABSENCE_STATS_NO_PUPILS_FOR_THE_READER), so the
 * pages do not offer the pupil list or the pupil card, and say why. A school's
 * own läsare is an ordinary administrator for this question.
 *
 * It is the page's courtesy, not its protection: a refusal that arrives
 * anyway is read as the same explanation (see isReaderRefusal).
 */
export function useIsHuvudmanReader(): boolean {
  const { profile, schools } = useProfile();
  return (schools ?? []).some((school) => school.schoolId === profile.schoolId && Boolean(school.huvudman));
}

/** The gateway's refusal of a pupil to the huvudman's läsare: the page that asked says why, not that it failed. */
export function isReaderRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === NO_PUPILS_FOR_THE_READER;
}
