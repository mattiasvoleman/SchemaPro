import {
  SUGGESTION_PROOFS,
  SUGGESTION_RULES,
  SUGGEST_VERDICTS,
  type AiEngineSuggestChangesResponse,
  type AiEngineSuggestedChange,
  type SuggestVerdict,
  type SuggestionProof,
  type SuggestionRule,
} from './interfaces/suggest-changes.interface';

/*
 * ÅTGÄRDSFÖRSLAG VID VÄGRAN (omgång 13, G6): THE CHANGES THAT WOULD LET A REFUSED WEEK BE LAID, AS A RUN KEEPS THEM.
 *
 * The engine answers POST /api/v1/suggest-changes with a list of changes, each of one of the five rules that may give way
 * (relaxation.py), and how well it has shown each (`proof`). This file turns that list into what OptimizationJobs."suggestions" keeps
 * and the page reads, and back: one whitelist, built field by field from the closed set of names and the bounded numbers it may hold,
 * never spread from what arrived. The stored value passes through `suggestionsOf` again on the way out, which is what makes the column
 * safe to trust: a value that is not wholly well formed is NOT shown in part, and the page then says nothing of suggestions.
 *
 * THE PROOF IS THE ENGINE'S AND NOTHING HERE RAISES IT. A change is `SOLVED` only when the engine says the list has one change and the
 * strict model accepted the timetable with it; `SOLVED_TOGETHER` is a fact about the WHOLE list, which is why `total` is kept beside
 * the few that are stored: a page that shows three of ten must say there are seven more that belong to the same proof. A list that the
 * engine did not check (`verified` false) is `MAY_HELP` whatever else it says, and a `SOLVABLE_AS_IS` without `verified` is not said.
 *
 * NO PERSON'S NAME AND NO FIGURE OF A POST IS STORED. A teacher's cap rides as the teacher's Users id in `teacherIds`, which no view
 * passes on: the page reads the name when it reads the run, as it does a free-day note. A change to a part-timer's days is the hidden
 * form for every reader (work-days.ts, deviations.ts): the rule, the price and the proof, and no post, no teacher, no figure and no
 * weekday. Several of them are one, since two of them say nothing the first did not, and their prices add.
 *
 * BOUNDED, BECAUSE THE COLUMN IS: at most MAX_STORED_CHANGES changes of at most MAX_NAMED posts and rooms each, every name cut to
 * MAX_NAME, and the whole text under what the CHECK on the column allows (8 KiB). What was left out is counted (`total`), never silent.
 */

/** How many of the changes are kept: the page shows three and says how many more belong to the list. */
export const MAX_STORED_CHANGES = 6;
/** How many posts and how many rooms one change names; the rest are counted by the length of the list on the engine's side only. */
export const MAX_NAMED = 3;
export const MAX_NAME = 80;
/**
 * The longest the whole value may be, in bytes of its compact JSON. The column's CHECK counts the text jsonb prints (a space after every
 * colon and comma, two bytes for an å), which is a fifth to a quarter longer than this; 5 500 leaves that and more under 8 192.
 */
export const MAX_STORED_BYTES = 5_500;
/** A run of the analysis that has been RUNNING this long is read as abandoned: its process went away (a deploy, a crash). */
export const STALE_AFTER_MS = 6 * 60 * 1000;

export const SUGGESTION_STATES = ['RUNNING', 'DONE', 'FAILED'] as const;
export type SuggestionsState = (typeof SUGGESTION_STATES)[number];

/** Why an analysis gave no list: the codes the page has a sentence for. */
export const SUGGESTION_FAILURES = [
  'ENGINE_LACKS_SUGGESTIONS',
  'ENGINE_BUSY',
  'ENGINE_FAILED',
  'NOTHING_TO_PLACE',
  'ABANDONED',
] as const;
export type SuggestionsFailure = (typeof SUGGESTION_FAILURES)[number];

/** One change as the column keeps it. `hidden` is a part-timer's days: nothing but the rule, the price and the proof. */
export interface StoredChange {
  rule: SuggestionRule;
  proof: SuggestionProof;
  cost: number;
  current: number | null;
  needed: number | null;
  weekdays: number[];
  requirementIds: string[];
  requirementNames: string[];
  roomIds: string[];
  roomNames: string[];
  /** The rows the change is about, in real ids: a work rule, or the room rules of a lock. Never a post. */
  resourceIds: string[];
  /** The Users ids a cap is about. Server-only: no view carries them out, and the page reads the name. */
  teacherIds: string[];
  hidden: boolean;
}

