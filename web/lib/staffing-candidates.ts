import type { GradeSpan } from "@/lib/grade-span";
import { qualificationCovers, type JudgedYear } from "@/lib/standard-week";
import type { LoadQualification, TeacherLoad } from "@/lib/teacher-load";
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

/** Strongest first, so the badge names the best claim the teacher has and the pickers list it first. */
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
  year: JudgedYear,
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

/**
 * The order the pickers list the candidates in: the strongest behörighet for
 * the row first — Legitimation, Behörig, Tillåten, then none — and within
 * each, the order the teachers came in (the roster's, by name).
 *
 * KEY (1) OF FÖRESLÅ LÄRARE and nothing more. The gateway ranks by the same
 * kinds in the same order (suggest-teachers.ts) from the same cover rule, so
 * the dialog and the tjänstefördelning's list never disagree about who comes
 * first on behörighet. Its later keys stay there: last year's teacher is not
 * computed on this route (it sits at its budget), and sorting by minutes left
 * would move names for a reason the admin weighs themselves.
 *
 * STABLE, so a teacher moves only for the word written beside them: two
 * names with the same badge keep their places. A school with no behörighet
 * rows has no badge to sort by and keeps the roster's order — the gateway
 * falls back to "already teaches the subject" there, which this line does not
 * say, and a list ordered by something it does not show reads as shuffled.
 */
export function strongestFirst<T>(
  teachers: readonly T[],
  qualificationOf: (teacher: T) => CandidateQualification,
): T[] {
  return teachers
    .map((teacher) => {
      const qualification = qualificationOf(teacher);
      return { teacher, rank: qualification.recorded && qualification.kind ? KIND_RANK[qualification.kind] : 0 };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.teacher);
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
