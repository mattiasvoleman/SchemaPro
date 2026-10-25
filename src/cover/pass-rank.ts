import type { CoverPoolPreference } from '@prisma/client';
import { rankCandidate, type RankReason, type Ranked } from './cover-rank';
import type { Span } from './cover-rules';

/**
 * HOW A CANDIDATE FOR A RASTVAKTSPASS IS RANKED (Rastvakt i vardagen,
 * 20261210090000): the lesson's weighted score (cover-rank.ts), with what a
 * lesson has and a pass has not left out, and two terms of the pass's own.
 *
 * Kept from the lesson's, with their weights and their reasons:
 *
 *   TRAVEL_TOO_SHORT −20 each
 *       The walk between the area's skolområde and the candidate's lesson
 *       before or after the pass, longer than the gap. First, as there.
 *   GAP_FILL +12 / ON_SITE +6 / NOT_ON_SITE −15, RELEASED +8 / AT_EVENT −20
 *       Presence before fairness, for twenty minutes even more than for an
 *       hour: calling somebody in for a rast costs the school a whole trip.
 *       The candidate's own passes that day count as being there.
 *   COUNTER_WEEK −5 each (cap −25), COUNTER_TERM −1 each (cap −15)
 *       Who has been asked: the lessons AND the passes the candidate has
 *       covered, in the week and the term. (The lessons' own ranking still
 *       counts lessons only; a follow-up may widen it.)
 *   POOL_PREFERRED / POOL / POOL_LAST, and the LAST_RESORT tier
 *   PREFERS_FREE −10, FREE_DAY_WISH −10
 *
 * Left out:
 *
 *   * behörighet, the subject and the class (QUAL_*, TEACHES_*, MENTOR): a
 *     pass has no subject and no class.
 *   * UNDER_TARGET / OVER_TARGET: a pass is not teaching (an area that
 *     counts as teaching aside), and its fifteen or twenty minutes move no
 *     weekly target by a tier.
 *
 * The pass's own:
 *
 *   KNOWS_AREA +10
 *       The candidate has a pass of their own in the same area this läsår:
 *       they know the place, its gates and its pupils.
 *   TEACHES_STAGE +8
 *       The candidate teaches a class in the area's årskurser (the läsår's
 *       timplansposter, read in NIOARIG): the pupils on the yard know them.
 *       Below KNOWS_AREA, which is the place itself.
 *
 * Sorted as the lesson's (compareRanked): tier, score, fewer covers this
 * week, id.
 */

export interface PassRankInput {
  userId: string;
  kind: 'STAFF' | 'POOL';
  /** The pass on its date. */
  pass: Span & { minutes: number };
  /** The candidate's lessons that hold their time on the day, and their own passes then. */
  dayLessons: Span[];
  releasedGroup: string | null;
  eventGroup: string | null;
  /** Lessons and passes covered. */
  counter: { week: number; term: number };
  poolPreference: CoverPoolPreference;
  prefersFree: boolean;
  wishesFreeDay: boolean;
  travel: readonly { from: string; to: string; minutes: number; gap: number }[];
  /** The area's name, when the candidate has a pass of their own there. */
  knowsArea: string | null;
  /** The årskurser, as a reason states them, when the candidate teaches a class in the area's span. */
  teachesStage: string | null;
}

export function rankPassCandidate(input: PassRankInput): Ranked {
  const base = rankCandidate({
    userId: input.userId,
    kind: input.kind,
    qualification: null,
    teachesSubject: false,
    teachesGroupSubject: false,
    teachesGroup: false,
    mentor: false,
    lesson: input.pass,
    dayLessons: input.dayLessons,
    releasedGroup: input.releasedGroup,
    eventGroup: input.eventGroup,
    counter: input.counter,
    load: { weekMinutes: 0, target: null, tolerancePercent: 0 },
    poolPreference: input.poolPreference,
    prefersFree: input.prefersFree,
    wishesFreeDay: input.wishesFreeDay,
    travel: input.travel,
    names: { subject: '', group: '', grades: null },
  });
  const own: RankReason[] = [];
  if (input.knowsArea !== null) own.push({ code: 'KNOWS_AREA', params: { area: input.knowsArea }, points: 10 });
  if (input.teachesStage !== null) own.push({ code: 'TEACHES_STAGE', params: { grades: input.teachesStage }, points: 8 });
  // After the walks, which stay first (the proposal and the list show the first reasons).
  const walks = base.reasons.filter((reason) => reason.code === 'TRAVEL_TOO_SHORT');
  const rest = base.reasons.filter((reason) => reason.code !== 'TRAVEL_TOO_SHORT');
  const reasons = [...walks, ...own, ...rest];
  return { ...base, reasons, score: reasons.reduce((sum, reason) => sum + reason.points, 0) };
}