export interface SuggestionsStored {
  version: 1;
  state: SuggestionsState;
  startedAt: string;
  finishedAt: string | null;
  verdict: SuggestVerdict | null;
  /** The strict model accepted the timetable with every change of the list. */
  verified: boolean;
  /** How many changes the engine's list had (the part-timers' days merged into one entry still count each); `changes` holds the first of them. */
  total: number;
  searchSeconds: number | null;
  verifySeconds: number | null;
  changes: StoredChange[];
  failure: SuggestionsFailure | null;
}

/** What the page reads of a change: the stored one without the Users ids, with the teachers named. */
export type SuggestionChangeView = Omit<StoredChange, 'teacherIds'> & { teacherNames: string[] };

export type SuggestionsView = Omit<SuggestionsStored, 'changes'> & { changes: SuggestionChangeView[] };

/** How the engine's anonymous ids are turned back into the school's own. */
export interface Realiser {
  /** The real id of an anonymous one; the id itself when the map does not know it. */
  real(anonId: string): string;
  /** The school's name for a post or a room, by real id. */
  nameOf(realId: string): string | undefined;
  /** The Users id of the teacher a work rule (real id) is about. */
  teacherOfRule(realRuleId: string): string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idsOf = (value: unknown, max: number): string[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !UUID.test(entry)) return null;
    out.push(entry);
  }
  return out;
};

/**
 * A name cut to MAX_NAME. Never through a surrogate pair (an emoji in a room's name): half of one is a lone surrogate, which JSON writes
 * as `\ud83c` and jsonb refuses (22P02), and the analysis that took a minute and a half would be lost to the write.
 */
const clip = (name: string): string => {
  const cut = name.slice(0, MAX_NAME);
  return name.length > MAX_NAME && /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};

const namesOf = (value: unknown, max: number): string[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    out.push(clip(entry));
  }
  return out;
};

const intOrNull = (value: unknown, max: number): number | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
};

const secondsOrNull = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400
    ? Math.round(value * 10) / 10
    : undefined;
};

const isoOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

