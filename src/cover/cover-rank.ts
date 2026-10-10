import type { CoverPoolPreference, TeacherQualificationKind } from '@prisma/client';
import type { Span } from './cover-rules';

/**
 * HOW A FEASIBLE CANDIDATE IS RANKED: a documented weighted score.
 *
 * Every term adds or subtracts points and names itself with a reason code and
 * its params, which the web renders in plain Swedish ("Legitimerad i
 * Matematik för åk 7–9"). The weights, and why:
 *
 *   QUAL_LEGITIMATION +40 / QUAL_BEHORIG +30 / QUAL_TILLATEN +15
 *       Behörighet first — the old picker's first key: a legitimerad
 *       stranger beats a familiar obehörig colleague.
 *   TEACHES_SUBJECT +10 (only without a qualification)
 *       The old picker's floor: a subject teacher nobody has recorded a
 *       behörighet for is still offered, after those somebody has.
 *   TEACHES_GROUP_SUBJECT +25 / TEACHES_GROUP +12, MENTOR +8
 *       Familiarity with the class, next (aSc's contracts panel, Lectio).
 *   GAP_FILL +12 / ON_SITE +6 / NOT_ON_SITE −15, RELEASED +8
 *       Presence before fairness: calling somebody in for one lesson costs
 *       more than an uneven week. A teacher whose own lesson at that time is
 *       cancelled is free and already in the building — on site, though the
 *       cancelled lesson is no longer among the day's lessons.
 *   AT_EVENT −20 (instead of RELEASED)
 *       A lesson cancelled for an activity the school names (EVENT: prao,
 *       friluftsdag, studiedag) frees its time by the hard rules, as every
 *       cancellation does, but its teacher may well be out with the class.
 *       A wish-like penalty and a reason the admin reads, not a filter:
 *       during prao the teacher is in school and free.
 *   COUNTER_WEEK −5 each (cap −25), COUNTER_TERM −1 each (cap −15)
 *       Untis' Vertretungszähler: after two or three covers in a week a
 *       teacher drops below the next qualification tier.
 *   UNDER_TARGET +6 / OVER_TARGET −20
 *       This week's calendar minutes plus the lesson against the Fas 1–3
 *       target, with the policy's tolerance on the upper side.
 *   POOL_PREFERRED +20 / POOL 0 / POOL_LAST −40 (by CoverSettings)
 *       LAST_RESORT is also a TIER: a pool vikarie (no post) is ranked after
 *       every feasible colleague, whatever the points — what "Använd poolen
 *       sist" promises the school. Points alone could not: a legitimerad
 *       pool vikarie at −15 outranked a free colleague who was over target
 *       with two covers this week, at −30. The −40 stays as the reason the
 *       list shows.
 *   PREFERS_FREE −10
 *       A PREFERRED_FREE row is a wish, never a filter.
 *
 * Sorted by tier, then score, then fewer covers this week, then id: two
 * loads of the same day agree.
 */

export type RankReasonCode =
  | 'QUAL_LEGITIMATION'
  | 'QUAL_BEHORIG'
  | 'QUAL_TILLATEN'
  | 'TEACHES_SUBJECT'
  | 'TEACHES_GROUP_SUBJECT'
  | 'TEACHES_GROUP'
  | 'MENTOR'
  | 'GAP_FILL'
  | 'ON_SITE'
  | 'NOT_ON_SITE'
  | 'RELEASED'
  | 'AT_EVENT'
  | 'COUNTER_WEEK'
  | 'COUNTER_TERM'
  | 'UNDER_TARGET'
  | 'OVER_TARGET'
  | 'POOL_PREFERRED'
  | 'POOL'
  | 'POOL_LAST'
  | 'PREFERS_FREE';

export interface RankReason {
  code: RankReasonCode;
  params: Record<string, string | number>;
  points: number;
}

