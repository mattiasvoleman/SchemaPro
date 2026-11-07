/**
 * What a pupil's consent on a list is now: the one definition, used by every screen and count (the database
 * stores answers, never "who has consented").
 *
 * The latest answer decides (ConsentEntries are only added to, ordered by when they were written, then by id):
 * GRANTED, DECLINED or WITHDRAWN. A pupil with no answer is MISSING. The one thing that comes before the answer is a
 * request to the guardians that is still open and was made after it: a Kvittens request of the rule ALL linked to
 * the list, which a guardian can still answer, makes the pupil ASKED (a consent that was withdrawn and is being asked
 * for again, or a pupil nobody has answered for, is waited for). A request nobody can answer any more (every
 * guardian's custody has ended) waits for nothing.
 */

export type ConsentKind = 'GRANTED' | 'DECLINED' | 'WITHDRAWN';
export type ConsentState = ConsentKind | 'ASKED' | 'MISSING';

export interface StateEntry {
  id: string;
  kind: ConsentKind;
  recordedAt: Date;
}

/** One Kvittens request linked to the list, as it stands for the pupil (app.ack_status). */
export interface StateAsk {
  requestId: string;
  askedAt: Date;
  /** Guardians asked, and how many of them can still confirm and have not. */
  asked: number;
  waiting: number;
  met: boolean;
}

/** The answers in the order they were written: oldest first. */
export function inOrder<T extends { id: string; recordedAt: Date }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function latestOf<T extends { id: string; recordedAt: Date }>(entries: readonly T[]): T | null {
  const ordered = inOrder(entries);
  return ordered.length > 0 ? ordered[ordered.length - 1]! : null;
}

/** The request that is waiting for a guardian and was made after the latest answer, the newest first. */
export function openAskOf(asks: readonly StateAsk[], latest: StateEntry | null): StateAsk | null {
  const open = asks
    .filter((ask) => !ask.met && ask.waiting > 0 && (!latest || ask.askedAt.getTime() > latest.recordedAt.getTime()))
    .sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime());
  return open[0] ?? null;
}

export function consentStateOf(entries: readonly StateEntry[], asks: readonly StateAsk[]): { state: ConsentState; latest: StateEntry | null; ask: StateAsk | null } {
  const latest = latestOf(entries);
  const ask = openAskOf(asks, latest);
  if (ask) return { state: 'ASKED', latest, ask };
  return { state: latest ? latest.kind : 'MISSING', latest, ask: null };
}

export interface ConsentCounts {
  pupils: number;
  granted: number;
  declined: number;
  withdrawn: number;
  asked: number;
  missing: number;
}

export function countStates(states: readonly ConsentState[]): ConsentCounts {
  const counts: ConsentCounts = { pupils: states.length, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 0 };
  for (const state of states) {
    if (state === 'GRANTED') counts.granted += 1;
    else if (state === 'DECLINED') counts.declined += 1;
    else if (state === 'WITHDRAWN') counts.withdrawn += 1;
    else if (state === 'ASKED') counts.asked += 1;
    else counts.missing += 1;
  }
  return counts;
}