function storedChangeOf(value: unknown): StoredChange | null {
  if (!isRecord(value)) return null;
  const { rule, proof } = value;
  if (typeof rule !== 'string' || !(SUGGESTION_RULES as readonly string[]).includes(rule)) return null;
  if (typeof proof !== 'string' || !(SUGGESTION_PROOFS as readonly string[]).includes(proof)) return null;
  const cost = intOrNull(value.cost, 1_000_000_000);
  const current = intOrNull(value.current, 100_000);
  const needed = intOrNull(value.needed, 100_000);
  if (cost === null || cost === undefined || current === undefined || needed === undefined) return null;
  const weekdays = Array.isArray(value.weekdays) ? value.weekdays : null;
  if (weekdays === null || weekdays.length > 7 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return null;
  const requirementIds = idsOf(value.requirementIds, MAX_NAMED);
  const roomIds = idsOf(value.roomIds, MAX_NAMED);
  const resourceIds = idsOf(value.resourceIds, MAX_NAMED + 1);
  const teacherIds = idsOf(value.teacherIds, 1);
  const requirementNames = namesOf(value.requirementNames, MAX_NAMED);
  const roomNames = namesOf(value.roomNames, MAX_NAMED);
  if (!requirementIds || !roomIds || !resourceIds || !teacherIds || !requirementNames || !roomNames) return null;
  if (typeof value.hidden !== 'boolean') return null;
  const hidden = value.hidden;
  // The hidden form holds nothing but the rule, the price and the proof: a stored value that carries more is not shown.
  if (
    hidden &&
    (rule !== 'TEACHER_WORK_DAYS' ||
      current !== null ||
      needed !== null ||
      weekdays.length > 0 ||
      requirementIds.length > 0 ||
      requirementNames.length > 0 ||
      roomIds.length > 0 ||
      roomNames.length > 0 ||
      resourceIds.length > 0 ||
      teacherIds.length > 0)
  ) {
    return null;
  }
  // A part-timer's days are never stored in any other form.
  if (!hidden && rule === 'TEACHER_WORK_DAYS') return null;
  return {
    rule: rule as SuggestionRule,
    proof: proof as SuggestionProof,
    cost,
    current,
    needed,
    weekdays: [...(weekdays as number[])].sort((a, b) => a - b),
    requirementIds,
    requirementNames,
    roomIds,
    roomNames,
    resourceIds,
    teacherIds,
    hidden,
  };
}

/**
 * The column as it may be trusted, or null when what is there is not wholly well formed. Idempotent: what it returns is accepted again
 * unchanged, which is what lets the stored value be read through the same door it was written through.
 */
export function suggestionsOf(value: unknown): SuggestionsStored | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const state = value.state;
  if (typeof state !== 'string' || !(SUGGESTION_STATES as readonly string[]).includes(state)) return null;
  const startedAt = isoOf(value.startedAt);
  const finishedAt = value.finishedAt === null || value.finishedAt === undefined ? null : isoOf(value.finishedAt);
  if (startedAt === null || (value.finishedAt != null && finishedAt === null)) return null;
  const verdictValue = value.verdict;
  if (
    verdictValue !== null &&
    verdictValue !== undefined &&
    (typeof verdictValue !== 'string' || !(SUGGEST_VERDICTS as readonly string[]).includes(verdictValue))
  ) {
    return null;
  }
  const failureValue = value.failure;
  if (
    failureValue !== null &&
    failureValue !== undefined &&
    (typeof failureValue !== 'string' || !(SUGGESTION_FAILURES as readonly string[]).includes(failureValue))
  ) {
    return null;
  }
  if (typeof value.verified !== 'boolean') return null;
  const total = intOrNull(value.total, 10_000);
  const searchSeconds = secondsOrNull(value.searchSeconds);
  const verifySeconds = secondsOrNull(value.verifySeconds);
  if (total === null || total === undefined || searchSeconds === undefined || verifySeconds === undefined) return null;
  if (!Array.isArray(value.changes) || value.changes.length > MAX_STORED_CHANGES) return null;
  const changes: StoredChange[] = [];
  for (const entry of value.changes) {
    const change = storedChangeOf(entry);
    if (change === null) return null;
    changes.push(change);
  }
  if (changes.length > total) return null;
  // A list the strict model did not accept holds MAY_HELP and nothing more: suggestionsFromEngine stores it so, and a column that says
  // SOLVED over an unverified list was written by something else (the review of #388, U-1).
  if (!value.verified && changes.some((change) => change.proof !== 'MAY_HELP')) return null;
  const stored: SuggestionsStored = {
    version: 1,
    state: state as SuggestionsState,
    startedAt,
    finishedAt,
    verdict: (verdictValue ?? null) as SuggestVerdict | null,
    verified: value.verified,
    total,
    searchSeconds,
    verifySeconds,
    changes,
    failure: (failureValue ?? null) as SuggestionsFailure | null,
  };
  return Buffer.byteLength(JSON.stringify(stored)) <= MAX_STORED_BYTES ? stored : null;
}

/** The analysis has been asked for and is running. */
export function runningSuggestions(now: Date): SuggestionsStored {
  return {
    version: 1,
    state: 'RUNNING',
    startedAt: now.toISOString(),
    finishedAt: null,
    verdict: null,
    verified: false,
    total: 0,
    searchSeconds: null,
    verifySeconds: null,
    changes: [],
    failure: null,
  };
}

/** The analysis ended without a list. */
export function failedSuggestions(startedAt: string, failure: SuggestionsFailure, now: Date): SuggestionsStored {
  return {
    ...runningSuggestions(new Date(startedAt)),
    state: 'FAILED',
    finishedAt: now.toISOString(),
    failure,
  };
}

/**
 * The analysis ended, and a rule that never gives way refuses the week (the engine's own, or the gateway's pre-flight): no change of the
 * five can help, and that is the answer. The refusal itself is already on the run.
 */
export function refusedSuggestions(startedAt: string, now: Date): SuggestionsStored {
  return {
    ...runningSuggestions(new Date(startedAt)),
    state: 'DONE',
    finishedAt: now.toISOString(),
    verdict: 'HARD_REFUSAL',
  };
}

/**
 * Whether a stored analysis is one a read must give up on: it says RUNNING and has said so for longer than any analysis lasts (the
 * engine's ceiling is about two and a half minutes). The process that started it went away, and nothing else will ever finish it.
 */
export function isAbandoned(stored: SuggestionsStored, now: Date): boolean {
  return stored.state === 'RUNNING' && now.getTime() - Date.parse(stored.startedAt) > STALE_AFTER_MS;
}