export interface RankInput {
  userId: string;
  kind: 'STAFF' | 'POOL';
  qualification: TeacherQualificationKind | null;
  teachesSubject: boolean;
  teachesGroupSubject: boolean;
  teachesGroup: boolean;
  mentor: boolean;
  /** The lesson to cover. */
  lesson: Span & { minutes: number };
  /** The candidate's SCHEDULED/COMPLETED lessons on the day, the cover excluded. */
  dayLessons: Span[];
  /** The group whose cancelled lesson frees them at that time, if any. */
  releasedGroup: string | null;
  /** The group whose lesson then is cancelled for an activity (EVENT), if any. */
  eventGroup?: string | null;
  counter: { week: number; term: number };
  load: { weekMinutes: number; target: number | null; tolerancePercent: number };
  poolPreference: CoverPoolPreference;
  prefersFree: boolean;
  names: { subject: string; group: string; grades: string | null };
}

export interface Ranked {
  userId: string;
  score: number;
  reasons: RankReason[];
  /** 0, or 1 for a pool vikarie the school uses last; sorted before the score. */
  tier?: number;
}

/** The tier of a candidate: a pool vikarie under LAST_RESORT comes after everybody else. */
export function poolTier(kind: 'STAFF' | 'POOL', preference: CoverPoolPreference): number {
  return kind === 'POOL' && preference === 'LAST_RESORT' ? 1 : 0;
}

export const QUALIFICATION_POINTS: Record<TeacherQualificationKind, number> = {
  LEGITIMATION: 40,
  BEHORIG: 30,
  TILLATEN: 15,
};

export function rankCandidate(input: RankInput): Ranked {
  const reasons: RankReason[] = [];
  const add = (code: RankReasonCode, points: number, params: Record<string, string | number> = {}) =>
    reasons.push({ code, params, points });
  const { subject, group, grades } = input.names;

  if (input.qualification) {
    const params: Record<string, string | number> = { subject };
    if (input.qualification !== 'TILLATEN' && grades) params.grades = grades;
    add(`QUAL_${input.qualification}` as RankReasonCode, QUALIFICATION_POINTS[input.qualification], params);
  } else if (input.teachesSubject) {
    add('TEACHES_SUBJECT', 10, { subject });
  }

  if (input.teachesGroupSubject) add('TEACHES_GROUP_SUBJECT', 25, { group, subject });
  else if (input.teachesGroup) add('TEACHES_GROUP', 12, { group });
  if (input.mentor) add('MENTOR', 8, { group });

  const before = input.dayLessons.some((span) => span.end <= input.lesson.start);
  const after = input.dayLessons.some((span) => span.start >= input.lesson.end);
  if (before && after) add('GAP_FILL', 12);
  else if (input.dayLessons.length > 0 || input.releasedGroup !== null) add('ON_SITE', 6);
  else add('NOT_ON_SITE', -15);
  if (input.releasedGroup !== null) add('RELEASED', 8, { group: input.releasedGroup });
  else if (input.eventGroup) add('AT_EVENT', -20, { group: input.eventGroup });

  if (input.counter.week > 0) add('COUNTER_WEEK', Math.max(-25, -5 * input.counter.week), { count: input.counter.week });
  if (input.counter.term > 0) add('COUNTER_TERM', Math.max(-15, -1 * input.counter.term), { count: input.counter.term });

  const { weekMinutes, target, tolerancePercent } = input.load;
  if (target !== null) {
    const withCover = weekMinutes + input.lesson.minutes;
    if (withCover > target + (target * tolerancePercent) / 100) {
      add('OVER_TARGET', -20, { minutes: Math.round(withCover - target) });
    } else if (withCover <= target) {
      add('UNDER_TARGET', 6, { minutes: Math.round(target - weekMinutes) });
    }
  }

  if (input.kind === 'POOL') {
    if (input.poolPreference === 'PREFER') add('POOL_PREFERRED', 20);
    else if (input.poolPreference === 'LAST_RESORT') add('POOL_LAST', -40);
    else add('POOL', 0);
  }
  if (input.prefersFree) add('PREFERS_FREE', -10);

  return {
    userId: input.userId,
    score: reasons.reduce((sum, reason) => sum + reason.points, 0),
    reasons,
    tier: poolTier(input.kind, input.poolPreference),
  };
}

/** Tier asc, then score desc, then fewer covers this week, then id. */
export function compareRanked(
  a: Ranked & { counter: { week: number } },
  b: Ranked & { counter: { week: number } },
): number {
  return (
    (a.tier ?? 0) - (b.tier ?? 0) ||
    b.score - a.score ||
    a.counter.week - b.counter.week ||
    a.userId.localeCompare(b.userId)
  );
}

