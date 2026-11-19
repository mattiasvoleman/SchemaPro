/*
 * KONTROLLERA VECKAN, MED LÄRARVAL: what the week would be if teachers could be
 * chosen (POST /api/v1/optimization/week-check/choice).
 *
 * The engine is not asked anything new: every number here is the answer of its
 * own /check-week (week-check.interface.ts) to a copy of Generera's payload in
 * which some posts have another teacher, so this file has no engine half and
 * the engine's contract is untouched. Mirrored by hand in web/lib/week-check-
 * choice.ts.
 *
 * EVERY NUMBER IS A LOWER BOUND ON THE TIGHTEST PERIOD. The engine counts each
 * period of the läsår on its own and keeps the heaviest one per year; a year
 * with dated posts is never one merged week. `period` says which, where it can
 * be said.
 */

/** Which part of the läsår a figure was counted in: the first stretch of days, and whether the period has more. */
export interface ChoicePeriod {
  /** YYYY-MM-DD. */
  from: string;
  to: string;
  /** The period has other stretches of weeks than the one named (the same entries run in them too). */
  more: boolean;
}

/**
 * What one /check-week said of one year.
 *
 * `LOAD`: the year's least week against its frames, in the tightest period.
 * `atLeast` when the week load's seconds ran out: the figure is then a lower
 * bound at the deadline and is never "the value", and never ranks another.
 * `over`: proved above the supply, so no timetable exists.
 * `UNDER`: counted to the end and not at the tight threshold (`below`, whole
 * percent): the engine gives a year under it no row.
 * `UNKNOWN`: the seconds ran out before the year was reached; nothing is said.
 * `REFUSED`: another count than the week load refused the week (a hall, a
 * teacher's hours, the class hours), by this sentence; no year figure exists.
 */
export type ChoiceCount =
  | {
      kind: 'LOAD';
      demandMinutes: number;
      capacityMinutes: number;
      /** Whole percent, rounded DOWN, as the check says it: a lower bound is never rounded up. */
      percent: number;
      over: boolean;
      atLeast: boolean;
      period: ChoicePeriod | null;
    }
  | { kind: 'UNDER'; below: number }
  | { kind: 'UNKNOWN' }
  | { kind: 'REFUSED'; code: string; params: Record<string, string | number> };

/**
 * "A second teacher in a subject": one teacher's posts of the subject in this
 * year, shared with a virtual second teacher, in the order of their lessons'
 * minutes so that both carry about the same. An EXAMPLE split, not the best:
 * the floor bounds every split from below. Names the subject, never a person.
 */
export interface ChoiceWhatIf {
  subject: string;
  /** Teachers qualified for the subject in this year, today: 1 says "a second would have to be found". */
  qualified: number;
  /** The posts that went to the second teacher, and the teacher's posts in all. */
  moved: number;
  of: number;
  count: ChoiceCount;
  /** False when this or the baseline figure is cut or unknown: it is listed, not ranked. */
  ranked: boolean;
}

export interface ChoiceYear {
  /** In the läsår's own numbering. */
  year: number;
  /** The same year as the check says it, counted again in this call so the figures below compare with it. */
  today: ChoiceCount;
  /** Every post whose subject has two or more qualified teachers got a teacher of its own. Null: nothing to relax. */
  floor: ChoiceCount | null;
  /** Best week first. */
  whatIf: ChoiceWhatIf[];
}

/**
 * `DONE`: asked. `NO_TIGHT_YEAR`: the check counted no year at the tight
 * threshold (a week another count refuses names no year), so there is no year
 * teacher choice could be asked about. `NOT_ASKED`: the gateway's own pre-flight
 * refuses the week (a post without a teacher) or every post is hand-placed, as
 * the check says itself, and there is nothing to relax.
 */
export type WeekCheckChoiceStatus = 'DONE' | 'NO_TIGHT_YEAR' | 'NOT_ASKED';

export interface WeekCheckChoiceView {
  status: WeekCheckChoiceStatus;
  /** The tight years, heaviest first. */
  years: ChoiceYear[];
  /** The school has recorded behörigheter at all; without any, no post can be released. */
  qualificationsRecorded: boolean;
  /** Posts that got a teacher of their own in the floor. */
  releasedPosts: number;
  /** What-ifs the time left no room for (the most that are asked is MAX_WHAT_IFS, inside the budget). */
  notRun: number;
  /** /check-week calls made (the baseline, the floor and the what-ifs). */
  calls: number;
  elapsedMs: number;
}