/** What a read shows of a stored analysis: an abandoned one is a failed one, said so. */
export function readAs(stored: SuggestionsStored, now: Date): SuggestionsStored {
  // It ended when a read first has the right to say so, not when this read happens: the page polls, and a time that moved on every poll
  // would be a different answer each time for something that finished once.
  return isAbandoned(stored, now)
    ? failedSuggestions(stored.startedAt, 'ABANDONED', new Date(Date.parse(stored.startedAt) + STALE_AFTER_MS))
    : stored;
}

const RULE_ORDER = new Map<string, number>(SUGGESTION_RULES.map((rule, index) => [rule, index]));

const cut = (name: string | undefined): string | null => (name === undefined || name === '' ? null : clip(name));

function realisedChange(change: AiEngineSuggestedChange, realiser: Realiser): StoredChange {
  const proof: SuggestionProof = change.proof;
  const price = Number.isFinite(change.cost) ? Math.max(0, Math.round(change.cost)) : 0;
  if (change.rule === 'TEACHER_WORK_DAYS') {
    // A part-timer's days: no post, no teacher, no figure, no weekday (work-days.ts).
    return {
      rule: change.rule, proof, cost: price, current: null, needed: null, weekdays: [], requirementIds: [], requirementNames: [],
      roomIds: [], roomNames: [], resourceIds: [], teacherIds: [], hidden: true,
    };
  }
  const requirementIds = change.requirementIds.slice(0, MAX_NAMED).map((id) => realiser.real(id));
  const roomIds = change.roomIds.slice(0, MAX_NAMED).map((id) => realiser.real(id));
  const resourceIds = change.resourceIds.slice(0, MAX_NAMED + 1).map((id) => realiser.real(id));
  const teachers =
    change.rule === 'TEACHER_DAILY_CAP'
      ? resourceIds.flatMap((id) => {
          const teacher = realiser.teacherOfRule(id);
          return teacher === undefined ? [] : [teacher];
        })
      : [];
  return {
    rule: change.rule,
    proof,
    cost: price,
    current: change.current ?? null,
    needed: change.needed ?? null,
    weekdays: [...new Set(change.weekdays)].sort((a, b) => a - b),
    requirementIds,
    requirementNames: requirementIds.flatMap((id) => cut(realiser.nameOf(id)) ?? []),
    roomIds,
    roomNames: roomIds.flatMap((id) => cut(realiser.nameOf(id)) ?? []),
    resourceIds,
    teacherIds: teachers.slice(0, 1),
    hidden: false,
  };
}

/**
 * The engine's answer as the column keeps it. Ranked by the proof, then the engine's price, then the rule's place in the engine's list,
 * and the part-timers' days (hidden) merged into one change whose price is the sum. Only the first MAX_STORED_CHANGES are kept, and fewer
 * where the whole would not fit under the column's limit: `total` says how many the list had.
 *
 * A list the engine did not check is MAY_HELP, whatever it said: `verified` is the one thing that makes a proof, and a response whose
 * changes claim more than `verified` allows is read as the weaker (a change is SOLVED only with `verified`, and only when it is the list).
 */
