import { ThrottlerStorageService } from '@nestjs/throttler';
import { WindowedThrottlerStorage } from './windowed-throttler-storage';

const TTL = 30_000;
const LIMIT = 3;
const BLOCK = 10_000;
const NAME = 'default';

/**
 * The storage replaces the library's, so the reference is the library itself:
 * the same requests at the same instants must get the same answers back. Jest's
 * clock drives both — the library through its real setTimeout calls, this one
 * through the injected `now`.
 */
describe('WindowedThrottlerStorage', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-14T08:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const storage = () => new WindowedThrottlerStorage(() => Date.now());

  describe('answers exactly as @nestjs/throttler does', () => {
    /** Milliseconds to wait before each request, then the key it is for. */
    type Step = [delayMs: number, key: string];

    const replay = async (steps: Step[]) => {
      const reference = new ThrottlerStorageService();
      const windowed = storage();
      const theirs: unknown[] = [];
      const ours: unknown[] = [];

      for (const [delay, key] of steps) {
        await jest.advanceTimersByTimeAsync(delay);
        theirs.push(await reference.increment(key, TTL, LIMIT, BLOCK, NAME));
        ours.push(await windowed.increment(key, TTL, LIMIT, BLOCK, NAME));
      }

      reference.onApplicationShutdown();
      return { theirs, ours };
    };

    it('while hits accumulate and age out of the window', async () => {
      const { theirs, ours } = await replay([
        [0, 'a'],
        [5_000, 'a'],
        [5_000, 'a'],
        [21_000, 'a'], // the first hit has expired
        [5_000, 'a'],
        [40_000, 'a'], // all of them have
      ]);

      expect(ours).toEqual(theirs);
    });

    it('through a block, the requests refused during it, and its end', async () => {
      const { theirs, ours } = await replay([
        [0, 'a'],
        [1_000, 'a'],
        [1_000, 'a'],
        [1_000, 'a'], // fourth hit: over the limit, blocked
        [2_000, 'a'], // still blocked, not counted
        [9_000, 'a'], // block over: counted afresh
        [1_000, 'a'],
      ]);

      expect(ours).toEqual(theirs);
      expect(ours[3]).toMatchObject({ isBlocked: true });
      expect(ours[5]).toMatchObject({ isBlocked: false, totalHits: 1 });
    });

    it('at the window boundary, where a hit expires the instant another arrives', async () => {
      const { theirs, ours } = await replay([
        [0, 'a'],
        [TTL, 'a'],
        [TTL - 1, 'a'],
        [1, 'a'],
      ]);

      expect(ours).toEqual(theirs);
    });
  });

  it('schedules no timer for a hit', async () => {
    const windowed = storage();

    for (let i = 0; i < 5_000; i++) {
      await windowed.increment(`route-${i % 7}`, TTL, 1_000_000, BLOCK, NAME);
    }

    // The library would now hold 5 000 pending timers, all of them filtering
    // one shared array when they fire.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('forgets a burst that has aged out without doing anything when it does', async () => {
    const windowed = storage();
    for (let i = 0; i < 50_000; i++) {
      await windowed.increment('flood', TTL, 1_000_000, BLOCK, NAME);
    }

    jest.advanceTimersByTime(TTL);

    await expect(windowed.increment('flood', TTL, 1_000_000, BLOCK, NAME)).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });

  it("does not reset another client's count when one client's block ends", async () => {
    // The library clears every pending timeout of the throttler name here, so
    // client b's hits would never expire again. Intentionally not reproduced.
    const windowed = storage();
    await windowed.increment('b', TTL, LIMIT, BLOCK, NAME);
    await windowed.increment('b', TTL, LIMIT, BLOCK, NAME);
    for (let i = 0; i < LIMIT + 1; i++) {
      await windowed.increment('a', TTL, LIMIT, BLOCK, NAME);
    }

    jest.advanceTimersByTime(BLOCK);
    await windowed.increment('a', TTL, LIMIT, BLOCK, NAME); // a's block ends

    jest.advanceTimersByTime(TTL);
    await expect(windowed.increment('b', TTL, LIMIT, BLOCK, NAME)).resolves.toMatchObject({
      totalHits: 1,
    });
  });

  it('counts the same key separately per throttler name', async () => {
    const windowed = storage();
    await windowed.increment('a', TTL, LIMIT, BLOCK, 'default');
    await windowed.increment('a', TTL, LIMIT, BLOCK, 'default');

    await expect(windowed.increment('a', TTL, LIMIT, BLOCK, 'burst')).resolves.toMatchObject({
      totalHits: 1,
    });
  });
});
