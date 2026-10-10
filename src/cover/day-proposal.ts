import { isFeasible, type CoverTarget, type PersonDay, type PersonLesson } from './cover-rules';
import type { RankReason } from './cover-rank';

/**
 * "FÖRDELA DAGEN": one proposal for every open lesson of a day, which the
 * admin reviews, unticks and applies in one transaction.
 *
 * GREEDY, IN THE GATEWAY, NO ENGINE CHANGE. A day has tens of open lessons
 * and tens of candidates; every hard rule is monotone (cover-rules.ts), so any
 * subset of a valid proposal is valid and the admin can untick freely. A
 * CP-SAT model would need an engine endpoint, a contract change and a deploy
 * of a solver that does not redeploy on merge, for a problem this solves well
 * and a person reviews anyway.
 *
 *   1. every lesson's feasible candidates, against the day as it is;
 *   2. lessons in order of fewest feasible candidates, then start, then id
 *      (most constrained first);
 *   3. each takes the best-scoring candidate still feasible against the
 *      EVOLVING day: a pick becomes a lesson of theirs, so the next pick
 *      re-checks overlap, lunch and rest, and their week counter goes up by
 *      one, which lowers their next score;
 *   4. a lesson left with nobody tries ONE augmenting swap: a candidate c who
 *      would be feasible here if their earlier pick L′ went to another
 *      feasible c′ — accepted only if both remain feasible;
 *   5. what is left is NO_FEASIBLE_CANDIDATE (nobody could ever) or CONSUMED
 *      (somebody could, but was given another lesson).
 *
 * Deterministic: every tie breaks by id, so the same input is the same
 * proposal.
 */

export interface ProposalLesson {
  lessonId: string;
  absenceId: string;
  target: CoverTarget;
  /** Who may be asked at all (active teachers, the excluded left out). */
  candidates: readonly string[];
}

export interface ProposalDeps {
  day(userId: string): PersonDay | undefined;
  /**
   * The score of `userId` for `lesson`, given the lessons already given to
   * them in this proposal (`picked`): their presence and counter move.
   */
  score(lesson: ProposalLesson, userId: string, picked: readonly PersonLesson[]): { score: number; reasons: RankReason[]; week: number };
}

export interface ProposalItem {
  lessonId: string;
  absenceId: string;
  userId: string;
  score: number;
  reasons: RankReason[];
}

export interface ProposalUnassigned {
  lessonId: string;
  absenceId: string;
  why: 'NO_FEASIBLE_CANDIDATE' | 'CONSUMED';
}

export interface DayProposal {
  items: ProposalItem[];
  unassigned: ProposalUnassigned[];
}

const asPick = (lesson: ProposalLesson): PersonLesson => ({
  id: lesson.target.id,
  date: lesson.target.date,
  start: lesson.target.start,
  end: lesson.target.end,
  status: 'SCHEDULED',
  studentGroupId: '',
  subjectId: '',
});

export function proposeDay(lessons: readonly ProposalLesson[], deps: ProposalDeps): DayProposal {
  const picks = new Map<string, ProposalLesson[]>();
  const pickedOf = (userId: string) => (picks.get(userId) ?? []).map(asPick);
  const feasible = (lesson: ProposalLesson, userId: string, picked: readonly PersonLesson[]) => {
    const day = deps.day(userId);
    return day !== undefined && isFeasible(day, lesson.target, picked);
  };

  const initial = new Map(
    lessons.map((lesson) => [lesson.lessonId, lesson.candidates.filter((userId) => feasible(lesson, userId, [])).length]),
  );
  const order = [...lessons].sort(
    (a, b) =>
      initial.get(a.lessonId)! - initial.get(b.lessonId)! ||
      a.target.start - b.target.start ||
      a.lessonId.localeCompare(b.lessonId),
  );

  const assigned = new Map<string, string>();
  const unassigned: ProposalUnassigned[] = [];

  for (const lesson of order) {
    const options = [...lesson.candidates]
      .sort()
      .filter((userId) => feasible(lesson, userId, pickedOf(userId)))
      .map((userId) => ({ userId, ...deps.score(lesson, userId, pickedOf(userId)) }))
      .sort((a, b) => b.score - a.score || a.week - b.week || a.userId.localeCompare(b.userId));
    const best = options[0];
    if (best) {
      give(best.userId, lesson);
      continue;
    }
    if (repair(lesson)) continue;
    unassigned.push({
      lessonId: lesson.lessonId,
      absenceId: lesson.absenceId,
      why: initial.get(lesson.lessonId)! === 0 ? 'NO_FEASIBLE_CANDIDATE' : 'CONSUMED',
    });
  }

  function give(userId: string, lesson: ProposalLesson): void {
    picks.set(userId, [...(picks.get(userId) ?? []), lesson]);
    assigned.set(lesson.lessonId, userId);
  }

  function take(userId: string, lesson: ProposalLesson): void {
    picks.set(
      userId,
      (picks.get(userId) ?? []).filter((entry) => entry.lessonId !== lesson.lessonId),
    );
    assigned.delete(lesson.lessonId);
  }

  function repair(lesson: ProposalLesson): boolean {
    for (const c of [...lesson.candidates].sort()) {
      for (const earlier of [...(picks.get(c) ?? [])].sort((a, b) => a.lessonId.localeCompare(b.lessonId))) {
        const without = (picks.get(c) ?? []).filter((entry) => entry.lessonId !== earlier.lessonId).map(asPick);
        if (!feasible(lesson, c, without)) continue;
        for (const other of [...earlier.candidates].sort()) {
          if (other === c) continue;
          if (!feasible(earlier, other, pickedOf(other))) continue;
          // The swap, then both checked against the state after it.
          take(c, earlier);
          give(other, earlier);
          give(c, lesson);
          const cOk = feasible(lesson, c, pickedOf(c).filter((pick) => pick.id !== lesson.target.id));
          const otherOk = feasible(earlier, other, pickedOf(other).filter((pick) => pick.id !== earlier.target.id));
          if (cOk && otherOk) return true;
          take(c, lesson);
          take(other, earlier);
          give(c, earlier);
        }
      }
    }
    return false;
  }

  const items: ProposalItem[] = [];
  for (const lesson of lessons) {
    const userId = assigned.get(lesson.lessonId);
    if (!userId) continue;
    const others = pickedOf(userId).filter((pick) => pick.id !== lesson.target.id);
    const scored = deps.score(lesson, userId, others);
    items.push({ lessonId: lesson.lessonId, absenceId: lesson.absenceId, userId, score: scored.score, reasons: scored.reasons });
  }
  items.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
  unassigned.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
  return { items, unassigned };
}
