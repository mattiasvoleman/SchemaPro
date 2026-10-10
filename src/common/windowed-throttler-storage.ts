import type { ThrottlerStorage } from '@nestjs/throttler';

/** The record `ThrottlerGuard` reads back from `increment`. */
export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

interface Entry {
  /** Expiry instant (ms) of every hit recorded, oldest first. */
  expiries: number[];
  /** Index of the oldest hit still inside the window; earlier ones are spent. */
  head: number;
  /** The window the `X-RateLimit-Reset` header counts down to. */
  expiresAt: number;
  isBlocked: boolean;
  blockExpiresAt: number;
}

/** Spent slots are reclaimed once they outnumber live ones past this size. */
const COMPACT_AFTER = 1024;

const secondsUntil = (instant: number, now: number): number =>
  Math.ceil((instant - now) / 1000);

/**
 * In-memory rate-limit storage with the same answers as `@nestjs/throttler`'s
 * own `ThrottlerStorageService`, and without a timer per request.
 *
 * ## Why the library's storage is not used
 *
 * `ThrottlerStorageService` (6.5.0, the latest release) schedules a
 * `setTimeout` for every hit, and each one, when it fires, rebuilds the array
 * of pending timeout ids with `.filter()`. That array is keyed by throttler
 * NAME, not by client or route: it holds every hit from every caller of every
 * route inside the TTL. Expiring n hits is therefore O(n²), all of it on the
 * event loop, bunched into whatever second those hits were made in.
 *
 * At a school's normal traffic that is invisible. It is not invisible to the
 * latency gate, whose read scenarios put ~40 000 hits on the default throttler
 * inside a minute: sixty seconds later they expire during the attendance write
 * scenario and hold single requests for four to nine seconds.
 *
 * Here a hit is an expiry instant pushed onto its key's queue, and spent hits
 * are dropped from the front the next time that key is incremented — amortised
 * O(1) per request, no timers, nothing to do when a burst ages out.
 *
 * ## Deliberate difference
 *
 * When a blocked key's block runs out, the library clears the pending timeouts
 * of the whole throttler name, so every OTHER client's hits stop expiring and
 * their counts only ever climb. Here an unblock resets that one key.
 *
 * Single-instance only, like the library's storage: counts live in this
 * process. See AppModule for the Redis path.
 */
export class WindowedThrottlerStorage implements ThrottlerStorage {
  private readonly entries = new Map<string, Entry>();
  /** The size at which the next new key first sweeps the idle ones away. */
  private sweepAt: number;

  /**
   * `sweepAbove` (opt-in; absent, nothing is ever swept, as before): a store
   * whose keys a caller chooses — the public viewer's per-link bucket, keyed
   * on whatever token the path carries — must not grow for ever. When a new
   * key would take the map to that size, every key with no hit inside its
   * window and no block in force is dropped first; such a key answers exactly
   * as a fresh one would, so nothing a caller sees changes. The next sweep
   * waits until the map has doubled, so the work stays amortised O(1).
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: { sweepAbove?: number } = {},
  ) {
    this.sweepAt = options.sweepAbove ?? Number.POSITIVE_INFINITY;
  }

  /** How many keys are held: for the tests that bound it. */
  get size(): number {
    return this.entries.size;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = this.now();
    const entry = this.entryFor(`${throttlerName}\u0000${key}`, now, ttl);
    this.dropSpent(entry, now);

    let timeToExpire = secondsUntil(entry.expiresAt, now);
    if (timeToExpire <= 0) {
      entry.expiresAt = now + ttl;
      timeToExpire = secondsUntil(entry.expiresAt, now);
    }

    if (!entry.isBlocked) {
      entry.expiries.push(now + ttl);
    }

    if (live(entry) > limit && !entry.isBlocked) {
      entry.isBlocked = true;
      entry.blockExpiresAt = now + blockDuration;
    }

    const timeToBlockExpire = secondsUntil(entry.blockExpiresAt, now);
    if (timeToBlockExpire <= 0 && entry.isBlocked) {
      entry.isBlocked = false;
      entry.expiries = [now + ttl];
      entry.head = 0;
    }

    return {
      totalHits: live(entry),
      timeToExpire,
      isBlocked: entry.isBlocked,
      timeToBlockExpire,
    };
  }

  private entryFor(id: string, now: number, ttl: number): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= this.sweepAt) this.sweepIdle(now);
      entry = {
        expiries: [],
        head: 0,
        expiresAt: now + ttl,
        isBlocked: false,
        blockExpiresAt: 0,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private sweepIdle(now: number): void {
    for (const [id, entry] of this.entries) {
      const lastExpiry = entry.expiries.length > 0 ? entry.expiries[entry.expiries.length - 1]! : 0;
      if (lastExpiry <= now && (!entry.isBlocked || entry.blockExpiresAt <= now)) this.entries.delete(id);
    }
    this.sweepAt = Math.max(this.options.sweepAbove ?? 0, this.entries.size * 2);
  }

  /**
   * A hit stops counting at its expiry instant, the moment the library's timer
   * would have decremented it. `<=` because a timer due at `now` has fired by
   * the time a request arriving at `now` is counted.
   */
  private dropSpent(entry: Entry, now: number): void {
    while (entry.head < entry.expiries.length && entry.expiries[entry.head] <= now) {
      entry.head++;
    }
    if (entry.head > COMPACT_AFTER && entry.head * 2 > entry.expiries.length) {
      entry.expiries = entry.expiries.slice(entry.head);
      entry.head = 0;
    }
  }
}

function live(entry: Entry): number {
  return entry.expiries.length - entry.head;
}
