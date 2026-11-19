import { createHash } from 'node:crypto';
import type {
  AiEngineScheduleRequest,
  AnonymousRequirement,
} from './interfaces/ai-engine-payload.interface';
import { qualificationCovers, type LoadQualification } from '../staffing/teacher-load';
import type { AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import type { ChoiceCount, ChoicePeriod } from './interfaces/week-check-choice.interface';
import { withPeriodDates, type PeriodStretch } from './year-periods';

/*
 * KONTROLLERA VECKAN, MED LÄRARVAL: the pure half. What the week would be if
 * teachers could be chosen is asked of the engine's own /check-week, with a copy
 * of Generera's payload in which some posts have another teacher, so the engine
 * is untouched and everything that is new is here, in the gateway:
 *
 *  - the FLOOR (releasePosts): every post whose subject has two or more
 *    qualified teachers for its year gets a teacher of its own, an id made from
 *    the post's (the relaxation the engine's own _parallel_groups_probe uses,
 *    `_derived_id`). No choice of teachers can do better than every post having
 *    its own, so the week this gives is a lower bound for every choice. It says
 *    that a choice MIGHT help; it never says that the week fits.
 *  - the WHAT-IFS (candidatesOf, shareWithSecond): one teacher's posts of a
 *    subject, shared with a virtual second teacher. An example split, not the
 *    best one: the floor bounds every split from below.
 *  - reading an answer for one year (countOf), and naming the period it was
 *    counted in (periodOfTightWeek), because the engine counts each period of a
 *    läsår on its own and keeps the heaviest per year.
 *
 * ONLY LEADS ARE MOVED. A post's co-teacher stays, as it does when Föreslå
 * bemanning proposes (the proposal changes the lead alone), and so does every
 * lesson another teacher takes (lessonTeacherIds): only the lead's own lessons
 * of a shared post move with the lead.
 */

/** Most what-ifs asked in one analysis. */
export const MAX_WHAT_IFS = 10;

/** Most tight years asked about; the heaviest first. */
export const MAX_YEARS = 3;

/** The engine's TIGHT_WEEK_LOAD, whole percent: a year under it has no row in an answer. */
export const TIGHT_PERCENT = 85;

/**
 * How many teachers are qualified for a subject in a year, on a day: the
 * behörigheter that cover the subject and the whole span of years
 * (qualificationCovers, the rule Föreslå bemanning offers a post by) and are
 * valid on that day. A span of null is a group whose years are unknown, which
 * any behörighet in the subject covers, as everywhere.
 *
 * ON A DAY, NOT "SOMETIME IN THE LÄSÅR". Ask it of today, or of the läsår's
 * first day for a year not begun, so that a legitimation that ended in October
 * does not count in November, and one that starts in August counts in the
 * summer's planning of the year that starts then (`judgedDay`).
 */
export function qualifiedHolders(
  qualifications: readonly LoadQualification[],
  subjectId: string,
  span: { min: number; max: number } | null,
  day: string,
): number {
  const holders = new Set<string>();
  for (const qualification of qualifications) {
    if (qualification.subjectId !== subjectId) continue;
    if (qualificationCovers(qualification, { subjectId, gradeSpan: span }, { startDate: day, endDate: day })) {
      holders.add(qualification.userId);
    }
  }
  return holders.size;
}

/** The day behörigheter are judged on: today, held inside the läsår (its first day before it, its last after it). */
export function judgedDay(today: string, yearStart: string, yearEnd: string): string {
  return today < yearStart ? yearStart : today > yearEnd ? yearEnd : today;
}

/** An id made from another and a label: the same every time, and nobody's own (the engine's `_derived_id`). */
export function derivedId(seed: string, label: string): string {
  const bytes = createHash('sha256').update(`${seed}:${label}`).digest().subarray(0, 16);
  // A UUID of version 4's shape, because the engine's ids are validated as such.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The minutes a post's lessons take in a week, as the engine counts them (every length of a split post, else the uniform one). */
export function lessonMinutesOf(requirement: AnonymousRequirement): number {
  if (requirement.lessonLengths && requirement.lessonLengths.length > 0) {
    return requirement.lessonLengths.reduce((sum, length) => sum + length, 0);
  }
  return requirement.lessonsPerWeek * requirement.minutesPerLesson;
}

/** The years a post's group holds, in the payload's numbering (NIOARIG), or null when they are unknown. */
export function spanOf(requirement: AnonymousRequirement): { min: number; max: number } | null {
  if (requirement.minGradeLevel === null || requirement.maxGradeLevel === null) return null;
  return { min: requirement.minGradeLevel, max: requirement.maxGradeLevel };
}

/** Whether a post is one of a year's, as the engine's week load reads it (`_in_year`). */
function inYear(requirement: AnonymousRequirement, year: number): boolean {
  const span = spanOf(requirement);
  return span !== null && span.min <= year && year <= span.max;
}

/** A post with its lead changed: and the lessons of a shared post that the old lead held. */
function withLead(requirement: AnonymousRequirement, to: string): AnonymousRequirement {
  const from = requirement.teacherId;
  return {
    ...requirement,
    teacherId: to,
    ...(requirement.lessonTeacherIds
      ? { lessonTeacherIds: requirement.lessonTeacherIds.map((id) => (id === from ? to : id)) }
      : {}),
  };
}

function withRequirements(
  payload: AiEngineScheduleRequest,
  changes: ReadonlyMap<string, AnonymousRequirement>,
): AiEngineScheduleRequest {
  return {
    ...payload,
    requirements: payload.requirements.map((requirement) => changes.get(requirement.id) ?? requirement),
  };
}

/**
 * THE FLOOR: the payload with a teacher of its own on every post `qualifiedOf`
 * says has two or more qualified teachers. The posts released are returned too,
 * so that a floor that released nothing is not asked about.
 */
export function releasePosts(
  payload: AiEngineScheduleRequest,
  qualifiedOf: (requirement: AnonymousRequirement) => number,
): { payload: AiEngineScheduleRequest; released: string[] } {
  const changes = new Map<string, AnonymousRequirement>();
  for (const requirement of payload.requirements) {
    if (requirement.teacherId === null || qualifiedOf(requirement) < 2) continue;
    changes.set(requirement.id, withLead(requirement, derivedId(requirement.id, 'own-teacher')));
  }
  return { payload: withRequirements(payload, changes), released: [...changes.keys()] };
}

/** One what-if: a teacher's posts of one subject in one tight year, and which of them a second teacher would take. */
export interface Candidate {
  /** In the payload's numbering. */
  year: number;
  subjectId: string;
  teacherId: string;
  /** All the teacher's posts of the subject in the year, heaviest first. */
  postIds: string[];
  /** The part of them the second teacher takes. Never empty and never all. */
  moved: string[];
  /** What the teacher carries of the subject in the year, minutes a week. */
  minutes: number;
}

/**
 * The what-ifs worth asking: for each tight year and subject, the teacher who
 * carries most of it, if they have two or more posts there to share (one post
 * cannot be shared by posts), heaviest first, at most `limit`.
 *
 * The posts are shared in the order of their minutes, each to whichever of the
 * two has the least so far (the first to the teacher, the tie to the teacher
 * too), so the second teacher gets about half and the split is the same every
 * time.
 */
export function candidatesOf(
  requirements: readonly AnonymousRequirement[],
  years: readonly number[],
  subjectOf: ReadonlyMap<string, string>,
  limit: number = MAX_WHAT_IFS,
): Candidate[] {
  const out: Candidate[] = [];
  for (const year of years) {
    const bySubject = new Map<string, Map<string, AnonymousRequirement[]>>();
    for (const requirement of requirements) {
      const subjectId = subjectOf.get(requirement.id);
      if (!subjectId || requirement.teacherId === null || !inYear(requirement, year)) continue;
      const byTeacher = bySubject.get(subjectId) ?? new Map<string, AnonymousRequirement[]>();
      byTeacher.set(requirement.teacherId, [...(byTeacher.get(requirement.teacherId) ?? []), requirement]);
      bySubject.set(subjectId, byTeacher);
    }
    for (const [subjectId, byTeacher] of bySubject) {
      let best: { teacherId: string; posts: AnonymousRequirement[]; minutes: number } | null = null;
      for (const [teacherId, posts] of byTeacher) {
        if (posts.length < 2) continue;
        const minutes = posts.reduce((sum, post) => sum + lessonMinutesOf(post), 0);
        if (
          best === null ||
          minutes > best.minutes ||
          (minutes === best.minutes && teacherId < best.teacherId)
        ) {
          best = { teacherId, posts, minutes };
        }
      }
      if (!best) continue;
      const posts = [...best.posts].sort(
        (a, b) => lessonMinutesOf(b) - lessonMinutesOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      let kept = 0;
      let taken = 0;
      const moved: string[] = [];
      for (const post of posts) {
        if (taken < kept) {
          moved.push(post.id);
          taken += lessonMinutesOf(post);
        } else {
          kept += lessonMinutesOf(post);
        }
      }
      out.push({
        year,
        subjectId,
        teacherId: best.teacherId,
        postIds: posts.map((post) => post.id),
        moved,
        minutes: best.minutes,
      });
    }
  }
  return out
    .sort(
      (a, b) =>
        b.minutes - a.minutes ||
        a.year - b.year ||
        (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0),
    )
    .slice(0, Math.max(0, limit));
}

/** The payload with a candidate's moved posts led by a virtual second teacher: nobody's own, the same every time. */
export function shareWithSecond(payload: AiEngineScheduleRequest, candidate: Candidate): AiEngineScheduleRequest {
  const second = derivedId(candidate.teacherId, `second:${candidate.subjectId}:${candidate.year}`);
  const moved = new Set(candidate.moved);
  const changes = new Map<string, AnonymousRequirement>();
  for (const requirement of payload.requirements) {
    if (moved.has(requirement.id)) changes.set(requirement.id, withLead(requirement, second));
  }
  return withRequirements(payload, changes);
}

/**
 * The period the tightest week of a year was counted in, said by the posts the
 * engine named for it.
 *
 * The engine keeps the heaviest of a year's periods and does not say which
 * (that is only said for a refusal), but the row it answers TIGHT with names
 * the posts of that week: the year's posts that run in it. A period is a real
 * set of weeks in which the same posts run, and a post's `periods` mask and
 * `recurrence` say which it is in (year-periods.ts), so the periods whose posts
 * of the year are exactly those are the ones it was counted in. Said as the
 * first stretch of days of the first of them, as a refusal names its period
 * (withPeriodDates).
 *
 * NULL when nothing can be said: a läsår not cut into periods, a year whose
 * every period holds the same posts (it is as tight in all of them), or posts
 * that no period holds exactly. A figure with no period is still the
 * tightest one's: the engine keeps the maximum, and this only names it.
 */
export function periodOfTightWeek(
  requirements: readonly AnonymousRequirement[],
  year: number,
  heldIds: readonly string[],
  stretches: readonly (readonly PeriodStretch[])[] | null,
): ChoicePeriod | null {
  if (!stretches || stretches.length < 2 || heldIds.length === 0) return null;
  const held = new Set(heldIds);
  const members = requirements.filter((requirement) => inYear(requirement, year));
  const matches: number[] = [];
  for (let period = 0; period < stretches.length; period += 1) {
    const running = members.filter(
      (requirement) => requirement.periods === undefined || requirement.periods[period] === true,
    );
    // The odd weeks of the period and its even weeks: a post that alternates runs in one of them only.
    const cells = [
      running.filter((requirement) => requirement.recurrence !== 'EVEN_WEEKS'),
      running.filter((requirement) => requirement.recurrence !== 'ODD_WEEKS'),
    ];
    if (cells.some((cell) => cell.length === held.size && cell.every((requirement) => held.has(requirement.id)))) {
      matches.push(period);
    }
  }
  if (matches.length === 0 || matches.length === stretches.length) return null;
  return periodOf(withPeriodDates({ period: matches[0]!, periods: matches.join(',') }, stretches));
}

/** A period as a refusal's params name it (`periodFrom`, `periodTo`, `periodStretches`), or null when they do not. */
export function periodOf(params: Record<string, string | number> | null | undefined): ChoicePeriod | null {
  if (!params) return null;
  const { periodFrom: from, periodTo: to, periodStretches: stretches } = params;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  return { from, to, more: typeof stretches === 'number' && stretches > 1 };
}

/**
 * A year's week as whole percent, rounded DOWN, as the engine says it
 * (`int(load * 100)`): a lower bound is never rounded up. Its demand is itself
 * rounded up to a whole slot, so a decimal would claim more than is proved.
 */
export function percentOf(demandMinutes: number, capacityMinutes: number): number {
  if (capacityMinutes <= 0) return 0;
  return Math.floor((demandMinutes * 100) / capacityMinutes);
}

/** What `countOf` reads of an answer besides its rows: the sentences of a refusal, realised and with the period in dates. */
export interface RealisedAnswer {
  /** The answer's own refusal or tight-week rows, ids still anonymous (`requirementIds`). */
  details: { code: string; params: Record<string, string | number>; requirementIds: string[] }[];
  /** The summary of a refusal with its params as the reader gets them (the period in dates). */
  summary: { code: string; params: Record<string, string | number> } | null;
}

/**
 * One year of one answer, as a count.
 *
 *  - a row for the year: `LOAD`, `atLeast` when the week load's seconds ran
 *    out (its figure is then at most what was proved by the deadline, and the
 *    year's true bound may be higher);
 *  - no row and the count finished: `UNDER` the tight threshold, unless another
 *    count refused the week, which is `REFUSED`;
 *  - no row and the seconds ran out: `UNKNOWN`, never "under".
 */
export function countOf(
  response: AiEngineWeekCheckResponse,
  year: number,
  answer: RealisedAnswer,
  requirements: readonly AnonymousRequirement[],
  stretches: readonly (readonly PeriodStretch[])[] | null,
): ChoiceCount {
  const cut = response.skipped.includes('WEEK_LOAD_DEADLINE');
  const row = response.years.find((candidate) => candidate.year === year);
  if (row) {
    let period: ChoicePeriod | null = null;
    if (row.over) {
      // A refusal on the week load names its period, as every refusal does.
      period = periodOf(answer.summary?.params) ?? null;
    } else {
      const tight = answer.details.find(
        (detail) => detail.code === 'TIGHT_WEEK_LOAD' && detail.params['grades'] === String(year),
      );
      period = tight ? periodOfTightWeek(requirements, year, tight.requirementIds, stretches) : null;
    }
    return {
      kind: 'LOAD',
      demandMinutes: row.demandMinutes,
      capacityMinutes: row.capacityMinutes,
      percent: percentOf(row.demandMinutes, row.capacityMinutes),
      over: row.over,
      atLeast: cut,
      period,
    };
  }
  if (response.verdict === 'IMPOSSIBLE' && answer.summary) {
    return { kind: 'REFUSED', code: answer.summary.code, params: answer.summary.params };
  }
  return cut ? { kind: 'UNKNOWN' } : { kind: 'UNDER', below: TIGHT_PERCENT };
}

/**
 * A count's figure for ranking, in percent of the frames, or null when it is not
 * one a ranking may use: cut, unknown or refused. A figure the seconds cut is a
 * lower bound at the deadline and ranks nobody. Not rounded, so that two weeks
 * in the same whole percent are still told apart.
 */
export function rankingFigure(count: ChoiceCount): number | null {
  if (count.kind === 'LOAD') return count.atLeast ? null : (count.demandMinutes * 100) / count.capacityMinutes;
  if (count.kind === 'UNDER') return count.below - 0.01;
  return null;
}
