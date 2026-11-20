import { BASIS_VERSION, WRITE_BASIS_PARTS, canonicalJson, sha256Hex, type BasisParts } from './candidate-basis';
import type { AiEngineScheduleRequest, AnonymousRequirement } from './interfaces/ai-engine-payload.interface';
import type { ChoiceCount } from './interfaces/week-check-choice.interface';
import type { StaffingWeekOverlay, StaffingWeekVerdict } from './interfaces/staffing-week.interface';
import { derivedId, rankable, rankingFigure, spanOf, withLead } from './week-check-choice';

/*
 * FÖRESLÅ BEMANNING: THE WEEK BEFORE AND AFTER A PROPOSAL, the pure half.
 *
 * The week is the one Kontrollera veckan builds (OptimizationProxyService.prepareSchedule), and what a proposal does to
 * it is the leads it gives: the engine is asked about it as it stands and about a copy in which each proposed lead has
 * been laid over its post (overlayLeads). Nothing else is changed, so what the engine is asked is Generera's payload
 * with the teachers a proposal would put on it.
 *
 * WHAT THIS ADDS TO WHAT KONTROLLERA VECKAN WITH LÄRARVAL DOES (week-check-choice.ts). That analysis only ever takes
 * edges away (a teacher of their own on a post, a virtual second teacher); a proposal puts a post on a REAL teacher,
 * who may already carry other posts of the same year, so it can add an edge and make the week heavier. The two figures
 * are therefore set against each other (compareCounts), and only where the engine's own rules allow it.
 */

/** Most years shown: the heaviest. A school has two or three tight years, never this many. */
export const MAX_YEARS_SHOWN = 6;

/** One lead change, in real ids: the row of a proposal (or of the part of it the admin kept selected). */
export interface LeadChange {
  requirementId: string;
  fromTeacherId: string | null;
  toTeacherId: string;
}

/** What translates real ids into the payload's own, for the posts and teachers the payload names. */
export interface PayloadIds {
  /** A post's real id -> the id the payload carries it under. A post the payload does not carry has none. */
  requirementOf: ReadonlyMap<string, string>;
  /** A teacher's real id -> the id the payload names them by. A teacher it does not name has none. */
  teacherOf: ReadonlyMap<string, string>;
}

/**
 * The payload with each change's lead laid over its post, and what became of the changes (StaffingWeekOverlay).
 *
 * AN EMPTY LIST CHANGES NOTHING, and returns the payload itself (the same object, so what is sent is byte for byte what
 * it was), with a count of zero. So does a list none of whose changes is laid over a post.
 *
 * A CHANGE IS LAID OVER A POST ONLY IF THE PAYLOAD CARRIES ITS FROM-LEAD ON IT. The post's entry must be there, and its
 * teacher must be the id of the lead the proposal changes FROM (null for a post nobody teaches): the payload's entry
 * for a shared post whose lead's lessons are all locked is one teacher's with no list, and that teacher is a share's,
 * not the lead, so replacing them would take a lesson from the wrong person. What a change does not touch in the week
 * is not "wrong": it is left out and counted.
 *
 * Only the LEAD is changed, as the proposal changes only the lead (withLead): the co-teacher stays, and so does every
 * lesson of a shared post that another teacher takes. A teacher the payload names by no id (they teach nothing in the
 * week yet) is given one minted for this call, the same for all their posts and nobody's own.
 */
export function overlayLeads(
  payload: AiEngineScheduleRequest,
  changes: readonly LeadChange[],
  ids: PayloadIds,
): { payload: AiEngineScheduleRequest; overlay: StaffingWeekOverlay; years: number[] | null } {
  const given = changes.length;
  const none = (notLaidOver: number): { payload: AiEngineScheduleRequest; overlay: StaffingWeekOverlay; years: number[] | null } => ({
    payload,
    overlay: { given, laidOver: 0, notLaidOver, fromNobody: 0, newToTheWeek: 0 },
    years: [],
  });
  if (given === 0) return none(0);

  const entryOf = new Map(payload.requirements.map((requirement) => [requirement.id, requirement]));
  const minted = new Map<string, string>();
  // Teachers the payload does not name, in the order of their ids: the same minted id on every post of one teacher, and
  // the same teacher gets the same one whichever order the changes came in.
  const unnamed = [...new Set(changes.map((change) => change.toTeacherId))]
    .filter((teacherId) => !ids.teacherOf.has(teacherId))
    .sort();
  unnamed.forEach((teacherId, index) => minted.set(teacherId, derivedId(payload.requestId, `proposed-teacher:${index}`)));

  const replaced = new Map<string, AnonymousRequirement>();
  const laid = new Set<string>();
  let fromNobody = 0;
  const years = new Set<number>();
  let yearsKnown = true;
  for (const change of changes) {
    const entry = entryOf.get(ids.requirementOf.get(change.requirementId) ?? '');
    if (!entry || replaced.has(entry.id)) continue;
    const to = ids.teacherOf.get(change.toTeacherId) ?? minted.get(change.toTeacherId)!;
    const expected = change.fromTeacherId === null ? null : (ids.teacherOf.get(change.fromTeacherId) ?? undefined);
    // The payload does not carry the from-lead on this post, or the post would have its new lead twice.
    if (expected === undefined || entry.teacherId !== expected) continue;
    if (entry.coTeacherId === to || (entry.lessonTeacherIds ?? []).includes(to)) continue;
    replaced.set(entry.id, withLead(entry, to));
    laid.add(change.toTeacherId);
    if (change.fromTeacherId === null) fromNobody += 1;
    const span = spanOf(entry);
    if (span === null) yearsKnown = false;
    else for (let year = span.min; year <= span.max; year += 1) years.add(year);
  }
  const laidOver = replaced.size;
  if (laidOver === 0) return none(given);
  return {
    payload: { ...payload, requirements: payload.requirements.map((requirement) => replaced.get(requirement.id) ?? requirement) },
    overlay: {
      given,
      laidOver,
      notLaidOver: given - laidOver,
      fromNobody,
      newToTheWeek: [...laid].filter((teacherId) => minted.has(teacherId)).length,
    },
    years: yearsKnown ? [...years].sort((a, b) => a - b) : null,
  };
}