export function suggestionsFromEngine(
  response: AiEngineSuggestChangesResponse,
  realiser: Realiser,
  startedAt: string,
  now: Date,
): SuggestionsStored {
  const verdict = response.verdict;
  // An answer that says no verdict this file knows is not an answer: an engine of another contract, or something that is not the engine at
  // all (a gateway page with a 200). Stored as it came it would read as an analysis that ended with nothing to say.
  if (typeof verdict !== 'string' || !(SUGGEST_VERDICTS as readonly string[]).includes(verdict)) {
    return failedSuggestions(startedAt, 'ENGINE_FAILED', now);
  }
  const entries = verdict === 'CHANGES' ? response.changes : [];
  // `verified` is the one thing that makes a proof, and only `true` is it. A truthy value that is not (a string, a number) used to keep the
  // engine's proofs here and then be stored as `verified: false`, which the read refuses (suggestionsOf): the analysis was lost to ENGINE_FAILED
  // at the write (the review of #431).
  const checked = response.verified === true;
  const mapped = entries.map((change) => {
    const stored = realisedChange(change, realiser);
    return checked ? stored : { ...stored, proof: 'MAY_HELP' as const };
  });
  // Two part-timers' days say nothing the first did not: one change, the prices added.
  const days = mapped.filter((change) => change.hidden);
  const merged: StoredChange[] = [
    ...mapped.filter((change) => !change.hidden),
    ...(days.length > 0 ? [{ ...days[0]!, cost: days.reduce((sum, change) => sum + change.cost, 0) }] : []),
  ];
  merged.sort(
    (a, b) =>
      SUGGESTION_PROOFS.indexOf(a.proof) - SUGGESTION_PROOFS.indexOf(b.proof) ||
      a.cost - b.cost ||
      (RULE_ORDER.get(a.rule) ?? 0) - (RULE_ORDER.get(b.rule) ?? 0),
  );
  // The proof is the engine's, per change, and merging does not raise it: a list of two part-timers' days that the engine checked
  // together is one change here and is still SOLVED_TOGETHER, because it is two posts.
  let kept = merged.slice(0, MAX_STORED_CHANGES);
  const base: SuggestionsStored = {
    version: 1,
    state: 'DONE',
    startedAt,
    finishedAt: now.toISOString(),
    // A refusal the engine's hard rules make carries its sentence in the run's own rows; this keeps only that no change can help.
    verdict,
    verified: checked && (verdict === 'CHANGES' || verdict === 'SOLVABLE_AS_IS'),
    // The engine's own count: the proof (SOLVED_TOGETHER) is about the WHOLE list, and the part-timers' days that were merged into one
    // entry above are still each a change the school has to make. The page says "and N more belong to it" from this.
    total: mapped.length,
    searchSeconds: secondsOrNull(response.searchSeconds) ?? null,
    verifySeconds: secondsOrNull(response.verifySeconds) ?? null,
    changes: kept,
    failure: null,
  };
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify({ ...base, changes: kept })) > MAX_STORED_BYTES) {
    kept = kept.slice(0, -1);
  }
  return { ...base, changes: kept };
}

/** What the page reads: the stored value with each cap's teacher named, and the Users ids left behind. */
export function viewOf(stored: SuggestionsStored, teacherNames: ReadonlyMap<string, string>): SuggestionsView {
  return {
    ...stored,
    changes: stored.changes.map(({ teacherIds, ...change }) => ({
      ...change,
      teacherNames: teacherIds.flatMap((id) => {
        const name = teacherNames.get(id);
        return name === undefined ? [] : [name];
      }),
    })),
  };
}

/** The Users ids a stored analysis names: whom the read has to look up. */
export function teachersOfSuggestions(stored: SuggestionsStored | null): string[] {
  return stored === null ? [] : [...new Set(stored.changes.flatMap((change) => change.teacherIds))];
}

/** The refusals of the engine's prechecks that a rule of the five gives (messages.py), by the families their codes are in. */
const FIVE_RULE_REFUSALS =
  /^(TEACHER_LESSON_LONGER_THAN_DAILY_CAP|TEACHER_DAILY_CAP_|TEACHER_WORK_DAYS_|SUBJECT_DISTRIBUTION_|DISTRIBUTION_|ROOM_LOCK_)/;

/** What a run that ended without an answer from the engine says, when the engine's own clock is what ran out. */
// The road between the API and the engine closing the call (ENGINE_PATH_CLOSED) is the run's time running out as well: the week was not answered in the time the road allows.
const RAN_OUT_OF_TIME = new Set(['ENGINE_TIMED_OUT', 'ENGINE_WAIT_EXPIRED', 'ENGINE_PATH_CLOSED']);

export interface RunOf {
  status: string;
  solverStatus: string | null;
  errorCode: string | null;
}

/**
 * Whether the analysis may be asked for about a run: it ended with no timetable, and the end is one the five rules can have given.
 *
 * A REFUSAL (INFEASIBLE, or a 400 named by a rule of the five), A TIMEOUT, OR THE ENGINE'S OWN CLOCK RUNNING OUT. Not a run that is
 * still going, not one that has a timetable, and not one whose refusal a rule that never gives way made (a lunch with no room): no
 * change of the five can help it, and the engine would take a minute to say so. Not a run the engine never answered (the engine was
 * down, the process went away): there is nothing about the week to explain.
 */
export function suggestionsMayBeAskedFor(run: RunOf): boolean {
  if (run.status === 'PENDING' || run.status === 'RUNNING') return false;
  if (run.solverStatus === 'INFEASIBLE' || run.solverStatus === 'TIMEOUT') return true;
  if (run.status !== 'FAILED' || run.errorCode === null) return false;
  return FIVE_RULE_REFUSALS.test(run.errorCode) || RAN_OUT_OF_TIME.has(run.errorCode);
}
