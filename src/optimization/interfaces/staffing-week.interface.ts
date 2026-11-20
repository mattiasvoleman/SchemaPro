import type { ChoiceCount } from './week-check-choice.interface';
import type { WeekCheckVerdict } from './week-check.interface';

/*
 * FÖRESLÅ BEMANNING: THE WEEK BEFORE AND AFTER A PROPOSAL
 * (POST /api/v1/optimization/staffing/proposal/week).
 *
 * The engine is not asked anything new: every figure is the answer of its own /check-week to the week as Generera
 * would send it, once as it stands and once with the proposed leads laid over it (staffing-week.ts). Mirrored by hand
 * in web/lib/staffing-week.ts. The figures are ChoiceCounts, so what is said of them in week-check-choice.interface.ts
 * holds here: a figure is a lower bound on the tightest period of its year, and a figure over the supply is only the
 * first period the engine refused, so two of them are never set in order.
 *
 * ADVICE, NOT A GATE. Nothing here refuses a proposal and nothing is written. A check that could not be made is an
 * answer of its own (`NOT_CHECKED` and why), not an error, so that the proposal and its apply go on without it.
 */

/**
 * How a year's week after the proposal stands to its week before.
 *
 *  - `TIGHTER`: provably heavier, or over the supply where it was not.
 *  - `LOOSER`:  provably lighter, or under the supply where it was over.
 *  - `SAME`:    the same figure.
 *  - `STILL_OVER`: over the supply before and after. Each is only a lower bound on its tightest period (the engine stops
 *    at the first period it refuses), so nothing can be said of which is heavier.
 *  - `NEWLY_REFUSED`: the engine refuses the week after the proposal for a reason other than the week's load (a hall,
 *    a teacher's hours, the class hours) and did not before. Said as a warning, with the sentence.
 *  - `NOT_COMPARED`: at least one of the two is not a value (the seconds ran out, the year was not reached, or the week
 *    was refused before): both are shown, neither is set against the other. Never "better".
 */
export type StaffingWeekVerdict = 'TIGHTER' | 'LOOSER' | 'SAME' | 'STILL_OVER' | 'NEWLY_REFUSED' | 'NOT_COMPARED';

export const STAFFING_WEEK_VERDICTS: readonly StaffingWeekVerdict[] = [
  'TIGHTER',
  'LOOSER',
  'SAME',
  'STILL_OVER',
  'NEWLY_REFUSED',
  'NOT_COMPARED',
];

/** One year of the week, before and after. */
export interface StaffingWeekYear {
  /** In the läsår's own numbering. */
  year: number;
  /** The week as it stands: counted in this call, so the two figures are made together. */
  before: ChoiceCount;
  /** The week with the proposal's leads laid over it. */
  after: ChoiceCount;
  verdict: StaffingWeekVerdict;
}

/**
 * Why no figure was made. `NO_CHANGES`: nothing is selected, so the week is as it stands. `NOT_READY`: the gateway's own
 * pre-flight refuses the week (a block partly locked, two blocks on the same times that no longer fit), as it refuses a
 * Generera. `NO_POSTS`: every post is hand-placed, so there is nothing to ask. `ENGINE_OLDER`: an engine without the
 * check. `ENGINE_ERROR`: the engine answered an error or nothing. `TOO_SLOW`: the first check took what the time
 * allowed and left none for the second.
 */
export type StaffingWeekReason = 'NO_CHANGES' | 'NOT_READY' | 'NO_POSTS' | 'ENGINE_OLDER' | 'ENGINE_ERROR' | 'TOO_SLOW';

export const STAFFING_WEEK_REASONS: readonly StaffingWeekReason[] = [
  'NO_CHANGES',
  'NOT_READY',
  'NO_POSTS',
  'ENGINE_OLDER',
  'ENGINE_ERROR',
  'TOO_SLOW',
];

/** What became of the selected changes when they were laid over the week. */
export interface StaffingWeekOverlay {
  /** The changes asked about. */
  given: number;
  /** Changes laid over a post of the week. */
  laidOver: number;
  /**
   * Changes that did not change the week and were left out: a post the engine is not sent (written at another post's
   * times, or with every lesson placed), or a lead the payload does not carry on the post (a shared post whose lessons
   * are another teacher's). They are not a problem; they are said so that "nothing changed" is not read as "nothing
   * was asked".
   */
  notLaidOver: number;
  /** Of the laid-over changes, the posts nobody teaches today: their week "before" is counted with no teacher on them. */
  fromNobody: number;
  /**
   * Teachers who get a post and have nothing else in the week's payload (no post, lock or reservation): the week
   * after counts only their new posts, and what the engine could have known of them is not in it.
   */
  newToTheWeek: number;
}

export interface StaffingWeekView {
  /** `DONE`: a figure was made before and after. `NOT_CHECKED`: none was, and `reason` says why. */
  status: 'DONE' | 'NOT_CHECKED';
  reason?: StaffingWeekReason;
  /** The years the changes touch that are at or over the tight threshold before or after, the heaviest first. */
  years: StaffingWeekYear[];
  /**
   * The engine's verdict for the whole week, before and after: `IMPOSSIBLE` also for a refusal that names no year.
   * Null when the figure was not made.
   */
  verdicts: { before: WeekCheckVerdict; after: WeekCheckVerdict } | null;
  /** The proposal makes the week provably tighter in some year, or makes the engine refuse it. The warning. */
  worse: boolean;
  /**
   * The digest to apply with when this figure was shown: the proposal's own basis and the week's (withWeekBasis). An
   * apply that sends it is refused as stale if the week has changed since. Null when no figure was made; the proposal's
   * own basis then stands, as it did before this existed.
   */
  basisSha256: string | null;
  overlay: StaffingWeekOverlay;
  /** /check-week calls made (the week as it stands, and with the proposal). */
  calls: number;
  elapsedMs: number;
}