/** Whether a count is a figure over the supply: proved, and only a lower bound of the tightest period. */
const isOver = (count: ChoiceCount): boolean => count.kind === 'LOAD' && count.over;

/**
 * How a year after a proposal stands to the year before it. Built on the two rules that say when two counts may be set
 * in order (rankingFigure, rankable), so that nothing is called better or worse that the engine cannot say:
 *
 *  - two VALUES (a week counted to its end and not over the supply: every period, and the week not refused in another
 *    year, for the engine stops every year's count at the first week any verdict refuses: countOf) are compared by their
 *    figures;
 *  - a value and a figure OVER the supply: the value is lighter, whichever it is, because an over figure is a bound
 *    above the supply that no value reaches;
 *  - two figures OVER the supply are never compared: the engine counts a year's periods in turn and stops at the first
 *    it refuses, so each is the heaviest of only some of its periods, and the proposal that only relaxes the autumn
 *    can show the spring's 144 % after the autumn's 107 %;
 *  - a count the seconds cut ("at least"), a year not reached, and a week refused for another reason are never compared.
 *
 * A week the engine refuses after the proposal for a reason other than the load, and did not before, is NEWLY_REFUSED.
 */
export function compareCounts(before: ChoiceCount, after: ChoiceCount): StaffingWeekVerdict {
  // rankable(today, count): `count` is a value, and `today` is a value too or over the supply.
  const afterIsLighter = rankable(before, after);
  const afterIsHeavier = rankable(after, before);
  if (afterIsLighter && afterIsHeavier) {
    // Two values: their figures, which are not rounded (two weeks in one whole percent are still told apart).
    const was = rankingFigure(before)!;
    const is = rankingFigure(after)!;
    if (Math.abs(is - was) < 1e-9) return 'SAME';
    return is > was ? 'TIGHTER' : 'LOOSER';
  }
  if (afterIsLighter) return 'LOOSER';
  if (afterIsHeavier) return 'TIGHTER';
  if (isOver(before) && isOver(after)) return 'STILL_OVER';
  if (after.kind === 'REFUSED' && before.kind !== 'REFUSED') return 'NEWLY_REFUSED';
  return 'NOT_COMPARED';
}

/** Whether a verdict is one the school must be warned about: the proposal makes the week provably worse. */
export const isWorse = (verdict: StaffingWeekVerdict): boolean => verdict === 'TIGHTER' || verdict === 'NEWLY_REFUSED';

/**
 * The years to show: those a change touches (every year of a post's span; all of them when a post's years are not
 * known) that have a row in either answer, the heaviest first, at most MAX_YEARS_SHOWN. A year without a row in an
 * answer is under the engine's tight threshold there, which is said, not left out: it is the one that can go from
 * "under" to over. `limit` is for the caller that needs every one (the warning is about all of them, not the ones that fit).
 */
export function yearsToShow(
  beforeYears: readonly (number | null)[],
  afterYears: readonly (number | null)[],
  touched: readonly number[] | null,
  heaviest: (year: number) => number,
  limit: number = MAX_YEARS_SHOWN,
): number[] {
  const seen = new Set<number>();
  for (const year of [...beforeYears, ...afterYears]) {
    if (year !== null && (touched === null || touched.includes(year))) seen.add(year);
  }
  return [...seen].sort((a, b) => heaviest(b) - heaviest(a) || a - b).slice(0, limit);
}

/**
 * The digest of the week a proposal was judged against: what Generera's own write holds still (WRITE_BASIS_PARTS: the
 * posts, the locks, the rooms, the rules and the pupils), over real ids so that two reads of an unchanged school agree
 * although every anonymous id differs (candidate-basis.ts). Not the draft: what the check reads is the question the
 * engine is asked, and a lesson of the draft moved by hand is not part of it.
 */
export function weekBasisOf(parts: BasisParts): string {
  return sha256Hex(canonicalJson({ v: BASIS_VERSION, week: WRITE_BASIS_PARTS.map((part) => [part, parts[part]]) }));
}

/**
 * The basis an apply sends when the dialog showed the week: the proposal's own (staffing-proposal.service.ts basisOf)
 * and the week's. An apply recomputes both under its lock and refuses a difference in either, so a proposal judged
 * against one week is not applied to another. A different digest from either alone, so one is never taken for the other.
 */
export function withWeekBasis(staffingBasis: string, weekBasis: string): string {
  return sha256Hex(canonicalJson({ staffing: staffingBasis, week: weekBasis }));
}
