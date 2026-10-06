import type { GradeSpan } from "@/lib/grade-span";
import {
  qualificationCovers,
  type LoadQualification,
  type TeacherLoad,
} from "@/lib/teacher-load";
import type { TeacherQualification, TeacherQualificationKind } from "@/lib/types";

/*
 * What the timplan's teacher pickers say about each candidate: the behörighet
 * they hold for THIS subject and THIS group's grades, and how many minutes
 * they have left to their target.
 *
 * INFORMATION, NOT A GATE. Nothing here refuses anybody — the policy's REFUSE
 * mode begins to bite at the write in Fas 2, on the gateway, where it belongs.
 * In this phase the dialog shows a badge and a number, and the admin decides.
 * That is also why the figure is read off the LOAD REPORT the page already
 * holds rather than recomputed: a candidate's "kvar" is what the matrix says
 * about them, and a second arithmetic here would be a second answer.
 */

/** Strongest first, so the badge names the best claim the teacher has. */
const KIND_RANK: Record<TeacherQualificationKind, number> = {
  LEGITIMATION: 3,
  BEHORIG: 2,
  TILLATEN: 1,
};

export type CandidateQualification =
  /** The school has recorded no behörighet at all, so nothing can be said. */
  | { recorded: false }
  /** The strongest kind covering the subject and span, or none. */
  | { recorded: true; kind: TeacherQualificationKind | null };

/**
 * The behörighet badge for one candidate.
 *
 * `recorded: false` when the school has no qualification rows, for the
 * reason the report leaves unqualifiedAssignments empty then: a school that
 * has recorded nothing has not said that nobody is qualified, and painting
 * "saknar behörighet" on every name would teach the admin to ignore the
 * badge. The span rule and the validity window are the report's own
 * (qualificationCovers), so the badge and the matrix's unqualified list agree.
 */
export function candidateQualification(
  qualifications: Pick<
    TeacherQualification,
    "userId" | "subjectId" | "minGradeLevel" | "maxGradeLevel" | "kind" | "validFrom" | "validTo"
  >[],
  teacherId: string,
  subjectId: string,
  gradeSpan: GradeSpan | null,
  year: { startDate: string; endDate: string },
): CandidateQualification {
  if (qualifications.length === 0) return { recorded: false };
  let best: TeacherQualificationKind | null = null;
  for (const row of qualifications) {
    if (row.userId !== teacherId) continue;
    const asLoad: LoadQualification = {
      userId: row.userId,
      subjectId: row.subjectId,
      minGradeLevel: row.minGradeLevel,
      maxGradeLevel: row.maxGradeLevel,
      kind: row.kind,
      validFrom: row.validFrom,
      validTo: row.validTo,
    };
    if (!qualificationCovers(asLoad, { subjectId, gradeSpan }, year)) continue;
    if (best === null || KIND_RANK[row.kind] > KIND_RANK[best]) best = row.kind;
  }
  return { recorded: true, kind: best };
}

export type CandidateRemaining =
  | { status: "NO_TARGET" }
  | { status: "REMAINING"; minutes: number }
  | { status: "OVER"; minutes: number };

/**
 * How far a candidate is from their target, from the report's own row.
 *
 * A teacher absent from the report (no post and no requirement yet) reads as
 * NO_TARGET too — the report would say the same the moment they were given a
 * row, and "kvar: 0" would be a claim about a target they do not have. Zero
 * balance is REMAINING 0 rather than OVER: exactly on target is not over it.
 */
export function candidateRemaining(
  report: { teachers: Pick<TeacherLoad, "userId" | "balanceMinutesPerWeek">[] } | undefined,
  teacherId: string,
): CandidateRemaining {
  const row = report?.teachers.find((teacher) => teacher.userId === teacherId);
  if (!row || row.balanceMinutesPerWeek === null) return { status: "NO_TARGET" };
  if (row.balanceMinutesPerWeek < 0) return { status: "OVER", minutes: -row.balanceMinutesPerWeek };
  return { status: "REMAINING", minutes: row.balanceMinutesPerWeek };
}
